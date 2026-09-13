import {projectStrategy,type StrategyData} from './strategy-view.js';
import {issueOrder,advanceWorld,validateOrder,validateAdvance} from './simulation-engine.js';
import {parseLocalCommand} from './simulation-commands.js';
import type {SimulationCommand,AdvanceCommand,SimulationReport} from './simulation-types.js';
import type {FieldChange,JsonValue,EntityRef} from './world-contracts.js';
import {createHash,randomUUID} from 'node:crypto';
import {assert,type Run} from './contracts.js';
import {buildInitialWorld} from './world-bootstrap.js';
import type {Store} from './store.js';
import type {ApplyResult,WorldStateService,InitialWorldInput,SettlementInput,WorldEvent,WorldSnapshot} from './world-contracts.js';
import {identifier,record,reduceWorld,validateSettlement,validateWorld} from './world-state.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
const digest=(value:unknown)=>createHash('sha256').update(canonical(value)).digest('hex');

/** 状态工具入口：无模型调用。所有提交由 SQLite 事务串行化，与绘图任务隔离。 */
export class WorldAgent implements WorldStateService {
  constructor(readonly store: Store) {
    store.db.exec(`CREATE TABLE IF NOT EXISTS world_states(run_id TEXT PRIMARY KEY,init_id TEXT NOT NULL,init_digest TEXT NOT NULL,basis TEXT NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_events(run_id TEXT NOT NULL,event_id TEXT NOT NULL,revision INTEGER NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,event_id),UNIQUE(run_id,revision));
      CREATE TABLE IF NOT EXISTS world_demos(request_id TEXT PRIMARY KEY,run_id TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS world_strategy_snapshots(run_id TEXT NOT NULL,decision_id TEXT NOT NULL,revision INTEGER NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,decision_id));`);
  }
  /** Called inside the caller's SQLite transaction, after the run row exists. */
  bootstrapRunInTransaction(run:Run):boolean {
    const existing=this.store.db.prepare('SELECT * FROM world_states WHERE run_id=?').get(run.id);
    if(existing){const current=JSON.parse(String(existing.payload)) as WorldSnapshot;
      if(existing.init_id!=='northern-expedition-preset-v1'||current.revision!==0||this.recentEvents(run.id).length)return false;
      const replacement=buildInitialWorld(run);if(!replacement)return false;
      this.store.db.prepare('UPDATE world_states SET init_id=?,init_digest=?,basis=?,payload=? WHERE run_id=?').run(replacement.initializationId,digest(replacement),JSON.stringify(replacement.basis),JSON.stringify(replacement.snapshot),run.id);return true;
    }
    if(this.store.history(run.id).length)return false;
    const input=buildInitialWorld(run);if(!input)return false;
    this.store.db.prepare('INSERT INTO world_states VALUES(?,?,?,?,?)').run(run.id,input.initializationId,digest(input),JSON.stringify(input.basis),JSON.stringify(input.snapshot));
    this.mirror(run.id,input.snapshot);return true;
  }
  /** Startup migration only; GET never initializes or advances a world. */
  bootstrapPendingRuns():number {
    const rows=this.store.db.prepare('SELECT id FROM runs').all();let count=0;
    for(const row of rows)this.store.transaction(()=>{const id=String(row.id);if(this.bootstrapRunInTransaction(this.store.run(id)))count++;const world=this.getWorld(id);if(world)this.archiveStrategies(world);});
    return count;
  }
  getWorld(runId:string): WorldSnapshot | null {
    this.store.run(runId); const row=this.store.db.prepare('SELECT payload FROM world_states WHERE run_id=?').get(runId);
    return row ? JSON.parse(String(row.payload)) : null;
  }
  basis(runId:string):InitialWorldInput['basis']|null {
    const row=this.store.db.prepare('SELECT basis FROM world_states WHERE run_id=?').get(runId);return row?JSON.parse(String(row.basis)):null;
  }
  initializeWorld(runId:string,raw:unknown):WorldSnapshot {
    record(raw,'初始世界输入'); identifier(raw.initializationId); validateWorld(raw.snapshot);
    assert(raw.snapshot.worldId===runId && raw.snapshot.revision===0,'初始世界编号必须对应当前对局，版本必须为0');
    record(raw.basis,'数据来源'); assert(['demo','research','mixed'].includes(String(raw.basis.kind))&&typeof raw.basis.note==='string'&&raw.basis.note.length>0&&raw.basis.note.length<5000,'需要注明初始数据来源');
    const input=raw as unknown as InitialWorldInput;
    return this.store.transaction(()=>{
      const run=this.store.run(runId),old=this.store.db.prepare('SELECT * FROM world_states WHERE run_id=?').get(runId);
      if(old){assert(old.init_id===input.initializationId&&old.init_digest===digest(input),'世界已初始化，不能用新数据覆盖',409);return JSON.parse(String(old.payload));}
      assert(input.snapshot.scenarioId===run.spec.id,'初始世界必须属于本局剧本');
      this.store.db.prepare('INSERT INTO world_states VALUES(?,?,?,?,?)').run(runId,input.initializationId,digest(input),JSON.stringify(input.basis),JSON.stringify(input.snapshot));
      this.mirror(runId,input.snapshot);return structuredClone(input.snapshot);
    });
  }
  private mirror(runId:string,w:WorldSnapshot) {
    const r=this.store.run(runId);r.world.day=w.clock.elapsedDays;r.world.version=w.revision;
    r.world.cities=Object.fromEntries(Object.values(w.cities).map(c=>[c.name,w.factions[c.ownerFactionId].name]));
    // Legacy numeric metrics remain engine-owned. Never apply an upstream delta twice.
    this.store.saveRun(r);this.archiveStrategies(w);
  }
  applySettlement(runId:string,raw:unknown):ApplyResult {
    validateSettlement(raw);const input: SettlementInput=raw;
    return this.store.transaction(()=>{
      const w=this.getWorld(runId);assert(w,'请先初始化世界',409);
      assert(!w.simulation,'本地推演对局只接受行动与时间推进，禁止外部直接改数值',409);
      const old=this.store.db.prepare('SELECT * FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.settlementId);
      if(old){assert(old.digest===digest(input),'相同事件编号对应不同内容',409);return {ok:true,alreadyApplied:true,appliedRevision:Number(old.revision),currentRevision:w.revision,eventId:input.settlementId};}
      if(input.source==='demo')assert(this.basis(runId)?.kind==='demo','演示事件不能写入正式世界',403);
      const {world,event}=reduceWorld(w,input);
      this.store.db.prepare('INSERT INTO world_events VALUES(?,?,?,?,?)').run(runId,input.settlementId,world.revision,digest(input),JSON.stringify(event));
      this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(world),runId);
      this.mirror(runId,world);
      return {ok:true,alreadyApplied:false,appliedRevision:world.revision,currentRevision:world.revision,eventId:event.id};
    });
  }
  /** A topic is one database unit. Completed decisions are immutable children of that unit. */
  strategyLibrary(cursor='',limit=100){
    assert(typeof cursor==='string'&&(cursor===''||/^[\w-]{1,120}$/.test(cursor))&&Number.isSafeInteger(limit)&&limit>=1&&limit<=200,'分页参数无效');
    const rows=this.store.db.prepare("SELECT r.id AS cursor,r.payload AS topic,w.payload AS world FROM runs r LEFT JOIN world_states w ON w.run_id=r.id WHERE (?='' OR r.id<?) AND (w.run_id IS NULL OR json_extract(w.basis,'$.kind')!='demo') ORDER BY r.id DESC LIMIT ?").all(cursor,cursor,limit);
    const maps=rows.map(row=>{
      const run=JSON.parse(String(row.topic)) as Run;
      if(!row.world)return{id:run.id,topicId:run.id,topicTitle:run.spec.title,title:run.spec.title,year:Number(run.spec.scenario.background.match(/公元\s*(\d+)\s*年/)?.[1])||0,place:Object.keys(run.world.cities).join('、'),keywords:run.spec.cast.map(p=>p.name),revision:0,status:'uninitialized',strategies:[]};
      const w=JSON.parse(String(row.world)) as WorldSnapshot;
      const strategies=Object.values(w.decisions).filter(d=>d.issuerId!=='local-defender').reverse().map(d=>({id:d.id,title:d.title,status:d.status,keywords:[d.orderText,...d.related.filter(r=>r.type==='army').map(r=>w.armies[r.id]?.commander.name||'')]}));
      const relevant=new Set(Object.values(w.actions).flatMap(a=>[a.origin.cityId,a.target.cityId]).filter((id):id is string=>!!id));
      for(const a of Object.values(w.armies).filter(a=>!w.simulation||w.simulation.activeArmyIds.includes(a.id)))if(a.location.kind==='city')relevant.add(a.location.cityId);
      return{id:run.id,topicId:run.id,topicTitle:run.spec.title,title:run.spec.title,year:Number(w.clock.startLabel.match(/公元\s*(\d+)\s*年/)?.[1])||0,
        place:[...relevant].map(id=>w.cities[id]?.name||id).join('、'),keywords:[...Object.values(w.armies).map(a=>a.commander.name),...strategies.flatMap(d=>[d.title,...d.keywords])],
        revision:w.revision,status:strategies.some(d=>['issued','executing'].includes(d.status))?'active':strategies.length?'ended':'ready',strategies};
    });
    return{maps,nextCursor:rows.length===limit?String(rows.at(-1)!.cursor):null};
  }
  private historicalStrategyWorld(current:WorldSnapshot,revision:number,events:WorldEvent[]):WorldSnapshot {
    const w=structuredClone(current);
    // Only restore display fields from the append-only audit trail. This is never a resumable simulation save.
    if(w.simulation)for(const [id,m] of Object.entries(w.simulation.armies))Object.assign(w.armies[id],{fatigue:m.fatigue,wounded:m.wounded,dead:m.dead,transportPeople:m.transportPeople});
    delete w.simulation;
    for(const e of events.filter(e=>e.revision>revision).reverse()){
      const created=new Set(e.changes.filter(c=>c.field==='id'&&c.before===null).map(c=>c.entity.type+':'+c.entity.id));
      for(const c of e.changes.slice().reverse()){
        if(c.entity.type==='clock'){if(c.field==='elapsedDays')w.clock.elapsedDays=c.before as number;continue;}
        const collection=(c.entity.type==='army'?w.armies:c.entity.type==='city'?w.cities:c.entity.type==='action'?w.actions:w.decisions) as unknown as Record<string,Record<string,JsonValue>>;
        if(created.has(c.entity.type+':'+c.entity.id)){delete collection[c.entity.id];continue;}
        const value=collection[c.entity.id];if(value)value[c.field]=structuredClone(c.before);
      }
    }
    w.revision=revision;const last=events.find(e=>e.revision===revision);if(last)w.clock.elapsedDays=last.toDay;
    validateWorld(w);return w;
  }
  private archiveStrategies(w:WorldSnapshot){
    const ended=Object.values(w.decisions).filter(d=>d.issuerId!=='local-defender'&&['completed','failed','cancelled'].includes(d.status));
    let events:WorldEvent[]|undefined;
    for(const d of ended){
      if(this.store.db.prepare('SELECT 1 FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(w.worldId,d.id))continue;
      events??=this.store.db.prepare('SELECT payload FROM world_events WHERE run_id=? ORDER BY revision').all(w.worldId).map(row=>JSON.parse(String(row.payload)));
      const end=events.find(e=>e.changes.some(c=>c.entity.type==='decision'&&c.entity.id===d.id&&c.field==='status'&&['completed','failed','cancelled'].includes(String(c.after))));
      // An imported terminal decision without a recorded end cannot masquerade as a historical snapshot.
      if(!end)continue;
      const snapshot=end.revision===w.revision?w:this.historicalStrategyWorld(w,end.revision,events);
      const data=this.strategyData(snapshot,d.id,events.filter(e=>e.revision<=end.revision).slice(-100));
      this.store.db.prepare('INSERT INTO world_strategy_snapshots VALUES(?,?,?,?)').run(w.worldId,d.id,end.revision,JSON.stringify(data));
    }
  }
  private strategyData(w:WorldSnapshot,decisionId?:string,events=this.recentEvents(w.worldId)):StrategyData {
    const data=projectStrategy(w,events,{title:this.store.run(w.worldId).spec.title,runId:w.worldId,basisNote:this.basis(w.worldId)?.note,demo:this.basis(w.worldId)?.kind==='demo'});
    data.decisions=data.decisions.filter(d=>w.decisions[d.id].issuerId!=='local-defender');
    data.focusDecisionId=decisionId||data.decisions.find(d=>['issued','executing'].includes(w.decisions[d.id].status))?.id||data.decisions[0]?.id;
    if(decisionId)data.actions=data.actions.filter(a=>a.decisionId===decisionId);
    if(!w.simulation)for(const army of data.armies){const original=w.armies[army.id] as unknown as Record<string,unknown>;for(const field of ['fatigue','wounded','dead','transportPeople'] as const)if(typeof original[field]==='number')army[field]=original[field] as number;}
    return data;
  }
  strategyMap(runId:string,decisionId?:string){
    const w=this.getWorld(runId);assert(w,'此议题尚未提供世界状态',404);
    if(decisionId){identifier(decisionId);assert(Object.hasOwn(w.decisions,decisionId)&&w.decisions[decisionId].issuerId!=='local-defender','战略不存在',404);
      if(['completed','failed','cancelled'].includes(w.decisions[decisionId].status)){
        const row=this.store.db.prepare('SELECT payload FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(runId,decisionId);
        assert(row,'此旧战略缺少可还原的结束记录；可查看议题最新状态',409);
        return{topicId:runId,decisionId,historical:true,data:JSON.parse(String(row.payload)) as StrategyData};
      }
    }
    return{topicId:runId,decisionId:decisionId||null,historical:false,data:this.strategyData(w,decisionId)};
  }
  localObservation(runId:string,factionId?:string){
    const w=this.getWorld(runId);assert(w?.simulation,'当前对局未启用本地规则',409);const s=w.simulation,id=factionId||s.playerFactionId;assert(!!w.factions[id],'势力不存在');
    return {worldId:runId,revision:w.revision,timeHours:s.timeHours,factionId:id,
      armies:Object.values(w.armies).filter(a=>a.factionId===id&&s.activeArmyIds.includes(a.id)).map(a=>({...a,condition:s.armies[a.id]})),
      cities:Object.values(w.cities).filter(c=>c.ownerFactionId===id),
      geography:Object.values(w.cities).map(c=>({id:c.id,name:c.name,point:c.point})),
      intelligence:s.intelligence.filter(i=>i.observerFactionId===id),
      rulesVersion:s.profile.id+':'+s.profile.version};
  }
  localOrder(runId:string,input:unknown):ApplyResult {
    validateOrder(input);return this.store.transaction(()=>this.applyLocalInTransaction(runId,'order',input));
  }
  localAdvance(runId:string,input:unknown):ApplyResult {
    validateAdvance(input);return this.store.transaction(()=>this.applyLocalInTransaction(runId,'advance',input));
  }
  private applyLocalInTransaction(runId:string,kind:'order'|'advance',input:SimulationCommand|AdvanceCommand):ApplyResult {
    const before=this.getWorld(runId);assert(before?.simulation,'当前对局未启用本地规则',409);
    assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
    const fingerprint=digest({kind,input}),prior=this.store.db.prepare('SELECT * FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
    if(prior){assert(prior.digest===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
    const result=kind==='order'?issueOrder(before,input as SimulationCommand):advanceWorld(before,input as AdvanceCommand);
    const w=result.world,report=result.report,changes:FieldChange[]=[],related=new Map<string,EntityRef>();
    const units:Record<string,FieldChange['unit']>={troops:'人',foodKg:'kg',morale:'分',fatigue:'分',wounded:'人',dead:'人',captured:'人',deserted:'人',defense:'分'};
    function collect(type:'army'|'city'|'action'|'decision',id:string,old:unknown,next:unknown){
      const previous=(old||{}) as Record<string,JsonValue>;
      for(const [field,after] of Object.entries(next as Record<string,JsonValue>))if(canonical(previous[field]??null)!==canonical(after)){
        changes.push({entity:{type,id},field,before:previous[field]??null,after,unit:units[field],reason:report.rulesVersion+' / '+(report.summaries.at(-1)||'本地规则结算')});
        if(type!=='decision')related.set(type+id,{type,id});
      }
    }
    for(const a of Object.values(w.armies)){collect('army',a.id,before.armies[a.id],a);collect('army',a.id,before.simulation.armies[a.id],w.simulation!.armies[a.id]);}
    for(const c of Object.values(w.cities))collect('city',c.id,before.cities[c.id],c);
    for(const a of Object.values(w.actions))collect('action',a.id,before.actions[a.id],a);
    for(const d of Object.values(w.decisions))collect('decision',d.id,before.decisions[d.id],d);
    if(w.clock.elapsedDays!==before.clock.elapsedDays)changes.push({entity:{type:'clock',id:runId},field:'elapsedDays',before:before.clock.elapsedDays,after:w.clock.elapsedDays,unit:'日',reason:'本地统一时钟'});
    const event:WorldEvent={id:input.commandId,worldId:runId,settlementId:input.commandId,decisionId:kind==='order'?Object.keys(w.decisions).find(id=>!before.decisions[id])||null:null,
      revision:w.revision,fromDay:before.clock.elapsedDays,toDay:w.clock.elapsedDays,source:'rules',title:kind==='order'?'命令已登记':report.pauseReason||'本地推演',summary:report.summaries.join('\n'),related:[...related.values()],changes,simulationReport:report};
    this.store.db.prepare('INSERT INTO world_events VALUES(?,?,?,?,?)').run(runId,event.id,w.revision,fingerprint,JSON.stringify(event));
    this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(w),runId);this.mirror(runId,w);
    return{ok:true,alreadyApplied:false,eventId:event.id,appliedRevision:w.revision,currentRevision:w.revision};
  }
  localMessage(runId:string,raw:unknown){
    record(raw,'本地消息');identifier(raw.commandId);assert(typeof raw.text==='string'&&raw.text.trim().length>0&&raw.text.length<=2000&&typeof raw.act==='boolean','消息格式无效');
    const fingerprint=digest(raw);
    return this.store.transaction(()=>{
      const run=this.store.run(runId),w=this.getWorld(runId);assert(w?.simulation,'此议题尚未配置本地战役',409);
      if(raw.to)assert(run.spec.cast.some(p=>p.id===raw.to),'目标人物不存在');
      const old=this.store.db.prepare('SELECT * FROM commands WHERE run_id=? AND command_id=?').get(runId,raw.commandId as string);
      if(old){assert(old.digest===fingerprint&&old.status==='done','相同消息编号内容不一致或未完成',409);return this.store.run(runId);}
      let resultText='本地规则不生成人物自由对话。勾选下达行动后，可输入“魏延 行军 长安”“魏延 补给 汉中 10000”或“推进 1 天”；也可接入队友角色 Agent。';
      if(raw.act){const command=parseLocalCommand(w,raw.text as string,raw.commandId as string);this.applyLocalInTransaction(runId,command.kind,command.input);const event=this.recentEvents(runId).at(-1)!;resultText=event.summary;}
      const next=this.store.run(runId);next.messages.push({id:'player-'+String(raw.commandId),kind:'player',name:'主上',text:raw.text as string},{id:'result-'+String(raw.commandId),kind:raw.act?'result':'npc',name:'史官',text:resultText});
      this.store.saveRun(next);this.store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(runId,raw.commandId as string,fingerprint,'done');return next;
    });
  }
  listEvents(runId:string,opts:{decisionId?:string;entityId?:string;afterRevision?:number;limit?:number}={}):WorldEvent[] {
    this.store.run(runId);const after=opts.afterRevision??0,limit=opts.limit??50;
    assert(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=200,'分页参数无效');
    const clauses=['run_id=?','revision>?'];const args:(string|number)[]=[runId,after];
    if(opts.decisionId){clauses.push("json_extract(payload,'$.decisionId')=?");args.push(opts.decisionId);}
    if(opts.entityId){clauses.push("EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.related')) WHERE json_extract(value,'$.id')=?)");args.push(opts.entityId);}
    args.push(limit);
    return this.store.db.prepare('SELECT payload FROM world_events WHERE '+clauses.join(' AND ')+' ORDER BY revision LIMIT ?').all(...args).map(r=>JSON.parse(String(r.payload)));
  }
  /** Page view is bounded; history API remains paginated and persistent. */
  recentEvents(runId:string):WorldEvent[]{return this.store.db.prepare('SELECT payload FROM world_events WHERE run_id=? ORDER BY revision DESC LIMIT 100').all(runId).reverse().map(r=>JSON.parse(String(r.payload)));}
  createDemo(requestId:string) {
    identifier(requestId);
    const old=this.store.db.prepare('SELECT run_id FROM world_demos WHERE request_id=?').get(requestId);if(old)return String(old.run_id);
    const id=randomUUID(),snapshot=demoWorld(id);
    this.store.transaction(()=>{
      this.store.saveRun({id,spec:{id:snapshot.scenarioId,title:'子午谷奇谋 · 世界状态演示',scenario:{background:'公元228年春。独立模拟局；所有资源和战果均为演示数据，不代表史实。'},cast:[{id:'wei-yan',name:'魏延',role:'蜀汉将领',description:'世界状态联调演示'}],metrics:[]},world:{version:0,day:0,metrics:{},cities:{}},mode:'standalone',engineTurn:0,messages:[],createdAt:new Date().toISOString()});
      this.store.db.prepare('INSERT INTO world_states VALUES(?,?,?,?,?)').run(id,'demo-init',digest(snapshot),JSON.stringify({kind:'demo',note:'独立联调演示，数值和结果不代表史实。'}),JSON.stringify(snapshot));
      this.store.db.prepare('INSERT INTO world_demos VALUES(?,?)').run(requestId,id);
      this.mirror(id,snapshot);
    });
    return id;
  }
  demoStep(runId:string,revision:unknown) {
    assert(this.basis(runId)?.kind==='demo'&&this.store.db.prepare('SELECT 1 FROM world_demos WHERE run_id=?').get(runId),'只能推进独立演示局',403);
    assert(typeof revision==='number'&&Number.isInteger(revision)&&revision>=0&&revision<4,'演示已完成或版本无效');
    return this.applySettlement(runId,demoSettlements()[revision]);
  }
}

// Data coordinates are normalized; the projection restores the supplied SVG's original pixels.
const pt=(x:number,y:number)=>({x:(x-436)/1172,y:(y-143)/662});
export function demoWorld(id:string):WorldSnapshot {
  const w:WorldSnapshot={schemaVersion:'world-state/v1',worldId:id,scenarioId:'ziwu-world-demo',mapId:'event-map-v1',revision:0,clock:{startLabel:'建兴六年 · 公元228年 · 春',elapsedDays:0},factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'}},cities:{hanzhong:{id:'hanzhong',name:'汉中',kind:'city',point:pt(810,438),ownerFactionId:'shu',governor:null,foodKg:30000,defense:70},changan:{id:'changan',name:'长安',kind:'city',point:pt(952,338),ownerFactionId:'wei',governor:null,foodKg:50000,defense:80}},armies:{'army-wei-yan':{id:'army-wei-yan',name:'魏延部',factionId:'shu',commander:{id:'wei-yan',name:'魏延'},troops:5000,foodKg:5000,morale:80,location:{kind:'city',cityId:'hanzhong'},status:'stationed'},'army-changan':{id:'army-changan',name:'长安守军',factionId:'wei',commander:{id:'demo-defender',name:'守将（演示）'},troops:3000,foodKg:2000,morale:70,location:{kind:'city',cityId:'changan'},status:'stationed'}},actions:{},decisions:{}};
  validateWorld(w);return w;
}
export function demoSettlements():SettlementInput[] {
  const common={decisionId:'decision-ziwu',source:'demo' as const};
  return [
    {...common,settlementId:'demo-departure',expectedRevision:0,elapsedDays:0,title:'魏延部出发',summary:'批准奇袭长安，魏延部离开汉中；兵力未发生损失。',mutations:[
      {kind:'decision.create',reason:'演示裁判确认命令',decision:{id:'decision-ziwu',title:'子午谷奇谋',orderText:'批准魏延率部经子午谷向长安进军。',issuerId:'player',issuedDay:0,status:'executing',related:[{type:'army',id:'army-wei-yan'},{type:'city',id:'hanzhong'},{type:'city',id:'changan'},{type:'action',id:'action-ziwu'}]}},
      {kind:'action.create',reason:'建立行动路线',action:{id:'action-ziwu',decisionId:'decision-ziwu',armyId:'army-wei-yan',kind:'attack',origin:{cityId:'hanzhong',point:pt(810,438),label:'汉中'},target:{cityId:'changan',point:pt(952,338),label:'长安'},route:[pt(810,438),pt(871,397),pt(910,389),pt(952,338)],status:'active',startedDay:0,estimatedArrivalDay:9,endedDay:null,progress:0}},
      {kind:'army.move',armyId:'army-wei-yan',location:{kind:'route',actionId:'action-ziwu'},status:'marching',reason:'部队出发'}]},
    {...common,settlementId:'demo-march',expectedRevision:1,elapsedDays:2,title:'行军两日',summary:'魏延部通过山路，粮草消耗750千克；长安仍由魏军控制。',mutations:[{kind:'army.adjust',armyId:'army-wei-yan',foodKgDelta:-750,reason:'两日行军消耗（演示）'},{kind:'action.update',actionId:'action-ziwu',patch:{progress:.3},reason:'行军进度经确认'}]},
    {...common,settlementId:'demo-arrival',expectedRevision:2,elapsedDays:7,title:'抵达长安城外',summary:'魏延部抵达城外，准备攻城；抵达不等于占领。',mutations:[{kind:'army.adjust',armyId:'army-wei-yan',foodKgDelta:-2250,reason:'后续行军消耗（演示）'},{kind:'action.update',actionId:'action-ziwu',patch:{progress:1},reason:'抵达目标附近'},{kind:'army.move',armyId:'army-wei-yan',location:{kind:'field',point:pt(921,360),label:'长安城外'},status:'besieging',reason:'驻于城外，未入城'}]},
    {...common,settlementId:'demo-battle',expectedRevision:3,elapsedDays:1,title:'攻城未克',summary:'本次模拟攻城未能破城，魏延部损失300人，转入城外休整。',mutations:[{kind:'army.adjust',armyId:'army-wei-yan',troopsDelta:-300,foodKgDelta:-300,moraleDelta:-10,reason:'模拟裁判确认战损与消耗'},{kind:'action.update',actionId:'action-ziwu',patch:{status:'failed',endedDay:10},reason:'本次进攻结束，未占城'},{kind:'army.move',armyId:'army-wei-yan',location:{kind:'field',point:pt(921,360),label:'长安城外'},status:'resting',reason:'部队休整'},{kind:'decision.update',decisionId:'decision-ziwu',status:'failed',reason:'奇袭未达成目标'}]},
  ];
}
