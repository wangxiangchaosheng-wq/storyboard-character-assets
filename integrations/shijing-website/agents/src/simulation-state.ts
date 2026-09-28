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
   // 魏延部（北伐军）携粮上限 120t：按 transit 约 16.7 天、6000 人日耗 6000kg 算，到长安城下
   // 需约 100t，另留 ~20t 作围城启动。65000kg 只够 10.8 天，是「奇袭流算术上无解」的主因——
   // 城里躺着 30000kg 却因容量上限带不走。守军仍是 25000，不受影响。
   capacityKg:attacking?120000:25000,waterLitres:(a.troops+transportPeople)*4,
   foodDeficitHours:0,waterDeficitHours:0,rationRatio:1,waterRatio:1,lastCombatHour:-100,
   roadId:null,roadKm:0,atCityId:a.location.kind==='city'?a.location.cityId:null,
   order:null,knownRoads:attacking?['road-ziwu']:[],effects:[],lossCarry:0,recoveryCarry:0,desertCarry:0};
 }
 // 运输人力由省人口出（P 社那套「上限量挂在人口上，不当隐藏常数」）：汉中 267,402 口
 // × 0.3% ≈ 800，与原 tuned 值一致；其余城池不再一律为 0。此前只有汉中有运力，
 // 军队一旦上路就再也收不到任何补给——实测奇袭队粮尽只能在路上爬，玩家毫无办法。
  // 率取 0.299%：汉中 267,402 口 × 0.299% = 800（与原 tuned 值逐户对齐），
  // 于是换算式子不换平衡；其余城池据此得实数运力。
  const TRANSPORT_RATE=.00299;
 const cityTransport=(cityId:string):number=>{
  const p=Object.values(w.provinces||{}).find(x=>x.seatCityId===cityId);
  return p?.census?Math.max(50,Math.round(p.census.population*TRANSPORT_RATE)):0;
 };
 const cities=Object.fromEntries(Object.values(w.cities).map(c=>[c.id,{
  residents:c.id==='changan'?5000:c.id==='hanzhong'?2000:0,
  transportAvailable:cityTransport(c.id),initialResidents:c.id==='changan'?5000:c.id==='hanzhong'?2800:0,
  waterAccessible:true,blockadeBy:[],gateOpen:false,
 }]));
 const s:SimulationState={version:1,mode:'local',profile:localProfile(),timeHours:0,playerFactionId:'shu',activeArmyIds:['army-wei-yan','army-changan'],armies,cities,
  // 第 5 轮：季节传闻的机制状态（到案即挂、到期自解）。开局空表，随传闻卡到场而增长。
  seasonal:[],
  // 道路网只通到「满携粮一次走得到」的距离：120t ≈ 20 日口粮，有效速度约 15km/日，
  // 单段超过 200km 就走不完（子午谷 240km 已是极限，实测到城下只剩 ~20t）。
  // 为什么必须有这几条路：只有汉中↔长安时，玩家最多拿下长安（3/12 城），
  // 「城池过半」的胜利线永远够不着——一局打到头也是师老无功。打通崤函、陇右、
  // 河内、鸿沟、江淮后，汉中→长安→洛阳→并州/徐州才构成一条真打得通的北伐线，
  // 且每段都在一次携粮范围内，粮道本身就是这条线的约束。
  roads:{
   'road-ziwu':{id:'road-ziwu',from:'hanzhong',to:'changan',distanceKm:240,terrainFactor:.75,capacityPeople:12000,open:true,waterAccessible:true,weatherFactor:1,
    source:'模拟路线：240km、道路容量与修正用于首版机制验证，未经历史地理校准；地图路径不参与距离换算。'},
   'road-jiange':{id:'road-jiange',from:'chengdu',to:'hanzhong',distanceKm:160,terrainFactor:.85,capacityPeople:15000,open:true,waterAccessible:true,weatherFactor:1,
    source:'模拟路线：成都—汉中，蜀中转输主道；里程按可通勤规模取，未经历史地理校准。'},
   'road-hangu':{id:'road-hangu',from:'changan',to:'luoyang',distanceKm:200,terrainFactor:.9,capacityPeople:20000,open:true,waterAccessible:true,weatherFactor:.95,
    source:'模拟路线：长安—洛阳（崤函道），出关中主路；弘农间多坂，故仍不及平地。'},
   'road-longyou':{id:'road-longyou',from:'changan',to:'liangzhou',distanceKm:200,terrainFactor:.8,capacityPeople:12000,open:true,waterAccessible:true,weatherFactor:.95,
    source:'模拟路线：长安—凉州（陇右道），河西走廊入口，道险而粮寡。'},
   'road-zhenbian':{id:'road-zhenbian',from:'luoyang',to:'bingzhou',distanceKm:160,terrainFactor:.85,capacityPeople:15000,open:true,waterAccessible:true,weatherFactor:.95,
    source:'模拟路线：洛阳—并州（河内道），跨河而北，太原之锁钥。'},
   'road-honggou':{id:'road-honggou',from:'luoyang',to:'xuzhou',distanceKm:180,terrainFactor:.95,capacityPeople:25000,open:true,waterAccessible:true,weatherFactor:1,
    source:'模拟路线：洛阳—徐州（鸿沟水网），平原漕路，通行修正是全网最好。'},
   'road-jianghuai':{id:'road-jianghuai',from:'xuzhou',to:'jingzhou',distanceKm:200,terrainFactor:.9,capacityPeople:20000,open:true,waterAccessible:true,weatherFactor:1,
    source:'模拟路线：徐州—荆州（江淮—荆襄道），东线入楚之路；吴扬之局自此可及。'},
  },
  shipments:{},intelligence:[],pauseReason:null,ledger:{initialFoodKg:0,consumedKg:0,spoiledKg:0,producedKg:0,initialPeople:0,transportCaptured:0}};
  // producedKg 记「开局之后新产的粮」。没有它，「开局国力」就算不出来——
  // initialFoodKg 被 accrueProvinceFood 一路累加，早就是「开局 + 期间产出」了。
  // 守恒式仍成立：初始(含产出) = 现量 + 消耗 + 损耗，产出只是被单列出来。
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
 // 季节传闻状态：key 必须是字符串、到期日必须有限。旧存档没有这个字段——缺了就当没有传闻，
 // 不该因此把整局旧档判废（后加字段的一贯纪律）。
 if(s.seasonal!==undefined){
  assert(Array.isArray(s.seasonal)&&s.seasonal.length<=8,'季节传闻状态无效');
  for(const x of s.seasonal){assert(typeof x.key==='string'&&x.key.length>0&&x.key.length<=60,'传闻标记无效');finite(x.untilDay);}
 }
 // 逐项查有限数。跳过 undefined：producedKg 是后加的字段，旧存档/手搓 fixture 里合法缺失
 // （缺了就当 0 用），不该因此判「数值越界」。
 for(const v of Object.values(s.ledger))if(v!==undefined)finite(v);
 if(s.ledger.producedKg===undefined)s.ledger.producedKg=0;
 assert(Math.abs(foodTotal(w,s)+s.ledger.consumedKg+s.ledger.spoiledKg-s.ledger.initialFoodKg)<.001,'粮草收支不守恒');
 assert(peopleTotal(w,s)===s.ledger.initialPeople,'全局人员收支不守恒');
}
