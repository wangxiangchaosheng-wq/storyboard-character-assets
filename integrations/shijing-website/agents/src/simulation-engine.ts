import {createHash} from 'node:crypto';
import {assert} from './contracts.js';
import type {Action,Army,WorldSnapshot} from './world-contracts.js';
import {identifier,record,validateWorld} from './world-state.js';
import {parameter} from './simulation-profile.js';
import {validateSimulation} from './simulation-state.js';
import {clamp,round,interpolate,type AdvanceCommand,type SimulationCommand,type SimulationReport,type ArmyModel,type Road} from './simulation-types.js';

const key=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,32);
const kinds=['march','forced-march','garrison','resupply','attack','besiege','retreat'];
const model=(w:WorldSnapshot,id:string)=>w.simulation!.armies[id];
const rule=(w:WorldSnapshot,name:string)=>parameter(w.simulation!.profile,name);
const total=(a:Army,m:ArmyModel)=>a.troops+m.wounded+m.transportPeople;
const ordered=(w:WorldSnapshot)=>w.simulation!.activeArmyIds.slice().sort().map(id=>w.armies[id]);
const now=(w:WorldSnapshot)=>w.simulation!.timeHours;
const report=(w:WorldSnapshot,id:string,kind:'order'|'advance'):SimulationReport=>({commandId:id,kind,advancedHours:0,pauseReason:null,rulesVersion:w.simulation!.profile.id+':'+w.simulation!.profile.version,traces:[],summaries:[]});
function ensure(w:WorldSnapshot,revision:number){assert(w.simulation?.mode==='local','当前对局未启用本地规则',409);assert(revision===w.revision,'世界版本已变化，请读取最新状态再提交',409);validateWorld(w);}
function exact(raw:Record<string,unknown>,allowed:string[]){assert(Object.keys(raw).every(k=>allowed.includes(k)),'请求包含不允许的字段');}
export function validateOrder(raw:unknown):asserts raw is SimulationCommand {
 record(raw,'本地命令');exact(raw,['commandId','expectedRevision','armyId','kind','targetCityId','sourceCityId','foodKg','effects']);identifier(raw.commandId);identifier(raw.armyId);
 assert(Number.isSafeInteger(raw.expectedRevision)&&(raw.expectedRevision as number)>=0,'世界版本无效');assert(kinds.includes(String(raw.kind)),'不支持的本地行动');
 for(const k of ['targetCityId','sourceCityId'])if(raw[k]!==undefined)identifier(raw[k]);
 if(raw.foodKg!==undefined)assert(typeof raw.foodKg==='number'&&Number.isFinite(raw.foodKg)&&raw.foodKg>0&&raw.foodKg<=1000000,'补给数量无效');
 if(raw.kind!=='resupply')assert(raw.foodKg===undefined&&raw.sourceCityId===undefined,'此行动不接受补给参数');
 if(raw.kind==='garrison'||raw.kind==='resupply')assert(raw.targetCityId===undefined&&raw.effects===undefined,'驻守或补给不接受路线参数');
 if(raw.effects!==undefined){assert(Array.isArray(raw.effects)&&raw.effects.length<=1,'同类加成不能叠加');for(const e of raw.effects){record(e,'效果');exact(e,['id','factor','roadId','durationHours','reason']);assert(e.id==='route-familiarity','不支持的效果');identifier(e.roadId);assert(typeof e.factor==='number'&&Number.isFinite(e.factor)&&e.factor>=1,'倍率无效');assert(typeof e.durationHours==='number'&&Number.isFinite(e.durationHours)&&e.durationHours>0&&e.durationHours<=24,'效果期限无效');assert(typeof e.reason==='string'&&e.reason.length>0&&e.reason.length<=500,'需要效果依据');}}
}
export function validateAdvance(raw:unknown):asserts raw is AdvanceCommand {
 record(raw,'推进请求');exact(raw,['commandId','expectedRevision','hours']);identifier(raw.commandId);
 assert(Number.isSafeInteger(raw.expectedRevision)&&(raw.expectedRevision as number)>=0,'世界版本无效');
 assert(typeof raw.hours==='number'&&Number.isSafeInteger(raw.hours)&&raw.hours>=1&&raw.hours<=168,'每次推进1—168小时');
}
function worldPoint(w:WorldSnapshot,m:ArmyModel){if(m.roadId){const r=w.simulation!.roads[m.roadId];return interpolate(w.cities[r.from].point,w.cities[r.to].point,m.roadKm/r.distanceKm);}assert(m.atCityId,'军队没有可用位置');return w.cities[m.atCityId].point;}
function stopOrder(w:WorldSnapshot,a:Army,status:'completed'|'failed',reason:string){
 const m=model(w,a.id),o=m.order;if(!o||o.status!=='active')return;
 o.status=status;o.stopReason=reason;
 if(o.actionId){const action=w.actions[o.actionId];action.status=status;action.endedDay=w.clock.elapsedDays;if(status==='completed')action.progress=1;}
 const d=w.decisions[o.id];if(d)d.status=status;
}
function hold(w:WorldSnapshot,a:Army,reason:string){
 const m=model(w,a.id);stopOrder(w,a,'failed',reason);
 a.location=m.atCityId&&w.cities[m.atCityId].ownerFactionId===a.factionId?{kind:'city',cityId:m.atCityId}:{kind:'field',point:worldPoint(w,m),label:m.atCityId?w.cities[m.atCityId].name+'城外':'道路上驻留'};
 a.status=a.troops===0?'destroyed':a.location.kind==='city'?'stationed':'resting';
}
function roadFor(w:WorldSnapshot,m:ArmyModel,target:string):Road|undefined {
 const roads=w.simulation!.roads;
 if(m.roadId){const r=roads[m.roadId];return r.from===target||r.to===target?r:undefined;}
 return Object.values(roads).find(r=>(r.from===m.atCityId&&r.to===target)||(r.to===m.atCityId&&r.from===target));
}
function installOrder(w:WorldSnapshot,input:SimulationCommand,r:SimulationReport,automatic=false){
 const s=w.simulation!,a=w.armies[input.armyId];assert(a&&s.activeArmyIds.includes(a.id),'军队不在首版战役范围内');const m=model(w,a.id);
 assert(automatic||a.factionId===s.playerFactionId,'只能指挥己方军队',403);assert(a.troops>0,'该军队已失去战斗能力');
 if(input.kind==='resupply'){supply(w,input,r);return;}
 const target=input.targetCityId;
 if(input.kind==='garrison')assert(!m.roadId,'在道路上需先完成移动或撤回据点，再休整');
 else assert(target&&!!w.cities[target],'需要有效的目标城池');
 if(input.kind==='forced-march')assert(m.fatigue<rule(w,'forcedLimit'),'疲劳过高，不能急行军');
 const road=target&&target!==m.atCityId?roadFor(w,m,target):undefined;
 if(target!==m.atCityId&&input.kind!=='garrison')assert(road?.open,'没有已配置且可通行的路线');
 if(input.kind==='retreat')assert(target&&w.cities[target].ownerFactionId===a.factionId,'撤退终点必须是己方据点');
 if(['attack','besiege'].includes(input.kind))assert(target&&w.cities[target].ownerFactionId!==a.factionId,'进攻目标必须是敌方城池');
 for(const e of input.effects||[]){assert(road&&road.id===e.roadId&&m.knownRoads.includes(e.roadId),'部队档案未登记熟悉该路段');assert(e.factor<=rule(w,'navigationMax'),'导航加成超过规则上限');assert(!m.effects.some(x=>x.expiresHour>s.timeHours),'已有同组效果生效，不能重复叠加');}
 if(m.order?.status==='active'){
  const old=m.order;if(old.actionId){w.actions[old.actionId].status='cancelled';w.actions[old.actionId].endedDay=w.clock.elapsedDays;}
  if(w.decisions[old.id])w.decisions[old.id].status='cancelled';
 }
 const id='decision-'+key(input.commandId),actionId='action-'+key(input.commandId);
 m.order={id,kind:input.kind,targetCityId:target,roadId:road?.id,sinceHour:s.timeHours,status:'active'};
 w.decisions[id]={id,title:input.kind==='garrison'?'驻守休整':`${a.name}：${({march:'行军','forced-march':'急行军',attack:'进攻',besiege:'围困',retreat:'撤退'} as Record<string,string>)[input.kind]}${w.cities[target!]?.name||''}`,orderText:automatic?'本地守军根据已获情报调整行动':`${a.name}执行${input.kind}${target?'，目标'+w.cities[target].name:''}`,issuedDay:w.clock.elapsedDays,issuerId:automatic?'local-defender':'player',status:'executing',related:[{type:'army',id:a.id},...(target?[{type:'city' as const,id:target}]:[])]};
 if(road&&target){
  const startPoint=worldPoint(w,m),originCity=m.atCityId;
  m.roadKm=m.roadId?m.roadKm:road.from===m.atCityId?0:road.distanceKm;m.roadId=road.id;m.atCityId=null;
  const action:Action={id:actionId,decisionId:id,armyId:a.id,kind:input.kind==='forced-march'?'march':input.kind==='besiege'?'attack':input.kind as Action['kind'],origin:{cityId:originCity,point:startPoint,label:originCity?w.cities[originCity].name:'途中'},target:{cityId:target,point:w.cities[target].point,label:w.cities[target].name},route:[startPoint,w.cities[target].point],status:'active',startedDay:w.clock.elapsedDays,estimatedArrivalDay:null,endedDay:null,progress:0};
  w.actions[actionId]=action;m.order.actionId=actionId;a.location={kind:'route',actionId};a.status='marching';w.decisions[id].related.push({type:'action',id:actionId});
 }else{a.status=m.atCityId&&w.cities[m.atCityId].ownerFactionId===a.factionId?'resting':input.kind==='besiege'?'besieging':'resting';}
 for(const e of input.effects||[])m.effects.push({id:e.id,parameter:'navigation',factor:e.factor,roadId:e.roadId,expiresHour:s.timeHours+e.durationHours,group:'navigation'});
 r.summaries.push(w.decisions[id].title+'，命令已记录；尚未推进时间。');
}
function supply(w:WorldSnapshot,input:SimulationCommand,r:SimulationReport){
 const s=w.simulation!,a=w.armies[input.armyId],m=model(w,a.id),source=input.sourceCityId||m.atCityId;
 assert(source&&w.cities[source]?.ownerFactionId===a.factionId,'补给必须从己方库存发出');
 const city=w.cities[source],requested=input.foodKg??Math.min(city.foodKg,m.capacityKg-a.foodKg);
 assert(requested>0&&requested<=city.foodKg,'库存不足或部队已满载');
 if(m.atCityId===source){assert(requested+a.foodKg<=m.capacityKg,'超过部队携粮能力');city.foodKg=round(city.foodKg-requested);a.foodKg=round(a.foodKg+requested);r.summaries.push(`${city.name}向${a.name}调拨${requested}公斤粮草。`);}
 else{
  assert(!Object.values(s.shipments).some(c=>c.targetArmyId===a.id&&!['returned','captured'].includes(c.status)),'该部队已有在途补给');
  const road=m.roadId?s.roads[m.roadId]:Object.values(s.roads).find(x=>(x.from===source&&x.to===m.atCityId)||(x.to===source&&x.from===m.atCityId));
  assert(road?.open&&(road.from===source||road.to===source),'没有可执行的运输路线');
  const start=road.from===source?0:road.distanceKm,target=m.roadId?m.roadKm:road.from===m.atCityId?0:road.distanceKm;
  const days=Math.abs(target-start)/(rule(w,'marchKmDay')*road.terrainFactor*road.weatherFactor);
  const rationPerCarrier=rule(w,'rationKg')*(days*2+2),cargoPerCarrier=rule(w,'carrierKg')-rationPerCarrier;
  assert(cargoPerCarrier>0,'运输队往返口粮超过载重；需中继仓或其他运输方式');
  const carriers=Math.ceil(requested/cargoPerCarrier),ration=round(carriers*rationPerCarrier);
  assert(carriers<=s.cities[source].transportAvailable,'运输人员不足');assert(requested+ration<=city.foodKg,'库存不足以支付货物及运输队往返口粮');
  city.foodKg=round(city.foodKg-requested-ration);s.cities[source].transportAvailable-=carriers;
  const id='shipment-'+key(input.commandId);s.shipments[id]={id,sourceCityId:source,targetArmyId:a.id,factionId:a.factionId,roadId:road.id,roadKm:start,targetKm:target,carriers,cargoKg:requested,rationKg:ration,waterAccessible:road.waterAccessible,status:'travelling',createdHour:s.timeHours};
  r.summaries.push(`补给已发出：货物${requested}公斤，运输人员${carriers}人；前线尚未收到。`);
 }
 const id='decision-'+key(input.commandId);w.decisions[id]={id,title:'调拨补给',orderText:r.summaries.at(-1)!,issuedDay:w.clock.elapsedDays,issuerId:'player',status:'completed',related:[{type:'army',id:a.id},{type:'city',id:source}]};
}
export function issueOrder(before:WorldSnapshot,input:SimulationCommand):{world:WorldSnapshot;report:SimulationReport}{
 validateOrder(input);ensure(before,input.expectedRevision);const w=structuredClone(before),r=report(w,input.commandId,'order');installOrder(w,input,r);w.simulation!.pauseReason=null;w.revision++;validateWorld(w);return{world:w,report:r};
}
function samePlace(w:WorldSnapshot,a:Army,b:Army){const x=model(w,a.id),y=model(w,b.id);return x.atCityId!==null&&x.atCityId===y.atCityId||x.roadId!==null&&x.roadId===y.roadId&&Math.abs(x.roadKm-y.roadKm)<1e-5;}
function observe(w:WorldSnapshot){
 const s=w.simulation!;
 for(const a of ordered(w))for(const b of ordered(w))if(a.troops&&b.troops&&a.factionId!==b.factionId&&samePlace(w,a,b)){
  const m=model(w,b.id);s.intelligence=s.intelligence.filter(i=>!(i.observerFactionId===a.factionId&&i.enemyArmyId===b.id));
  s.intelligence.push({observerFactionId:a.factionId,enemyArmyId:b.id,seenHour:s.timeHours,atCityId:m.atCityId,roadId:m.roadId,roadKm:m.roadKm,estimatedTroops:Math.max(100,Math.round(b.troops/500)*500)});
 }
}
function enemyOrders(w:WorldSnapshot,r:SimulationReport){
 const s=w.simulation!;
 for(const a of ordered(w).filter(a=>a.factionId!==s.playerFactionId&&a.troops>0)){
  const m=model(w,a.id),hostile=s.intelligence.filter(i=>i.observerFactionId===a.factionId&&s.timeHours-i.seenHour<=rule(w,'intelHours'));
  const threat=hostile.find(i=>i.atCityId&&i.atCityId===m.atCityId);
  if(a.morale<rule(w,'retreatMorale')&&threat){
   const safe=Object.values(s.roads).find(x=>x.open&&(x.from===m.atCityId&&w.cities[x.to].ownerFactionId===a.factionId||x.to===m.atCityId&&w.cities[x.from].ownerFactionId===a.factionId));
   if(safe&&m.order?.kind!=='retreat')installOrder(w,{commandId:`auto-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'retreat',targetCityId:safe.from===m.atCityId?safe.to:safe.from},r,true);
   else if(!safe&&a.morale<=10){surrender(w,a,r);}
   continue;
  }
  if(m.roadId&&m.order?.status!=='active'){const road=s.roads[m.roadId],home=[road.from,road.to].find(id=>w.cities[id].ownerFactionId===a.factionId);if(road.open&&home)installOrder(w,{commandId:`auto-return-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'retreat',targetCityId:home},r,true);continue;}
  if(m.order?.status==='active'&&s.timeHours-m.order.sinceHour<rule(w,'minimumOrderHours'))continue;
  if(m.atCityId&&w.cities[m.atCityId].ownerFactionId===a.factionId&&a.foodKg<total(a,m)*rule(w,'rationKg')*2&&w.cities[m.atCityId].foodKg>0){
   const amount=Math.min(w.cities[m.atCityId].foodKg,m.capacityKg-a.foodKg,total(a,m)*rule(w,'rationKg')*3);
   if(amount>0)supply(w,{commandId:`auto-supply-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'resupply',foodKg:amount},r);
  }
  // Optional additional configured units may reinforce or intercept using shared observed intelligence.
  // Do not evacuate an otherwise undefended home city, or use unseen exact enemy resources.
  const homeCovered=m.atCityId&&ordered(w).some(other=>other.id!==a.id&&other.factionId===a.factionId&&other.troops>0&&model(w,other.id).atCityId===m.atCityId);
  if(homeCovered&&(!m.order||m.order.status!=='active'||m.order.kind==='garrison')){
   const distress=hostile.find(i=>i.atCityId&&i.atCityId!==m.atCityId&&w.cities[i.atCityId].ownerFactionId===a.factionId);
   const intercept=hostile.find(i=>i.roadId&&s.roads[i.roadId]&&(s.roads[i.roadId].from===m.atCityId||s.roads[i.roadId].to===m.atCityId)&&i.estimatedTroops<=a.troops);
   const target=distress?.atCityId||(intercept?.roadId?(s.roads[intercept.roadId].from===m.atCityId?s.roads[intercept.roadId].to:s.roads[intercept.roadId].from):undefined);
   const road=target?roadFor(w,m,target):undefined;
   if(target&&road?.open){const days=road.distanceKm/(rule(w,'marchKmDay')*road.terrainFactor*road.weatherFactor*clamp(1-rule(w,'fatigueSpeed')*m.fatigue,.5,1));
    if(a.foodKg>=total(a,m)*rule(w,'rationKg')*days){installOrder(w,{commandId:`auto-support-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'march',targetCityId:target},r,true);continue;}
   }
  }
  if(!m.order||m.order.status!=='active')installOrder(w,{commandId:`auto-hold-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'garrison'},r,true);
 }
}
function surrender(w:WorldSnapshot,a:Army,r:SimulationReport){
 const m=model(w,a.id);m.captured+=a.troops+m.wounded+m.transportPeople;a.troops=0;m.wounded=0;m.transportPeople=0;hold(w,a,'守軍士气崩溃，正式投降');r.pauseReason='守军投降';r.summaries.push(a.name+'正式投降，人员记为被俘。');
}
function blockade(w:WorldSnapshot){
 const s=w.simulation!;
 for(const [id,c] of Object.entries(s.cities)){
  const attackers=ordered(w).filter(a=>a.troops>0&&model(w,a.id).atCityId===id&&a.factionId!==w.cities[id].ownerFactionId&&['attack','besiege'].includes(model(w,a.id).order?.kind||'')&&model(w,a.id).order?.status==='active');
  const defense=ordered(w).filter(a=>a.troops>0&&model(w,a.id).atCityId===id&&a.factionId===w.cities[id].ownerFactionId).reduce((n,a)=>n+a.troops,0);
  // The v1 theatre has one configured supply road. Other theatres require explicit entrances.
  c.blockadeBy=attackers.reduce((n,a)=>n+a.troops,0)>=Math.max(1,defense*rule(w,'blockadeNeed'))?attackers.map(a=>a.id):[];
 }
}
function speed(w:WorldSnapshot,a:Army,occupancy:Record<string,number>):number {
 const s=w.simulation!,m=model(w,a.id),o=m.order;if(!m.roadId||o?.status!=='active'||!o.targetCityId||a.troops===0)return 0;
 const road=s.roads[m.roadId];if(!road.open||(!road.waterAccessible&&m.waterLitres<=0))return 0;
 const nav=m.effects.find(e=>e.roadId===road.id&&e.expiresHour>s.timeHours)?.factor||1;
 const load=clamp(1-.2*Math.max(0,a.foodKg/m.capacityKg-.8),.8,1);
 const forced=o.kind==='forced-march'&&m.fatigue<rule(w,'forcedLimit')?rule(w,'forcedFactor'):1;
 // Capacity shares are calculated from the common snapshot, never iteration order.
 const capacity=Math.min(1,road.capacityPeople/(occupancy[road.id]||1));
 return rule(w,'marchKmDay')/24*road.terrainFactor*road.weatherFactor*load*clamp(1-rule(w,'fatigueSpeed')*m.fatigue,.5,1)*forced*nav*capacity*(a.foodKg>0?1:.25);
}
function consume(w:WorldSnapshot,dt:number,r:SimulationReport){
 const s=w.simulation!,days=dt/24;
 for(const a of ordered(w)){
  const m=model(w,a.id),people=total(a,m);if(!people)continue;
  const demand=people*rule(w,'rationKg')*days,food=Math.min(demand,a.foodKg);a.foodKg=round(a.foodKg-food);s.ledger.consumedKg+=food;m.rationRatio=demand?food/demand:1;
  const waterNeeded=people*rule(w,'waterLitres')*days;
  const accessible=m.roadId?s.roads[m.roadId].waterAccessible:m.atCityId?s.cities[m.atCityId].waterAccessible:false;
  if(accessible)m.waterLitres=Math.max(m.waterLitres,people*rule(w,'waterLitres'));
  const water=Math.min(waterNeeded,m.waterLitres);m.waterLitres=round(m.waterLitres-water);m.waterRatio=waterNeeded?water/waterNeeded:1;
  m.foodDeficitHours=m.rationRatio<.999?round(m.foodDeficitHours+dt):0;m.waterDeficitHours=m.waterRatio<.999?round(m.waterDeficitHours+dt):0;
  a.morale=clamp(a.morale-(1-m.rationRatio)*rule(w,'foodMorale')*days-(1-m.waterRatio)*rule(w,'waterMorale')*days);
  if(m.foodDeficitHours>rule(w,'hungerThresholdHours')&&a.troops>0){const value=a.troops*rule(w,'hungerDesertion')*(1-m.rationRatio)*days+m.desertCarry;const loss=Math.min(a.troops,Math.floor(value));m.desertCarry=value-Math.floor(value);a.troops-=loss;m.deserted+=loss;}
  if(m.rationRatio<1||m.waterRatio<1)m.fatigue=clamp(m.fatigue+8*((1-m.rationRatio)+(1-m.waterRatio))*days);
  r.traces.push({rule:'rations',entityId:a.id,hours:dt,inputs:{people,kgPerPersonDay:rule(w,'rationKg'),demandKg:demand},result:{consumedKg:food,remainingKg:a.foodKg,waterRatio:m.waterRatio}});
  if(m.rationRatio<1&&m.foodDeficitHours<=dt+.000001){r.pauseReason='部队补给不足';r.summaries.push(a.name+'开始缺粮，需要调整补给或行动。');}
  if(m.waterRatio<1&&m.waterDeficitHours<=dt+.000001){r.pauseReason='部队供水不足';r.summaries.push(a.name+'供水不足。');}
  if(a.troops===0&&a.status!=='destroyed')hold(w,a,'部队失去战斗能力');
 }
 for(const [id,c] of Object.entries(s.cities)){
  const city=w.cities[id],need=(c.residents+c.transportAvailable)*rule(w,'rationKg')*days,food=Math.min(need,city.foodKg);city.foodKg=round(city.foodKg-food);s.ledger.consumedKg+=food;
  if(food<need&&need>0){for(const a of ordered(w).filter(a=>model(w,a.id).atCityId===id&&a.factionId===city.ownerFactionId))a.morale=clamp(a.morale-rule(w,'foodMorale')*days);}
 }
}
function refreshLocation(w:WorldSnapshot,a:Army){
 const s=w.simulation!,m=model(w,a.id),o=m.order;if(!m.roadId||!o?.actionId||o.status!=='active')return;
 const road=s.roads[m.roadId],action=w.actions[o.actionId],end=o.targetCityId===road.from?0:road.distanceKm;
 const origin=action.origin.cityId===road.from?0:action.origin.cityId===road.to?road.distanceKm:(Math.hypot(action.origin.point.x-w.cities[road.from].point.x,action.origin.point.y-w.cities[road.from].point.y)/Math.hypot(w.cities[road.to].point.x-w.cities[road.from].point.x,w.cities[road.to].point.y-w.cities[road.from].point.y))*road.distanceKm;
 action.progress=clamp(1-Math.abs(end-m.roadKm)/Math.max(1e-8,Math.abs(end-origin)),0,1);
}
function arrive(w:WorldSnapshot,a:Army,r:SimulationReport){
 const m=model(w,a.id),o=m.order!;m.atCityId=o.targetCityId!;m.roadId=null;
 const city=w.cities[m.atCityId];if(o.actionId)w.actions[o.actionId].progress=1;
 a.location=city.ownerFactionId===a.factionId?{kind:'city',cityId:city.id}:{kind:'field',point:city.point,label:city.name+'城外'};
 a.status=city.ownerFactionId===a.factionId?'stationed':['attack','besiege'].includes(o.kind)?'besieging':'resting';
 if(!['attack','besiege'].includes(o.kind))stopOrder(w,a,'completed','抵达目标');
 r.pauseReason='抵达目标';r.summaries.push(a.name+'抵达'+city.name+(city.ownerFactionId===a.factionId?'。':'城外，城池归属尚未改变。'));
}
function losses(w:WorldSnapshot,a:Army,amount:number,r:SimulationReport,why:string){
 const m=model(w,a.id),value=amount+m.lossCarry,loss=Math.min(a.troops,Math.floor(value));m.lossCarry=value-Math.floor(value);
 const wounded=Math.floor(loss*rule(w,'woundedShare'));a.troops-=loss;m.wounded+=wounded;m.dead+=loss-wounded;
 if(loss){a.morale=clamp(a.morale-loss/Math.max(1,a.troops+loss)*100);r.summaries.push(`${a.name}${why}：${loss}人暂失战力，其中伤员${wounded}人、阵亡${loss-wounded}人。`);}
 if(a.troops===0)hold(w,a,'失去全部可战兵力');
}
function battle(w:WorldSnapshot,dt:number,r:SimulationReport,contactAtStart:Set<string>){
 const units=ordered(w).filter(a=>a.troops>0),s=w.simulation!,days=dt/24;
 const pending=new Map<string,number>(),engaged=new Set<string>();
 for(let i=0;i<units.length;i++)for(let j=i+1;j<units.length;j++){
  const a=units[i],b=units[j],pair=[a.id,b.id].sort().join('|');if(a.factionId===b.factionId||!contactAtStart.has(pair))continue;
  const x=model(w,a.id),y=model(w,b.id);
  if(!samePlace(w,a,b))continue;
  const hostileCity=x.atCityId? w.cities[x.atCityId]:null;
  const assault=hostileCity&&((a.factionId!==hostileCity.ownerFactionId&&x.order?.kind==='attack'&&x.order.status==='active')||(b.factionId!==hostileCity.ownerFactionId&&y.order?.kind==='attack'&&y.order.status==='active'));
  if(hostileCity&&!assault)continue;
  const withdrawing=x.order?.kind==='retreat'||y.order?.kind==='retreat';
  const opponents=(unit:Army)=>Math.max(1,units.filter(other=>other.factionId!==unit.factionId&&contactAtStart.has([unit.id,other.id].sort().join('|'))&&samePlace(w,unit,other)).length);
  const nA=Math.min(a.troops,rule(w,'frontage'))/opponents(a),nB=Math.min(b.troops,rule(w,'frontage'))/opponents(b);
  const power=(a:Army,m:ArmyModel,n:number)=>n*m.training*m.equipment*(.5+a.morale/200)*(.5+(100-m.fatigue)/200)*clamp(m.rationRatio,.25,1)*(hostileCity?.ownerFactionId===a.factionId?1+(rule(w,'assaultDefender')-1)*hostileCity.defense/100:1);
  const pA=power(a,x,nA),pB=power(b,y,nB),rate=rule(w,'lossRate')*days;
  let aLoss=nA*rate*clamp(pB/pA,rule(w,'combatRatioMin'),rule(w,'combatRatioMax'));
  let bLoss=nB*rate*clamp(pA/pB,rule(w,'combatRatioMin'),rule(w,'combatRatioMax'));
  if(withdrawing){if(x.order?.kind==='retreat'){aLoss*=rule(w,'pursuitFactor');bLoss=0;}else{bLoss*=rule(w,'pursuitFactor');aLoss=0;}}
  pending.set(a.id,(pending.get(a.id)||0)+aLoss);pending.set(b.id,(pending.get(b.id)||0)+bLoss);engaged.add(a.id);engaged.add(b.id);
  r.traces.push({rule:withdrawing?'pursuit':'combat',entityId:a.id+'|'+b.id,hours:dt,inputs:{aEngaged:nA,bEngaged:nB,aPower:pA,bPower:pB,baseRatePerDay:rule(w,'lossRate')},result:{aLoss,bLoss}});
 }
 for(const id of engaged){const a=w.armies[id],m=model(w,id);losses(w,a,pending.get(id)||0,r,'交战');m.lastCombatHour=s.timeHours;m.fatigue=clamp(m.fatigue+rule(w,'combatFatigue')*days);if(a.troops>0){if(m.roadId)a.location={kind:'field',point:worldPoint(w,m),label:'道路交战处'};a.status='fighting';}}
 for(const a of units){const m=model(w,a.id);if(!engaged.has(a.id)&&!m.roadId&&s.timeHours-m.lastCombatHour>=24&&m.rationRatio===1&&m.waterRatio===1&&a.troops>0){
   m.fatigue=clamp(m.fatigue-rule(w,'fatigueRest')*days);
   const amount=m.wounded*rule(w,'recoveryRate')*days+m.recoveryCarry,n=Math.min(m.wounded,Math.floor(amount));m.recoveryCarry=amount-Math.floor(amount);m.wounded-=n;a.troops+=n;
  }}
 // Siege damage requires actual equipment. Starting expedition has no siege train.
 for(const a of units){const m=model(w,a.id);if(m.atCityId&&m.order?.status==='active'&&m.order.kind==='attack'&&w.cities[m.atCityId].ownerFactionId!==a.factionId&&m.siegePower>0){const c=w.cities[m.atCityId];c.defense=clamp(c.defense-m.siegePower*rule(w,'siegeDamage')*days);if(c.defense===0)s.cities[c.id].gateOpen=true;}}
}
function occupy(w:WorldSnapshot,r:SimulationReport){
 const s=w.simulation!;
 for(const a of ordered(w)){
  const m=model(w,a.id);if(!a.troops||!m.atCityId||m.order?.status!=='active'||!['attack','besiege'].includes(m.order.kind))continue;
  const city=w.cities[m.atCityId];if(city.ownerFactionId===a.factionId)continue;
  if(ordered(w).some(b=>b.troops>0&&b.factionId===city.ownerFactionId&&model(w,b.id).atCityId===city.id))continue;
  for(const b of Object.values(w.armies).filter(b=>b.location.kind==='city'&&b.location.cityId===city.id&&b.factionId!==a.factionId)){b.location={kind:'field',point:city.point,label:city.name+'城外'};}
  city.ownerFactionId=a.factionId;city.governor={...a.commander};s.cities[city.id].blockadeBy=[];s.cities[city.id].gateOpen=true;
  a.location={kind:'city',cityId:city.id};a.status='stationed';stopOrder(w,a,'completed','守军已失去抵抗能力，部队入城');r.pauseReason='城池归属改变';r.summaries.push(a.name+'进入'+city.name+'，城内剩余库存保留原数值。');
 }
}
function shipments(w:WorldSnapshot,dt:number,r:SimulationReport){
 const s=w.simulation!,days=dt/24;
 for(const c of Object.values(s.shipments).sort((a,b)=>a.id.localeCompare(b.id))){
  if(['captured','returned'].includes(c.status))continue;
  const road=s.roads[c.roadId],need=c.carriers*rule(w,'rationKg')*days;
  const ration=Math.min(need,c.rationKg);c.rationKg=round(c.rationKg-ration);
  const cargoRation=Math.min(need-ration,c.cargoKg);c.cargoKg=round(c.cargoKg-cargoRation);s.ledger.consumedKg+=ration+cargoRation;
  const spoil=c.cargoKg*rule(w,'shipmentLoss')*days;c.cargoKg=round(c.cargoKg-spoil);s.ledger.spoiledKg+=spoil;
  r.traces.push({rule:'transport',entityId:c.targetArmyId,hours:dt,inputs:{shipment:c.id,carriers:c.carriers,roadKm:c.roadKm},result:{consumedKg:ration+cargoRation,spoiledKg:spoil,cargoKg:c.cargoKg,rationKg:c.rationKg}});
  const end=c.status==='returning'?(road.from===c.sourceCityId?0:road.distanceKm):c.targetKm;
  if(road.open&&road.waterAccessible&&ration+cargoRation>=need-1e-8&&c.status!=='waiting'){
   const speedKmHour=rule(w,'marchKmDay')/24*road.terrainFactor*road.weatherFactor;
   c.roadKm=round(c.roadKm+Math.sign(end-c.roadKm)*Math.min(Math.abs(end-c.roadKm),speedKmHour*dt));
  }
  const enemies=ordered(w).filter(a=>a.troops>0&&a.factionId!==c.factionId&&positionOnRoad(w,a,c.roadId)!==null&&Math.abs(positionOnRoad(w,a,c.roadId)!-c.roadKm)<1e-5);
  if(enemies.length){
   const captor=enemies[0],m=model(w,captor.id),captured=c.cargoKg+c.rationKg,taken=Math.min(captured,m.capacityKg-captor.foodKg);
   captor.foodKg=round(captor.foodKg+taken);s.ledger.spoiledKg+=captured-taken;s.ledger.transportCaptured+=c.carriers;c.cargoKg=0;c.rationKg=0;c.status='captured';
   r.pauseReason='补给被截';r.summaries.push(`运输队被${captor.name}截获，${c.carriers}人被俘；超出敌军运力的粮草记为损毁。`);continue;
  }
  if(Math.abs(c.roadKm-end)>1e-5)continue;
  if(c.status==='returning'){
   const city=w.cities[c.sourceCityId];if(city.ownerFactionId===c.factionId){city.foodKg=round(city.foodKg+c.cargoKg+c.rationKg);s.cities[city.id].transportAvailable+=c.carriers;c.status='returned';}
   else{s.ledger.transportCaptured+=c.carriers;city.foodKg=round(city.foodKg+c.cargoKg+c.rationKg);c.status='captured';}
   c.cargoKg=0;c.rationKg=0;continue;
  }
  const receiver=w.armies[c.targetArmyId],targetPosition=positionOnRoad(w,receiver,c.roadId);
  if(receiver.troops===0){c.status='returning';continue;}
  if(targetPosition===null||Math.abs(targetPosition-c.roadKm)>1e-5){c.status='waiting';continue;}
  const amount=Math.min(c.cargoKg,model(w,receiver.id).capacityKg-receiver.foodKg);receiver.foodKg=round(receiver.foodKg+amount);c.cargoKg=round(c.cargoKg-amount);c.status='returning';
  r.pauseReason='补给抵达';r.summaries.push(`${receiver.name}实际收到补给${round(amount)}公斤，运输队携余粮返回。`);
 }
}
function positionOnRoad(w:WorldSnapshot,a:Army,id:string):number|null {
 const m=model(w,a.id),road=w.simulation!.roads[id];if(m.roadId===id)return m.roadKm;
 if(m.atCityId===road.from)return 0;if(m.atCityId===road.to)return road.distanceKm;return null;
}
export function advanceWorld(before:WorldSnapshot,input:AdvanceCommand):{world:WorldSnapshot;report:SimulationReport}{
 validateAdvance(input);ensure(before,input.expectedRevision);const w=structuredClone(before),s=w.simulation!,r=report(w,input.commandId,'advance'),end=s.timeHours+input.hours;
 s.pauseReason=null;let iterations=0;
 while(s.timeHours<end-1e-7&&!r.pauseReason){
  assert(++iterations<2000,'推进超过内部事件上限');observe(w);enemyOrders(w,r);blockade(w);occupy(w,r);if(r.pauseReason)break;
  const occupancy:Record<string,number>={};for(const a of ordered(w)){const m=model(w,a.id);if(m.roadId)occupancy[m.roadId]=(occupancy[m.roadId]||0)+total(a,m);}
  const moves=new Map<string,number>(),contacts=new Set<string>(),arriving=new Set<string>();
  const units=ordered(w).filter(a=>a.troops>0);
  let dt=Math.min(1,end-s.timeHours);
  for(const a of units){const m=model(w,a.id);if(!m.roadId)continue;
   const road=s.roads[m.roadId],o=m.order;
   if(o?.kind==='forced-march'&&o.status==='active'&&m.fatigue>=rule(w,'forcedLimit')){hold(w,a,'急行军疲劳达到上限');r.pauseReason='急行军达到疲劳上限';break;}
   if(o?.status==='active'&&!road.open){hold(w,a,'道路中断');r.pauseReason='道路中断';break;}
   let v=speed(w,a,occupancy);const endKm=o?.targetCityId===road.from?0:road.distanceKm;
   if(units.some(b=>b.factionId!==a.factionId&&samePlace(w,a,b))&&o?.kind!=='retreat')v=0;
   if(o?.status!=='active')v=0;
   const signed=v*Math.sign(endKm-m.roadKm);moves.set(a.id,signed);
   if(v>0){const until=Math.abs(endKm-m.roadKm)/v;if(until<dt)dt=until;
    if(o?.kind==='forced-march'){const untilFatigue=(rule(w,'forcedLimit')-m.fatigue)/(rule(w,'fatigueForced')/24);if(untilFatigue>1e-7)dt=Math.min(dt,untilFatigue);}
   }
  }
  if(r.pauseReason)break;
  for(const a of units){const m=model(w,a.id),people=total(a,m);if(people){
    const foodHours=a.foodKg/(people*rule(w,'rationKg')/24);if(foodHours>1e-7)dt=Math.min(dt,foodHours);
    const waterAvailable=m.roadId?s.roads[m.roadId].waterAccessible:m.atCityId?s.cities[m.atCityId].waterAccessible:false;
    if(!waterAvailable){const waterHours=m.waterLitres/(people*rule(w,'waterLitres')/24);if(waterHours>1e-7)dt=Math.min(dt,waterHours);}
  }
  for(const e of m.effects)if(e.expiresHour-s.timeHours>1e-7)dt=Math.min(dt,e.expiresHour-s.timeHours);
  }
  for(let i=0;i<units.length;i++)for(let j=i+1;j<units.length;j++){
   const a=units[i],b=units[j];if(a.factionId===b.factionId)continue;
   const pair=[a.id,b.id].sort().join('|');if(samePlace(w,a,b)){contacts.add(pair);continue;}
   const roadId=model(w,a.id).roadId||model(w,b.id).roadId;if(!roadId)continue;
   const pa=positionOnRoad(w,a,roadId),pb=positionOnRoad(w,b,roadId);if(pa===null||pb===null)continue;
   const relative=(moves.get(a.id)||0)-(moves.get(b.id)||0);if(relative===0)continue;
   const until=(pb-pa)/relative;if(until>1e-7&&until<=dt+1e-7)dt=Math.min(dt,until);
  }
  // Bound transport crossing too, so an hourly step cannot leap through an enemy.
  for(const c of Object.values(s.shipments).filter(c=>!['captured','returned'].includes(c.status))){
   const road=s.roads[c.roadId],endKm=c.status==='returning'?(road.from===c.sourceCityId?0:road.distanceKm):c.targetKm;
   const cv=road.open&&road.waterAccessible&&c.status!=='waiting'?rule(w,'marchKmDay')/24*road.terrainFactor*road.weatherFactor*Math.sign(endKm-c.roadKm):0;
   if(cv){const until=Math.abs(endKm-c.roadKm)/Math.abs(cv);if(until>1e-7)dt=Math.min(dt,until);}
   for(const a of units.filter(a=>a.factionId!==c.factionId)){const ap=positionOnRoad(w,a,c.roadId);if(ap===null)continue;const relative=cv-(moves.get(a.id)||0);const until=relative?(ap-c.roadKm)/relative:0;if(until>1e-7&&until<=dt+1e-7)dt=Math.min(dt,until);}
  }
  if(dt<1e-7){for(const a of units){const m=model(w,a.id);if(m.roadId&&m.order?.targetCityId){const rd=s.roads[m.roadId],dest=m.order.targetCityId===rd.from?0:rd.distanceKm;if(Math.abs(dest-m.roadKm)<1e-5)arrive(w,a,r);}}if(r.pauseReason)break;assert(false,'无法推进零长度时间段');}
  consume(w,dt,r);
  // Resolve contact losses before movement using the same starting battle snapshot.
  battle(w,dt,r,contacts);
  for(const a of units){const m=model(w,a.id),v=m.order?.status==='active'?(moves.get(a.id)||0):0;if(!m.roadId||!v||!a.troops)continue;
   const road=s.roads[m.roadId];m.roadKm=round(clamp(m.roadKm+v*dt,0,road.distanceKm));
   m.fatigue=clamp(m.fatigue+(m.order?.kind==='forced-march'?rule(w,'fatigueForced'):rule(w,'fatigueMarch'))*dt/24);
   if(m.order?.actionId){a.location={kind:'route',actionId:m.order.actionId};a.status='marching';}refreshLocation(w,a);const dest=m.order?.targetCityId===road.from?0:road.distanceKm;if(Math.abs(dest-m.roadKm)<1e-5)arriving.add(a.id);
   r.traces.push({rule:'march',entityId:a.id,hours:dt,inputs:{speedKmHour:Math.abs(v),roadKm:road.distanceKm},result:{movedKm:Math.abs(v)*dt,fatigue:m.fatigue,positionKm:m.roadKm}});
  }
  s.timeHours=round(s.timeHours+dt);w.clock.elapsedDays=s.timeHours/24;
  for(const id of arriving)arrive(w,w.armies[id],r);
  shipments(w,dt,r);observe(w);blockade(w);occupy(w,r);
  for(let i=0;i<units.length;i++)for(let j=i+1;j<units.length;j++){const a=units[i],b=units[j],pair=[a.id,b.id].sort().join('|');if(a.troops&&b.troops&&a.factionId!==b.factionId&&!contacts.has(pair)&&samePlace(w,a,b)){r.pauseReason=r.pauseReason||'遭遇敌军';r.summaries.push(a.name+'与'+b.name+'发生接触，等待下一步决策。');}}
  if([...contacts].length&&units.some(a=>a.troops>0&&a.morale<rule(w,'retreatMorale')&&a.factionId===s.playerFactionId)){r.pauseReason='部队士气过低';}
  s.armies&&Object.values(s.armies).forEach(m=>{m.effects=m.effects.filter(e=>e.expiresHour>s.timeHours);});
 }
 r.advancedHours=round(s.timeHours-before.simulation!.timeHours);s.pauseReason=r.pauseReason;
 // Coalesce repetitive substep messages without losing the per-step calculation traces.
 r.summaries=[...new Set(r.summaries)].slice(0,100);
 if(!r.summaries.length)r.summaries.push(`本地规则已推进${r.advancedHours}小时。`);
 w.revision++;validateWorld(w);validateSimulation(w);return{world:w,report:r};
}
