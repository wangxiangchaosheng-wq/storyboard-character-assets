import {test} from 'node:test';
import assert from 'node:assert/strict';
import {bandTroops,courierDelayDays,visibilityTier,fogReport,fogForCourt,COURIER_KM_PER_DAY,INTEL_STALE_DAYS} from '../dist/fog.js';

const road=(id,from,to,distanceKm)=>({id,from,to,distanceKm,terrainFactor:.75,capacityPeople:12000,open:true,waterAccessible:true,weatherFactor:1,source:'测试路线'});
const city=(id,ownerFactionId='shu')=>({id,name:id+'城',kind:'city',point:{x:.5,y:.5},ownerFactionId,governor:null,foodKg:20000,defense:70});
const army=(id,name,o={})=>({id,name,factionId:o.factionId??'shu',commander:{id:'cmd-'+id,name},troops:o.troops??5000,foodKg:1e5,morale:80,location:o.location??{kind:'city',cityId:o.cityId},status:o.status??'stationed'});
const intel=(enemyArmyId,seenDay,o={})=>({observerFactionId:o.observer??'shu',enemyArmyId,seenHour:seenDay*24,atCityId:o.atCityId??null,roadId:o.roadId??null,roadKm:0,estimatedTroops:o.estimatedTroops??8000});
const sim=(o={})=>({version:1,mode:'local',profile:{id:'hanzhong-local-v1',version:1,status:'experimental',parameters:{},sources:[]},
 timeHours:(o.day??10)*24,playerFactionId:o.playerFactionId??'shu',activeArmyIds:[],armies:{},cities:{},roads:o.roads??{},shipments:{},intelligence:o.intelligence,pauseReason:null,ledger:{initialFoodKg:0,consumedKg:0,spoiledKg:0,initialPeople:0,transportCaptured:0}});

function mkWorld(o={}){
 const w={schemaVersion:'world-state/v1',worldId:'w',scenarioId:'s',mapId:'m',revision:0,clock:{startLabel:'建兴六年',elapsedDays:o.day??10},
  factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'}},
  armies:{},cities:{},actions:{},decisions:{}};
 if(o.simulation!==false)w.simulation=sim({day:o.day,roads:o.roads,intelligence:o.intelligence??[],playerFactionId:o.playerFactionId});
 return w;
}

/** 标准对局：蜀有魏延部驻 c1，魏有张郃部（已被探马见到）与郭淮部（无线报）在 c2、c3。 */
function frontWorld(o={}){
 const w=mkWorld({day:o.day??10,roads:o.roads,intelligence:o.intelligence??[intel('e1',8,{atCityId:'c2'})],playerFactionId:o.playerFactionId,simulation:o.simulation});
 w.cities['c1']=city('c1');w.cities['c2']=city('c2','wei');w.cities['c3']=city('c3','wei');
 w.armies['a1']=army('a1','魏延部',{troops:4732,cityId:'c1'});
 w.armies['e1']=army('e1','张郃部',{troops:8100,cityId:'c2',factionId:'wei'});
 w.armies['e2']=army('e2','郭淮部',{troops:6000,cityId:'c2',factionId:'wei'});
 return w;
}

test('bandTroops pins every band boundary and the two constants are the documented simulation settings',()=>{
 assert.equal(bandTroops(0),'数百');assert.equal(bandTroops(499),'数百');
 assert.equal(bandTroops(500),'千余');assert.equal(bandTroops(1999),'千余');
 assert.equal(bandTroops(2000),'数千');assert.equal(bandTroops(9999),'数千');
 assert.equal(bandTroops(10000),'数万');assert.equal(bandTroops(49999),'数万');
 assert.equal(bandTroops(50000),'十数万');assert.equal(bandTroops(199999),'十数万');
 assert.equal(bandTroops(200000),'数十万众');assert.equal(bandTroops(1e6),'数十万众');
 assert.equal(COURIER_KM_PER_DAY,60);assert.equal(INTEL_STALE_DAYS,30);
});

test('courierDelayDays converts road distance to days, and zeroes out degenerate cases',()=>{
 const w=mkWorld({roads:{'r1':road('r1','c1','c2',240)}});
 w.cities['c1']=city('c1');w.cities['c2']=city('c2');
 assert.equal(courierDelayDays('c1','c2',w),4,'240 km ÷ 60 km每日 = 4 日');
 assert.equal(courierDelayDays('c2','c1',w),4,'方向无关');
 assert.equal(courierDelayDays('c1','c1',w),0,'同城返回 0');
 assert.equal(courierDelayDays('c1','nowhere',w),0,'城市不存在返回 0');
 assert.equal(courierDelayDays('nowhere','c1',w),0,'起程城不存在同样返回 0');
 const flat=mkWorld({roads:{'r0':road('r0','c1','c2',0)}});
 flat.cities['c1']=city('c1');flat.cities['c2']=city('c2');
 assert.equal(courierDelayDays('c1','c2',flat),0,'距离 0 返回 0');
 const detour=mkWorld({roads:{'r1':road('r1','c1','x',100),'r2':road('r2','c2','y',200)}});
 for(const id of ['c1','c2','x','y'])detour.cities[id]=city(id);
 assert.equal(courierDelayDays('c1','c2',detour),5,'无直达路：两城各自最长一段 100+200=300 km → 5 日');
 const dead=mkWorld({roads:{'r1':road('r1','c1','x',100)}});
 dead.cities['c1']=city('c1');dead.cities['c2']=city('c2');
 assert.equal(courierDelayDays('c1','c2',dead),2,'c2 无路可通：近似退化成 c1 单独一段 100 km → 2 日');
 const island=mkWorld({roads:{}});
 island.cities['c1']=city('c1');island.cities['c2']=city('c2');
 assert.equal(courierDelayDays('c1','c2',island),0,'两城都无路可通记 0');
 assert.equal(courierDelayDays('c1','c2',mkWorld({simulation:false})),0,'旧存档没有道路层记 0');
});

test('visibilityTier gives full to own assets, partial to fresh intel, hidden otherwise',()=>{
 assert.equal(visibilityTier({own:true,hasIntel:false,intelAgeDays:999}),'full','本方恒 full，多老的本方军报也是 full');
 assert.equal(visibilityTier({own:true,hasIntel:true,intelAgeDays:0}),'full');
 assert.equal(visibilityTier({own:false,hasIntel:true,intelAgeDays:0}),'partial');
 assert.equal(visibilityTier({own:false,hasIntel:true,intelAgeDays:INTEL_STALE_DAYS}),'partial','恰 30 日记未过期，边界含在内');
 assert.equal(visibilityTier({own:false,hasIntel:true,intelAgeDays:INTEL_STALE_DAYS+1}),'hidden','超期即 hidden');
 assert.equal(visibilityTier({own:false,hasIntel:false,intelAgeDays:0}),'hidden','无线报即 hidden');
});

test('fogReport: own armies are full with exact troops, intelled enemies partial, the rest hidden',()=>{
 const r=fogReport(frontWorld());
 assert.equal(r.observerFactionId,'shu','默认观察者是 playerFactionId');
 assert.equal(r.asOfDay,10,'默认 asOfDay 取 timeHours/24');
 const own=r.armies.find(a=>a.id==='a1');
 assert.equal(own.tier,'full');assert.equal(own.troops,4732,'本方给精确数');
 assert.equal(own.troopsBand,undefined,'full 不给段位');assert.equal(own.location,'c1城');
 assert.equal(own.seenDay,10,'驻在后方：军报当日即达');assert.equal(own.stale,false);
 const seen=r.armies.find(a=>a.id==='e1');
 assert.equal(seen.tier,'partial');assert.equal(seen.troopsBand,'数千');
 assert.equal(seen.troops,undefined,'partial 只给段位，不给精确数');
 assert.equal(seen.location,'c2城');assert.equal(seen.seenDay,8,'探马见到张郃部是第 8 日');assert.equal(seen.stale,false);
 const blind=r.armies.find(a=>a.id==='e2');
 assert.equal(blind.tier,'hidden');assert.equal(blind.troopsBand,undefined);
 assert.equal(blind.location,undefined);assert.equal(blind.seenDay,0);assert.equal(blind.stale,false);
 assert.ok(JSON.stringify(seen).includes('8100')===false,'报告里不得出现敌军精确人数');
});

test('fogReport: stale intelligence drops a partial enemy and its city to hidden',()=>{
 const w=frontWorld({day:40,intelligence:[intel('e1',9,{atCityId:'c2',estimatedTroops:8100})]});
 const r=fogReport(w);
 const seen=r.armies.find(a=>a.id==='e1');
 assert.equal(seen.tier,'hidden','过期情报不可靠：partial 降 hidden');
 assert.equal(seen.stale,true,'stale 标记保留：曾见过，只是过期了');
 const theirs=r.cities.find(c=>c.id==='c2');
 assert.equal(theirs.tier,'hidden','驻该城的敌军情报过期，城市跟着 hidden');
 assert.equal(theirs.stale,true);
 assert.equal(r.summary[0],'本方 1 军 · 已探明敌军 0 支 · 不明 2 支','过期即未探明');
});

test('fogReport: repeated intelligence for one army takes the freshest record',()=>{
 const w=frontWorld({intelligence:[intel('e1',3,{atCityId:'c3',estimatedTroops:3000}),intel('e1',8,{atCityId:'c2',estimatedTroops:8100})]});
 const seen=fogReport(w).armies.find(a=>a.id==='e1');
 assert.equal(seen.seenDay,8,'取 seenHour 最大的一条');
 assert.equal(seen.troopsBand,'数千');assert.equal(seen.location,'c2城');
});

test('fogReport: cities show garrison only as a band — even our own',()=>{
 const w=frontWorld();
 w.armies['a2']=army('a2','江州守军',{troops:1800,cityId:'c1'});
 const r=fogReport(w);
 const home=r.cities.find(c=>c.id==='c1');
 assert.equal(home.tier,'full');assert.equal(home.garrisonBand,'数千','3200+1800=5000 守军只报段位');
 assert.equal(home.controller,'蜀');assert.equal(home.seenDay,10);assert.equal(home.stale,false);
 assert.ok(!JSON.stringify(home).includes('5000'),'本方守军也不给精确数');
 const theirs=r.cities.find(c=>c.id==='c2');
 assert.equal(theirs.tier,'partial');assert.equal(theirs.garrisonBand,'数千');
 assert.equal(theirs.controller,'魏','城池归属是地图上的公开信息');assert.equal(theirs.seenDay,8);
 const blind=r.cities.find(c=>c.id==='c3');
 assert.equal(blind.tier,'hidden');assert.equal(blind.controller,undefined,'一无所知：连归属都不写');
 assert.equal(blind.garrisonBand,undefined);assert.equal(blind.seenDay,0);
});

test('fogReport: summary counts armies and names the courier delay of the freshest news',()=>{
  const w=frontWorld({roads:{'r1':road('r1','c1','c2',240)}});
  const r=fogReport(w);
  assert.equal(r.summary.length,2,'一行计数一行延迟');
  assert.equal(r.summary[0],'本方 1 军 · 已探明敌军 1 支 · 不明 1 支');
  assert.equal(r.summary[1],'信使延迟 4 日');
  assert.equal(r.courierDays,4,'最新一条情报从 c2 到后方 c1 走了 240 km → 4 日');
  assert.equal(fogReport(frontWorld()).courierDays,0,'没有情报就无所谓延迟');
});

test('B8：城市级探索情报点亮城内守军——探明城防不再「已探明敌军 0 支」',()=>{
 // QA B8 实测形态：探索令落的情报 enemyArmyId=explore-<city>（城级，不对应任何真实军队），
 // estimatedTroops 是全城守军总数。fog 曾只按真实敌军 id 精确匹配，于是 cities 有
 // garrisonBand、armies 里守军仍 hidden、summary 恒报「已探明敌军 0 支」，与探索回执
 // 「获悉守军规模与城防状态」自相矛盾。方向取 fog 侧点亮：守军规模≠精确数，段位可见。
 const w=frontWorld({intelligence:[intel('explore-c2',8,{atCityId:'c2',estimatedTroops:14100})]});
 const r=fogReport(w);
 for(const id of ['e1','e2']){
  const a=r.armies.find(x=>x.id===id);
  assert.equal(a.tier,'partial','城内守军随城级探索情报升 partial');
  assert.equal(a.troopsBand,'数万','段位取全城守军总数 8100+6000=14100');
  assert.equal(a.troops,undefined,'段位可见，精确数仍不给');
  assert.equal(a.location,'c2城','位置即该城：探索情报记的就是城池');
  assert.equal(a.seenDay,8);assert.equal(a.stale,false);
 }
 assert.ok(!JSON.stringify(r).includes('14100'),'全城合计也不得以任何形式泄漏精确数');
 assert.equal(r.summary[0],'本方 1 军 · 已探明敌军 2 支 · 不明 0 支','summary 不再恒报 0 支');
 assert.equal(r.cities.find(c=>c.id==='c2').tier,'partial','城防线照旧：两处口径一致');
 assert.equal(r.cities.find(c=>c.id==='c3').tier,'hidden','没探过的城照旧一无所知');
});

test('B8：城级情报只看自己的日子——过期降 hidden 标 stale，新鲜的能兜底过期的精确情报',()=>{
 // 精确情报（认到番号的那条）过期、城级情报还新：城级兜底点亮。过期情报比没有更误导，
 // 但不该拖着新鲜的城市探报一起瞎。
 const mixed=frontWorld({day:40,intelligence:[intel('e1',9,{atCityId:'c2',estimatedTroops:8100}),intel('explore-c2',39,{atCityId:'c2',estimatedTroops:14100})]});
 const m=fogReport(mixed);
 const e1=m.armies.find(x=>x.id==='e1');
 assert.equal(e1.tier,'partial','精确情报过期后，新鲜的城级情报兜底');
 assert.equal(e1.troopsBand,'数万','兜底的段位按全城合计');
 assert.equal(e1.seenDay,39,'见报日按城级情报算');
 assert.equal(m.summary[0],'本方 1 军 · 已探明敌军 2 支 · 不明 0 支');
 // 城级情报也过期：城内守军回 hidden，并如实标 stale（曾探明，如今瞎了）
 const old=frontWorld({day:40,intelligence:[intel('explore-c2',9,{atCityId:'c2',estimatedTroops:14100})]});
 const o=fogReport(old);
 const e2=o.armies.find(x=>x.id==='e2');
 assert.equal(e2.tier,'hidden','过期城级情报不可靠，城内守军回 hidden');
 assert.equal(e2.stale,true);
 assert.equal(o.summary[0],'本方 1 军 · 已探明敌军 0 支 · 不明 2 支','过期即未探明');
 assert.equal(o.cities.find(c=>c.id==='c2').stale,true,'城与军同一口径');
});

test('fogReport: an explicit observer sees the world from the other side',()=>{
 const r=fogReport(frontWorld(),10,'wei');
 assert.equal(r.observerFactionId,'wei');
 const own=r.armies.find(a=>a.id==='e1');
 assert.equal(own.tier,'full');assert.equal(own.troops,8100,'魏看自己的兵是精确数');
 const enemy=r.armies.find(a=>a.id==='a1');
 assert.equal(enemy.tier,'hidden','魏没有蜀军情报：蜀军音讯全无');
 const home=r.cities.find(c=>c.id==='c2');
 assert.equal(home.tier,'full');assert.equal(home.controller,'魏');
});

test('fogReport: own army reports carry the courier delay in seenDay but stay full',()=>{
 const w=frontWorld({roads:{'r1':road('r1','c1','c2',240)}});
 w.armies['a1'].cityId='c2';w.armies['a1'].location={kind:'city',cityId:'c2'};
 const a=fogReport(w).armies.find(x=>x.id==='a1');
 assert.equal(a.tier,'full');assert.equal(a.troops,4732);
 assert.equal(a.seenDay,6,'军报走了 4 日：今日所见是第 6 日的状况——本方也不是全知');
});

test('fogReport: a marching own army is full but only reports 行军途中',()=>{
 const w=mkWorld({day:10});
 w.cities['c1']=city('c1');w.cities['c2']=city('c2');
 w.actions['act1']={id:'act1',decisionId:'d1',armyId:'a1',kind:'march',origin:{cityId:'c1',point:{x:.4,y:.5},label:'c1城'},target:{cityId:'c2',point:{x:.6,y:.5},label:'c2城'},route:[],status:'active',startedDay:5,estimatedArrivalDay:15,endedDay:null,progress:.5};
 w.armies['a1']=army('a1','魏延部',{troops:4732,location:{kind:'route',actionId:'act1'}});
 const a=fogReport(w).armies.find(x=>x.id==='a1');
 assert.equal(a.tier,'full');assert.equal(a.troops,4732);
 assert.equal(a.location,'行军途中','路上的精确里程是引擎内部账，不上报');
});

test('an old save without simulation or intelligence neither throws nor omits the front',()=>{
 const w=frontWorld({simulation:false});
 const r=fogReport(w);
 assert.equal(r.asOfDay,10,'无 simulation 时 asOfDay 退化到 clock.elapsedDays');
 assert.equal(r.armies.find(a=>a.id==='a1').tier,'full','本方军队照常 full');
 assert.equal(r.armies.find(a=>a.id==='e1').tier,'hidden','没有情报层，敌军全部 hidden');
 assert.equal(r.cities.find(c=>c.id==='c2').tier,'hidden');
 assert.deepEqual(fogForCourt(w),{critical:[],notes:[]},'旧存档里没有音讯全无的本方军队');
 const bare=mkWorld({simulation:false});
 bare.simulation={timeHours:0}; // 连 intelligence 都没有的更旧存档
 assert.doesNotThrow(()=>fogReport(bare));
});

test('a world with no factions at all returns an empty report',()=>{
 const w=frontWorld();delete w.simulation;w.factions={};
 assert.deepEqual(fogReport(w),{observerFactionId:'',asOfDay:10,armies:[],cities:[],courierDays:0,summary:[]});
 assert.deepEqual(fogForCourt(w),{critical:[],notes:[]});
});

test('fogForCourt raises a major note when an own army has gone silent',()=>{
 const lost=mkWorld({day:10});
 lost.cities['c1']=city('c1');
 lost.armies['a1']=army('a1','魏延部',{troops:4732,cityId:'lost-city'}); // 城池已从簿册上消失：军报送不到
 const r=fogForCourt(lost);
 assert.deepEqual(r.critical,['major'],'音讯全无按 major 惊动玩家');
 assert.deepEqual(r.notes,['有 1 支本方军队音讯全无']);
 const healthy=mkWorld({day:10});
 healthy.cities['c1']=city('c1');healthy.armies['a1']=army('a1','魏延部',{troops:4732,cityId:'c1'});
 assert.deepEqual(fogForCourt(healthy),{critical:[],notes:[]},'军报畅通就不惊动玩家');
});

test('fogForCourt raises major when an own army is too far for fresh reports',()=>{
 const w=mkWorld({day:100,roads:{'r-far':road('r-far','c1','far',1860)}});
 w.cities['c1']=city('c1');w.cities['far']=city('far');
 w.armies['a1']=army('a1','远征军',{troops:4732,cityId:'far'});
 const a=fogReport(w).armies.find(x=>x.id==='a1');
 assert.equal(a.tier,'hidden');assert.equal(a.stale,true,'1860 km ÷ 60 = 31 日 > 30 日：最新军报送到时也已过期');
 const r=fogForCourt(w);
 assert.deepEqual(r.critical,['major']);assert.equal(r.notes[0],'有 1 支本方军队音讯全无');
});

test('fogReport is pure and deterministic: same world, same report, untouched input',()=>{
 const w=frontWorld({roads:{'r1':road('r1','c1','c2',240)},intelligence:[intel('e1',8,{atCityId:'c2'}),intel('e2',40,{atCityId:'c3'})]});
 const before=structuredClone(w);
 assert.deepEqual(fogReport(w),fogReport(w),'两次调用必须深相等');
 fogReport(w,3);fogReport(w,99,'wei');fogForCourt(w);
 assert.deepEqual(w,before,'纯函数：坏状态由裁判层改，不由迷雾改');
});
