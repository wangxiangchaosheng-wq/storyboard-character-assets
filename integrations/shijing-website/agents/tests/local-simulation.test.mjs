import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/store.js';
import {WorldAgent} from '../dist/world-agent.js';
import {buildInitialWorld} from '../dist/world-bootstrap.js';
import {advanceWorld,issueOrder} from '../dist/simulation-engine.js';
import {jumpToDay} from '../dist/jump.js';
import {validateWorld,worldVerdict,pruneDecisions} from '../dist/world-state.js';
import {foodTotal,peopleTotal} from '../dist/simulation-state.js';
import {parseLocalCommand,isGrammarRejection} from '../dist/simulation-commands.js';
import {expediteFocus} from '../dist/focuses.js';
import {expediteTech} from '../dist/techs.js';
import {evaluateForRun} from '../dist/achievement-runtime.js';
import {makeServer} from '../dist/server.js';
import {lookupEvent,acknowledgeId,DECISION_EVENTS,SEASONAL_EFFECTS} from '../dist/decisions.js';
import {reportTransitDays} from '../dist/courier.js';
import {round,seasonalActive} from '../dist/simulation-types.js';
const spec={id:'northern-test',title:'诸葛亮北伐：子午谷奇谋',scenario:{background:'公元228年春。汉中向长安进军。'},cast:[{id:'wei-yan',name:'魏延',role:'蜀汉将领',description:'测试'}],metrics:[]};
function setup(t){mkdirSync(fileURLToPath(new URL("./.runtime/",import.meta.url)),{recursive:true});const dir=mkdtempSync(fileURLToPath(new URL('./.runtime/run-',import.meta.url)));const store=new Store(dir),agent=new WorldAgent(store),run=store.create(spec);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});settleOpening(agent,run.id);return{store,agent,id:run.id,dir};}
/** 开局即摆子午谷决策卡：走 agent 层的用例先把它裁掉，否则一切军令都被拦。 */
const settleOpening=(agent,id)=>agent.decide(id,{commandId:'settle-opening',expectedRevision:agent.getWorld(id).revision,choiceId:'decline'});
function fixture(){return buildInitialWorld({id:'fixture',spec,mode:'standalone',world:{version:0,day:0,metrics:{},cities:{}},engineTurn:0}).snapshot;}
const order=(w,kind='march',extra={})=>({commandId:'order-'+w.revision,expectedRevision:w.revision,armyId:'army-wei-yan',kind,...(kind==='garrison'?{}:{targetCityId:'changan'}),...extra});
const advance=(w,hours=24)=>({commandId:'advance-'+w.revision,expectedRevision:w.revision,hours});
function balance(w){const s=w.simulation;assert.ok(Math.abs(foodTotal(w,s)+s.ledger.consumedKg+s.ledger.spoiledKg-s.ledger.initialFoodKg)<.001);assert.equal(peopleTotal(w,s),s.ledger.initialPeople);validateWorld(w);}
function atChangan(w){const a=w.armies['army-wei-yan'],m=w.simulation.armies[a.id];m.atCityId='changan';m.roadId=null;a.location={kind:'field',point:w.cities.changan.point,label:'长安城外'};a.status='resting';return w;}
test('new northern run has initialized armies, source and no invented decisions',t=>{const {agent,id}=setup(t),w=agent.getWorld(id);assert.ok(w.simulation);assert.equal(w.armies['army-wei-yan'].foodKg,120000);assert.equal(Object.keys(w.actions).length,0);assert.equal(agent.listEvents(id).length,1,'开局清算决策卡留下一条事件');assert.match(agent.basis(id).note,/模拟/);balance(w);});
test('ineligible scenarios and externally owned worlds are not auto-filled',()=>{for(const patch of [{mode:'engine'},{spec:{...spec,title:'赤壁',scenario:{background:'公元208年秋'}}},{world:{version:1,day:0,metrics:{},cities:{}}}])assert.equal(buildInitialWorld({id:'fixture',spec,mode:'standalone',world:{version:0,day:0,metrics:{},cities:{}},engineTurn:0,...patch}),null);});
// BUG-108：年份/阵营口径不合的 spec（官渡 200）不再被硬套北伐推演世界，而是落一个
// 无推演的独立世界——不冒充战役；下方专门的官渡用例覆盖这条链路。
test('BUG-108：官渡 spec 建局走无推演独立模式，绝不把魏延塞进官渡',t=>{
 mkdirSync(fileURLToPath(new URL('./.runtime/',import.meta.url)),{recursive:true});
 const dir=mkdtempSync(fileURLToPath(new URL('./.runtime/guandu-',import.meta.url)));
 const store=new Store(dir),agent=new WorldAgent(store);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const guandu={id:'guandu-spec',title:'官渡对峙·汉魏争锋',scenario:{background:'公元200年。曹操与袁绍相持于官渡，淳于琼屯乌巢。'},cast:[{id:'cao-cao',name:'曹操',role:'汉司空',description:'测试'}],metrics:[]};
 const run=store.create(guandu);
 const w=agent.getWorld(run.id);
 assert.ok(w,'官渡局应建成独立世界，而不是 422 或北伐模板');
 assert.ok(!w.simulation,'不许附带北伐推演层');
 assert.equal(Object.keys(w.armies).length,0,'不许出现魏延部');
 assert.equal(Object.keys(w.cities).length,0,'不许出现十二城样板');
 assert.equal(w.startYear,200);
 assert.match(agent.basis(run.id).note,/暂只支持随包/,'basisNote 要如实说明本局没有推演');
 assert.equal(run.messages.length,1,'UX-101：开局要有一条指路消息');
 assert.match(run.messages[0].text,/独立议题/,'指路要说清这是无推演独立局');
 // 军令入口被诚实挡下
 assert.throws(()=>agent.localJump(run.id,{commandId:'j1',expectedRevision:w.revision,targetDay:30}),/未启用本地规则/);
});

test('order does not advance time; movement consumes food and accrues fatigue without inventing casualties',()=>{let w=fixture();w=issueOrder(w,order(w)).world;assert.equal(w.clock.elapsedDays,0);const result=advanceWorld(w,advance(w));w=result.world;assert.equal(w.armies['army-wei-yan'].foodKg,114000);assert.equal(w.armies['army-wei-yan'].troops,5000);assert.ok(Math.abs(w.simulation.armies['army-wei-yan'].fatigue-28)<1e-6);// 首日约 17.6km：marchKmDay 25 × terrainFactor 0.75 × 疲劳折减。旧 20 时是 13km。
 assert.ok(w.simulation.armies['army-wei-yan'].roadKm>16&&w.simulation.armies['army-wei-yan'].roadKm<19);assert.equal(w.clock.elapsedDays,1);balance(w);});
test('arrival pauses at actual subday time and does not capture a defended city',()=>{let w=fixture();w.simulation.roads['road-ziwu'].distanceKm=3;w=issueOrder(w,order(w,'attack')).world;const r=advanceWorld(w,advance(w));assert.ok(r.report.advancedHours<24);assert.equal(r.world.cities.changan.ownerFactionId,'wei');assert.equal(r.world.armies['army-wei-yan'].troops,5000);assert.equal(r.world.simulation.armies['army-wei-yan'].atCityId,'changan');balance(r.world);});
test('simultaneous battle, deterministic replay, no dictionary iteration advantage',()=>{let w=atChangan(fixture());w=issueOrder(w,order(w,'attack')).world;const r=advanceWorld(w,advance(w,6));assert.ok(r.world.armies['army-wei-yan'].troops<5000);assert.ok(r.world.armies['army-changan'].troops<3000);assert.deepEqual(advanceWorld(w,advance(w,6)),r);const reversed=structuredClone(w);reversed.armies=Object.fromEntries(Object.entries(reversed.armies).reverse());reversed.simulation.activeArmyIds.reverse();const second=advanceWorld(reversed,advance(reversed,6));for(const id of w.simulation.activeArmyIds)assert.deepEqual(second.world.armies[id],r.world.armies[id]);balance(r.world);});
test('rest restores fatigue and wounded personnel without creating people',()=>{let w=fixture(),a=w.armies['army-wei-yan'],m=w.simulation.armies[a.id];a.troops-=100;m.wounded=100;m.fatigue=60;w=issueOrder(w,order(w,'garrison')).world;const r=advanceWorld(w,advance(w));assert.ok(r.world.simulation.armies[a.id].wounded<100);assert.ok(r.world.simulation.armies[a.id].fatigue<60);balance(r.world);});
test('hunger and zero water pause; closed road cannot be overridden by multiplier',()=>{let w=fixture();w=issueOrder(w,order(w)).world;const a=w.armies['army-wei-yan'];w.simulation.ledger.consumedKg+=a.foodKg;a.foodKg=0;
 // 绝境的定义是「后方无粮」，不是「部队手上没粮」——后者在长跳里必然出现，照它停就等于
 // 每跳必停。所以要测暂停，得把己方所有城池的粮也清空（只清蜀的，敌城留着做对照）。
 for(const c of Object.values(w.cities))if(c.ownerFactionId==='shu'){w.simulation.ledger.consumedKg+=c.foodKg;c.foodKg=0;}
 const r=advanceWorld(w,advance(w));assert.match(r.report.pauseReason,/补给/);assert.ok(r.report.advancedHours<=1);balance(r.world);const closed=fixture();closed.simulation.roads['road-ziwu'].open=false;assert.throws(()=>issueOrder(closed,order(closed,'march',{effects:[{id:'route-familiarity',factor:1.05,roadId:'road-ziwu',durationHours:24,reason:'熟悉路线'}]})),/通行/);});
test('effects have bounds, eligibility, expiry and cannot stack; raw numeric patches reject',()=>{let w=fixture();const e={id:'route-familiarity',factor:1.05,roadId:'road-ziwu',durationHours:1,reason:'熟悉路线'};assert.throws(()=>issueOrder(w,order(w,'march',{effects:[{...e,factor:2}]})),/上限/);assert.throws(()=>issueOrder(w,{...order(w),troops:9999}),/不允许/);w=issueOrder(w,order(w,'march',{effects:[e]})).world;assert.throws(()=>issueOrder(w,order(w,'march',{effects:[e]})),/重复/);w=advanceWorld(w,advance(w,2)).world;assert.equal(w.simulation.armies['army-wei-yan'].effects.length,0);balance(w);});
test('第 5/6 轮满仓出口：拨粮量 clamp 到实限不再整单拒；在途运输仍不凭空挪粮',()=>{
 // 实测痛点：满仓 12 万公斤时一切补给令整单被打回（「拨粮十二万」在余量 110076 时也拒），
 // 玩家必须自己心算余量。第 5 轮改为按实限收单、回执写明「实拨 N」。
 // 第 6 轮 BUG-119 补：开局即满仓（room=0）的 in-city 补给不再 409 硬拒——接受并落决策簿
 // 待兑现，等途中消耗腾出余量后自动接拨。
 let w=fixture();
 // 开局即满仓：接受补给令，落 decision 入簿，summary 说人话（BUG-119）
 const r0=issueOrder(w,order(w,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:1000000}));
 assert.equal(r0.world.armies['army-wei-yan'].foodKg,120000,'满仓不涨粮');
 assert.match(r0.report.summaries.join(''),/已携满.*补给令已记录/,'回执说清楚待兑现');
 assert.ok(r0.world.decisions['decision-3917a688a68a62bf38b1f0d32bd6acfd'],`满仓应在决策簿落一条 issued 态补给令`);
 assert.equal(r0.world.decisions['decision-3917a688a68a62bf38b1f0d32bd6acfd'].status,'issued','状态为 issued');
 // 余量 110076 时拨十二万：只收 110076，回执写明（第 5 轮保留）
 {const a=w.armies['army-wei-yan'];
  w.simulation.ledger.initialFoodKg=round(w.simulation.ledger.initialFoodKg-120000+9924);a.foodKg=9924;
  w.cities.hanzhong.foodKg+=260000;w.simulation.ledger.initialFoodKg+=260000;}
 const r=issueOrder(w,order(w,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:120000}));
 assert.equal(r.world.armies['army-wei-yan'].foodKg,120000,'按余量实拨到满');
 assert.match(r.report.summaries.join(''),/实拨 110076/,'回执要说清实拨多少');
 balance(r.world);
 // 在途运输不瞬移：军队上路后收粮走 shipment，军中当下不多一粒
 w.simulation.roads['road-ziwu'].distanceKm=12;w=issueOrder(w,order(w)).world;w=advanceWorld(w,advance(w,4)).world;
 const before=w.armies['army-wei-yan'].foodKg;
 w=issueOrder(w,order(w,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:1000})).world;
 assert.equal(w.armies['army-wei-yan'].foodKg,before);
 assert.equal(Object.values(w.simulation.shipments)[0].status,'travelling');balance(w);});
test('第 7 轮：探索必须指明目标城——「巡边」类无目标句语法层确定性拒绝，不落模型（BUG-122）',()=>{
 const w=fixture();
 for(const text of ['巡边','魏延巡边','探索']){
  try{parseLocalCommand(w,text,'cmd');assert.fail('应当拒绝：'+text);}
  catch(e){assert.ok(isGrammarRejection(e),`${text} 应抛 GrammarRejection（直达玩家），实际 ${e.constructor.name}`);assert.match(e.message,/探索需指明目标城池/);}
 }
 // 有目标的探索照常通过
 const r=parseLocalCommand(w,'魏延 探索 长安','cmd');
 assert.equal(r.kind==='order'&&r.input.kind,'explore');
});
test('第 7 轮：点数加急——1 点缩短 1 日、单次上限 30 日、进行中才可加急（封顶后消费出口）',()=>{
 const w=fixture();
 // 买一项国策再加急：整军经武 cost 5 / days 20
 const w1=issueOrder(w,order(w,'garrison')).world; // 占位推进无碍；直接走 focuses 层
 const st0=w.focuses;
 const day=w.simulation.timeHours/24;
 // 先采纳（直接调 adoptFocus 语义：用 agent 层太重，这里手搓等价状态）
 const focus=st0.available.find(f=>f.id==='focus-military-drill');
 const st1={...st0,points:round(st0.points),active:[...st0.active,{focusId:focus.id,startedDay:day,endsDay:day+focus.days}]};
 const {state,cost,daysCut}=expediteFocus(st1,focus.id,day);
 assert.equal(cost,Math.min(Math.floor(st1.points),focus.days,30),'加急花费=min(点数,剩余天数,30)');
 assert.equal(daysCut,cost,'1 点=1 日');
 const entry=state.active.find(a=>a.focusId===focus.id);
 assert.ok(entry.endsDay<day+focus.days,'endsDay 必须被缩短');
 // 单次上限 30：把剩余天数撑到 100 再加急
 const st2={...st1,points:100,active:[{focusId:focus.id,startedDay:day,endsDay:day+100}]};
 const r2=expediteFocus(st2,focus.id,day);
 assert.equal(r2.daysCut,30,'单次加急不得超过 30 日');
 assert.equal(r2.state.points,70);
 // 未在进行中的国策不能加急
 assert.throws(()=>expediteFocus(st0,focus.id,day),/不在进行中/);
 // 点数为 0 时拒绝
 assert.throws(()=>expediteFocus({...st1,points:0},focus.id,day),/政治点不足/);
});
test('第 7 轮：科技加急与国策同口径',()=>{
 const w=fixture(),day=w.simulation.timeHours/24;
 const st0=w.techs;
 const tech=st0.available.find(t=>!t.requires.length);
 const st1={...st0,points:80,active:[{techId:tech.id,startedDay:day,endsDay:day+40}]};
 const {state,cost,daysCut}=expediteTech(st1,tech.id,day);
 assert.equal(cost,30,'单次上限 30 日');
 assert.equal(daysCut,30);
 assert.equal(state.points,50);
 const entry=state.active.find(a=>a.techId===tech.id);
 assert.equal(entry.endsDay,day+10,'40 日工期加急 30 日后剩 10 日');
});
test('第 7 轮：粜粮济民——城粮换朝望与寒门认可，留 1 万公斤底仓，全程留痕（城粮出口）',t=>{
 const {agent,id}=setup(t);
 let w=agent.getWorld(id);
 // 把成都粮抬到 30 万，模拟长期堆积（粜粮文案阈值 20 万已过）
 const bump=agent.getWorld(id);
 bump.cities.chengdu.foodKg=300000;
 agent.store.transaction(()=>{agent.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(bump),id);agent.mirror(id,bump);});
 w=agent.getWorld(id);
 const rev=w.revision;
 const applied=agent.sellGrain(id,{commandId:'r7-sell-1',expectedRevision:rev,cityId:'chengdu',amountKg:100000});
 const after=agent.getWorld(id);
 assert.equal(after.cities.chengdu.foodKg,200000,'粜 10 万公斤后城粮减 10 万');
 assert.equal(applied.gain,4,'10 万公斤 → 每2.5万+1 → +4');
 assert.ok(after.politics.prestige>0,'朝望为正（初始 60 + 4 = 64）');
 assert.equal(Math.round(after.politics.prestige),64);
 assert.ok(after.politics.factions.commoner.approval>0,'寒门认可上升');
 assert.equal(after.politics.factions.commoner.approval,4,'寒门认可 +4');
 // 幂等：同编号重放不重复扣粮（expectedRevision 须用首次提交时的版本，指纹含该字段）
 const again=agent.sellGrain(id,{commandId:'r7-sell-1',expectedRevision:after.revision-1,cityId:'chengdu',amountKg:100000});
 assert.equal(again.alreadyApplied,true);
 assert.equal(agent.getWorld(id).cities.chengdu.foodKg,200000,'重放不再扣粮');
 // 底仓守卫：把成都压到 5 万再粜 5 万 → 拒绝（须留 1 万）
 const low=agent.getWorld(id);low.cities.chengdu.foodKg=50000;
 agent.store.transaction(()=>{agent.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(low),id);agent.mirror(id,low);});
 assert.throws(()=>agent.sellGrain(id,{commandId:'r7-sell-2',expectedRevision:agent.getWorld(id).revision,cityId:'chengdu',amountKg:50000}),/底仓/);
 // 敌城不可粜
 assert.throws(()=>agent.sellGrain(id,{commandId:'r7-sell-3',expectedRevision:agent.getWorld(id).revision,cityId:'changan',amountKg:50000}),/只能粜己方/);
});
test('capture occurs only after defenders surrender and occupying army enters',()=>{let w=atChangan(fixture());w.armies['army-changan'].morale=5;w=issueOrder(w,order(w,'attack')).world;const r=advanceWorld(w,advance(w,1));assert.equal(r.world.cities.changan.ownerFactionId,'shu');assert.equal(r.world.armies['army-wei-yan'].location.kind,'city');assert.equal(r.world.simulation.armies['army-changan'].captured,3300);assert.equal(r.world.cities.changan.foodKg,50000);balance(r.world);});
test('full replay survives database restart, stale writes, duplicate requests and raw settlement rejection',t=>{const {agent,id,dir}=setup(t);const first=order(agent.getWorld(id));agent.localOrder(id,first);const input=advance(agent.getWorld(id));agent.localAdvance(id,input);const state=agent.getWorld(id);assert.equal(agent.localAdvance(id,input).alreadyApplied,true);assert.deepEqual(agent.getWorld(id),state);assert.throws(()=>agent.localAdvance(id,{...input,commandId:'stale'}),/版本/);assert.throws(()=>agent.localAdvance(id,{...input,hours:12}),/不同内容/);const second=new Store(dir);try{const other=new WorldAgent(second);assert.deepEqual(other.getWorld(id),state);assert.equal(other.localOrder(id,first).alreadyApplied,true);}finally{second.close();}assert.throws(()=>agent.applySettlement(id,{settlementId:'patch',expectedRevision:state.revision,decisionId:null,source:'referee',elapsedDays:1,title:'x',summary:'x',mutations:[]}),/禁止/);balance(state);});
test('strict command parser never interprets questions or negations as orders',()=>{const w=fixture();for(const text of ['不要魏延进攻长安','魏延如果进攻长安','魏延进攻长安吗','魏延进攻长安，然后增加兵力'])assert.throws(()=>parseLocalCommand(w,text,'cmd'));assert.equal(parseLocalCommand(w,'魏延 进攻 长安','cmd').input.kind,'attack');assert.equal(parseLocalCommand(w,'推进 2 天','cmd').input.hours,48);});
test('HTTP local commands, reads and messages do not invoke a worker or external API',async t=>{const {agent,store,id}=setup(t);let calls=0;const server=makeServer(store,{active:false,drain(){calls++;}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const base='http://127.0.0.1:'+server.address().port;const post=(path,data)=>fetch(base+'/runs/'+id+'/'+path,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify(data)});const jobs=store.jobs(id).length;let res=await post('messages',{commandId:'msg1',text:'魏延 行军 长安',act:true});assert.equal(res.status,202,await res.clone().text());res=await post('messages',{commandId:'msg2',text:'推进 1 天',act:true});assert.equal(res.status,202,await res.clone().text());const v=await res.json();assert.equal(v.strategy.ready,true);assert.equal(v.strategy.armies.find(a=>a.id==='army-wei-yan').food,114000);const rev=agent.getWorld(id).revision;await fetch(base+'/runs/'+id);assert.equal(agent.getWorld(id).revision,rev);assert.equal(store.jobs(id).length,jobs);assert.equal(calls,0);});
test('no water means no movement; time and consumption still settle without NaN',()=>{let w=fixture();w.simulation.roads['road-ziwu'].waterAccessible=false;w.simulation.armies['army-wei-yan'].waterLitres=0;w=issueOrder(w,order(w)).world;const r=advanceWorld(w,advance(w));assert.equal(r.world.simulation.armies['army-wei-yan'].roadKm,0);assert.match(r.report.pauseReason,/供水/);balance(r.world);});
test('forced march pauses at its fatigue threshold and retreat creates a new reverse route',()=>{let w=fixture();w.simulation.armies['army-wei-yan'].fatigue=69;w=issueOrder(w,order(w,'forced-march')).world;let r=advanceWorld(w,advance(w));w=r.world;assert.match(r.report.pauseReason,/疲劳/);assert.ok(r.report.advancedHours<2);const previous=w.simulation.armies['army-wei-yan'].roadKm;w=issueOrder(w,order(w,'retreat',{targetCityId:'hanzhong'})).world;w=advanceWorld(w,advance(w)).world;assert.ok(w.simulation.armies['army-wei-yan'].atCityId==='hanzhong'||w.simulation.armies['army-wei-yan'].roadKm<previous);balance(w);});
test('transport delivers to a waiting army and returns personnel with food conserved',()=>{let w=fixture();w.simulation.roads['road-ziwu'].distanceKm=6;w=issueOrder(w,order(w)).world;w=advanceWorld(w,advance(w,3)).world;const a=w.armies['army-wei-yan'],m=w.simulation.armies[a.id];w=issueOrder(w,order(w,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:1000})).world;
 // Independent fixture holds at the agreed rendezvous, without moving or creating resources.
 const mm=w.simulation.armies[a.id],oo=mm.order;w.actions[oo.actionId].status='failed';w.actions[oo.actionId].endedDay=w.clock.elapsedDays;w.decisions[oo.id].status='failed';oo.status='failed';a.location=w.armies[a.id].location={kind:'field',point:w.cities.hanzhong.point,label:'补给会合点'};w.armies[a.id].status='resting';
 // 「是否送达」用 shipment 自己说，不用 pauseReason：补给抵达是玩家下令后的好消息、
 // 没有需要决断的事，引擎已不再因它暂停（否则玩家每补一次粮就被打断一次，长局每跳必停）。
 // 不断言「粮必须增加」：这个 fixture 的军队本来就接近满携粮出发（60000/65000），
 // 送达那点缓冲可能已被同期的口粮消耗吃掉。平衡账（balance）才是粮食守恒的判据。
 let delivered=false;for(let i=0;i<12;i++){const r=advanceWorld(w,advance(w,2));w=r.world;balance(w);
  if(Object.values(w.simulation.shipments)[0].status==='returned'){delivered=true;break;}}
 assert.equal(delivered,true,'运输队应能返程，即货物已送达');
 assert.equal(Object.values(w.simulation.shipments)[0].status,'returned');assert.equal(w.simulation.cities.hanzhong.transportAvailable,800);
});
test('long siege and starvation remain valid through repeat pauses and terminal armies',()=>{
 // 围城要自带粮草：军队在敌方城外，observe 的属地输粮只喂玩家**自己城里的**部队，
 // 孤军深入会先饿崩（实测第 21 天士气归零、粮 0）。所以只把魏延部喂足再围。
 // **不能喂长安守军**——围困的机制本就是切断守军补给，饿到士气崩才会投降
 // （实测守军粮 8700→2100、第 12 天归蜀）。喂饱它就夺不了城了。
 let w=atChangan(fixture());
 {const m=w.simulation.armies['army-wei-yan'];m.capacityKg=2e6;m.waterLitres=2e6;
  w.simulation.ledger.initialFoodKg+=2e6-w.armies['army-wei-yan'].foodKg;w.armies['army-wei-yan'].foodKg=2e6;}
 w=issueOrder(w,order(w,'besiege')).world;let captured=false;
 for(let i=0;i<400;i++){const r=advanceWorld(w,advance(w,24));w=r.world;balance(w);if(w.cities.changan.ownerFactionId==='shu'){captured=true;break;}}
 assert.equal(captured,true);});
test('advance accepts a 90-day jump and rejects anything beyond it',()=>{let w=fixture();w=issueOrder(w,order(w,'garrison')).world;
 // 两支军队都喂足，避免任何一方提前触发缺粮暂停，从而测到完整的 90 天
 for(const id of w.simulation.activeArmyIds){const m=w.simulation.armies[id];m.capacityKg=2e6;m.waterLitres=2e6;w.simulation.ledger.initialFoodKg+=2e6-w.armies[id].foodKg;w.armies[id].foodKg=2e6;}
 const r=advanceWorld(w,advance(w,2160));assert.equal(r.report.pauseReason,null);assert.ok(r.world.clock.elapsedDays>80);
 assert.throws(()=>advanceWorld(w,{...advance(w,2161)}),/2160/);balance(r.world);});
test('verdict v0 ends a run only when one faction holds every city and blocks further commands',t=>{const {store,agent,id}=setup(t);
 assert.equal(worldVerdict(agent.getWorld(id)).over,false);
 const done=structuredClone(agent.getWorld(id));for(const c of Object.values(done.cities))c.ownerFactionId='shu';
 const win=worldVerdict(done);assert.equal(win.over,true);assert.equal(win.outcome,'victory');
 store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(done),id);
 assert.throws(()=>agent.localOrder(id,order(agent.getWorld(id),'garrison')),/已终局/);
 assert.throws(()=>agent.localAdvance(id,advance(agent.getWorld(id))),/已终局/);
 const lost=structuredClone(done);for(const c of Object.values(lost.cities))c.ownerFactionId='wei';
 const defeat=worldVerdict(lost);assert.equal(defeat.over,true);assert.equal(defeat.outcome,'defeat');
 assert.equal(worldVerdict(agent.getWorld(id)).outcome,'victory');});
test('startup migrates only untouched old presets and never replaces an advanced world',t=>{const dir=mkdtempSync(fileURLToPath(new URL('./.runtime/run-',import.meta.url)));const store=new Store(dir),agent=new WorldAgent(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const id=store.create(spec).id;let w=agent.getWorld(id);delete w.simulation;w.armies['army-wei-yan'].foodKg=5000;store.db.prepare('UPDATE world_states SET init_id=?,payload=? WHERE run_id=?').run('northern-expedition-preset-v1',JSON.stringify(w),id);assert.equal(agent.bootstrapPendingRuns(),1);assert.ok(agent.getWorld(id).simulation);
  // 迁移守的「零事件、零版本」这一关过了，再裁开局决策卡、下军令
  agent.decide(id,{commandId:'settle-'+id,expectedRevision:agent.getWorld(id).revision,choiceId:acknowledgeId(lookupEvent(agent.getWorld(id).pendingDecision.eventId))});
  agent.localOrder(id,order(agent.getWorld(id)));const before=agent.getWorld(id);assert.equal(agent.bootstrapPendingRuns(),0);assert.deepEqual(agent.getWorld(id),before);});
test('role observations exclude unknown enemy resources and orders',t=>{const {agent,id}=setup(t);const o=agent.localObservation(id);assert.equal(o.armies.length,1);assert.equal(o.intelligence.length,0);assert.ok(!o.cities.some(c=>c.id==='changan'));assert.ok(!JSON.stringify(o).includes('army-changan'));});
test('reinforcement uses observed threat and leaves another home defender in place',()=>{let w=fixture(),s=w.simulation;
 const support=w.armies['army-luoyang'],home=w.armies['army-bingzhou'];home.location={kind:'city',cityId:'luoyang'};s.armies[home.id].atCityId='luoyang';s.activeArmyIds.push(support.id,home.id);
 s.roads['road-relief']={...s.roads['road-ziwu'],id:'road-relief',from:'luoyang',to:'changan',distanceKm:6};
 s.intelligence.push({observerFactionId:'wei',enemyArmyId:'army-wei-yan',seenHour:0,atCityId:'changan',roadId:null,roadKm:0,estimatedTroops:5000});
 const r=advanceWorld(w,advance(w,1));const pair=[support.id,home.id].map(id=>r.world.simulation.armies[id]);assert.equal(pair.filter(m=>m.order.kind==='march').length,1);assert.equal(pair.filter(m=>m.atCityId==='luoyang').length,1);balance(r.world);
});
test('malformed simulation input rejects before committing; reserve counting is bounded in multi-contact combat',()=>{const bad=fixture();bad.simulation.armies=null;assert.throws(()=>validateWorld(bad),/缺少/);let w=atChangan(fixture());const extra=w.armies['army-luoyang'];extra.location={kind:'city',cityId:'changan'};w.simulation.armies[extra.id].atCityId='changan';w.simulation.activeArmyIds.push(extra.id);w=issueOrder(w,order(w,'attack')).world;const r=advanceWorld(w,advance(w,1));const traces=r.report.traces.filter(t=>t.rule==='combat'&&t.entityId.includes('army-wei-yan'));let sum=0;for(const t of traces)sum+=t.entityId.startsWith('army-wei-yan')?t.inputs.aEngaged:t.inputs.bEngaged;assert.ok(sum<=2500);balance(r.world);});

test('POST /runs with a topic the world builder cannot initialize fails loudly instead of a silent empty world',async t=>{
  // 这条守一个真出过的 P0：buildInitialWorld 对议题文案有文本门槛（题目+背景要命中三国
  // 人物/势力/地名，且背景里要有「公元N年」），够不着就返回 null。此前 POST /runs 不检查，
  // 于是「建局 202、读世界 200 但 world=null」：地图全空、下令与跳转全部 409，玩家看不到
  // 任何解释，只会觉得这游戏玩不起来。真机试玩时用口语化议题一测就中招。
  const dir=mkdtempSync(fileURLToPath(new URL("./.runtime/run-",import.meta.url)));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const server=makeServer(store,{active:false,drain(){}});
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
  const base='http://127.0.0.1:'+server.address().port;
  // 能初始化的：题目/背景里同时有人物与地名
  const ok=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},
    body:JSON.stringify({spec,reuseKey:'gate-ok'})});
  assert.equal(ok.status,202,await ok.clone().text());
  // 不能初始化的：短背景，无人物名也无地名（但年份合法）
  const bad=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},
    // 题目与背景都换成不含人物/势力/地名的表述——门槛看的是两者合并后的文本，
    // 只改背景不够（题目里的「诸葛亮」会把它救回来）。
    body:JSON.stringify({spec:{...spec,title:'军中议事',scenario:{background:'公元228年春。北伐。这一局争的是粮。'}},reuseKey:'gate-bad'})});
  assert.equal(bad.status,422,'必须明确失败，不能静默返回 202');
  const err=await bad.json();
  assert.match(err.error,/本地世界没能初始化/,'错误要说清是世界没初始化');
  assert.match(err.error,/诸葛亮|魏延|曹操|汉中|长安/,'错误要给出可操作的修改建议');
  // 已知小瑕疵（如实记录，不掩盖）：422 之前 run 行已经落库，而 Store 没有删除能力，
  // 所以失败建局会留下一具没有世界的尸体对局，可能出现在 /runs 列表里。这里只断言
  // 「最多一具」而不是「一具都没有」——彻底清掉要给 Store 级联删除，是另一个改动的范围。
  const worlds=new WorldAgent(store);
  const dead=store.db.prepare('SELECT id FROM runs').all().map(r=>String(r.id)).filter(id=>worlds.getWorld(id)===null);
  assert.ok(dead.length<=1,`失败建局最多留一具体体对局，实际 ${dead.length} 具`);
});

test('a long idle game never freezes on the decision dictionary cap',t=>{
  // 这条守一个实测到的 P0：AI 自动补给每约 2.3 天记一条决策，纯挂机的对局会在第 ~1160 天
  // 触到 world-state 的 500 硬顶，此后**所有跳转与下令全部 400「决策数量超过500」**，
  // 对局永久冻结，而玩家事先没有任何预兆——等于每局都有隐形的三年寿命。
  const dir=mkdtempSync(fileURLToPath(new URL("./.runtime/run-",import.meta.url)));
  const store=new Store(dir);
  t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
  const agent=new WorldAgent(store);
  const id=store.create(spec).id;
  let blocked=null;
  // 30 天一跳：沿途每张决策卡都要各结算一次（写事件 + 全量 validateWorld），
  // 所以迭代上限留足——裁卡也要占一次。
  for(let i=0;i<140;i++){
    const w=agent.getWorld(id);
    if(w.pendingDecision){agent.decide(id,{commandId:'idle-pick-'+i,expectedRevision:w.revision,choiceId:acknowledgeId(lookupEvent(w.pendingDecision.eventId))});continue;}
    const target=Math.ceil(w.clock.elapsedDays)+30;
    try{agent.localJump(id,{commandId:'idle-'+i,expectedRevision:w.revision,targetDay:target});}
    catch(e){blocked=e;break;}
    if(agent.getWorld(id).clock.elapsedDays>=1400)break;
  }
  const world=agent.getWorld(id);
  assert.ok(!blocked,`推进到 ${world.clock.elapsedDays.toFixed(0)} 日时被拒：${blocked&&blocked.message}`);
  assert.ok(world.clock.elapsedDays>=1400,`应能推过 1400 日，实际 ${world.clock.elapsedDays.toFixed(0)} 日`);
  const kept=Object.values(world.decisions);
  assert.ok(kept.length<=500,`决策数必须守在硬上限内，实际 ${kept.length}`);
});

test('pruneDecisions drops only completed automatic rulings, never player decisions',()=>{
  // 口径逐条对应用意：只淘汰已完成、且是 AI/本地守军的例行代决；玩家的战略决策一条不删
  // （他们要在策略库与起居注里回看自己的决断）。淘汰只丢快照里的旧条目，事件流水不动。
  const mk=(id,issuerId,status,day)=>({id,issuerId,status,issuedDay:day,title:'t',orderText:'o'});
  const decisions={};
  for(let i=0;i<520;i++)decisions['auto-'+i]=mk('auto-'+i,'ai-marshal','completed',i);
  for(let i=0;i<10;i++)decisions['player-'+i]=mk('player-'+i,'player','completed',1000+i);
  decisions['active-1']=mk('active-1','ai-marshal','executing',400);
  const world={decisions};
  const removed=pruneDecisions(world);
  assert.ok(removed>0,'超软上限时必须淘汰，返回值告诉调用方删了几条');
  const left=Object.values(world.decisions);
  assert.ok(left.length<=400,`淘汰后应降到软上限以下，实际 ${left.length}`);
  assert.equal(left.filter(d=>d.issuerId==='player').length,10,'玩家的已完成决策一条都不能少');
  assert.ok(left.some(d=>d.id==='active-1'),'执行中的代决不能淘汰');
  const small={decisions:{a:mk('a','player','completed',1)}};
  assert.equal(pruneDecisions(small),0,'未超软上限时什么都不动');
});

// BUG-103：行军/进攻到脚下这座城是空令——要么合法直达要么拒得明白，不再 202 入簿
test('BUG-103：行军/进攻到本城被拒且说得明白，不再当空令写进决策簿',async t=>{
 const {agent,id}=setup(t),w=agent.getWorld(id);
 assert.throws(()=>issueOrder(w,{commandId:'same-1',expectedRevision:w.revision,armyId:'army-wei-yan',kind:'march',targetCityId:'hanzhong'}),/已驻汉中，无需行军；要休整请下驻守令/);
 assert.throws(()=>issueOrder(w,{commandId:'same-2',expectedRevision:w.revision,armyId:'army-wei-yan',kind:'attack',targetCityId:'hanzhong'}),/无从进攻本城/);
 // 全链路：localMessage 的 act=true 路径同样被 400 挡下（不再 202 + 「命令已记录」）
 await assert.rejects(()=>agent.localMessage(id,{commandId:'same-3',text:'魏延 行军 汉中',act:true}),/无需行军/);
 assert.ok(!Object.values(agent.getWorld(id).decisions).some(d=>d.title.includes('行军汉中')),'决策簿里不留这条空令');
});

// BUG-112：阅览室局（无推演）也能问对（act=false）；act=true 军令仍 409 且文案明说
test('BUG-112：阅览室局可以问对，军令 409 说清「本局未附本地推演，仅可问对与阅览」',async t=>{
 mkdirSync(fileURLToPath(new URL('./.runtime/',import.meta.url)),{recursive:true});
 const dir=mkdtempSync(fileURLToPath(new URL('./.runtime/room-',import.meta.url)));
 const store=new Store(dir),agent=new WorldAgent(store);
 t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const guandu={id:'guandu-room',title:'官渡对峙·汉魏争锋',scenario:{background:'公元200年。曹操与袁绍相持于官渡，淳于琼屯乌巢。'},cast:[{id:'cao-cao',name:'曹操',role:'汉司空',description:'测试',stance:'奉天子以令不臣'}],metrics:[]};
 const run=store.create(guandu);
 const w=agent.getWorld(run.id);
 assert.ok(w&&!w.simulation,'前置：官渡局是无推演阅览室');
 const out=await agent.localMessage(run.id,{commandId:'ask-room',text:'袁绍势大，如之奈何？',act:false,to:'cao-cao'});
 const npc=out.messages.at(-1);
 assert.equal(npc.kind,'npc');
 assert.ok(npc.text.includes('问对')&&npc.text.includes('阅览'),'阅览室口径要说清能干什么');
 assert.ok(npc.text.includes('曹操在侧'),'指名人物仍附立场台词');
 assert.ok(!/推演至第|下达行动/.test(npc.text),'不借用推演局的引导话术');
 await assert.rejects(()=>agent.localMessage(run.id,{commandId:'order-room',text:'曹操 进攻 许昌',act:true}),e=>{assert.equal(e.status,409);assert.ok(e.message.includes('本局未附本地推演，仅可问对与阅览'));return true;});
});

// UX-105：重大风险解除也要播报，不再无声消失
test('UX-105：哗变风险解除（士气回升）后，跳转汇报出现【朝局】已解/渐平一句',()=>{
 let w=fixture();
 const a=w.armies['army-wei-yan'];
 a.morale=5;
 const first=jumpToDay(w,{commandId:'ux105-a',expectedRevision:w.revision,targetDay:2});
 assert.ok(first.report.alarms.some(r=>r.kind==='mutiny'&&r.tier!=='notable'),'第一步：低士气构成 major 哗变风险');
 const w2=first.world;
 // 不手动回血：驻地休整本就会逐日回复士气——跳 12 日让 major 险自然降到 notable 档
 const second=jumpToDay(w2,{commandId:'ux105-b',expectedRevision:w2.revision,targetDay:Math.floor(w2.simulation.timeHours/24)+12});
 assert.ok(second.report.summaries.some(s=>s.startsWith('【朝局】')&&/之险已解|之险渐平/.test(s)),'风险解除要有一句【朝局】播报：'+JSON.stringify(second.report.summaries.filter(s=>s.startsWith('【朝局】'))));
});

// BUG-109：非 UTF-8 请求干净拒绝；引导失败的 spec 不留孤儿局
test('BUG-109：GBK 式坏字节 400 干净拒绝；建局失败即清局，/runs 不留乱码孤儿',async t=>{
 const {store,agent,id}=setup(t);
 const server=makeServer(store,{active:false,drain(){}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://127.0.0.1:'+server.address().port;
 const badSpec={id:'gbk-spec',title:'官渡对峙·汉魏争锋',scenario:{background:'公元200年。曹操与袁绍相持于官渡，淳于琼屯乌巢。'},cast:[{id:'cao-cao',name:'曹操',role:'汉司空',description:'测试'}],metrics:[]};
 const body=JSON.stringify({spec:badSpec});
 const idx=body.indexOf('官');
 const broken=Buffer.concat([Buffer.from(body.slice(0,idx),'utf8'),Buffer.from([0xFF,0xFE]),Buffer.from(body.slice(idx+1),'utf8')]);
 const badRes=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:broken});
 assert.equal(badRes.status,400,'非法 UTF-8 就地 400');
 const badErr=await badRes.json();
 assert.match(badErr.error,/UTF-8/,'报错要说是编码问题');
 // 修好的 spec（合法 UTF-8）走 422：内容过不了世界引导门槛
 const before=store.db.prepare('SELECT COUNT(*) n FROM runs').get().n;
 const failRes=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({spec:{id:'mars-spec',title:'火星移民计划',scenario:{background:'公元2200年。火星殖民地自治。'},cast:[{id:'cmd',name:'指挥官',role:'测试',description:'测试'}],metrics:[]}})});
 assert.equal(failRes.status,422);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs').get().n,before,'引导失败的局不留孤儿');
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM jobs').get().n,store.jobs(id).length,'孤儿任务一并清空');
});

// UX-007：DELETE /runs/{id} 整局删除，连带世界与任务数据
test('UX-007：DELETE /runs/{id} 删整局，世界/任务/事件一并清掉，再读 404',async t=>{
 const {store,agent,id}=setup(t);
 const server=makeServer(store,{active:false,drain(){}});
 await new Promise(r=>server.listen(0,'127.0.0.1',r));
 t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));
 const base='http://127.0.0.1:'+server.address().port;
 assert.ok(agent.getWorld(id),'前置：该局已有世界');
 const res=await fetch(base+'/runs/'+id,{method:'DELETE'});
 assert.equal(res.status,200);
 for(const t2 of ['world_states','jobs','world_events','commands'])assert.equal(store.db.prepare(`SELECT COUNT(*) n FROM ${t2} WHERE run_id=?`).get(id).n,0,`${t2} 应清空`);
 assert.equal(store.db.prepare('SELECT COUNT(*) n FROM runs WHERE id=?').get(id).n,0,'runs 行应删除');
 const gone=await fetch(base+'/runs/'+id);
 assert.equal(gone.status,404,'再读即 404');
});

// ── 第四轮修复（2026-09-27）：围城死锁 / 必死军令 / 运输终结 / 心跳刷屏 / 行军同城 / 胜利仪式 ──

test('BUG-116：围城中士气崩溃要真的解围后撤——暂停改变世界状态，时间不再每小时卡死',()=>{
 let w=atChangan(fixture());
 {const m=w.simulation.armies['army-wei-yan'];m.capacityKg=2e6;m.waterLitres=2e6;
  w.simulation.ledger.initialFoodKg+=2e6-w.armies['army-wei-yan'].foodKg;w.armies['army-wei-yan'].foodKg=2e6;}
 w.armies['army-wei-yan'].morale=20;
 w=issueOrder(w,order(w,'besiege')).world;
 const r1=advanceWorld(w,advance(w,24));w=r1.world;
 // 暂停落地且**世界状态已变**：攻围令停掉，部队已在撤退路上（不再钉在城下）
 assert.match(r1.report.pauseReason||'',/士气过低/);
 assert.equal(w.simulation.armies['army-wei-yan'].order.kind,'retreat');
 assert.equal(w.simulation.armies['army-wei-yan'].atCityId,null,'解围：部队离开被围城池');
 // 连续推进：每次结算都真正前进（不得每小时一停），部队最终撤回己方城池
 let hours=0,calls=0,home=false;
 for(let i=0;i<60;i++){const r=advanceWorld(w,advance(w,24));w=r.world;hours+=r.report.advancedHours;calls++;
  const a=w.armies['army-wei-yan'];
  if(a.location.kind==='city'&&a.location.cityId==='hanzhong'){home=true;break;}}
 assert.ok(home,'溃师应自动撤回汉中重整');
 assert.ok(hours>calls*2,'每次结算都要真正推进，不得退化为每次 1 小时');
 balance(w);
});

test('BUG-116：无路可退的溃师就地驻扎，处置一次后不再反复暂停',()=>{
 let w=atChangan(fixture());
 w.simulation.roads['road-ziwu'].open=false;   // 长安通蜀汉方向唯一的路封死：四顾无路
 w.armies['army-wei-yan'].morale=20;
 w=issueOrder(w,order(w,'besiege')).world;
 const r1=advanceWorld(w,advance(w,6));w=r1.world;
 assert.ok(r1.report.summaries.some(s=>/就地驻扎/.test(s)),'写清「无路可退，就地驻扎」');
 assert.equal(w.simulation.armies['army-wei-yan'].order?.status,'failed','原攻围令要真的停下');
 const r2=advanceWorld(w,advance(w,24));w=r2.world;
 assert.notEqual(r2.report.pauseReason,'部队士气过低，溃师自行撤退','处置过一次就不得再按同一个暂停');
 balance(w);
});

test('BUG-117：携粮为零的行军/进攻被拒（必死之行）；有在途补给放行；撤退不受限',()=>{
 const w=fixture();const a=w.armies['army-wei-yan'];
 w.simulation.ledger.consumedKg+=a.foodKg;a.foodKg=0;
 assert.throws(()=>issueOrder(w,order(w,'march')),e=>{assert.match(e.message,/粮秣全无，此行必溃；先补给或改道/);assert.equal(e.status,409);return true;});
 assert.throws(()=>issueOrder(w,order(w,'attack')),/粮秣全无/);
 // 在途补给=「粮在路上」：不算粮秣全无，照常放行
 w.simulation.shipments['shipment-test']={id:'shipment-test',sourceCityId:'hanzhong',targetArmyId:a.id,factionId:'shu',roadId:'road-ziwu',roadKm:0,targetKm:100,carriers:10,cargoKg:1000,rationKg:100,waterAccessible:true,status:'travelling',createdHour:0};
 w.simulation.ledger.initialFoodKg+=1100;   // 在途货物也是天下存粮：不记账就是「收支不守恒」
 w.simulation.ledger.initialPeople+=10;     // 运输人员同理进人员总账
 assert.doesNotThrow(()=>issueOrder(w,order(w,'march')));
 // 撤退不在其列：败军归巢天经地义
 const w2=fixture();const a2=w2.armies['army-wei-yan'];w2.simulation.ledger.consumedKg+=a2.foodKg;a2.foodKg=0;
 assert.doesNotThrow(()=>issueOrder(w2,{commandId:'r0',expectedRevision:w2.revision,armyId:a2.id,kind:'retreat',targetCityId:'chengdu'}),'败军归巢（撤往己方邻城）不得被拦');
});

test('BUG-118：运输队的每次终结都有史官流水——中途散失/返程入库/收货人覆没折返',()=>{
 // ① 中途散失：货与口粮在途耗尽，人员归建、货物颗粒无存
 let w=fixture();w.simulation.roads['road-ziwu'].distanceKm=12;w=issueOrder(w,order(w)).world;
 w=issueOrder(w,order(w,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:1000})).world;
 const sh=Object.values(w.simulation.shipments)[0];
 w.simulation.ledger.initialFoodKg+=1-(sh.cargoKg+sh.rationKg);sh.cargoKg=1;sh.rationKg=0;   // 同上：改存量必须连账一起改
 let lost=false;
 for(let i=0;i<10;i++){const r=advanceWorld(w,advance(w,6));w=r.world;
  if(Object.values(w.simulation.shipments)[0].status==='returned'){lost=r.report.summaries.some(s=>/散失于途/.test(s));break;}}
 assert.ok(lost,'散失要有一条史官流水');balance(w);
 // ② 返程入库：余粮入库、人员归建要记账一条
 let w2=fixture();w2.simulation.roads['road-ziwu'].distanceKm=6;w2=issueOrder(w2,order(w2)).world;w2=advanceWorld(w2,advance(w2,3)).world;
 w2=issueOrder(w2,order(w2,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:1000})).world;
 {const a=w2.armies['army-wei-yan'],mm=w2.simulation.armies[a.id],oo=mm.order;
  w2.actions[oo.actionId].status='failed';w2.actions[oo.actionId].endedDay=w2.clock.elapsedDays;
  w2.decisions[oo.id].status='failed';oo.status='failed';
  a.location={kind:'field',point:w2.cities.hanzhong.point,label:'补给会合点'};w2.armies[a.id].status='resting';}
 let back=false;
 for(let i=0;i<12;i++){const r=advanceWorld(w2,advance(w2,2));w2=r.world;
  if(Object.values(w2.simulation.shipments)[0].status==='returned'){back=r.report.summaries.some(s=>/归建/.test(s));break;}}
 assert.ok(back,'返程入库要有一条史官流水');balance(w2);
 // ③ 收货人覆没：运输队原路折返，两头都要有流水
 let w3=fixture();w3.simulation.roads['road-ziwu'].distanceKm=12;w3=issueOrder(w3,order(w3)).world;
 w3=advanceWorld(w3,advance(w3,2)).world;   // 先上路，让补给走「在途运输」分支而不是驻地即时调拨
 w3=issueOrder(w3,order(w3,'resupply',{targetCityId:undefined,sourceCityId:'hanzhong',foodKg:1000})).world;
 const a3=w3.armies['army-wei-yan'],m3=w3.simulation.armies[a3.id];
 {const oo=m3.order;   // 收货人覆没前先停掉行军：覆灭军队不得仍挂执行中的行动
  if(oo?.actionId){w3.actions[oo.actionId].status='failed';w3.actions[oo.actionId].endedDay=w3.clock.elapsedDays;}
  if(oo){oo.status='failed';if(w3.decisions[oo.id])w3.decisions[oo.id].status='failed';}
  a3.location={kind:'field',point:w3.cities.hanzhong.point,label:'覆没处'};
  m3.dead+=a3.troops;a3.troops=0;a3.status='destroyed';}
 const all=[];
 for(let i=0;i<14;i++){const r=advanceWorld(w3,advance(w3,4));w3=r.world;all.push(...r.report.summaries);
  if(Object.values(w3.simulation.shipments)[0].status==='returned')break;}
 assert.ok(all.some(s=>/折返/.test(s)),'收货人覆没要写明运输队折返');
 assert.ok(all.some(s=>/归建/.test(s)),'折返回城也要有入库流水');balance(w3);
});

test('UX-108：心跳按「内容+推演日」去重——同日同文案只落一条，次日另当别论',t=>{
 const {agent,id,store}=setup(t);
 agent.localAdvance(id,{commandId:'hb-1',expectedRevision:agent.getWorld(id).revision,hours:6});
 agent.localAdvance(id,{commandId:'hb-2',expectedRevision:agent.getWorld(id).revision,hours:6});
 const hearts=store.run(id).messages.filter(m=>m.id.startsWith('report-'));
 assert.ok(hearts.length>=1,'心跳机制仍在产');
 assert.equal(hearts.filter(m=>m.text==='本地规则已推进6小时。').length,1,'同日同文案只留一条');
 agent.localAdvance(id,{commandId:'hb-3',expectedRevision:agent.getWorld(id).revision,hours:24});
 const again=store.run(id).messages.filter(m=>m.id.startsWith('report-')&&m.text==='诸军按粮行军、无新变，推进 1 日。');
 assert.equal(again.length,1,'次日同构文案照常落一条');
});

test('UX-109：位置在城外、账面驻本城时行军本城也是空令，报人话不报「零长度」',()=>{
 let w=fixture();const a=w.armies['army-wei-yan'];
 a.location={kind:'field',point:w.cities.hanzhong.point,label:'汉中城外'};a.status='resting';
 assert.throws(()=>issueOrder(w,{commandId:'m0',expectedRevision:w.revision,armyId:a.id,kind:'march',targetCityId:'hanzhong'}),/已驻汉中，无需行军；要休整请下驻守令/);
});

test('胜利仪式感：verdict=victory 首次达成时史官当廷宣告，只报一次，成就同时解锁',t=>{
 const {agent,id,store}=setup(t);
 // 铺垫 5/12 城，再让长安守军这一小时里崩溃弃城——占领跨过半数线，胜利在本结算内达成
 const w=structuredClone(agent.getWorld(id));
 for(const c of ['chengdu','liangzhou','bingzhou','xuzhou']){w.cities[c].ownerFactionId='shu';
  for(const p of Object.values(w.provinces??{}))if(p.seatCityId===c)p.ownerFactionId='shu';   // 省归属与治所同步，否则 validateWorld 拒
  for(const g of Object.values(w.armies))if(g.location.kind==='city'&&g.location.cityId===c&&g.factionId!=='shu')
   g.location={kind:'field',point:w.cities[c].point,label:w.cities[c].name+'城外'};   // 原驻守军挪到城外：不得「驻扎在未控制的城市」
 }
 w.armies['army-changan'].morale=5;
 w.simulation.roads['road-hangu'].open=false;w.simulation.roads['road-longyou'].open=false;
 {const a=w.armies['army-wei-yan'],m=w.simulation.armies[a.id];
  m.atCityId='changan';m.roadId=null;a.location={kind:'field',point:w.cities.changan.point,label:'长安城外'};a.status='resting';}
 store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(w),id);
 agent.localOrder(id,{commandId:'win-order',expectedRevision:agent.getWorld(id).revision,armyId:'army-wei-yan',kind:'attack',targetCityId:'changan'});
 const day=Math.floor(agent.getWorld(id).clock.elapsedDays);
 agent.localAdvance(id,{commandId:'win-adv',expectedRevision:agent.getWorld(id).revision,hours:24});
 assert.equal(agent.getWorld(id).cities.changan.ownerFactionId,'shu','长安要在这段结算里易主');
 const wins=store.run(id).messages.filter(m=>m.id.startsWith('win-'));
 assert.equal(wins.length,1,'首次胜利要有一条宣告');
 assert.ok(wins[0].text.includes('此局为胜'),'宣告要带「此局为胜」');
 assert.ok(wins[0].text.includes('城池过半'),'宣告要引终局 summary');
 assert.throws(()=>agent.localAdvance(id,{commandId:'win-after',expectedRevision:agent.getWorld(id).revision,hours:1}),/已终局/);
 assert.equal(store.run(id).messages.filter(m=>m.id.startsWith('win-')).length,1,'不重复报');
 const r=evaluateForRun({runId:id,world:agent.getWorld(id),events:agent.listEvents(id),dir:store.directory});
 assert.ok(r.progress.find(p=>p.id==='campaign_victory')?.unlocked,'剧本胜利要解锁 campaign_victory');
});

// ── 第 5 轮：打长安粮账死局（在途粮道）、溃退死亡行军、季节传闻挂钩、满仓出口 ──
test('第 5 轮卡点1：在途部队收得到粮——发粮城不在路上就近改道，运输队按 roadKm 相遇点交付',()=>{
 // 实测死局：满仓 12 万在后方躺着，魏延部在子午谷上饿到 0 粮溃退，一切补给令回
 // 「没有可执行的运输路线」。现在：默认源取脚下路两端的己方城；玩家点成都也改道汉中，
 // 运输队沿同一条路按军队当前位置（相遇点）结算，正常速度追得上 0.25 倍速的爬行部队。
 let w=fixture();
 w.simulation.roads['road-ziwu'].distanceKm=12;w=issueOrder(w,order(w)).world;
 w=advanceWorld(w,advance(w,4)).world;
 const pos=w.simulation.armies['army-wei-yan'].roadKm;assert.ok(pos>0,'部队在路上');
 const a=w.armies['army-wei-yan'];w.simulation.ledger.initialFoodKg-=a.foodKg;a.foodKg=0;   // 断粮（账同步改）
 const r=issueOrder(w,order(w,'resupply',{targetCityId:undefined,sourceCityId:'chengdu',foodKg:1000}));
 const sh=Object.values(r.world.simulation.shipments);
 assert.equal(sh.length,1,'改道后运输队照发，不再 409');
 assert.equal(sh[0].sourceCityId,'hanzhong','成都不在子午谷上：改自己方一端发出');
 assert.equal(sh[0].targetKm,pos,'运输队目标是军队当前位置（相遇点交付）');
 assert.match(r.report.summaries.join(''),/改自汉中发出/,'回执要说清改道');
 w=r.world;
 let got=0;
 for(let i=0;i<20&&!got;i++){const rr=advanceWorld(w,advance(w,6));w=rr.world;
  if(rr.report.summaries.some(s=>/实际收到补给/.test(s)))got=1;else if(rr.report.pauseReason)break;}
 assert.ok(got,'在途部队应当收到粮');balance(w);
});

test('第 5 轮卡点1：出征预警算全口径（下诏＋行军＋围城），缺口超过携粮上限时明说须在途补给接应',()=>{
 // 旧口径只算行军 13 日≈78t，把满仓 12 万说成够用；实际 4＋13＋10＝27 日≈163t，
 // 大于携粮上限，玩家到城下必 0 粮溃退（实测死局）。缺口超上限时必须明说。
 const w=fixture();
 const r=issueOrder(w,order(w,'attack'));
 const line=r.report.summaries.join('');
 assert.match(line,/粮草不足/,'仍要预警');
 assert.match(line,/下诏 4 日/,'下诏驿传天数算进去');
 assert.match(line,/行军 13 日/,'行军天数算进去');
 assert.match(line,/围城 10 日/,'围城启动天数算进去');
 assert.match(line,/现携 120000 公斤/,'现携数照实说');
 assert.match(line,/途中需粮/,'缺口要换算成公斤数');assert.match(line,/此令需在途补给接应/,'缺口超过携粮上限时明说救援路径');
 balance(r.world);
});

test('第 5 轮卡点2：0 粮溃退全速撤退——逃命不省粮，败军走得回来',()=>{
 // 从前 0 粮撤退也按 0.25 倍速：240km 爬 51 日、每日逃散 1%，全程士气 0、不可干预，
 // 玩家只能看着部队磨死（实测）。0.25 倍速只适用于有粮行军的节省；溃退改为全速。
 let w=fixture();w.simulation.roads['road-ziwu'].distanceKm=120;
 w=issueOrder(w,order(w)).world;w=advanceWorld(w,advance(w,2)).world;
 const a=w.armies['army-wei-yan'];
 w.simulation.ledger.initialFoodKg-=a.foodKg;a.foodKg=0;a.morale=10;   // 断粮＋士气崩
 w.simulation.armies['army-wei-yan'].roadKm=60;                        // 放到半道上再溃逃
 w=advanceWorld(w,advance(w,1)).world;
 assert.equal(w.simulation.armies['army-wei-yan'].order?.kind,'retreat','粮尽气衰应自行退往己方城');
 const at=w.simulation.armies['army-wei-yan'].roadKm;
 const r=advanceWorld(w,advance(w,24));w=r.world;
 const back=at-w.simulation.armies['army-wei-yan'].roadKm;
 assert.ok(back>=10,'0 粮溃退应全速撤退（24h 实测 '+Math.round(back)+' km，0.25 倍速只有约 4km）');
 balance(w);
});

test('第 5 轮：季节传闻连上机制——时疫掉行军士气、夏潦慢行军、驿路修治驿报早一日，到期自解',()=>{
 // ① 军中时疫：行军部队士气日衰 1.5 分（驻扎不衰——整备正是时疫的解药）
 let w=fixture();w.simulation.seasonal=[{key:'seasonal-epidemic',untilDay:30}];
 w=issueOrder(w,order(w)).world;const morale0=w.armies['army-wei-yan'].morale;
 w=advanceWorld(w,advance(w,24)).world;
 const drop=morale0-w.armies['army-wei-yan'].morale;
 assert.ok(Math.abs(drop-1.5)<.3,'时疫行军士气日衰 1.5 分，实测 '+drop);balance(w);
 // 驻扎整备不受时疫影响：与无传闻的对照组同样的 +1.5 休整恢复
 const ctl=advanceWorld(fixture(),advance(fixture(),24)).world.armies['army-wei-yan'].morale;
 let rest=fixture();rest.simulation.seasonal=[{key:'seasonal-epidemic',untilDay:30}];
 rest=advanceWorld(rest,advance(rest,24)).world;
 assert.equal(rest.armies['army-wei-yan'].morale,ctl,'驻扎时疫不额外掉士气（休整照常恢复）');
 // ② 夏潦坏道：子午/剑阁天气修正 ×0.7（行军与运输同权）
 const flatW=(w0)=>{w0.simulation.roads['road-ziwu'].distanceKm=48;
  const w1=issueOrder(w0,order(w0)).world;return advanceWorld(w1,advance(w1,24)).world;};
 const kmFlat=flatW(fixture()).simulation.armies['army-wei-yan'].roadKm;
 const wet=fixture();wet.simulation.seasonal=[{key:'seasonal-flood',untilDay:30}];
 const kmWet=flatW(wet).simulation.armies['army-wei-yan'].roadKm;
 assert.ok(kmWet<kmFlat*.75,'夏潦慢三成：平地 '+kmFlat.toFixed(1)+'km vs 雨潦 '+kmWet.toFixed(1)+'km');
 assert.ok(kmWet>kmFlat*.65,'只慢山地那几条，不该全网漂移');
 // ③ 驿路修治：驿报早到 1 日
 {const cw=fixture();const base=reportTransitDays(cw,'changan');
  cw.simulation.seasonal=[{key:'seasonal-courier',untilDay:30}];
  assert.equal(reportTransitDays(cw,'changan'),base-1,'驿路修治早一日（汉中→长安 240km：5→4）');
  cw.simulation.seasonal=[{key:'seasonal-courier',untilDay:-1}];
  assert.equal(reportTransitDays(cw,'changan'),base,'到期的传闻不再有效');
  assert.equal(seasonalActive(cw.simulation,'seasonal-courier'),false);}
 // ④ advanceWorld 每步过滤过期传闻，状态自解
 {let ss=fixture();ss.simulation.seasonal=[{key:'seasonal-epidemic',untilDay:.01},{key:'seasonal-flood',untilDay:99}];
  ss=advanceWorld(ss,advance(ss,2)).world;
  assert.deepEqual(ss.simulation.seasonal,[{key:'seasonal-flood',untilDay:99}],'到期的撤、未到期的留');}
});

test('第 5 轮：季节传闻到案即挂 30 日状态，【朝局】行把数值写明',()=>{
 // 史册讲完之后的世界（day>1133）才有传闻卡上案：seasonal-<季数> 按季循环。
 // 季数 15%8=7 → 「驿路修治」：挂 reportTransitDays-1 的状态并写明数值。
 let w=fixture();
 // fixture 自带开局决策卡：先腾空御案，传闻卡才进得来（pendingDecision 挡着就永不发报）
 w.pendingDecision=undefined;w.resolvedDecisions={...(w.resolvedDecisions||{}),'ziwu-plan':'decline'};
 w.simulation.timeHours=1365*24;w.clock.elapsedDays=1365;
 w=advanceWorld(w,{commandId:'snd-1',expectedRevision:w.revision,hours:24*40}).world;
 assert.ok((w.incomingEvents||[]).length,'传闻应已付驿传');
 const seen=[];
 const r2=advanceWorld(w,{commandId:'snd-2',expectedRevision:w.revision,hours:24*10});
 w=r2.world;seen.push(...r2.report.summaries);
 assert.ok(w.pendingDecision,'传闻到案');
 const on=w.simulation.seasonal||[];
 assert.equal(on.length,1,'挂上一条传闻状态');
 assert.ok(SEASONAL_EFFECTS[on[0].key],'挂的是有机制的那几张');
 assert.ok(on[0].untilDay>w.simulation.timeHours/24,'未到期');
 assert.ok(seen.some(s=>/【朝局】/.test(s)&&/驿报早到 1 日，为期 30 日/.test(s)),'上案行要写明数值：'+seen.filter(s=>/朝局/.test(s)).join());
 balance(w);
 // 传闻期内驿报真的早一日；过了 30 日自解后恢复
 const fast=reportTransitDays(w,'changan');
 w.simulation.seasonal=[{key:on[0].key,untilDay:-1}];
 assert.equal(reportTransitDays(w,'changan'),fast+1,'状态自解后驿报恢复原速');
});

test('第 5 轮满仓出口（文案档）：城粮涨过阈值时史官提一句「仓廪充盈，可粜粮济民」',()=>{
 // 数字疯涨没人管：挂机几年成都能囤到千万公斤，玩家毫无实感。先解观感（纯文案），
 // 粜粮事件卡机制留档下轮。只在**上穿**阈值那一刻说，不然日日念叨刷满起居注。
 let w=fixture();const seat=w.cities.chengdu,before=seat.foodKg;
 seat.foodKg=199000;w.simulation.ledger.initialFoodKg+=199000-before;
 const r=advanceWorld(w,advance(w,48));w=r.world;
 assert.ok(r.report.summaries.some(s=>/仓廪充盈/.test(s)&&/可粜粮济民/.test(s)),'城粮过线要提一句');
 assert.ok(w.cities.chengdu.foodKg>200000,'益州日产约万斤，两日必过线');
 const r2=advanceWorld(w,advance(w,48));
 assert.ok(!r2.report.summaries.some(s=>/仓廪充盈/.test(s)),'过线之后不再重复念叨');
 balance(w);
});
