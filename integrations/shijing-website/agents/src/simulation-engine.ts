import {createHash} from 'node:crypto';
import {assert} from './contracts.js';
import type {Action,Army,WorldSnapshot} from './world-contracts.js';
import {identifier,record,validateWorld,pruneDecisions} from './world-state.js';
import {parameter} from './simulation-profile.js';
import {validateSimulation} from './simulation-state.js';
import {accrueProvinceFood,provinceOutput} from './economy.js';
import {HISTORY_ANCHORS,anchorsBetween,anchorLine,ANCHOR_HISTORIAN_NOTE} from './anchors.js';
import {DECISION_EVENTS,NEWS_EVENTS,decisionsBetween,newsBetween,applyDecisionEffect,eventsForScenario,FLAVOR_NEWS,lookupNews,seasonalEffectOf} from './decisions.js';
import {enqueueIncoming,dropIncoming,takeDueIncoming,reportTransitDays,edictTransitDays} from './courier.js';
import {accruePoints,completeFocuses} from './focuses.js';
import {accrueTechPoints,completeTechs} from './techs.js';
import {clamp,round,interpolate,seasonalActive,type AdvanceCommand,type SimulationCommand,type SimulationReport,type ArmyModel,type Road} from './simulation-types.js';

const key=(value:string)=>createHash('sha256').update(value).digest('hex').slice(0,32);
const kinds=['march','forced-march','garrison','resupply','attack','besiege','retreat','explore'];
/** UX-010：军令类型 → 中文动词。orderText/决策簿是玩家可达字段，英文枚举不许漏进去。 */
const KIND_CN:Record<string,string>={march:'行军','forced-march':'急行军',garrison:'驻守',resupply:'补给',attack:'进攻',besiege:'围困',retreat:'撤退',explore:'探索'};
const model=(w:WorldSnapshot,id:string)=>w.simulation!.armies[id];
const rule=(w:WorldSnapshot,name:string)=>parameter(w.simulation!.profile,name);
/**
 * 围城启动要备多少日粮（预警口径用）。不是规则参数而是实测档：第 4/5 轮试玩三场围城
 * （凉州/洛阳/并州）都在 9—11 日内把守军磨空，出征预警把它算进去——否则「此行约 13 日」
 * 把满仓 12 万说成够用，实际 4+13+10 日 > 携粮上限，玩家到城下必 0 粮溃退。
 * 单独一个常量而不进 profile：加参数会让没有该键的旧存档直接校验失败。
 */
export const SIEGE_STARTUP_DAYS=10;
/** 满仓出口（第 5 轮，纯文案档）：城粮超过这条线，史官提一句「仓廪充盈，可粜粮济民」。
 *  取 20 万公斤——满编军团携粮上限是 12 万，超过这条线的存粮没有任何出兵能一次带走。
 *  事件卡机制（粜粮换朝望/民望）留档下轮。 */
const FOOD_SURPLUS_KG=200000;
/** 季节传闻挂钩（第 5 轮）：军中时疫期间行军士气日衰刻度（分/日）。 */
const EPIDEMIC_MORALE_DAY=1.5;
/** 季节传闻挂钩（第 5 轮）：夏潦 30 日内，山道（子午/剑阁）天气修正 ×0.7——行军与运输
 *  同权，否则传闻只是会动的墙纸。 */
const FLOOD_SLOW_ROADS=['road-ziwu','road-jiange'];
const FLOOD_FACTOR=.7;
/** 这路的当前天气修正：夏潦传闻期内山路慢三成（travelDays/speed/预警/运输同一口径）。 */
function weatherOf(w:WorldSnapshot,road:Road):number{
 return FLOOD_SLOW_ROADS.includes(road.id)&&seasonalActive(w.simulation,'seasonal-flood')?road.weatherFactor*FLOOD_FACTOR:road.weatherFactor;
}
/** 一省治所城池的日产出（公斤）。取不到省或产出为 0 时返回 0。 */
function provinceDailyFood(w:WorldSnapshot,cityId:string):number{
 const p=Object.values(w.provinces||{}).find(x=>x.seatCityId===cityId);
 if(!p)return 0;
 try{return provinceOutput(w,p).day.food;}catch{return 0;}
}
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
 assert(typeof raw.hours==='number'&&Number.isSafeInteger(raw.hours)&&raw.hours>=1&&raw.hours<=2160,'每次推进1—2160小时（90天）');
}
function worldPoint(w:WorldSnapshot,m:ArmyModel){if(m.roadId){const r=w.simulation!.roads[m.roadId];return interpolate(w.cities[r.from].point,w.cities[r.to].point,m.roadKm/r.distanceKm);}assert(m.atCityId,'军队没有可用位置');return w.cities[m.atCityId].point;}
/**
 * 这条路走起来是不是零长度：部队一步没走，而目标正是脚下这条路的出发城。
 * 出现这种情形不是玩家下错令，而是**诏令在途**——令还没到军中，队伍却已经「上了路」，
 * 此时一张指回出发城的撤退令会让路线首尾同点，被 validateWorld 整单拒掉。
 */
function degenerateRoute(w:WorldSnapshot,m:ArmyModel,road:Road,target:string):boolean{
 if(!m.roadId||m.roadKm>1e-9)return false;
 const at=road.from;
 if(target!==at)return false;
 const from=w.cities[at],to=w.cities[target];
 return !!from&&!!to&&Math.abs(from.point.x-to.point.x)<1e-9&&Math.abs(from.point.y-to.point.y)<1e-9;
}
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
/** 走完一条路要几天：速度由基础路速 × 地形 × 天气决定，负重与疲劳另算。 */
function travelDays(w:WorldSnapshot,road:Road):number{
 return road.distanceKm/(rule(w,'marchKmDay')*road.terrainFactor*weatherOf(w,road));
}
function roadFor(w:WorldSnapshot,m:ArmyModel,target:string):Road|undefined {
 const roads=w.simulation!.roads;
 if(m.roadId){const r=roads[m.roadId];return r.from===target||r.to===target?r:undefined;}
 // 同一对城之间可能有多条路（辟通崤函道后，长安↔洛阳就有官道与便道两条）：取走得最快的
 // 一条，而不是对象键序里的第一条。键序无关紧要，选错会把 6km 的便道换成 200km 的大道，
 // 于是「粮够走完这段路」的判定跟着失真。
 const candidates=Object.values(roads).filter(r=>(r.from===m.atCityId&&r.to===target)||(r.to===m.atCityId&&r.from===target));
 return candidates.reduce<Road|undefined>((best,r)=>!best||travelDays(w,r)<travelDays(w,best)?r:best,undefined);
}
function installOrder(w:WorldSnapshot,input:SimulationCommand,r:SimulationReport,automatic=false){
 const s=w.simulation!,a=w.armies[input.armyId];assert(a&&s.activeArmyIds.includes(a.id),'军队不在首版战役范围内');const m=model(w,a.id);
 // 出征粮草预警：粮不够走完这段路就明说。别让玩家第 3 天在路上断粮、然后自动撤退
 // 20 天沿途饿死（试玩实测：13473 粮出征 200km，全程需 5.3 万，零预警）。
 // 只提示、不拦截——玩家可能就是要奔袭，或打算路上另想办法，那是他的决断。
 if(!automatic&&['march','forced-march','attack','besiege'].includes(input.kind)&&input.targetCityId&&input.targetCityId!==m.atCityId){
  // BUG-117：现携粮为零的行军/进攻是必死之行——路上没有任何补给点（属地输粮只喂城里
  // 与围城的部队），0.25 倍速加逐小时逃散，走到哪饿到哪。此前只打「粮草不足」警告照单
  // 全收，实测携 0 公斤照样 202。升级为拒绝：在途补给队追得上部队，故有在途补给时仍
  // 放行——那是「粮在路上」，不是「粮秣全无」。撤退不在其列：败军归巢天经地义。
  const replenishing=Object.values(s.shipments).some(c=>c.targetArmyId===a.id&&!['returned','captured'].includes(c.status));
  if(a.foodKg<=0&&!replenishing)assert(false,`${a.name}粮秣全无，此行必溃；先补给或改道`,409);
  const road=roadFor(w,m,input.targetCityId);
  if(road&&road.open){
   // 出征粮草预警：粮不够走完这段路就明说。别让玩家第 3 天在路上断粮、然后自动撤退
   // 20 天沿途饿死（试玩实测：13473 粮出征 200km，全程需 5.3 万，零预警）。
   // 只提示、不拦截——玩家可能就是要奔袭，或打算路上另想办法，那是他的决断。
   // 第 5 轮卡点1：天数要算**全口径**——下诏驿传＋行军＋围城启动。旧版只算行军，于是
   // 「此行约 13 日、需粮约 76800」把满仓 12 万说成够用；实际 4+13+10 日 > 携粮上限，
   // 到城下必 0 粮溃退（实测死局）。缺口超过携粮上限时明说须以在途补给接应。
   const edictDays=edictTransitDays(w,a.id,input.targetCityId);
   const trip=road.distanceKm/(rule(w,'marchKmDay')*road.terrainFactor*weatherOf(w,road));
   const days=edictDays+trip+SIEGE_STARTUP_DAYS,need=total(a,m)*rule(w,'rationKg')*days;
   if(a.foodKg<need)r.summaries.push(`粮草不足：此行下诏 ${edictDays} 日、行军 ${Math.round(trip)} 日、围城 ${SIEGE_STARTUP_DAYS} 日，共约 ${Math.round(days)} 日，需粮约 ${Math.round(need)} 公斤，现携 ${Math.round(a.foodKg)} 公斤，途中恐断粮${need>m.capacityKg?`；携粮上限 ${m.capacityKg} 公斤，途中需粮 ${Math.round(need)} 公斤，此令需在途补给接应（如「粮草送到${a.name}军中」）`:''}。`);
  }
 }
 assert(automatic||a.factionId===s.playerFactionId,'只能指挥己方军队',403);assert(a.troops>0,'该军队已失去战斗能力');
 // 补粮提前返回，但 automatic 必须透传给 supply：补给令也是决策，AI 代决的补给要记
 // ai-marshal 而不是 player，否则史官流水两处口径不一致（summary 写【已行】太尉、
 // decision 却标玩家拍板）。这里漏传是「AI 代决被记成玩家」的最后一处漏点。
 if(input.kind==='resupply'){supply(w,input,r,automatic);return;}
 // BUG-121：探索/细作——玩家主动派侦察，在目标城落一条情报条目（城市归属+守军规模）；
 // 军队原地不动，无移动、无粮耗、不造 Action。后续推进 30 日若未再探则被 fogReport 判 stale。
 if(input.kind==='explore'){
  const target=input.targetCityId;
  assert(target&&!!w.cities[target],'探索需要明确目标城池');
  const city=w.cities[target];
  // 替换同目标旧情报：细作回报会刷新，不累积重复条目。
  s.intelligence=s.intelligence.filter(i=>!(i.observerFactionId===a.factionId&&i.atCityId===target));
  s.intelligence.push({observerFactionId:a.factionId,enemyArmyId:'explore-'+target,seenHour:s.timeHours,atCityId:target,roadId:null,roadKm:0,estimatedTroops:Object.values(w.armies).filter(b=>b.location.kind==='city'&&b.location.cityId===target&&b.factionId!==a.factionId).reduce((n,b)=>n+b.troops,0)});
  const id='decision-'+key(input.commandId);
  w.decisions[id]={id,title:`${a.name}：探索${city.name}`,orderText:`${a.name}遣细作探查${city.name}${city.ownerFactionId===a.factionId?'（己方城池，情报有限）':'，预计获悉守军规模与城防状态'}`,issuedDay:w.clock.elapsedDays,issuerId:automatic?'ai-marshal':'player',status:'executing',related:[{type:'army',id:a.id},{type:'city',id:target}]};
  r.summaries.push(w.decisions[id].orderText+'；命令已记录。');
  return;
 }
 const target=input.targetCityId;
 if(input.kind==='garrison')assert(!m.roadId,'在道路上需先完成移动或撤回据点，再休整');
 else assert(target&&!!w.cities[target],'需要有效的目标城池');
 // BUG-103：行军/急行军/进攻/围困到**脚下这座城**是空令——此前照单全收，落一条
 // 「行军汉中，命令已记录」的决策只给决策簿添噪声（与撤退本城的既有拒绝同一语义）。
 // 只拦「驻在城里」的：城外扎营（location=field、atCityId=城）时进攻/围困这座城是正当
 // 的攻城，绝不能拦（province.test 的既有用例就是这么打的）。代决层不动。
 if(!automatic&&a.location.kind==='city'&&target&&a.location.cityId===target&&['march','forced-march','attack','besiege'].includes(input.kind))
  assert(false,`${a.name}已驻${w.cities[target].name}，${input.kind==='attack'||input.kind==='besiege'?'无从进攻本城':'无需行军'}；要休整请下驻守令`);
 // UX-109：驻在城里、位置记账却在**城外**（location=field、atCityId=本城，溃退驻扎后常见）
 // 的部队，行军回本城同样是一步不走的空令——此前漏到这里，最后撞上路线层「行动路线不能
 // 为零长度」的技术报错。只拦行军：城外扎营时进攻/围困脚下这座城是正当的攻城，不能误伤。
 if(!automatic&&target&&m.atCityId===target&&['march','forced-march'].includes(input.kind))
  assert(false,`${a.name}已驻${w.cities[target].name}，无需行军；要休整请下驻守令`);
 if(input.kind==='forced-march')assert(m.fatigue<rule(w,'forcedLimit'),'疲劳过高，不能急行军');
 const road=target&&target!==m.atCityId?roadFor(w,m,target):undefined;
 if(target!==m.atCityId&&input.kind!=='garrison')assert(road?.open,'没有已配置且可通行的路线');
 if(input.kind==='retreat'){assert(target&&w.cities[target].ownerFactionId===a.factionId,'撤退终点必须是己方据点');
  // 原地撤退是空令：部队已经在这座城里，落一条「撤退汉中」的决策只是给决策簿添噪声。
  // 要驻守就明确下 garrison——那是另一条语义（休整、恢复士气），不能同名混过去。
  assert(target!==m.atCityId,'部队已在该城，无需撤退；要休整请下驻守令');}
 if(['attack','besiege'].includes(input.kind))assert(target&&w.cities[target].ownerFactionId!==a.factionId,'进攻目标必须是敌方城池');
 for(const e of input.effects||[]){assert(road&&road.id===e.roadId&&m.knownRoads.includes(e.roadId),'部队档案未登记熟悉该路段');assert(e.factor<=rule(w,'navigationMax'),'导航加成超过规则上限');assert(!m.effects.some(x=>x.expiresHour>s.timeHours),'已有同组效果生效，不能重复叠加');}
 if(m.order?.status==='active'){
  const old=m.order;if(old.actionId){w.actions[old.actionId].status='cancelled';w.actions[old.actionId].endedDay=w.clock.elapsedDays;}
  if(w.decisions[old.id])w.decisions[old.id].status='cancelled';
 }
 const id='decision-'+key(input.commandId),actionId='action-'+key(input.commandId);
 m.order={id,kind:input.kind,targetCityId:target,roadId:road?.id,sinceHour:s.timeHours,status:'active'};
 w.decisions[id]={id,title:input.kind==='garrison'?'驻守休整':`${a.name}：${KIND_CN[input.kind]}${w.cities[target!]?.name||''}`,orderText:automatic?'本地守军根据已获情报调整行动':`${a.name}执行${KIND_CN[input.kind]}${target?'，目标'+w.cities[target].name:''}`,issuedDay:w.clock.elapsedDays,issuerId:automatic?'local-defender':'player',status:'executing',related:[{type:'army',id:a.id},...(target?[{type:'city' as const,id:target}]:[])]};
 if(road&&target&&!degenerateRoute(w,m,road,target)){
  const startPoint=worldPoint(w,m),originCity=m.atCityId;
  if(Math.abs(startPoint.x-w.cities[target].point.x)<1e-8&&Math.abs(startPoint.y-w.cities[target].point.y)<1e-8){
   // UX-109：部队真实位置已在目标城上（极端账面态），照造行动就是零长度路线，会被
   // validateWorld 整单拒掉（「行动路线不能为零长度」）。与 degenerateRoute 同法：回城下桩。
   m.roadId=null;m.roadKm=0;m.atCityId=target;a.location={kind:'city',cityId:target};a.status='resting';
  }else{
  m.roadKm=m.roadId?m.roadKm:road.from===m.atCityId?0:road.distanceKm;m.roadId=road.id;m.atCityId=null;
  const action:Action={id:actionId,decisionId:id,armyId:a.id,kind:input.kind==='forced-march'?'march':input.kind==='besiege'?'attack':input.kind as Action['kind'],origin:{cityId:originCity,point:startPoint,label:originCity?w.cities[originCity].name:'途中'},target:{cityId:target,point:w.cities[target].point,label:w.cities[target].name},route:[startPoint,w.cities[target].point],status:'active',startedDay:w.clock.elapsedDays,estimatedArrivalDay:null,endedDay:null,progress:0};
  w.actions[actionId]=action;m.order.actionId=actionId;a.location={kind:'route',actionId};a.status='marching';w.decisions[id].related.push({type:'action',id:actionId});
  }
 }else if(road&&target&&degenerateRoute(w,m,road,target)){
  // 队伍上了路却一步没走（诏令在途时常如此），新令又指回这条路的出发城：
  // 造出来的路线首尾同点，validateWorld 会直接拒。让它回城下桩——队伍本就没离开过。
  m.roadId=null;m.roadKm=0;m.atCityId=target;a.location={kind:'city',cityId:target};a.status='resting';
 }else{a.status=m.atCityId&&w.cities[m.atCityId].ownerFactionId===a.factionId?'resting':input.kind==='besiege'?'besieging':'resting';}
 for(const e of input.effects||[])m.effects.push({id:e.id,parameter:'navigation',factor:e.factor,roadId:e.roadId,expiresHour:s.timeHours+e.durationHours,group:'navigation'});
 // 汇报只给玩家自己下的令：AI 自动补粮（本函数下方 273 行起）与 auto-hold 的例行驻守
 // 都不进起居注——敌方守军每天被喂一遍粮、每天重新「驻守休整」一次，写出来就是同一行
 // 刷一百遍，把玩家自己的断粮/交战信息全盖掉（QA 实测的噪声）。账照记（决策簿与台账
 // 都要能查「这道令是谁下的」），只是不给玩家看。
 if(!automatic)r.summaries.push(w.decisions[id].title+'，命令已记录；尚未推进时间。');
}
/**
 * 第 5 轮卡点1：驻地能送到粮的那条路。在路上 = 脚下这条路；围在敌城下/驻在城里 =
 * 通到该城的一条开放路。运输队只能沿一条路走（shipment 模型所限），所以在途/围城
 * 部队只有这条路两端的城送得到粮。
 */
function supplyRoad(w:WorldSnapshot,m:ArmyModel):Road|undefined{
 if(m.roadId)return w.simulation!.roads[m.roadId];
 if(!m.atCityId)return undefined;
 return Object.values(w.simulation!.roads).find(r=>r.open&&(r.from===m.atCityId||r.to===m.atCityId));
}
/**
 * 补给。`automatic` 表示这不是玩家下的令，而是 AI（太尉）或本地守军的代决——记进
 * decisions 时 issuerId 必须如实反映，否则史官会出现「summary 写【已行】太尉、change log
 * 却标（玩家拍板）」两处口径不一致，玩家会以为自己下过这道令。
 */
function supply(w:WorldSnapshot,input:SimulationCommand,r:SimulationReport,automatic=false){
 const s=w.simulation!,a=w.armies[input.armyId],m=model(w,a.id);
 let source=input.sourceCityId||m.atCityId;
 assert(source&&w.cities[source]?.ownerFactionId===a.factionId,'补给必须从己方库存发出');
 let detour='';
 if(m.atCityId!==source){
  // 在途/围城部队的粮道：发粮城不在这条路上时（最常见：按库存缺省选到不在路上的成都），
  // 从前一律 409「没有可执行的运输路线」——实测满仓 12 万公斤躺着、在途部队饿死。改为
  // 就近改道：从这条路己方一端有库存的城发出，回执写明；真的无可改之路才拒绝。
  const road=m.roadId?s.roads[m.roadId]:roadFor(w,m,source);
  if(!(road?.open&&(road.from===source||road.to===source))){
   const det=supplyRoad(w,m);
   const alt=det?[det.from,det.to].filter(id=>id!==source&&w.cities[id]?.ownerFactionId===a.factionId&&w.cities[id].foodKg>0)
    .sort((x,y)=>w.cities[y].foodKg-w.cities[x].foodKg)[0]:undefined;
   if(alt){detour=`（${w.cities[source].name}道远不通，改自${w.cities[alt].name}发出）`;source=alt;}
  }
 }
 const city=w.cities[source],room=Math.max(0,m.capacityKg-a.foodKg),asked=input.foodKg??Math.min(city.foodKg,room);
 // 满仓出口（BUG-119，第 6 轮补）：当 room=0 且 instant=true（军已驻源城），
 // 不再 409 硬拒——接受补给令并落决策簿，等路上消耗腾出余量后自动交付。
 // 非 instant（在途/围城）仍保留 409：运输队必须能载货，room=0 的在途补给没意义。
 const instant=m.atCityId===source;
 const requested=Math.max(0,Math.min(asked,city.foodKg,...(instant?[room]:[]))),shownKg=Math.round(requested);
 if(requested<=0){
  if(instant&&room<=0){
   r.summaries.push(`${a.name}已携满 ${Math.round(a.foodKg)} 公斤（上限 ${m.capacityKg} 公斤），补给令已记录；待途中消耗后自动接拨。`);
   const id='decision-'+key(input.commandId);
   w.decisions[id]={id,title:'调拨补给（待兑现）',orderText:`${a.name} 补给 ${city.name} ${Math.round(asked)} 公斤（待兑现）`,issuedDay:w.clock.elapsedDays,issuerId:automatic?'ai-marshal':'player',status:'issued',related:[{type:'army',id:a.id},{type:'city',id:source}]};
   return;
  }
  assert(false,`${city.name}仓中无一粮可拨`,409);
 }
 const binder=instant&&asked>room+.5?'携粮余量':'库存余量';
 const clampNote=asked>requested+.5?`（原拨 ${Math.round(asked)}，${binder}所限，实拨 ${shownKg}）`:'';
 // BUG-111：文案里的公斤数四舍五入取整——账（foodKg/账本）仍用精确值，玩家可见文本
 // 不许出现「3355.6701295499997公斤」这类浮点（decisions[].command 与 messages 同管道）。
 let note='';
 if(m.atCityId===source){
  city.foodKg=round(city.foodKg-requested);a.foodKg=round(a.foodKg+requested);
  note=`${city.name}向${a.name}调拨${shownKg}公斤粮草${clampNote}。${detour}`;
 }else{
  assert(!Object.values(s.shipments).some(c=>c.targetArmyId===a.id&&!['returned','captured'].includes(c.status)),'该部队已有在途补给');
  // 运输队沿路截击交付：在路上时走**同一条路**、按 roadKm 相遇点结算（start=端点城、
  // target=军队当前位置）， shipment 既有的 chasing/waiting 追及逻辑原样复用——0.25 倍速
  // 溃退的部队（见 speed()）正常速度的运输队也追得上。
  const road=m.roadId?s.roads[m.roadId]:roadFor(w,m,source);
  assert(road?.open&&(road.from===source||road.to===source),'没有可执行的运输路线');
  const start=road.from===source?0:road.distanceKm,target=m.roadId?m.roadKm:road.from===m.atCityId?0:road.distanceKm;
  const days=Math.abs(target-start)/(rule(w,'marchKmDay')*road.terrainFactor*weatherOf(w,road));
  const rationPerCarrier=rule(w,'rationKg')*(days*2+2),cargoPerCarrier=rule(w,'carrierKg')-rationPerCarrier;
  assert(cargoPerCarrier>0,'运输队往返口粮超过载重；需中继仓或其他运输方式');
  const carriers=Math.ceil(requested/cargoPerCarrier),ration=round(carriers*rationPerCarrier);
  assert(carriers<=s.cities[source].transportAvailable,'运输人员不足');assert(requested+ration<=city.foodKg,'库存不足以支付货物及运输队往返口粮');
  city.foodKg=round(city.foodKg-requested-ration);s.cities[source].transportAvailable-=carriers;
  const id='shipment-'+key(input.commandId);s.shipments[id]={id,sourceCityId:source,targetArmyId:a.id,factionId:a.factionId,roadId:road.id,roadKm:start,targetKm:target,carriers,cargoKg:requested,rationKg:ration,waterAccessible:road.waterAccessible,status:'travelling',createdHour:s.timeHours};
  note=`补给已发出：货物${shownKg}公斤，运输人员${carriers}人；前线尚未收到。${clampNote}${detour}`;
 }
 // AI 阵营的例行补粮不进起居注：敌方守军每天被后方喂一遍，写出来就是同一行刷一百遍，
 // 把玩家自己的断粮/交战信息全盖掉。账照记（决策簿与台账都要能查），只是不给玩家看。
 if(!automatic)r.summaries.push(note);
 // 补粮也是决策，玩家与 AI 代决都要留痕——史官要能查「这道补给令是谁下的」。
 // AI 代决记 ai-marshal（不是 local-defender：那是本地守军的自动行为，AI 大臣代决是另一回事）。
 // 两条都会被 pruneDecisions 淘汰（例行后勤不占决策簿）：否则几百个游戏日的例行补给会把
 // 簿子撑到 500 硬顶，「决策数量超过500」此后拒绝一切军令——实测 10 年挂机局永久冻结。
 // 玩家的**非例行**决策（进军/围城/撤军）一条不淘汰，他们要在策略库里回看自己的决断；
 // 被淘汰的例行补给也打得开，strategyMap 会改读 world_strategy_snapshots 里的结束态。
 const id='decision-'+key(input.commandId);
 w.decisions[id]={id,title:'调拨补给',orderText:note,issuedDay:w.clock.elapsedDays,
  issuerId:automatic?'ai-marshal':'player',status:'completed',
  related:[{type:'army',id:a.id},{type:'city',id:source}]};
}
/**
 * 下达军令。`automatic` 表示这是 AI 大臣代决（commander-runtime 走这条），此时 decision 的
 * issuerId 必须是 AI 而不是 player——否则史官流水里会同时出现「summary 写【已行】太尉」
 * 和「（玩家拍板）」，两处口径不一致，玩家会以为自己下过这道令。
 */
export function issueOrder(before:WorldSnapshot,input:SimulationCommand,automatic=false):{world:WorldSnapshot;report:SimulationReport}{
 validateOrder(input);ensure(before,input.expectedRevision);const w=structuredClone(before),r=report(w,input.commandId,'order');
 installOrder(w,input,r,automatic);
 w.simulation!.pauseReason=null;w.revision++;validateWorld(w);return{world:w,report:r};
}
function samePlace(w:WorldSnapshot,a:Army,b:Army){const x=model(w,a.id),y=model(w,b.id);return x.atCityId!==null&&x.atCityId===y.atCityId||x.roadId!==null&&x.roadId===y.roadId&&Math.abs(x.roadKm-y.roadKm)<1e-5;}
/**
 * 观测与例行后勤。`stepHours` 是本次小时步时长，用于在本步内结算省产。
 *
 * 为什么必须在小时步里结、不能只在跳转末尾结一次：末尾按「实推进天数」一次性入池，
 * 小时步里城池库存只减不增——驻地城被抽干后，同阵营其它城的池子也空着，补粮无处可取，
 * 玩家军会在后方躺着几千万斤粮的同时被饿死（实测 10 年挂机局 ~第117天 5000 人溃散殆尽）。
 * 逐小时结一点，库存才跟得上消耗。守恒不会破：accrueProvinceFood 同步加 initialFoodKg，
 * 实测 200 天累计偏差 1.6e-5，远小于 0.001 容差。
 */
function observe(w:WorldSnapshot,stepHours=0,r?:SimulationReport){
 const s=w.simulation!;
 // 省产按「整天」结，不在小时步里结。两个原因：
 //  ① 守恒：accrueProvinceFood 每次把 gain 四舍五入到 1e-8，同时加 initialFoodKg。
 //     小时步长常是 0.14 这类小数，连乘之后单次 gain 极小、舍入占比高——3650 日 ≈ 3 万步
 //     累加下来，实测会把 validateSimulation 的 0.001 容差撑爆（「粮草收支不守恒」）。
 //     按整天结把步数压掉 24 倍，量级差距下舍入误差可忽略。
 //  ② 语义：古代本来就按年/月计赋，没有「按钟头产粮」的道理。
 const stepDays=Math.floor(s.timeHours/24)-Math.floor((s.timeHours-stepHours)/24);
 if(stepDays>0&&w.provinces)for(const id of Object.keys(w.provinces)){
  // 满仓出口（第 5 轮，纯文案档）：城粮从阈值下方涨过阈值时史官提一句。只在**上穿**
  // 那一刻说：按判定线日日念叨会把起居注刷满，而数字疯涨无人管的观感问题，一句就够。
  // 事件卡机制（粜粮换朝望/民望）留档下轮。
  const seat=w.cities[w.provinces[id].seatCityId],before=seat?.foodKg??0;
  accrueProvinceFood(w,id,stepDays);
  if(seat&&before<=FOOD_SURPLUS_KG&&seat.foodKg>FOOD_SURPLUS_KG)
   r?.summaries.push(`${seat.name}仓廪充盈，存粮已逾 ${Math.round(FOOD_SURPLUS_KG/10000)} 万公斤，可粜粮济民。`);
 }
 // 驻地部队的后方输粮：玩家阵营的军队驻在己方城池、粮不足三日时，自动补到三日量。
 // 为什么玩家军队也补、且不需要 mandate：「军政危局是不待旨的常例」——断粮是生存问题不是
 // 战略选择，等玩家自己发现时部队已经饿死了。而且不补的话「后方有粮就不暂停」这条规则会让
 // 部队无限饿着（暂停不响、粮也不来），玩家看到的是一支慢慢死掉的军队和永无变化的数字。
  // 补粮顺序：① 驻地城（即时调拨，不需要路线）；② **同阵营任意城池直调**。
  // 为什么需要②：驻地城日产出低，抽几次就见底（实测汉中第 8 天见底），而囤粮的省会在另一座城。
  // 且本舆图只有汉中↔长安一条路，成都→汉中走不了在途运输——若不支持直调，玩家军队会在
  // 后方躺着几千万斤粮的同时被 silent 饿死（实测 10 年挂机 ~第117天 5000 人溃散殆尽，
  // 全程无暂停、无事件、无提示）。史实正是「从成都转输汉中」，车道不通不等于转运不存在。
  const feed:SimulationReport={commandId:'observe-feed',kind:'advance',advancedHours:0,pauseReason:null,
  rulesVersion:s.profile.id+':'+s.profile.version,traces:[],summaries:[]};
 // 只喂**玩家阵营**：AI 阵营的后勤由 enemyOrders 自己管（那边也会 auto-supply），
 // 这里再喂一遍会把该被围困饿死的守军也救活——「长安守军饿到投降」是本剧本
 // 唯一的夺城路径（玩家 siegePower=0），救活它就一局打不通了。
 for(const a of ordered(w)){
  const m=model(w,a.id);
  if(!a.troops||!m.atCityId||a.factionId!==s.playerFactionId)continue;
  const here=w.cities[m.atCityId];
  // 围城中的部队也吃后方的粮。只喂「驻在己方城里」的部队时，围城部队一断粮就自行撤退，
  // 守军随即脱离围困重新自动补粮、士气回满——长安永远打不下来（实测：守军粮 6486↜8322
  // 反复回涨，围城 200 天纹丝不动）。攻城的粮道从后方来，被切断的是守军的粮道，
  // 这条不对称才让「围城断粮」这一机制成立。
  const besieging=here.ownerFactionId!==a.factionId&&m.order?.status==='active'&&['attack','besiege'].includes(m.order.kind);
  if(!here||(here.ownerFactionId!==a.factionId&&!besieging))continue;
  const people=total(a,m);
  // 低于三日口粮就补到三日量。不要只补一日：判定线若是「一日量」，部队粮会停在略高于一日
  // 的位置然后每天净减口粮，几天后见底（实测 d10 起粮停在 10683 一字不变、d15 归零）。
  // 补到三日量则始终留两天余量， hour 步之间不会掉到断粮线。
  if(people<=0||a.foodKg>=people*rule(w,'rationKg')*3)continue;
  const want=people*rule(w,'rationKg')*3-a.foodKg;
  if(want<=0)continue;
  // 源粮仓：驻地城优先；其次同阵营库存最多的城。两样都没有才真的没粮。
  // 允许「预支省产」：城池库存是省产的蓄水池，而省产只在跳转末尾一次性入池——
  // 小时步里看池子是空的，但田里正在长。预支的口子按省日产给（不超过三日所需），
  // 账上仍从池子扣；池子扣成负数也不破坏守恒（收支式算的是现量与初始量的差）。
  // 源粮仓：驻地城优先；否则同阵营库存最多的城。小时步已按步长结过省产（见顶部注释），
  // 所以「有库存」是常态；真的全军覆没都没粮时才不补——那正是要玩家决断的绝境。
  const own=Object.values(w.cities).filter(c=>c.ownerFactionId===a.factionId&&c.foodKg>0);
  if(!own.length)continue;
  // 围城部队只能吃后方的粮：拿被围城池的库存喂围城军，等于替守军开仓，「围城断粮」
  // 的机制直接作废。驻地是己方城池时才就地取粮。
  const source=here.ownerFactionId===a.factionId&&here.foodKg>0?here:own.sort((x,y)=>y.foodKg-x.foodKg)[0];
  if(!source)continue;
  const amount=Math.min(source.foodKg,want);
  if(amount<=0)continue;
  // 一律走「划拨」：城里减、部队加，不走 shipment、不要求路线（本舆图只有汉中↔长安一条路，
  // 成都→汉中没有在途路线，但转运在史实里成立）。同城也不调 supply：它走即时调拨分支
  // 时要求库存 > 0，而预支时库存恰好是 0，会被「库存不足」拒掉。
  source.foodKg=round(source.foodKg-amount);a.foodKg=round(a.foodKg+amount);
  feed.summaries.push(`${source.name}向${a.name}转输粮草${amount}公斤。`);
 }
 for(const a of ordered(w))for(const b of ordered(w))if(a.troops&&b.troops&&a.factionId!==b.factionId&&samePlace(w,a,b)){
  const m=model(w,b.id);s.intelligence=s.intelligence.filter(i=>!(i.observerFactionId===a.factionId&&i.enemyArmyId===b.id));
  s.intelligence.push({observerFactionId:a.factionId,enemyArmyId:b.id,seenHour:s.timeHours,atCityId:m.atCityId,roadId:m.roadId,roadKm:m.roadKm,estimatedTroops:Math.max(100,Math.round(b.troops/500)*500)});
 }
}
/**
 * 溃退去处的查找：从当前位置出发、沿一条**已开启**且另一端是己方城池的路退回去。
 * 原是 enemyOrders 粮尽规则的内联段，BUG-116 的士气崩溃解围也要用同一套口径，故抽成函数。
 * 坑：road 的 from/to 是城市 id，`id` 才是路 id。曾经写 `x.from===m.roadId`（拿城市 id
 * 和路 id 比），恒不相等 → back 永远是 null → 这条规则形同不存在。
 * 实测：路上粮尽气衰的部队跑了 40 天掉 1900 人也没退出撤退。
 */
function retreatCity(w:WorldSnapshot,a:Army,m:ArmyModel):string|null{
 const s=w.simulation!;
 for(const x of Object.values(s.roads)){
  if(!x.open)continue;
  const startsHere=m.roadId?x.id===m.roadId:(m.atCityId!==null&&(x.from===m.atCityId||x.to===m.atCityId));
  if(!startsHere)continue;
  // 两端都试。曾经写成 `roadId ? x.to : x.from`——在路上的军队永远只看路的一端，
  // 而汉中↔长安的 to 端是敌城、from 端才是家：于是路上的饥军永远找不到退路，
  // 只能以 1.9km/日无限爬行掉人（实测 26 天 5000→4347）。
  const candidates=m.roadId?[x.to,x.from]:(x.from===m.atCityId?[x.to]:[x.from]);
  const home=candidates.find(id=>id&&w.cities[id]?.ownerFactionId===a.factionId);
  if(home)return home;
 }
 return null;
}
function enemyOrders(w:WorldSnapshot,r:SimulationReport){
 const s=w.simulation!;
 // 玩家军队的「溃师自退」。敌军那边的对称规则早就有了（士气低 + 有威胁 → 撤回安全城），
 // 玩家军队却什么都没有：孤军深入粮尽气衰之后，「部队士气过低」会每个跳转都触发，
 // 一局永远推进不了（实测奇袭流卡在第 82 天，2473 人粮 0 士气 0，连跳 8 次 zero 进展）。
 // 军事常识是溃师不战——自动撤回最近的有路可通的己方城池，让玩家有重整的机会。
 for(const a of ordered(w).filter(a=>a.factionId===s.playerFactionId&&a.troops>0)){
  const m=model(w,a.id);
  if(m.order?.kind==='retreat')continue;               // 已经在退了就别翻来覆去
  if(a.morale>=rule(w,'retreatMorale')||a.foodKg>0)continue;
  // 只对**不在己方城里**的部队生效：驻守己城的部队有属地输粮兜底，用不着逃。
  if(m.atCityId&&w.cities[m.atCityId]?.ownerFactionId===a.factionId)continue;
  // 撤离目标用统一的 retreatCity 查找（含上面两条历史坑的防御）。
  const back=retreatCity(w,a,m);
  if(!back)continue;
  installOrder(w,{commandId:`player-withdraw-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'retreat',targetCityId:back},r,true);
  r.summaries.push(`${a.name}粮尽气衰，自行退往${w.cities[back].name}。`);
 }
 for(const a of ordered(w).filter(a=>a.factionId!==s.playerFactionId&&a.troops>0)){
  const m=model(w,a.id),hostile=s.intelligence.filter(i=>i.observerFactionId===a.factionId&&s.timeHours-i.seenHour<=rule(w,'intelHours'));
  const threat=hostile.find(i=>i.atCityId&&i.atCityId===m.atCityId);
  if(a.morale<rule(w,'retreatMorale')&&threat){
   const safe=Object.values(s.roads).find(x=>x.open&&(x.from===m.atCityId&&w.cities[x.to].ownerFactionId===a.factionId||x.to===m.atCityId&&w.cities[x.from].ownerFactionId===a.factionId));
   // 走得动才准退。粮不够走完这段路时，退军只会卡在城门口零公里处与玩家对峙：
   // 行军被「接触」按死、补给又够不着前方，每步都触发「遭遇敌军」暂停，而玩家没有任何
   // 一条军令能解这个接触（军令只打城池）——整局锁死。实测辟通崤函道后长安守军
   // 粮尽仍奉命退洛阳，卡在道口 2469 人饿到天亮，北伐线就此断在半路。
   const tripDays=safe?Math.abs(safe.distanceKm)/(rule(w,'marchKmDay')*safe.terrainFactor*weatherOf(w,safe)):0;
   const canWalk=!!safe&&a.foodKg>=total(a,m)*rule(w,'rationKg')*tripDays;
   if(safe&&canWalk&&m.order?.kind!=='retreat')installOrder(w,{commandId:`auto-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'retreat',targetCityId:safe.from===m.atCityId?safe.to:safe.from},r,true);
   else if(!safe||!canWalk){if(a.morale<=10)surrender(w,a,r);}
   continue;
  }
  if(m.roadId&&m.order?.status!=='active'){const road=s.roads[m.roadId],home=[road.from,road.to].find(id=>w.cities[id].ownerFactionId===a.factionId);if(road.open&&home)installOrder(w,{commandId:`auto-return-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'retreat',targetCityId:home},r,true);continue;}
  if(m.order?.status==='active'&&s.timeHours-m.order.sinceHour<rule(w,'minimumOrderHours'))continue;
  // 被围困的守军不自动补粮。围困的意义就是切断补给；这里若照补，守军永远饿不死，
  // 而玩家 siegePower=0（无攻城器械）打不动城防——本剧本一座城都夺不下来，一局必然
  // 打不通（实测围城 3000 天长安纹丝不动）。断粮→士气崩→投降，是玩家唯一夺城路径。
  const besieged=m.atCityId?ordered(w).some(b=>b.troops>0&&b.factionId===s.playerFactionId
   &&model(w,b.id).atCityId===m.atCityId&&['attack','besiege'].includes(model(w,b.id).order?.kind||'')):false;
  if(!besieged)autoSupply(w,a,m,r);
  // Optional additional configured units may reinforce or intercept using shared observed intelligence.
  // Do not evacuate an otherwise undefended home city, or use unseen exact enemy resources.
  const homeCovered=m.atCityId&&ordered(w).some(other=>other.id!==a.id&&other.factionId===a.factionId&&other.troops>0&&model(w,other.id).atCityId===m.atCityId);
  if(homeCovered&&(!m.order||m.order.status!=='active'||m.order.kind==='garrison')){
   const distress=hostile.find(i=>i.atCityId&&i.atCityId!==m.atCityId&&w.cities[i.atCityId].ownerFactionId===a.factionId);
   const intercept=hostile.find(i=>i.roadId&&s.roads[i.roadId]&&(s.roads[i.roadId].from===m.atCityId||s.roads[i.roadId].to===m.atCityId)&&i.estimatedTroops<=a.troops);
   const target=distress?.atCityId||(intercept?.roadId?(s.roads[intercept.roadId].from===m.atCityId?s.roads[intercept.roadId].to:s.roads[intercept.roadId].from):undefined);
   const road=target?roadFor(w,m,target):undefined;
   if(target&&road?.open){const days=road.distanceKm/(rule(w,'marchKmDay')*road.terrainFactor*weatherOf(w,road)*clamp(1-rule(w,'fatigueSpeed')*m.fatigue,.5,1));
    if(a.foodKg>=total(a,m)*rule(w,'rationKg')*days){installOrder(w,{commandId:`auto-support-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'march',targetCityId:target},r,true);continue;}
   }
  }
  if(!m.order||m.order.status!=='active')installOrder(w,{commandId:`auto-hold-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'garrison'},r,true);
 }
}
function surrender(w:WorldSnapshot,a:Army,r:SimulationReport){
 const m=model(w,a.id);m.captured+=a.troops+m.wounded+m.transportPeople;a.troops=0;m.wounded=0;m.transportPeople=0;hold(w,a,'守軍士气崩溃，正式投降');r.pauseReason='守军投降';r.summaries.push(a.name+'正式投降，人员记为被俘。');
}
/**
 * BUG-116：士气跌破溃退线且**正在接敌**的玩家军队要真的解围后撤，而不是只按暂停键。
 *
 * 此前 advanceWorld 只在这里设 pauseReason、世界状态纹丝不动：围城战每小时磨出的战损
 * 让士气全程低于溃退线，条件恒真 → 每小时重新暂停，任何跳转只推进 1 小时——实测玩家
 * 为磨完三场围城连发了约 500 次 jump。暂停必须改变世界状态：溃师不战，退出 besieging、
 * 停掉攻围令、退往有路可通的己方城池（无路可退时原地驻扎并写清原因），时间才能继续流。
 * 已在撤退途中与已处置过本次溃退的部队豁免（routedAtHour 挡重复触发；士气回到线上升即清）。
 */
function routCollapse(w:WorldSnapshot,r:SimulationReport){
 const s=w.simulation!;
 for(const a of ordered(w)){
  const m=model(w,a.id);
  if(a.morale>=rule(w,'retreatMorale')){if(m.routedAtHour!==undefined)delete m.routedAtHour;continue;}
  if(a.troops<=0||a.factionId!==s.playerFactionId)continue;
  if(m.order?.status==='active'&&m.order.kind==='retreat')continue;
  if(m.routedAtHour!==undefined&&m.routedAtHour<=s.timeHours)continue;
  // 驻守己城的部队不在此列——「不逃己城」与粮尽溃退规则（enemyOrders）同一口径。
  if(m.atCityId&&w.cities[m.atCityId]?.ownerFactionId===a.factionId)continue;
  // 只对正在接敌的部队生效：围城中（攻/围敌城）或与敌军同处一片战场。
  const besieging=!!m.atCityId&&w.cities[m.atCityId].ownerFactionId!==a.factionId&&m.order?.status==='active'&&['attack','besiege'].includes(m.order.kind);
  const touching=besieging||ordered(w).some(b=>b.troops>0&&b.factionId!==a.factionId&&samePlace(w,a,b));
  if(!touching)continue;
  m.routedAtHour=s.timeHours;
  const back=retreatCity(w,a,m);
  if(back){
   installOrder(w,{commandId:`rout-${a.id}-${Math.round(s.timeHours)}`,expectedRevision:w.revision,armyId:a.id,kind:'retreat',targetCityId:back},r,true);
   r.summaries.push(`${a.name}士气崩溃（${Math.round(a.morale)}），${besieging?'解围':''}后撤，退往${w.cities[back].name}重整。`);
  }else{
   stopOrder(w,a,'failed','士气崩溃且无路可退');hold(w,a,'士气崩溃，就地驻扎');
   r.summaries.push(`${a.name}士气崩溃（${Math.round(a.morale)}），四顾无路可退，就地驻扎。`);
  }
  r.pauseReason=r.pauseReason||'部队士气过低，溃师自行撤退';
 }
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
 // 第 5 轮卡点2：0.25 倍速只适用于**有粮行军**的节省。0 粮溃退是逃命——从前 0 粮撤退
 // 也按 0.25 倍爬 240km，实测要走 51 日、每日逃散 1%，全程士气 0、不可干预，玩家只能
 // 看着部队磨死。溃退全速：跑回家就有后方输粮兜底（见 observe），也来得及被在途补给
 // 截住（supply 的相遇点交付）——把锁死改成慢刑，不如让败军走得回来。
 const crawl=a.foodKg>0||o.kind==='retreat'?1:.25;
 return rule(w,'marchKmDay')/24*road.terrainFactor*weatherOf(w,road)*load*clamp(1-rule(w,'fatigueSpeed')*m.fatigue,.5,1)*forced*nav*capacity*crawl;
}
/**
 * 驻地自动补给：驻在己方城池里、粮草将尽（不足两日）的部队，从该城库存调拨补到三日。
 *
 * **必须在 consume() 之前调用。** 它原本在 observe() 里，而 observe 在 consume 之后跑，
 * 于是每个 hour 分片都是「consume 看见 0 粮 → 记下『部队补给不足』暂停 → observe 才把粮补满」。
 * 下一片开头又是 0 粮，再次暂停——状态是个不动点：粮草数字跨跳一字不变、每跳必停、
 * 一局永远推进不了（实测稳守法 25 跳只前进 259 日、25/25 全暂停，且从未到终局）。
 * 挪到消费结算之前，consume 看到的就是补过的粮，暂停只在真的没人补时才会响。
 */
/**
 * 驻地部队的后方输粮：不足两日口粮就补到三日量。
 *
 * 源粮仓优先取**驻地城**（即时调拨，不需要运输路线）；驻地城没粮才跨城调——史实正是
 * 「从成都转输汉中」。为什么不能只取驻地城：实测驻地城（汉中）日产出低，被抽几次就见底
 * （30000→0），而真正的粮仓在成都（几年后囤到 34 万公斤）却用不上，部队驻在己方城里却断粮。
 */
function autoSupply(w:WorldSnapshot,a:Army,m:ArmyModel,r:SimulationReport){
 const people=total(a,m);
 if(people<=0)return;
 if(a.foodKg>=people*rule(w,'rationKg')*2)return;   // 还有两日以上口粮就不动
 const want=people*rule(w,'rationKg')*3-a.foodKg;    // 补到三日口粮，不是补满：粮仍要省着用
 if(want<=0)return;
 const home=m.atCityId?w.cities[m.atCityId]:undefined;
 const useHome=home&&home.ownerFactionId===a.factionId&&home.foodKg>0;
 if(useHome){
  // 驻地即时调拨：量受驻地城库存与携粮余量双重约束，不走 shipment
  supply(w,{commandId:`auto-supply-${a.id}-${w.simulation!.timeHours}`,expectedRevision:w.revision,
    armyId:a.id,kind:'resupply',sourceCityId:home.id,foodKg:Math.min(home.foodKg,want)},r,true);
  return;
 }
 // 驻地城没粮：从己方库存最多的城走**在途运输**。没有可用路线时 supply 自己会抛错，
 // 这里必须吞掉——自动行为不能因为「暂时调不过来」把整次推演炸掉。
 try{
  const own=Object.values(w.cities).filter(c=>c.ownerFactionId===a.factionId&&c.foodKg>0);
  const source=own.sort((x,y)=>y.foodKg-x.foodKg)[0];
  if(!source)return;
  supply(w,{commandId:`auto-supply-${a.id}-${w.simulation!.timeHours}`,expectedRevision:w.revision,
    armyId:a.id,kind:'resupply',sourceCityId:source.id,foodKg:Math.min(source.foodKg,want)},r,true);
 }catch{/* 路不通/运力不足：下一小时步再试，或等玩家自己下令 */}
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
 // 季节传闻挂钩（第 5 轮）：军中时疫 30 日内，本方**行军**部队士气每日额外 -1.5 分
 //（¼ 格 foodMorale）。只算行军：驻扎整备正是时疫的解药，驻着也掉就没道理了。
 if(seasonalActive(s,'seasonal-epidemic')&&a.factionId===s.playerFactionId&&m.roadId&&m.order?.status==='active')
  a.morale=clamp(a.morale-EPIDEMIC_MORALE_DAY*days);
  if(m.foodDeficitHours>rule(w,'hungerThresholdHours')&&a.troops>0){const value=a.troops*rule(w,'hungerDesertion')*(1-m.rationRatio)*days+m.desertCarry;const loss=Math.min(a.troops,Math.floor(value));m.desertCarry=value-Math.floor(value);a.troops-=loss;m.deserted+=loss;}
  if(m.rationRatio<1||m.waterRatio<1)m.fatigue=clamp(m.fatigue+8*((1-m.rationRatio)+(1-m.waterRatio))*days);
  r.traces.push({rule:'rations',entityId:a.id,hours:dt,inputs:{people,kgPerPersonDay:rule(w,'rationKg'),demandKg:demand},result:{consumedKg:food,remainingKg:a.foodKg,waterRatio:m.waterRatio}});
  // 「真的断粮」要留容差。hour 步进的 dt 会被 foodHours 卡在粮刚好耗尽那一刻，于是
  // food=min(demand,foodKg) 常落在比 demand 差一丝的位置（实测 rationRatio=0.99992 而部队其实满载）。
  // ratio<1 就暂停会把这种边界态误判成缺粮。只认「缺口超过千分之一」的短缺。
  // 注意：这修的是「满载却报缺粮」的误判，**不是**「跳转推进不了」——后者是因为
  // 6000 人的部队日耗 6000kg、携粮上限 65000kg，一次只带得了约 11 日粮，而分片默认 30 日，
  // 于是超过十日的跳转必然断粮。那是携粮量与分片长度的设计权衡，见
  // docs/steam-road/09-Steam上架清单.md 的 D 节补记，不要用改这里的容差去「修」它。
  const RATION_SHORT_EPS=1e-3;
  // 断粮要停，但只在**真正的绝境**停：后方没有任何己方城池有粮、也没有补给在途。
  // 为什么：补给量注定补不满一次长跳（6000 人日耗 6000kg、携粮上限 65000kg，一次只带约
  // 11 日粮），所以只要按「部队手上的粮断了」就停，任何超过十日的跳转都会停在半路——实测
  // 一局只能推进几百日、永远到不了剧本年数，玩家看到的是「每跳必停」。而后方有粮时，
  // 这只是"还没补"，不是要玩家决断的事。真正的绝境（全据点的粮都光了、或路断了运不过来）
  // 才值得把玩家从跳转里拽出来。断粮的代价（士气、溃散）照旧走，不因不停而豁免。
  const replenishing=Object.values(s.shipments).some(c=>c.targetArmyId===a.id&&c.status!=='returned'&&c.status!=='captured');
  const rearHasFood=Object.values(w.cities).some(c=>c.ownerFactionId===a.factionId&&c.foodKg>0);
  const starved=m.rationRatio<1-RATION_SHORT_EPS&&m.foodDeficitHours<=dt+.000001;
  if(starved&&!replenishing&&!rearHasFood){
    r.pauseReason='部队补给不足';r.summaries.push(a.name+'粮草已尽，后方亦无存粮：需调整补给或行动。');
  }else if(starved){
    // 别再说「继续推进」：部队此刻可能正站着饿肚子（后方有粮却送不到路上来），
    // 这句话等于让玩家以为没事，然后每天悄没声地逃掉几十人。照实说。
    const moving=!!m.roadId&&!!m.order&&m.order.status==='active';
    r.summaries.push(replenishing?`${a.name}粮草将尽，补给队已在途中。`
      :moving?`${a.name}粮草将尽，仍在赶路，每日逃散渐增。`
      :`${a.name}粮草将尽，后方存粮送不到这里：需撤回据点或改走有补给的路线。`);
  }
  if(m.waterRatio<1&&m.waterDeficitHours<=dt+.000001){r.pauseReason='部队供水不足';r.summaries.push(a.name+'供水不足。');}
  // 士气跌破溃退线要留一句。断粮、撤军、易主都有起居注，唯独士气一路掉到 0 无声无息——
  // 试玩原话是「士气崩了，起居注一句话没有」。只在**跨过**那条线的那一刻说，
  // 否则几十个小时步够把同一行刷满整本起居注。
  const collapse=rule(w,'retreatMorale');
  if(a.morale<collapse&&a.morale+(1-m.rationRatio)*rule(w,'foodMorale')*days+(1-m.waterRatio)*rule(w,'waterMorale')*days>=collapse){
    r.summaries.push(`${a.name}士气跌破 ${Math.round(collapse)}，军心浮动：再不整备恐将溃散。`);
  }
  if(a.troops===0&&a.status!=='destroyed')hold(w,a,'部队失去战斗能力');
 }
 for(const [id,c] of Object.entries(s.cities)){
  // 只算**在籍居民**的口粮。运输人员不在其中：他们的往返口粮由运输队的 rationKg 支付
  // （provider.ts/supply 里按天数×2+2 计），在这里再吃一遍就是双倍计费——实测按运力
  // 合成年吃 300 万公斤，比扬州全省农业产出还高，省会库存被凭空抽干。
  const city=w.cities[id],need=c.residents*rule(w,'rationKg')*days,food=Math.min(need,city.foodKg);city.foodKg=round(city.foodKg-food);s.ledger.consumedKg+=food;
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
 // 暂停文案要带主语：光说「抵达目标」会被读成跳转到达了目标日（实测 UX-013）。
 r.pauseReason=a.name+'抵达'+city.name+(city.ownerFactionId===a.factionId?'，行军结束':'城外，行军结束');
 r.summaries.push(a.name+'抵达'+city.name+(city.ownerFactionId===a.factionId?'。':'城外，城池归属尚未改变。'));
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
   a.morale=clamp(a.morale+rule(w,'moraleRest')*days);
   const amount=m.wounded*rule(w,'recoveryRate')*days+m.recoveryCarry,n=Math.min(m.wounded,Math.floor(amount));m.recoveryCarry=amount-Math.floor(amount);m.wounded-=n;a.troops+=n;
  }}
 // Siege damage requires actual equipment. Starting expedition has no siege train.
 for(const a of units){const m=model(w,a.id);if(m.atCityId&&m.order?.status==='active'&&m.order.kind==='attack'&&w.cities[m.atCityId].ownerFactionId!==a.factionId&&m.siegePower>0){const c=w.cities[m.atCityId];c.defense=clamp(c.defense-m.siegePower*rule(w,'siegeDamage')*days);if(c.defense===0)s.cities[c.id].gateOpen=true;}}
}

/**
 * 把某城的既有守军拉进战局：加到 activeArmyIds、补上 ArmyModel。
 * v1 的 12 城都在 w.armies 里有「守军 N」，但只有长安与魏延部在 activeArmyIds 里，
 * 于是其余十城的守军不吃饭、不打仗、不会饿死——城市面板上的兵力是装饰数字。
 * 这里补的是入场券，不改部队本身：人数、粮草、士气都按世界快照里现成的来。
 */
function activateGarrison(w:WorldSnapshot,cityId:string){
  const s=w.simulation!;
  for(const a of Object.values(w.armies)){
    if(a.location.kind!=='city'||a.location.cityId!==cityId)continue;
    if(s.activeArmyIds.includes(a.id))continue;
    s.activeArmyIds.push(a.id);
    s.armies[a.id]={fatigue:0,wounded:0,dead:0,captured:0,deserted:0,transportPeople:300,initialPeople:a.troops+300,
      training:1,equipment:1,siegePower:1,capacityKg:25000,waterLitres:(a.troops+300)*4,
      foodDeficitHours:0,waterDeficitHours:0,rationRatio:1,waterRatio:1,lastCombatHour:-100,
      roadId:null,roadKm:0,atCityId:a.location.cityId,order:null,knownRoads:[],effects:[],
      lossCarry:0,recoveryCarry:0,desertCarry:0};
    s.armies[a.id].order=null;
  }
}
function occupy(w:WorldSnapshot,r:SimulationReport){
 const s=w.simulation!;
 for(const a of ordered(w)){
  const m=model(w,a.id);if(!a.troops||!m.atCityId||m.order?.status!=='active'||!['attack','besiege'].includes(m.order.kind))continue;
  const city=w.cities[m.atCityId];if(city.ownerFactionId===a.factionId)continue;
  // 该城守军在此之前从未进过战局（不在 activeArmyIds 里，所以一直不参战）——**就地激活**，
  // 让它进入 occupy / battle / 饥饿那套结算。否则整张 12 城地图只有长安一座城要打，
  // 其余 11 城是「兵临城下即开城」的白给：试玩原话「打下一座城后剩下的全是白给」。
  // 激活而不是开打时才造军队：部队、粮草、士气都在 w.armies 里现成，缺的只是一张入场券。
  activateGarrison(w,city.id);
  if(ordered(w).some(b=>b.troops>0&&b.factionId===city.ownerFactionId&&model(w,b.id).atCityId===city.id))continue;
  for(const b of Object.values(w.armies).filter(b=>b.location.kind==='city'&&b.location.cityId===city.id&&b.factionId!==a.factionId)){b.location={kind:'field',point:city.point,label:city.name+'城外'};}
  city.ownerFactionId=a.factionId;city.governor={...a.commander};s.cities[city.id].blockadeBy=[];s.cities[city.id].gateOpen=true;
  // 省归属跟随治所易主；否则省层与城池层会各记一本账
  for(const p of Object.values(w.provinces||{}))if(p.seatCityId===city.id)p.ownerFactionId=a.factionId;
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
  // BUG-118：「中途散失」也要有史官流水。货与口粮在途耗尽的运输队此前僵在原地——
  // inTransit 永远挂着、货物人间蒸发（实测 30000 公斤无到达无失败消息）。粮秣尽了人就散：
  // 人员陆续归建（运力回池），货物颗粒无存，运输队就此终结。
  if(c.status!=='returning'&&c.cargoKg<=.5&&c.rationKg<=.5){
   s.cities[c.sourceCityId].transportAvailable+=c.carriers;c.status='returned';
   r.summaries.push(`运输队粮秣在途耗尽，人货散失于途：${c.carriers}人陆续归建，货物颗粒无存。`);
   continue;
  }
  const end=c.status==='returning'?(road.from===c.sourceCityId?0:road.distanceKm):c.targetKm;
  // waiting 的运输队要**追着目标军队走**，不能僵在原地。
  // 原来的 `c.status!=='waiting'` 让等不到人的运输队永远停下：军队继续前进就永不相遇，
  // 货物霉变到只剩一半，而且「该部队已有在途补给」把后续补给也堵死——玩家在路上
  // 完全无法得到补给（实测补 10000kg，最终货烂到 0，军队 5000→1093 人）。
  const chasing=c.status==='waiting'&&model(w,c.targetArmyId).roadKm!==null?model(w,c.targetArmyId).roadKm:end;
  // 返程的运输队货已交清（cargo/ration 都是 0），若仍要求「有粮才动」，它就永远冻在交付点：
  // 实测 40 天后仍在 km 200.8 一动不动，而「该部队已有在途补给」把 returning 也算在途，
  // 这支部队从此再也收不到任何补给，出发城的运力也被永久吃掉。人员照旧走得回来。
  if(road.open&&road.waterAccessible&&(c.status==='returning'||ration+cargoRation>=need-1e-8)){
   const speedKmHour=rule(w,'marchKmDay')/24*road.terrainFactor*weatherOf(w,road);
   c.roadKm=round(c.roadKm+Math.sign(chasing-c.roadKm)*Math.min(Math.abs(chasing-c.roadKm),speedKmHour*dt));
  }
  const enemies=ordered(w).filter(a=>a.troops>0&&a.factionId!==c.factionId&&positionOnRoad(w,a,c.roadId)!==null&&Math.abs(positionOnRoad(w,a,c.roadId)!-c.roadKm)<1e-5);
  if(enemies.length){
   const captor=enemies[0],m=model(w,captor.id),captured=c.cargoKg+c.rationKg,taken=Math.min(captured,m.capacityKg-captor.foodKg);
   captor.foodKg=round(captor.foodKg+taken);s.ledger.spoiledKg+=captured-taken;s.ledger.transportCaptured+=c.carriers;c.cargoKg=0;c.rationKg=0;c.status='captured';
   r.pauseReason='补给被截';r.summaries.push(`运输队被${captor.name}截获，${c.carriers}人被俘；超出敌军运力的粮草记为损毁。`);continue;
  }
  // 「抵达」的判据要按本次实际去向算：waiting 状态朝军队当前位置追（见上面 chasing），
  // 所以判它到没到要看军队位置；其它状态才看固定终点 end。
  //  曾经一律按 end 判：军队驶过下单时的会合点后，roadKm 与 end 的差值只会越来越大，
  //  这个 continue 永远截住，met 检查永不执行——运输队卡在 waiting 上追 20+ 天，
  //  货霉变、军队粮为 0、且「已有在途补给」把后续补给也堵死。
  const goalKm=c.status==='waiting'&&model(w,c.targetArmyId).roadKm!==null?model(w,c.targetArmyId).roadKm:end;
  const tolerance=rule(w,'marchKmDay')/24*2+1e-5;
  if(Math.abs(c.roadKm-goalKm)>tolerance&&c.status!=='travelling')continue;
  if(c.status==='returning'){
   const city=w.cities[c.sourceCityId];if(city.ownerFactionId===c.factionId){city.foodKg=round(city.foodKg+c.cargoKg+c.rationKg);s.cities[city.id].transportAvailable+=c.carriers;c.status='returned';
    // BUG-118：「到达入库」要有史官流水，否则返程的运输队在玩家眼里是凭空蒸发的。
    r.summaries.push(`运输队返回${city.name}：${c.cargoKg>.5?`余粮${round(c.cargoKg)}公斤入库，`:''}${c.carriers}人归建。`);}
   else{s.ledger.transportCaptured+=c.carriers;city.foodKg=round(city.foodKg+c.cargoKg+c.rationKg);c.status='captured';
    r.summaries.push(`运输队返程时${city.name}已易主，${c.carriers}人被俘，货物散佚。`);}
   c.cargoKg=0;c.rationKg=0;continue;
  }
  const receiver=w.armies[c.targetArmyId],targetPosition=positionOnRoad(w,receiver,c.roadId);
  if(receiver.troops===0){c.status='returning';r.summaries.push(`${receiver.name}已失去战斗能力，运输队原路折返。`);continue;}
  // 交付判据放宽到「已抵达军队位置」：原来是 Math.abs(差)>1e-5 就算没送到，
  // 浮点上几乎永远差一点 → 永远 waiting。给一个步长量级的容差就行。
  const met=targetPosition!==null&&Math.abs(targetPosition-c.roadKm)<=Math.max(1e-5,rule(w,'marchKmDay')/24/2);
  if(!met){c.status='waiting';continue;}
  c.status='travelling';   // 已追上：恢复常态，让下面的交付逻辑继续走
  const amount=Math.min(c.cargoKg,model(w,receiver.id).capacityKg-receiver.foodKg);receiver.foodKg=round(receiver.foodKg+amount);c.cargoKg=round(c.cargoKg-amount);c.status='returning';
  // 补给抵达**不暂停**。它是玩家下令后的好消息，没有需要决断的事——此前在这里设 pauseReason，
  // 结果玩家每补一次粮就被打断一次，长局里每跳必停（实测稳守法 60 跳只推进 627 日，
  // 而剧本要 30 年才终局）。只留 summary 让史官记一笔，时间继续走。
  // BUG-118：货沿途霉光时也要照实说，不写「收到补给0公斤」糊弄玩家。
  r.summaries.push(c.cargoKg>0||amount>.5?`${receiver.name}实际收到补给${round(amount)}公斤，运输队携余粮返回。`:`运输队追上${receiver.name}，但货物沿途损毁殆尽，颗粒未交。`);
 }
}
function positionOnRoad(w:WorldSnapshot,a:Army,id:string):number|null {
 const m=model(w,a.id),road=w.simulation!.roads[id];if(m.roadId===id)return m.roadKm;
 if(m.atCityId===road.from)return 0;if(m.atCityId===road.to)return road.distanceKm;return null;
}

/** 起始季从 clock.startLabel 取（形如「公元208年 · 冬」）。取不到按春——时间线过滤的兜底。 */
/** 效果的一句话说明：科技/国策完成行用它说清「到底得到了什么」。 */
function effectNote(e:import('./decisions.js').DecisionEffect):string{
 switch(e.kind){
  case 'city-food':return `${e.cityId}粮 ${e.deltaKg>0?'+':''}${Math.round(e.deltaKg/1000)}千斤`;
  case 'city-defense':return `${e.cityId}城防 ${e.delta>0?'+':''}${e.delta}`;
  case 'army-food':return `携粮 ${e.deltaKg>0?'+':''}${Math.round(e.deltaKg/1000)}千斤`;
  case 'army-morale':return `士气 ${e.delta>0?'+':''}${e.delta}`;
  case 'treasury':return `库金 ${e.coin>0?'+':''}${e.coin}、徭役 ${e.corvee>0?'+':''}${e.corvee}`;
  case 'prestige':return `朝望 ${e.delta>0?'+':''}${e.delta}`;
  case 'approval':return `${e.faction}拥戴 ${e.delta>0?'+':''}${e.delta}`;
  case 'province-mode':return `治政改为 ${e.mode}`;
  default:return '';
 }
}
function startSeasonOf(w:WorldSnapshot):string|undefined{return w.clock.startLabel.match(/[春夏秋冬]/)?.[0];}

export function advanceWorld(before:WorldSnapshot,input:AdvanceCommand):{world:WorldSnapshot;report:SimulationReport}{
 validateAdvance(input);ensure(before,input.expectedRevision);const w=structuredClone(before),s=w.simulation!,r=report(w,input.commandId,'advance'),end=s.timeHours+input.hours;
 s.pauseReason=null;let iterations=0;const iterationCap=Math.ceil(input.hours*2)+200;
 while(s.timeHours<end-1e-7&&!r.pauseReason){
  assert(++iterations<iterationCap,'推进超过内部事件上限');
  // 季节传闻到期自解（第 5 轮）：到日子的传闻先撤，本步的结算按撤过之后的状态算。
  if(s.seasonal?.length)s.seasonal=s.seasonal.filter(x=>x.untilDay>s.timeHours/24);
  observe(w,0,r);enemyOrders(w,r);blockade(w);occupy(w,r);if(r.pauseReason)break;
  // 在长推进内部也淘汰例行代决。AI 的自动补给每约三日一条决策，只靠 commitLocal 拦的话，
  // 单次跳转内部就能把 decisions 撑到 500 硬顶而直接炸「决策数量超过500」——
  // 实测 3650 日的 indulging 跳转撞过（12 支军队各自补粮）。玩家自己的决策一条不淘汰。
  pruneDecisions(w);
  const occupancy:Record<string,number>={};for(const a of ordered(w)){const m=model(w,a.id);if(m.roadId)occupancy[m.roadId]=(occupancy[m.roadId]||0)+total(a,m);}
  const moves=new Map<string,number>(),contacts=new Set<string>(),arriving=new Set<string>();
  const units=ordered(w).filter(a=>a.troops>0);
  let dt=Math.min(1,end-s.timeHours);
  for(const a of units){const m=model(w,a.id);if(!m.roadId)continue;
   const road=s.roads[m.roadId],o=m.order;
   // 急行军触顶不能只把命令判失败就撒手：那样军队会**没有在执行的命令**，速度归零，
   // 在路中间静静站到粮尽（实测 km57 冻 18 天无任何提示，粮放烂才开始逃死）。
   // 改为降格成常行军，同一目标继续走——急行军是加速手段，不是独立的任务。
   if(o?.kind==='forced-march'&&o.status==='active'&&m.fatigue>=rule(w,'forcedLimit')){
    const target=o.targetCityId,name=target?w.cities[target]?.name:undefined;hold(w,a,'急行军疲劳达到上限');
    if(target)installOrder(w,{commandId:`normalize-${a.id}-${s.timeHours}`,expectedRevision:w.revision,armyId:a.id,kind:'march',targetCityId:target},r,true);
    r.pauseReason='急行军达到疲劳上限，改为常行';r.summaries.push(`${a.name}疲惫已极，急行军改为常行，继续向${name||'目标'}前进。`);break;}
   if(o?.status==='active'&&!road.open){hold(w,a,'道路中断');r.pauseReason='道路中断';break;}
   // 诏令在途：令还没到军中，部队原地候旨——不动、不进军、不接战。这就是「古代滞后性」：
   //  令已下、簿已录，但路上那几天里世界照常演进，军队照常吃粮，只是还没动身。
   const edictInTransit=!!o&&(o.arrivalHour??0)>s.timeHours;
   let v=speed(w,a,occupancy);const endKm=o?.targetCityId===road.from?0:road.distanceKm;
   if(units.some(b=>b.factionId!==a.factionId&&samePlace(w,a,b))&&o?.kind!=='retreat')v=0;
   if(o?.status!=='active'||edictInTransit)v=0;
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
   // `waiting` 的运输队不能就此僵死。原来的写法 `status!=='waiting'` 让等不到人的运输队
   // 永远停下：军队继续前进就永不相遇，货物霉变到只剩一半，而且「该部队已有在途补给」
   // 把后续补给也堵死——玩家在路上完全无法得到补给（实测补 10000kg，货到 8478 就烂了）。
   // 改成「追着目标送」：waiting 时朝军队当前位置走。
   const chasing=c.status==='waiting'?model(w,c.targetArmyId).roadKm:null;
   const dst=chasing!==null?chasing:endKm;
   const cv=road.open&&road.waterAccessible?rule(w,'marchKmDay')/24*road.terrainFactor*weatherOf(w,road)*Math.sign(dst-c.roadKm):0;
   if(cv){const until=Math.abs(endKm-c.roadKm)/Math.abs(cv);if(until>1e-7)dt=Math.min(dt,until);}
   for(const a of units.filter(a=>a.factionId!==c.factionId)){const ap=positionOnRoad(w,a,c.roadId);if(ap===null)continue;const relative=cv-(moves.get(a.id)||0);const until=relative?(ap-c.roadKm)/relative:0;if(until>1e-7&&until<=dt+1e-7)dt=Math.min(dt,until);}
  }
  if(dt<1e-7){for(const a of units){const m=model(w,a.id);if(m.roadId&&m.order?.targetCityId){const rd=s.roads[m.roadId],dest=m.order.targetCityId===rd.from?0:rd.distanceKm;if(Math.abs(dest-m.roadKm)<1e-5)arrive(w,a,r);}}if(r.pauseReason)break;assert(false,'无法推进零长度时间段');}
  // 这里**不要**给玩家军队补粮。曾经在 consume 前无条件调 autoSupply，结果正是它自己造出了
  // 要修的不动点：autoSupply 补到满载 65000 → consume 吃到 0 并记「补给不足」暂停 →
  // 下个小时步 autoSupply 又补满。玩家于是永远看到「满载却 rationRatio=0」、每跳必停。
  // 玩家的粮归玩家管（下补给令），AI 只在自己阵营的军队上代决（见 enemyOrders）。
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
  shipments(w,dt,r);observe(w,dt,r);blockade(w);occupy(w,r);
  for(let i=0;i<units.length;i++)for(let j=i+1;j<units.length;j++){const a=units[i],b=units[j],pair=[a.id,b.id].sort().join('|');if(a.troops&&b.troops&&a.factionId!==b.factionId&&!contacts.has(pair)&&samePlace(w,a,b)){r.pauseReason=r.pauseReason||'遭遇敌军';r.summaries.push(a.name+'与'+b.name+'发生接触，等待下一步决策。');}}
  // 士气崩盘时**不要**只用 pauseReason 把玩家按在原地：试玩实测，士气归零后
  // advance(24h) 返回成功却只走 0.04 天、jump 静默停在半路，玩家没有任何手段继续
  // （军令拦、推进也拦），只能开新档——这是比「暂停」严重得多的锁死。
  // BUG-116：围城/接战中跌破溃退线的部队由 routCollapse 真正解围后撤——暂停必须
  // 改变世界状态，时间才能继续流；已在撤退途中或已处置过的部队在此豁免。
  routCollapse(w,r);
  s.armies&&Object.values(s.armies).forEach(m=>{m.effects=m.effects.filter(e=>e.expiresHour>s.timeHours);});
 }
 r.advancedHours=round(s.timeHours-before.simulation!.timeHours);s.pauseReason=r.pauseReason;
 // 国策层：政治点按日累积，到日子的国策完成并兑现效果。放在推进收尾处一次算完，
 // 不在小时步里逐格结算——政治点与国策都是「天」粒度的事，逐小时算是白算。
 {
  const tc=w.techs;
  if(tc){
   const days2=Math.max(0,(s.timeHours-before.simulation!.timeHours)/24);
   w.techs=accrueTechPoints(tc,days2);
   const tdone=completeTechs(w.techs,s.timeHours/24);
   w.techs=tdone.state;
   for(const t of tdone.done){
    // 完成行别复述立项那段（立项时已经写过 text 前 40 字）——写成「已成：…」，
    // 否则玩家分不清刚立项和已研究完（试玩员原话「两句几乎同文」）。
    r.summaries.push(`【科技】${t.title}已成：${t.effects.map(effectNote).filter(Boolean).join('；')||'其法大行，军中称便。'}`);
    for(const e of t.effects)applyDecisionEffect(w,e);
   }
  }
 }
 {
  const fc=w.focuses;
  if(fc){
   const days=Math.max(0,(s.timeHours-before.simulation!.timeHours)/24);
   const absent=w.politics?.absenceDays??0;
   w.focuses=accruePoints(fc,days,absent);
   const {state:after,done}=completeFocuses(w.focuses,s.timeHours/24);
   w.focuses=after;
   for(const f of done){
    r.summaries.push(`【国策】${f.title}：${f.doneSummary}`);
    for(const e of f.effects)applyDecisionEffect(w,e);
   }
  }
 }
 // 推演跨过了哪段史实：锚点是史官预设的既成事实，不随玩家改变，到日子就照实报上来。
 // 此前 anchors.ts 的 30 条锚点一个消费方都没有——写好了却从没进过游戏，玩家看不到天下
 // 正在发生什么。接在这里，单次推进与跳转的每个分片就都能带上「这天，石亭之战打了」。
 // 时间线跟着剧本年份走：本局快照上的 anchors（bootstrap 时已按起始年份选好），
 // 旧存档没有就回落预设清单。否则 200 年官渡的局会收到 234 年的新闻。
 const timeline=w.anchors??HISTORY_ANCHORS;
 const beforeDay=before.simulation!.timeHours/24,afterDay=s.timeHours/24;
 const crossed=anchorsBetween(timeline,beforeDay,afterDay);
 // BUG-106：史册行后跟一句史官按——史册所载未必是本局走向，玩家要分得清两说。
 if(crossed.length){r.history=crossed.map(anchorLine);r.summaries.push(...r.history,ANCHOR_HISTORIAN_NOTE);}
 // 历史决策卡：事情发生了先发驿报，驿报到了才摆上御案——「先决此事，再议军行」。
 // 只在御案还空着时才发报；发出去的不立刻上案，要走 courier.ts 的驿传日子。
 // 通宵发电报的三国不是三国：实测这一刻起，同一天的「孟达伏诛」不再当天拍在主上脸上。
 if(!w.pendingDecision){
  // 决策与新闻都过「已读账」：同一天排两队时决策优先（玩家手里始终是有选择的那件事）
  const resolved=w.resolvedDecisions||{};
  // 事件池按剧本年份挑：208 赤壁局不该拿到 228 北伐的子午谷奇谋（实测 bug）。
  const pool=eventsForScenario(DECISION_EVENTS,w.startYear,startSeasonOf(w));
  const newsPool=eventsForScenario(NEWS_EVENTS,w.startYear,startSeasonOf(w));
  const due=decisionsBetween(pool,beforeDay,afterDay,resolved)
   .find(e=>!e.requiresCity||w.cities[e.requiresCity!]?.ownerFactionId===s.playerFactionId);
  const news=newsBetween(newsPool,beforeDay,afterDay,resolved)[0];
  const horizon=Math.max(0,...pool.map(e=>e.day),...newsPool.map(e=>e.day));
  const first=due??news;
  // 史册讲完之后（BUG-115）：真实锚点/新闻池喂完的世界不该再没有访客。按季补一条
  // 「军中传闻」级常规新闻上案——只当新闻不拦军行，卡面自报家门，绝不冒充史实。
  if(!first&&afterDay>horizon+30){
   const season=Math.floor(afterDay/91),key='seasonal-'+season,resolved0=w.resolvedDecisions||{};
   if(!resolved0[key]&&!(w.incomingEvents||[]).some(i=>i.eventId===key)){
    const flavor=FLAVOR_NEWS[season%FLAVOR_NEWS.length],days=reportTransitDays(w,undefined);
    enqueueIncoming(w,{eventId:key,happenedDay:afterDay,arrivalDay:Math.ceil(afterDay+days),kind:'news'});
    r.summaries.push(`【驿报】${flavor.title} 已发往御前（${days} 日路程）`);
   }
  }
  if(first){
   // 驿报自「事发地」发：枢要（本方首城）离事发地越远，主上知道得越晚。
   // 事发地：决策卡带 requiresCity；新闻没有属地，按「无属地」给一段基准路程。
   const where=(first as {requiresCity?:string}).requiresCity;
   const days=reportTransitDays(w,where);
   enqueueIncoming(w,{eventId:first.id,happenedDay:first.day,arrivalDay:Math.ceil(first.day+days),kind:due?'decision':'news'});
   r.summaries.push(`【驿报】${first.title} 已发往御前（${days} 日路程）`);
  }
 }
 // 驿报到期才上案：御案空着、且最早一条在途驿报已到，就把它摆上来。
 if(!w.pendingDecision){
  // 裁过的卡要能从队列里摘掉：否则裁完 A，B 的驿报到了还会把 A 再摆一次（同一张卡看两回）。
  const resolvedNow=w.resolvedDecisions||{};
  for(const id of Object.keys(resolvedNow))dropIncoming(w,id);
  const arrived=takeDueIncoming(w,afterDay);
  if(arrived){
   w.pendingDecision={eventId:arrived.eventId,day:arrived.happenedDay};
   // 只有决策卡拦路。新闻卡面写着「不拦推进与军令」——那跳转也就不该停，
   // 否则 CLI 一边说「不拦军令」一边把 jump 摁住，两处自相矛盾（实测）。
   const dueEvent=arrived.kind==='decision';
   if(dueEvent)r.pauseReason='待主上决策';
   const line=DECISION_EVENTS.find(e=>e.id===arrived.eventId)??lookupNews(arrived.eventId);
   const late=Math.max(0,Math.ceil(afterDay-arrived.happenedDay));
   // 季节传闻机制挂钩（第 5 轮）：带机制的传闻卡**到案即挂** 30 日状态、到期自解，
   // 上案行从【新闻】升格为【朝局】并把数值写明——卡面自报家门是传闻，数值照实说。
   // 为什么到案就挂而不是等玩家裁：新闻卡可能一直摆在案上没人裁，而传闻描摹的
   // 「时疫/夏潦/驿路通塞」是世界里正在发生的事，不因主上看没看那张卡而改变。
   const effect=seasonalEffectOf(arrived.eventId);
   if(effect){
    s.seasonal=[...(s.seasonal||[]).filter(x=>x.key!==lookupNews(arrived.eventId)!.id),
     {key:lookupNews(arrived.eventId)!.id,untilDay:afterDay+effect.days}];
   }
   r.summaries.push(`【${effect?'朝局':'新闻'}】${line?.title||arrived.eventId}：${line?.text||''}${late>0?`（驿报迟了 ${late} 日）`:''}${effect?`——${effect.note}`:''}`);
  }
 }
 // Coalesce repetitive substep messages without losing the per-step calculation traces.
 r.summaries=[...new Set(r.summaries)].slice(0,100);
 // 空转也要说人话：起居注是给玩家看的，不要把内部小时步长原样搬上来。
 if(!r.summaries.length){
  const hours=Math.round(r.advancedHours);
  r.summaries.push(hours>=24?`诸军按粮行军、无新变，推进 ${Math.round(hours/24)} 日。`:`本地规则已推进${hours}小时。`);
 }
 w.revision++;validateWorld(w);validateSimulation(w);return{world:w,report:r};
}
