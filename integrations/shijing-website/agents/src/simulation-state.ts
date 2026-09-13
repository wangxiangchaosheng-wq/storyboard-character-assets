import {assert} from './contracts.js';
import type {WorldSnapshot} from './world-contracts.js';
import type {SimulationState,ArmyModel} from './simulation-types.js';
import {localProfile} from './simulation-profile.js';

export function seedSimulation(w:WorldSnapshot):SimulationState {
 const armies:Record<string,ArmyModel>={};
 for(const a of Object.values(w.armies)){
  const attacking=a.id==='army-wei-yan',transportPeople=attacking?1000:300;
  armies[a.id]={fatigue:20,wounded:0,dead:0,captured:0,deserted:0,transportPeople,
   initialPeople:a.troops+transportPeople,training:1,equipment:1,siegePower:attacking?0:1,
   capacityKg:attacking?65000:25000,waterLitres:(a.troops+transportPeople)*4,
   foodDeficitHours:0,waterDeficitHours:0,rationRatio:1,waterRatio:1,lastCombatHour:-100,
   roadId:null,roadKm:0,atCityId:a.location.kind==='city'?a.location.cityId:null,
   order:null,knownRoads:attacking?['road-ziwu']:[],effects:[],lossCarry:0,recoveryCarry:0,desertCarry:0};
 }
 const cities=Object.fromEntries(Object.values(w.cities).map(c=>[c.id,{
  residents:c.id==='changan'?5000:c.id==='hanzhong'?2000:0,
  transportAvailable:c.id==='hanzhong'?800:0,initialResidents:c.id==='changan'?5000:c.id==='hanzhong'?2800:0,
  waterAccessible:true,blockadeBy:[],gateOpen:false,
 }]));
 const s:SimulationState={version:1,mode:'local',profile:localProfile(),timeHours:0,playerFactionId:'shu',activeArmyIds:['army-wei-yan','army-changan'],armies,cities,
  roads:{'road-ziwu':{id:'road-ziwu',from:'hanzhong',to:'changan',distanceKm:240,terrainFactor:.75,capacityPeople:12000,open:true,waterAccessible:true,weatherFactor:1,
   source:'模拟路线：240km、道路容量与修正用于首版机制验证，未经历史地理校准；地图路径不参与距离换算。'}},
  shipments:{},intelligence:[],pauseReason:null,ledger:{initialFoodKg:0,consumedKg:0,spoiledKg:0,initialPeople:0,transportCaptured:0}};
 s.ledger.initialFoodKg=foodTotal(w,s);
 s.ledger.initialPeople=peopleTotal(w,s);
 return s;
}
export function foodTotal(w:WorldSnapshot,s:SimulationState):number {
 return Object.values(w.armies).reduce((n,a)=>n+a.foodKg,0)+Object.values(w.cities).reduce((n,c)=>n+c.foodKg,0)+Object.values(s.shipments).reduce((n,c)=>n+c.cargoKg+c.rationKg,0);
}
export function peopleTotal(w:WorldSnapshot,s:SimulationState):number {
 return Object.values(w.armies).reduce((n,a)=>{const m=s.armies[a.id];return n+a.troops+m.transportPeople+m.wounded+m.dead+m.captured+m.deserted;},0)
  +Object.values(s.cities).reduce((n,c)=>n+c.residents+c.transportAvailable,0)
  +Object.values(s.shipments).filter(c=>!['returned','captured'].includes(c.status)).reduce((n,c)=>n+c.carriers,0)+s.ledger.transportCaptured;
}
export function validateSimulation(w:WorldSnapshot):void {
 const s=w.simulation;if(s===undefined)return;
 const object=(v:unknown)=>!!v&&typeof v==='object'&&!Array.isArray(v);
 assert(object(s),'本地推演必须是对象');
 for(const field of ['armies','cities','roads','shipments','ledger','profile'] as const)assert(object(s[field]),'本地推演缺少'+field);
 assert(object(s.profile.parameters)&&Array.isArray(s.profile.sources)&&Array.isArray(s.intelligence),'本地规则或情报格式错误');
 for(const collection of [s.armies,s.cities,s.roads,s.shipments])for(const value of Object.values(collection))assert(object(value),'模拟对象格式错误');
 for(const m of Object.values(s.armies))assert(Array.isArray(m.effects)&&Array.isArray(m.knownRoads),'军队效果或已知道路格式错误');

 const finite=(v:unknown,min=0,max=Number.MAX_SAFE_INTEGER)=>assert(typeof v==='number'&&Number.isFinite(v)&&v>=min&&v<=max,'本地推演数值越界');
 const count=(v:unknown)=>{finite(v);assert(Number.isSafeInteger(v),'人员必须为整数');};
 assert(s.version===1&&s.mode==='local','不支持的本地推演格式');
 assert(s.profile?.id==='hanzhong-local-v1'&&s.profile.version===1&&s.profile.status==='experimental','规则档案无效');
 for(const [key,p] of Object.entries(localProfile().parameters)){
  const value=s.profile.parameters[key];assert(value&&value.unit===p.unit&&value.sourceKind==='simulation','规则参数缺失或单位错误');
  finite(value.value,p.min,p.max);assert(value.min===p.min&&value.max===p.max,'参数范围不允许扩大');
 }
 finite(s.timeHours);assert(Math.abs(w.clock.elapsedDays-s.timeHours/24)<1e-6,'世界时间与本地时钟不一致');
 assert(!!w.factions[s.playerFactionId]&&Array.isArray(s.activeArmyIds)&&s.activeArmyIds.length<=20&&new Set(s.activeArmyIds).size===s.activeArmyIds.length,'推演范围无效');
 assert(Object.keys(s.armies).length===Object.keys(w.armies).length&&Object.keys(s.cities).length===Object.keys(w.cities).length,'模拟对象与世界不一致');
 for(const id of s.activeArmyIds)assert(!!w.armies[id],'推演军队不存在');
 for(const [id,m] of Object.entries(s.armies)){
  const a=w.armies[id];assert(a,'模拟军队不存在');
  for(const v of [m.wounded,m.dead,m.captured,m.deserted,m.transportPeople,m.initialPeople])count(v);
  assert(a.troops+m.wounded+m.dead+m.captured+m.deserted+m.transportPeople===m.initialPeople,'军队人员账目不守恒');
  for(const v of [m.fatigue])finite(v,0,100);
  for(const v of [m.training,m.equipment])finite(v,.5,1.5);
  for(const v of [m.rationRatio,m.waterRatio])finite(v,0,1);
  for(const v of [m.lossCarry,m.recoveryCarry,m.desertCarry])finite(v,0,1);
  for(const v of [m.waterLitres,m.foodDeficitHours,m.waterDeficitHours,m.capacityKg,m.siegePower])finite(v);
  assert(a.foodKg<=m.capacityKg+1e-5,'携粮超过运力');
  if(m.roadId){const road=s.roads[m.roadId];assert(road,'道路不存在');finite(m.roadKm,0,road.distanceKm+1e-5);assert(m.atCityId===null,'在途军队不能同时驻城');}
  if(m.atCityId)assert(!!w.cities[m.atCityId]&&!m.roadId,'驻地不存在');
  if(a.location.kind==='city')assert(m.atCityId===a.location.cityId,'军队驻地与模拟驻地不一致');
  if(a.location.kind==='route')assert(m.roadId&&m.order?.actionId===a.location.actionId,'军队路线与命令不一致');
  assert(m.effects.length<=1,'同类效果不能叠加');
  for(const e of m.effects){assert(e.id==='route-familiarity'&&e.parameter==='navigation'&&e.group==='navigation'&&m.knownRoads.includes(e.roadId),'效果无依据');finite(e.factor,1,s.profile.parameters.navigationMax.value);finite(e.expiresHour);}
 }
 for(const [id,c] of Object.entries(s.cities)){
  assert(!!w.cities[id],'模拟城池不存在');count(c.residents);count(c.transportAvailable);count(c.initialResidents);
  assert(typeof c.waterAccessible==='boolean'&&typeof c.gateOpen==='boolean'&&Array.isArray(c.blockadeBy),'城市条件无效');
  for(const id of c.blockadeBy)assert(!!w.armies[id],'围城军队不存在');
 }
 for(const [id,r] of Object.entries(s.roads)){
  assert(id===r.id&&!!w.cities[r.from]&&!!w.cities[r.to]&&r.from!==r.to,'道路端点无效');
  finite(r.distanceKm,1,2000);finite(r.terrainFactor,.1,1);finite(r.weatherFactor,.1,1);finite(r.capacityPeople,1,1000000);
  assert(typeof r.open==='boolean'&&typeof r.waterAccessible==='boolean','道路条件无效');
 }
 for(const [id,c] of Object.entries(s.shipments)){
  assert(id===c.id&&!!s.roads[c.roadId]&&!!w.cities[c.sourceCityId]&&!!w.armies[c.targetArmyId],'运输对象无效');
  assert(['travelling','waiting','delivered','captured','returning','returned'].includes(c.status),'运输状态无效');
  count(c.carriers);finite(c.cargoKg);finite(c.rationKg);finite(c.roadKm,0,s.roads[c.roadId].distanceKm);finite(c.targetKm,0,s.roads[c.roadId].distanceKm);
 }
 for(const v of Object.values(s.ledger))finite(v);
 assert(Math.abs(foodTotal(w,s)+s.ledger.consumedKg+s.ledger.spoiledKg-s.ledger.initialFoodKg)<.001,'粮草收支不守恒');
 assert(peopleTotal(w,s)===s.ledger.initialPeople,'全局人员收支不守恒');
}
