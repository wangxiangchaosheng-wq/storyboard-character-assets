import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,mkdirSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {Store} from '../dist/store.js';
import {WorldAgent,demoWorld,demoSettlements} from '../dist/world-agent.js';
import {makeServer} from '../dist/server.js';
const spec={id:'shared-spec',title:'诸葛亮北伐',scenario:{background:'公元228年春。汉中向长安进军。'},cast:[{id:'wei-yan',name:'魏延',role:'将领',description:'测试'}],metrics:[]};
function setup(t){mkdirSync(fileURLToPath(new URL("./.runtime/",import.meta.url)),{recursive:true});const dir=mkdtempSync(fileURLToPath(new URL('./.runtime/library-',import.meta.url))),store=new Store(dir),agent=new WorldAgent(store);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});const id=store.create(spec).id;agent.decide(id,{commandId:'settle-opening',expectedRevision:agent.getWorld(id).revision,choiceId:'decline'});return{store,agent,id,dir};}
const order=(a,id,commandId,kind,extra={})=>a.localOrder(id,{commandId,expectedRevision:a.getWorld(id).revision,armyId:'army-wei-yan',kind,...extra});
test('one topic is one data unit even when scenario ids match; reads share state without advancing',t=>{const {store,agent,id}=setup(t),second=store.create(spec).id;const index=agent.strategyLibrary();assert.equal(index.maps.length,2);assert.notEqual(id,second);assert.deepEqual(new Set(index.maps.map(m=>m.topicId)),new Set([id,second]));const snapshot=agent.getWorld(id);const map=agent.strategyMap(id);assert.equal(map.topicId,id);assert.equal(map.data.armies[0].food,snapshot.armies['army-wei-yan'].foodKg);assert.deepEqual(agent.getWorld(id),snapshot);assert.ok(index.maps.every(m=>m.status==='ready'&&m.strategies.length===0));});
test('ongoing strategy reads live changes through the same topic id',t=>{const {agent,id}=setup(t);order(agent,id,'march','march',{targetCityId:'changan'});let index=agent.strategyLibrary().maps[0];assert.equal(index.status,'active');assert.equal(index.strategies.length,1);const d=index.strategies[0].id;agent.localAdvance(id,{commandId:'day',expectedRevision:agent.getWorld(id).revision,hours:24});const map=agent.strategyMap(id,d);assert.equal(map.historical,false);assert.equal(map.data.armies.find(a=>a.id==='army-wei-yan').food,114000);assert.ok(map.data.revision>0&&map.data.revision===agent.getWorld(id).revision,'实战地图 revision 应等于当前世界版本');assert.ok(!agent.strategyLibrary().maps[0].strategies.some(d=>d.title==='驻守休整'));});
test('completed child strategy is frozen while parent topic continues; retry cannot duplicate archives',t=>{const {agent,store,id}=setup(t);// 先推 8 小时：魏延部出生即满携粮（120000=上限），不先耗掉 2000 公斤就装不下新粮
 agent.localAdvance(id,{commandId:'warmup',expectedRevision:agent.getWorld(id).revision,hours:8});const input={commandId:'load',expectedRevision:agent.getWorld(id).revision,armyId:'army-wei-yan',kind:'resupply',sourceCityId:'hanzhong',foodKg:2000};agent.localOrder(id,input);const d=agent.strategyLibrary().maps[0].strategies[0].id;const past=agent.strategyMap(id,d);assert.equal(past.historical,true);assert.equal(past.data.armies[0].food,120000);order(agent,id,'march','march',{targetCityId:'changan'});agent.localAdvance(id,{commandId:'day',expectedRevision:agent.getWorld(id).revision,hours:24});assert.deepEqual(agent.strategyMap(id,d),past);assert.equal(agent.strategyMap(id).data.armies[0].food,114000);
 // 只断言「重试不新增」：AI 守军自己的补给也会落快照，绝对值取决于敌方后勤节奏
 const archived=store.db.prepare('SELECT count(*) AS n FROM world_strategy_snapshots WHERE run_id=?').get(id).n;agent.localOrder(id,input);assert.equal(store.db.prepare('SELECT count(*) AS n FROM world_strategy_snapshots WHERE run_id=?').get(id).n,archived);const index=agent.strategyLibrary().maps[0];assert.equal(index.status,'active');assert.ok(index.strategies.length>=2);});
test('cancelled strategy stays below its own topic with correct frozen status',t=>{const {agent,id}=setup(t);order(agent,id,'out','march',{targetCityId:'changan'});agent.localAdvance(id,{commandId:'hour',expectedRevision:agent.getWorld(id).revision,hours:1});order(agent,id,'return','retreat',{targetCityId:'hanzhong'});const entries=agent.strategyLibrary().maps[0].strategies;const cancelled=entries.find(d=>d.status==='cancelled');assert.ok(cancelled);const past=agent.strategyMap(id,cancelled.id);assert.equal(past.data.focusDecisionId,cancelled.id);assert.equal(past.data.decisions.find(d=>d.id===cancelled.id).status,'已撤销');assert.equal(agent.strategyMap(id,entries.find(d=>d.status==='executing').id).historical,false);});
test('archive write failure rolls back world, event and inventory together',t=>{const {store,agent,id}=setup(t);store.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON world_strategy_snapshots BEGIN SELECT RAISE(ABORT,'test archive failure'); END;");agent.localAdvance(id,{commandId:'warmup',expectedRevision:agent.getWorld(id).revision,hours:8});// 同上：满携粮状态下装不下这 1000 公斤，先耗一点才走得到存档写入
 const before=agent.getWorld(id);const eventsBefore=agent.listEvents(id).length;assert.throws(()=>order(agent,id,'load','resupply',{sourceCityId:'hanzhong',foodKg:1000}),/archive failure/);assert.deepEqual(agent.getWorld(id),before);assert.equal(agent.listEvents(id).length,eventsBefore,'失败的军令不许留下事件');});
// G（工程审计实测：生产库 7.13GB、磁盘 98%）——战略快照表原来**只插不改、从不淘汰**，
// 每条约 300KB 且随世界复杂度膨胀，一局 360 日能到 2.7GB，是全仓唯一「再跑几个长局就
// 吃满磁盘」的机制。这里锁两条：① AI/例行代决的快照只留最近 200 条；② 玩家亲手下的
// 战略**永久保留**——战略库是玩家可分享的成果，不是缓存。
test('expired strategy snapshots are pruned; player-owned strategies are kept forever',t=>{
 const {agent,store,id}=setup(t);
 // 下一道玩家自己的军令：行军令会建一条 issuerId==='player' 的决策
 agent.localOrder(id,{commandId:'player-order',expectedRevision:agent.getWorld(id).revision,armyId:'army-wei-yan',kind:'march',targetCityId:'changan'});
 const playerIds=Object.values(agent.getWorld(id).decisions).filter(d=>d.issuerId==='player').map(d=>d.id);
 assert.ok(playerIds.length>0,'行军令应产生玩家自己的决策');
 const playerSnapId=playerIds[0];
 store.db.prepare('INSERT INTO world_strategy_snapshots VALUES(?,?,?,?)').run(id,playerSnapId,1,JSON.stringify({mine:true}));
 // 再造 210 条 AI 例行快照（revision 越大越新，淘汰按 revision 从旧的开始）
 for(let i=0;i<210;i++)store.db.prepare('INSERT OR REPLACE INTO world_strategy_snapshots VALUES(?,?,?,?)').run(id,'ai-'+i,i+2,JSON.stringify({ai:i}));
 const before=store.db.prepare('SELECT COUNT(*) AS n FROM world_strategy_snapshots WHERE run_id=?').get(id).n;
 assert.equal(before,211);
 // 触发一次归档（任意写入都会走 archiveStrategies → pruneSnapshots）
 agent.localAdvance(id,{commandId:'prune-trigger',expectedRevision:agent.getWorld(id).revision,hours:1});
 const rows=store.db.prepare('SELECT decision_id AS id FROM world_strategy_snapshots WHERE run_id=?').all(id).map(r=>r.id);
 assert.ok(rows.includes(playerSnapId),'玩家亲手下的战略必须保留');
 assert.ok(rows.length<before,'淘汰必须真的发生了（原 '+before+' → 现 '+rows.length+'）');
});
test('library pagination does not inherit the old 30-run cap and excludes demo units',t=>{const {store,agent}=setup(t);for(let i=0;i<31;i++)store.create({...spec,title:'北伐 '+i});agent.createDemo('excluded');let cursor='',ids=[];do{const page=agent.strategyLibrary(cursor,7);ids.push(...page.maps.map(m=>m.id));if(page.nextCursor===null)break;cursor=page.nextCursor;}while(true);assert.equal(ids.length,32);assert.equal(new Set(ids).size,32);assert.throws(()=>agent.strategyLibrary(-1),/分页/);});
test('startup reconstructs legacy ended snapshots before later ownership changes, including null fields',t=>{const {store,agent}=setup(t);const run=store.create({...spec,id:'external-test',title:'测试外部世界',scenario:{background:'公元228年'}});const w=demoWorld(run.id);w.scenarioId=run.spec.id;agent.initializeWorld(run.id,{initializationId:'external',snapshot:w,basis:{kind:'research',note:'测试记录'}});for(const e of demoSettlements())agent.applySettlement(run.id,{...e,source:'rules'});const past=agent.strategyMap(run.id,'decision-ziwu');agent.applySettlement(run.id,{settlementId:'later',expectedRevision:agent.getWorld(run.id).revision,decisionId:null,source:'rules',elapsedDays:1,title:'后续占领',summary:'后续独立事件',mutations:[{kind:'army.move',armyId:'army-changan',location:{kind:'field',point:w.cities.changan.point,label:'撤离'},status:'resting',reason:'撤离'},{kind:'city.capture',cityId:'changan',ownerFactionId:'shu',governor:{id:'new-governor',name:'新守将'},reason:'新事件'}]});store.db.prepare('DELETE FROM world_strategy_snapshots WHERE run_id=?').run(run.id);agent.bootstrapPendingRuns();assert.deepEqual(agent.strategyMap(run.id,'decision-ziwu'),past);assert.equal(agent.getWorld(run.id).cities.changan.ownerFactionId,'shu');});
test('HTTP library and topic map are read-only and never generate art',async t=>{const {store,agent,id}=setup(t);const server=makeServer(store,{active:false,drain(){assert.fail('read must not generate');}});await new Promise(r=>server.listen(0,'127.0.0.1',r));t.after(()=>new Promise(r=>{server.close(r);server.closeAllConnections();}));const base='http://127.0.0.1:'+server.address().port;const index=await(await fetch(base+'/strategy-library')).json();assert.equal(index.maps[0].id,id);const map=await(await fetch(base+'/runs/'+id+'/strategy-map')).json();assert.equal(map.topicId,id);assert.equal(agent.getWorld(id).revision,1,'只读不得改写世界（开局清算那一次除外）');assert.equal((await fetch(base+'/runs/'+id+'/strategy-map?decisionId=missing')).status,404);});
test('uninitialized topics have their own units without inventing map data',t=>{const {store,agent}=setup(t);const run=store.create({...spec,title:'其他时代议题',scenario:{background:'公元1000年春'}});const unit=agent.strategyLibrary().maps.find(r=>r.id===run.id);assert.equal(unit.status,'uninitialized');assert.equal(unit.year,1000);assert.equal(unit.strategies.length,0);assert.throws(()=>agent.strategyMap(run.id),/尚未提供/);});
test('pagination remains stable when a previously unseen topic changes between pages',t=>{const {store,agent}=setup(t);for(let i=0;i<4;i++)store.create(spec);const page=agent.strategyLibrary('',2);const remaining=agent.strategyLibrary(page.nextCursor,2);const id=remaining.maps[0].id;if(agent.getWorld(id).pendingDecision)agent.decide(id,{commandId:'settle-'+id,expectedRevision:agent.getWorld(id).revision,choiceId:'decline'});order(agent,id,'concurrent','march',{targetCityId:'changan'});const after=agent.strategyLibrary(page.nextCursor,2);assert.deepEqual(after.maps.map(r=>r.id),remaining.maps.map(r=>r.id));});
// H（启动性能）：bootstrapPendingRuns 原来每次启动都全量遍历所有局、把每局 world_events 全读
// 出来 JSON.parse 归档——448 局的库里启动到 health 可用要 ~50 秒（日志全是「淘汰过期战略
// 快照」）。现在每局记一枚 bootstrap_markers（上次成功归档到的 revision），没变过的局直接
// 跳过。三条回归锁死：① 不变的世界第二次 bootstrap 不再触发归档（变了才补）；② 旧库
// （标记表缺失/无标记行）仍然全量归档；③ 归档抛异常的局不写标记、修好后下次开机补得上。
const endedSetup=(t)=>{const {store,agent,id}=setup(t);// 造一条已结束且已归档的决策：补给令走完即 completed，归档随 mirror 当时落库
 agent.localAdvance(id,{commandId:'warmup',expectedRevision:agent.getWorld(id).revision,hours:8});
 agent.localOrder(id,{commandId:'load',expectedRevision:agent.getWorld(id).revision,armyId:'army-wei-yan',kind:'resupply',sourceCityId:'hanzhong',foodKg:2000});
 const ended=Object.values(agent.getWorld(id).decisions).find(d=>d.issuerId!=='local-defender'&&['completed','failed','cancelled'].includes(d.status));assert.ok(ended,'推进后应有一条结束的决策，否则归档无事可做、测不到跳过');
 return{store,agent,id,endedId:ended.id};};
const spyArchive=(agent)=>{let calls=0;const orig=agent.archiveStrategies.bind(agent);agent.archiveStrategies=(w)=>{calls++;return orig(w);};return()=>calls;};
const snapCount=(store,id)=>store.db.prepare('SELECT COUNT(*) AS n FROM world_strategy_snapshots WHERE run_id=?').get(id).n;
const markerOf=(store,id)=>store.db.prepare('SELECT revision FROM bootstrap_markers WHERE run_id=?').get(id);
test('unchanged world is skipped by the incremental archive marker; changed worlds are re-archived',t=>{
 const {store,agent,id}=endedSetup(t);
 const before=snapCount(store,id);assert.ok(before>0,'结束决策应已有快照（写入时按需归档）');
 agent.bootstrapPendingRuns();
 const rev=agent.getWorld(id).revision;
 assert.equal(markerOf(store,id)?.revision,rev,'首次 bootstrap 必须把标记写成当前 revision');
 const calls=spyArchive(agent);
 agent.bootstrapPendingRuns();
 assert.equal(calls(),0,'revision 没变的世界再 bootstrap 不得触发归档');
 assert.equal(snapCount(store,id),before,'跳过时不得改动快照表');
 assert.equal(markerOf(store,id)?.revision,rev,'跳过时不得改写标记');
 // 反方向：世界一变，标记就过期，归档照跑、标记照更新——增量标记不能把「真的变了」也漏掉
 agent.localAdvance(id,{commandId:'move',expectedRevision:agent.getWorld(id).revision,hours:2});
 const after=agent.getWorld(id).revision;assert.ok(after>rev);
 const base=calls();// 注意：localAdvance 自己就走 mirror→archiveStrategies 按需归档过一次，计数只认 bootstrap 这一趟的增量
 agent.bootstrapPendingRuns();
 assert.equal(calls(),base+1,'推进过的世界再 bootstrap 必须重新归档');
 assert.equal(markerOf(store,id)?.revision,after,'归档成功后标记必须更新到新 revision');
 assert.equal(snapCount(store,id),before,'重归档是幂等补齐，不该多出快照');
});
test('legacy library without marker rows still fully archives on first upgraded boot',t=>{
 const {store,agent,id,endedId}=endedSetup(t);
 const payload=String(store.db.prepare('SELECT payload FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(id,endedId).payload);
 // 旧库模拟一：标记表整张不存在（这一次升级之前的库）
 store.db.exec('DROP TABLE bootstrap_markers');
 store.db.prepare('DELETE FROM world_strategy_snapshots WHERE run_id=?').run(id);
 agent.bootstrapPendingRuns();
 const again=store.db.prepare('SELECT payload FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(id,endedId);
 assert.deepEqual(JSON.parse(String(again?.payload)),JSON.parse(payload),'旧库没有标记表也必须把缺失的归档补齐，内容一帧不许差');
 assert.equal(markerOf(store,id)?.revision,agent.getWorld(id).revision,'补齐后照样打标记');
 // 旧库模拟二：表在但这一局没有标记行（升级中途、标记被清）
 store.db.prepare('DELETE FROM bootstrap_markers WHERE run_id=?').run(id);
 store.db.prepare('DELETE FROM world_strategy_snapshots WHERE run_id=?').run(id);
 agent.bootstrapPendingRuns();
 const third=store.db.prepare('SELECT payload FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(id,endedId);
 assert.deepEqual(JSON.parse(String(third?.payload)),JSON.parse(payload),'没有标记行一律按从没归档过处理，绝不能因「读不到」就跳过');
});
test('a run whose archive throws gets no marker and is retried on the next boot',t=>{
 const {store,agent,id,endedId}=endedSetup(t);
 store.db.prepare('DELETE FROM world_strategy_snapshots WHERE run_id=?').run(id);
 store.db.exec("CREATE TRIGGER fail_archive BEFORE INSERT ON world_strategy_snapshots BEGIN SELECT RAISE(ABORT,'test archive failure'); END;");
 const rev=agent.getWorld(id).revision;
 agent.bootstrapPendingRuns();
 assert.ok(!markerOf(store,id),'归档被回滚的局绝不能留下标记——否则它下次就被跳过、归档缺失永远补不上');
 assert.equal(agent.getWorld(id).revision,rev,'失败的 bootstrap 不许改动世界');
 assert.equal(snapCount(store,id),0,'归档失败时快照表必须原样（事务回滚）');
 store.db.exec('DROP TRIGGER fail_archive');
 agent.bootstrapPendingRuns();
 assert.equal(markerOf(store,id)?.revision,rev,'存档修好后下次开机补打标记');
 assert.ok(store.db.prepare('SELECT 1 FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(id,endedId),'修好后归档必须真的补上');
});
test('skipped runs still get over-quota AI snapshots pruned by the cheap aggregate',t=>{
 const {store,agent,id}=endedSetup(t);
 agent.bootstrapPendingRuns();// 先打上标记：此后再 bootstrap 必走跳过路径
 const calls=spyArchive(agent);
 const playerSnap=store.db.prepare('SELECT decision_id FROM world_strategy_snapshots WHERE run_id=?').all(id)[0].decision_id;
 for(let i=0;i<210;i++)store.db.prepare('INSERT OR REPLACE INTO world_strategy_snapshots VALUES(?,?,?,?)').run(id,'ai-'+i,i+50,JSON.stringify({ai:i}));
 assert.equal(snapCount(store,id),211);
 agent.bootstrapPendingRuns();
 assert.equal(calls(),0,'标记未过期，归档不得触发');
 const rows=store.db.prepare('SELECT decision_id AS id FROM world_strategy_snapshots WHERE run_id=?').all(id).map(r=>r.id);
 assert.ok(rows.includes(playerSnap),'玩家的战略不被这条兜底误伤');
 assert.equal(rows.length,201,'被跳过的局超配的例行快照仍要被廉价聚合淘汰（210+1 → 201）');
});
