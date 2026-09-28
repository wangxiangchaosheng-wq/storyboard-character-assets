import {projectStrategy,type StrategyData} from './strategy-view.js';
import {issueOrder,advanceWorld,validateOrder,validateAdvance} from './simulation-engine.js';
import {parseLocalCommand,LOCAL_COMMAND_HELP} from './simulation-commands.js';
import {understandLocalCommand} from './command-understanding.js';
import {worldVerdict} from './world-state.js';
import {DECISION_EVENTS,applyDecision,lookupEvent,blockingDecision,lookupNews} from './decisions.js';
import {jumpToDay,validateJump,type JumpCommand,type JumpReport} from './jump.js';
import {runCommanderRound} from './commander-runtime.js';
import {readCommanderState,type CommanderState} from './agent-commander.js';
import {edictTransitDays,type PendingEdict} from './courier.js';
import {applyProvinceUpdate,validateProvinceUpdate,type ProvinceUpdateCommand} from './province-update.js';
import {formAlliance,declareWar} from './commander-runtime.js';
import {adoptFocus as adoptFocusPure,expediteFocus as expediteFocusPure} from './focuses.js';
import {adoptTech as adoptTechPure,expediteTech as expediteTechPure} from './techs.js';
import {adjustApproval} from './politics.js';
import {deriveFocuses} from './focus-derive.js';
import {deriveAnchors} from './anchor-derive.js';
import {mandatesFrom,directiveLine,directiveHint} from './directive.js';
import {deriveWhatIfs,whatIfSummary,type WhatIfCard} from './whatif.js';
import {applyDecisionEffect} from './decisions.js';
import {round,clamp} from './simulation-types.js';
import {anchorLine,ANCHOR_HISTORIAN_NOTE} from './anchors.js';
import {leisurePassage,counselReply} from './court.js';

/**
 * 探针：这个世界现在还能不能往前推？
 *
 * 用法是「AI 指挥官处置完暂停原因之后问一句」。返回 false 表示再推一步还是同一条暂停——
 * 那说明处置没真正解决问题（典型的：补给是**在途运输**，军队手上仍是 0 粮），
 * 这一条暂停必须照旧报给玩家，不能靠 continue 糊过去。
 *
 * 在 structuredClone 上跑，不碰真实世界；时钟/乱数都不外泄。
 */
function canAdvanceFurther(w:WorldSnapshot,reason:string):boolean{
  try{
    const probe=structuredClone(w);
    const r=advanceWorld(probe,{commandId:'advance-probe',expectedRevision:probe.revision,hours:1});
    return r.report.pauseReason!==reason;
  }catch{return false;}
}
import type {SimulationCommand,AdvanceCommand,SimulationReport,OrderKind} from './simulation-types.js';

import type {FieldChange,JsonValue,EntityRef} from './world-contracts.js';
import {createHash,randomUUID} from 'node:crypto';
import {assert,type Run} from './contracts.js';
import {buildInitialWorld} from './world-bootstrap.js';
import type {Store} from './store.js';
import type {ApplyResult,WorldStateService,InitialWorldInput,SettlementInput,WorldEvent,WorldSnapshot} from './world-contracts.js';
import {identifier,record,reduceWorld,validateSettlement,validateWorld,pruneDecisions} from './world-state.js';

function canonical(value: unknown): string {
  if (Array.isArray(value)) return '['+value.map(canonical).join(',')+']';
  if (value && typeof value==='object') return '{'+Object.keys(value).sort().map(k=>JSON.stringify(k)+':'+canonical((value as Record<string,unknown>)[k])).join(',')+'}';
  return JSON.stringify(value);
}
/** UX-010：军令类型 → 玩家口径的中文动词。英文枚举只活在代码与 trace 里，不进叙事。 */
const ORDER_KIND_CN:Record<OrderKind,string>={march:'行军','forced-march':'急行军',garrison:'驻守',resupply:'补给',attack:'进攻',besiege:'围困',retreat:'撤退',explore:'探索'};
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
    // 开局指路：不指路，新玩家点开议题只看到一张地图和一排面板，不知道桌上有张决策卡
    // 等着裁、也不知道能在输入框里直接打字下令——试玩反馈的原话是「玩不起来」。
    // buildInitialWorld 是纯函数，压不了 message，所以在这里写；revision==0 时只加一次。
    // UX-101：spec 路径（含无推演独立局）同样开局零引导——三种开局各有各的指路话。
    if(run.messages.length===0){
     const opening=(text:string)=>{run.messages.push({id:'opening-'+run.id,kind:'npc',name:'史官',text});this.store.saveRun(run);};
     if(input.snapshot.pendingDecision){
      const title=lookupEvent(input.snapshot.pendingDecision.eventId)?.title??'初始决策';
      opening(`主上，北伐之议已决于目前。案上摆着第一道决策：${title}——打开右侧局势图即可看到并裁决。此后要在军议厅里吩咐，可直接写「魏延 进攻 长安」「推进 1 天」，口语目前只认「X 进攻 Y」「推进 N 天」两种写法，请照这两句的格式写；说得再浅我也会回一句「无法识别」。`);
     }else if(input.snapshot.simulation){
      opening('主上，本局推演已就绪，案上暂无待决之事。可在军议厅里勾选「下达行动」直接下令，如「魏延 进攻 长安」「魏延 补给 汉中 10000」「推进 1 天」；也可整句托付方略，如「先取长安，三年不出斜谷」，诸卿自当奉行。');
     }else{
      // BUG-108：无推演独立局也要如实告诉玩家本局能干什么、不能干什么。
      opening('主上，此议已立为独立议题：本地推演暂只支持随包的三国剧本，本局不启战役推演。人物图谱与故事板照常可看，亦可向诸人问对；若要行军打仗、推演粮道，请另开一局随包剧本（如「子午谷之议」）。');
     }
    }
    this.mirror(run.id,input.snapshot);return true;
  }
  /**
   * 开局后按剧本年份补史实时间线（异步）。228 年北伐用预设 36 条，别的年代（官渡 200、
   * 赤壁 208…）预设一条都不适用，这里让模型按议题与起始年份读一份出来。
   * 派生失败（没 key/超时/答非所问/校验不过）就保留空时间线——**没有史实新闻也好过
   * 拿 228 年的史事冒充别的年代**。军令、国策、外交、省政照旧可玩。
   */
  async refreshDerivedAnchors(runId:string){
    const run=this.store.run(runId),w=this.getWorld(runId);
    if(!w||!w.startYear)return{derived:0,reason:'没有起始年份'};
    if((w.anchors||[]).length)return{derived:0,reason:'已用预设时间线'};
    const seasonOfStart=run.spec.scenario.background.match(/年\s*([春夏秋冬])/)?.[1]||'春';
    const derived=await deriveAnchors(run.spec.title+' '+run.spec.scenario.background,w.startYear,seasonOfStart);
    if(!derived.length)return{derived:0,reason:'读不出该年份的史实，本局不设史实新闻'};
    // 派生要几秒网络往返，期间玩家可能已经在推进/下令，写事务会撞 SQLITE_BUSY。
    // 退避重试两次仍失败就当这局没有史实新闻——不阻塞玩家，也不假造史实。
    for(const wait of [0,300,900]){
      if(wait)await new Promise(r=>setTimeout(r,wait));
      try{
        return this.store.transaction(()=>{
          const current=this.getWorld(runId);
          if(!current||!current.startYear)return{derived:0,reason:'世界已不在'};
          if((current.anchors||[]).length)return{derived:0,reason:'已有时间线'};
          const next:WorldSnapshot={...current,anchors:derived,revision:current.revision+1};
          this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(next),runId);
          this.mirror(runId,next);
          // **补报被越过的锚点**：派生是异步的，玩家可能已经推进了几天。此时若只把锚点
          // 写进快照，那些 day 已被 fromDay 越过的条目永远跨不出来——起居注里一条没有，
          // 而投影的「往事」里却显示它们已发生（实测：208 局推进 90 日后只见到 1 条）。
          // 这里按 dailyNotes 的口径补一条事件，把漏掉的当「既成之事」交代清楚。
          const missed=derived.filter(a=>a.day<=current.simulation!.timeHours/24);
          if(missed.length){
            const nowDay=current.simulation!.timeHours/24;
            const report:SimulationReport={commandId:'derived-anchors-'+runId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'anchor-derive/v1',traces:[],
              // BUG-106：史实条目统一冠【史册】标并附史官按——玩家裁决过的事件（如「全师还汉中」）
              // 与史册记载（「魏延西入羌中大破郭淮」）是两说，起居注必须让玩家分得清哪个是本局现实。
              summaries:[...missed.map(anchorLine),ANCHOR_HISTORIAN_NOTE]};
            this.store.db.prepare('INSERT INTO world_events VALUES(?,?,?,?,?)').run(runId,'derived-anchors-'+runId,current.revision+1,'anchor-derive',JSON.stringify({id:'derived-anchors-'+runId,worldId:runId,settlementId:'derived-anchors-'+runId,decisionId:null,revision:current.revision+1,fromDay:0,toDay:nowDay,source:'rules',title:'史实时间线',summary:report.summaries.join('\n'),related:[],changes:[],simulationReport:report}));
          }
          return{derived:derived.length,missed:missed.length,reason:`按 ${current.startYear} 年议题派生 ${derived.length} 条史实${missed.length?`，补报漏掉 ${missed.length} 条`:''}`};
        });
      }catch(e){
        if(wait===900){console.error('史实时间线派生落库失败：'+(e instanceof Error?e.message:String(e)));return{derived:0,reason:'落库被占用，本局不设史实新闻'};}
      }
    }
    return{derived:0,reason:'落库被占用'};
  }
  /**
   * 开局后用 LLM 从议题里派生国策，替换 bootstrap 时那份关键词兜底。
   *
   * 为什么不在 buildInitialWorld 里做：那是纯函数，且派生要一次网络往返——同步卡在开局
   * 会让「点开议题转半天圈」。所以开局先用关键词兜底保证**立刻有得点**，这里异步补
   * 一份真正贴合玩家意图的。派生失败（没 key/超时/答非所问）就保留兜底那份，不动世界。
   * 复用与 order/advance 同一套纪律：版本锁 + commandId 幂等，且只改 focuses 一层。
   */
  async refreshDerivedFocuses(runId:string){
    const run=this.store.run(runId),w=this.getWorld(runId);
    if(!w?.focuses)return{derived:0,reason:'没有国策层'};
    const topic=run.spec.title+' '+run.spec.scenario.background;
    const derived=await deriveFocuses(topic);
    if(!derived.length)return{derived:0,reason:'议题读不出国策，保留兜底清单'};
    // **纯追加**：只在末尾接上标题还没出现过的派生项，原有顺序一个字节都不动。
    // 实测 bug（试玩原话「屏显 [1] 与实点不符」）：派生是 fire-and-forget，落地时机不定；
    // 之前按「通用在前、派生在后」重排，把玩家点下的那条挪到了列表末尾，而政治点不可退——
    // 玩家照几秒前读到的序号点下去，点中的是另一条。序号稳定比列表漂亮重要。
    const titles=new Set(w.focuses.available.map(f=>f.title));
    const merged=[...w.focuses.available,...derived.filter(f=>!titles.has(f.title))];
    return this.store.transaction(()=>{
      const current=this.getWorld(runId);if(!current?.focuses)return{derived:0,reason:'没有国策层'};
      const next:WorldSnapshot={...current,focuses:{...current.focuses,available:merged.filter((f,i)=>merged.findIndex(x=>x.id===f.id)===i)},revision:current.revision+1};
      this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(next),runId);
      this.mirror(runId,next);
      return{derived:derived.length,reason:'已按议题派生 '+derived.length+' 条国策'};
    });
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
  /**
   * 读档回滚（BUG-114）：把槽位快照里的世界与对话原样写回本局，「存档→作死→读档」必须
   * 能真的回去。纪律有三——① world_states 只回写快照、不动 init_id/init_digest；
   * ② 事件流水只删存档之后的那段「被作废的未来」，回滚本身补一条【读档】审计（revision
   * 与快照一致，不会与后续结算撞号）；③ 对话流随快照回滚，另加一条史官读档说明。
   */
  restoreRun(runId:string,restored:{run:Run;world:WorldSnapshot}):Run{
    const {run,world}=restored;
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before,'此议题尚未初始化世界',409);
      assert(run.world.version===world.revision,'存档内的对局与世界版本不一致',409);
      // world_events 有 UNIQUE(run_id,revision)：存档时刻的结算行已占用 revision R，审计行
      // 让到 R+1，快照版本同步 +1——内容按存档还原，版本号只前进不回头，后续结算照常单调。
      const restoredRevision=world.revision+1;
      this.store.db.prepare('DELETE FROM world_events WHERE run_id=? AND revision>?').run(runId,world.revision);
      const restoredWorld:WorldSnapshot={...world,revision:restoredRevision};
      this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(restoredWorld),runId);
      run.world.day=restoredWorld.clock.elapsedDays;run.world.version=restoredRevision;
      run.world.cities=Object.fromEntries(Object.values(restoredWorld.cities).map(c=>[c.name,restoredWorld.factions[c.ownerFactionId]?.name||'']));
      const note={id:'load-note-'+String(restoredRevision),kind:'npc' as const,name:'史官',
        text:`【读档】依槽位存档回滚至第 ${Math.floor(restoredWorld.clock.elapsedDays)+1} 日（读档前为第 ${Math.floor(before.clock.elapsedDays)+1} 日）。被回滚的岁月如流水既去，簿册上已删；史官照旧执笔。`};
      if(!run.messages.some(m=>m.id===note.id))run.messages=[...run.messages,note];
      this.store.saveRun(run);this.mirror(runId,restoredWorld);
      const audit={id:'load-'+runId+'-'+String(restoredRevision),worldId:runId,settlementId:'load-'+String(restoredRevision),decisionId:null,
        revision:restoredRevision,fromDay:restoredWorld.clock.elapsedDays,toDay:restoredWorld.clock.elapsedDays,source:'rules',
        title:'读档',summary:`【读档】依槽位存档回滚至第 ${Math.floor(restoredWorld.clock.elapsedDays)+1} 日（读档前为第 ${Math.floor(before.clock.elapsedDays)+1} 日）。`,
        related:[],changes:[],simulationReport:{commandId:'load-'+String(restoredRevision),kind:'advance' as const,advancedHours:0,pauseReason:null,rulesVersion:'load/v1',traces:[],summaries:['【读档】回滚至第 '+String(Math.floor(restoredWorld.clock.elapsedDays)+1)+' 日']}};
      const exists=this.store.db.prepare('SELECT 1 FROM world_events WHERE run_id=? AND event_id=?').get(runId,audit.id);
      if(!exists)this.store.db.prepare('INSERT INTO world_events VALUES(?,?,?,?,?)').run(runId,audit.id,restoredRevision,digest(audit),JSON.stringify(audit));
      return this.store.run(runId);
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
    if(decisionId){identifier(decisionId);
      const live=w.decisions[decisionId];
      // 例行补给令会被 pruneDecisions 淘汰（决策簿有 500 硬顶），但战略库的快照表还留着它的
      // 结束态：这时改读快照，老战略照样打得开，只是不再占决策簿的位置。
      if(!live){
        const gone=this.store.db.prepare('SELECT payload FROM world_strategy_snapshots WHERE run_id=? AND decision_id=?').get(runId,decisionId);
        assert(gone,'战略不存在',404);
        return{topicId:runId,decisionId,historical:true,data:JSON.parse(String(gone.payload)) as StrategyData};
      }
      assert(live.issuerId!=='local-defender','战略不存在',404);
      if(['completed','failed','cancelled'].includes(live.status)){
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
  /** 跳转到指定推演日：内部按日分片连续结算，遇暂停即停，并把每个分片的汇报并入事件流水。 */
  localJump(runId:string,input:unknown):ApplyResult&{jump?:JumpReport} {
    validateJump(input);return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'当前对局未启用本地规则',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const fingerprint=digest({kind:'jump',input}),prior=this.store.db.prepare('SELECT * FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(prior.digest===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      // 久不视事：AI 指挥官按各角色授权自行决策并执行；朝会亲政（attending）则不代决——战端与国策是君上的事
      const {world,report}=jumpToDay(before,input);const jump=report;
      // 享乐对白只用剧本人物台词拼装：不调 LLM、不生成图片
      jump.leisure=leisurePassage(jump.courtState,this.store.run(runId).spec.cast,jump.advancedDays);
      let current=world;
      if(jump.courtState==='attending')jump.commander={executed:[],skipped:[],notes:['本次朝会亲政，诸事由主上亲断，未交臣等代决'],rounds:0};
      else{
        const mandates=readCommanderState((this.store.run(runId) as {commander?:CommanderState}).commander).mandates;
        const round=runCommanderRound({world:current,mandates,court:jump.courtState});
        current=round.world;jump.commander=round.result;
      }
      // 在途诏令随跳转逐个日子到期：不能只在 advance 里兑现，否则「下完令跳 30 日」
      // 会让诏令在第 30 日才突然全体到达，中间的日子成了空转。
      const flushed=this.flushEdicts(current);current=flushed.world;
      const merged:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:report.advancedDays*24,pauseReason:report.pauses.at(-1)||null,rulesVersion:report.rulesVersion,traces:report.slices.flatMap(s=>s.traces),
        // AI 代决逐条并入事件 summary：省模式/方针/外交不在 commitLocal 的字段级 diff 覆盖范围内（只 diff 军/城/行/策与时钟），史官要能逐条看到
        // jump.summaries 一并入史官流水：UX-011 的【朝局】风险播报与 BUG-106 的史官按都在这一层，
        // 此前只并分片汇报，跳顶层算出来的播报（缺勤代价、危机告急）进不了起居注（重复行由 Set 去重）。
        summaries:[...new Set([...report.slices.flatMap(s=>s.summaries),...jump.commander.notes,...flushed.notes,...jump.summaries])].slice(0,100)};
      const applied=this.commitLocal(runId,'jump',input,current,merged,before);return{...applied,jump};
    });
  }
  private applyLocalInTransaction(runId:string,kind:'order'|'advance'|'decision',input:SimulationCommand|AdvanceCommand):ApplyResult {
    const before=this.getWorld(runId);assert(before?.simulation,'当前对局未启用本地规则',409);
    const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
    assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
    const fingerprint=digest({kind,input}),prior=this.store.db.prepare('SELECT * FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
    if(prior){assert(prior.digest===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
    if(kind==='order')return this.commitLocal(runId,kind,input,...this.queueEdict(before,input as SimulationCommand),before);
    const result=advanceWorld(before,input as AdvanceCommand);
    const flushed=this.flushEdicts(result.world);
    // 方针要能驱动**单次推进**：此前 runCommanderRound 只在 jump 里跑，玩家敲 `day 1`
    // 推了三十回，太尉一次都没动过——「方针—代决」只剩 jump 一条路，等于没做。
    // 朝会亲政（attending）仍然不代决：战端与国策是君上的事。
    const court=(this.store.run(runId) as {courtState?:string}).courtState;
    const mandates=readCommanderState((this.store.run(runId) as {commander?:CommanderState}).commander).mandates;
    const round=court==='attending'?null:runCommanderRound({world:flushed.world,mandates,court:(court==='indulging'?'indulging':'delegated') as 'delegated'|'indulging'});
    const advanced=round?round.world:flushed.world;
    return this.commitLocal(runId,kind,input,advanced,
      {...result.report,summaries:[...result.report.summaries,...flushed.notes,...(round?.result.notes||[])]},before);
  }
  /**
   * 主上的军令当堂记录、按驿传日子生效。
   *
   * 为什么不「记录也延迟」：决策簿、存档快照、界面上的军令列表都以「令已录」为凭；
   * 令等三天再出现，玩家会以为自己没点下去，史官也无从交代这道旨。
   * 为什么不「当天就生效」：「当天令当天到」把整个游戏退化成格子回合制，玩家读不出
   * 「迟」。折中就是这里——**令当场录进决策簿、当场派驿使出城，军中按 arrivalHour
   *   才开始动**（见 advanceWorld 里 edictInTransit 那一行）。
   * 同时把这道令挂到 pendingEdicts 供界面提示，并保留到期回报的钩子。
   *
   * 只迟**主上的令**。太尉代决的危局（断粮补给等）仍当天办：那是生存问题不是战略选择，
   * 代码里写着「不待旨」，迟三日部队已经饿死了（见 observe() 的后勤常例）。
   */
  private queueEdict(before:WorldSnapshot,input:SimulationCommand):[WorldSnapshot,SimulationReport]{
    const days=edictTransitDays(before,input.armyId,input.targetCityId);
    // 只给**本命令新装上的订单**打生效时刻。补给令不换订单（installOrder 里 supply 早退），
    // 那时军队身上还挂着上一条行军令——照着打戳就会把在走的队伍也摁住几天（实测踩过）。
    const priorOrderId=before.simulation?.armies[input.armyId]?.order?.id;
    const {world,report}=issueOrder(before,input);
    const model=world.simulation?.armies[input.armyId];
    const order=model?.order;
    if(order&&days>0&&order.id!==priorOrderId)order.arrivalHour=(world.simulation!.timeHours)+days*24;
    const army=world.armies[input.armyId];
    // UX-010：军令类型是英文枚举（march/attack/resupply…），照抄进叙事就是「·resupply」
    // 满天飞。玩家只见中文动词；补给令点明自何处发粮，行军/进攻点明去向。
    const kindCN=ORDER_KIND_CN[input.kind]||input.kind;
    const place=input.targetCityId?world.cities[input.targetCityId]?.name||input.targetCityId:input.sourceCityId?`（自${world.cities[input.sourceCityId]?.name||input.sourceCityId}）`:'';
    const note=`${army?.name||input.armyId}·${kindCN}${place}`;
    const list=world.pendingEdicts||(world.pendingEdicts=[]);
    list.push({id:'edict-'+String(input.commandId).replace(/[^0-9a-zA-Z_-]/g,''),armyId:input.armyId,kind:input.kind,
      ...(input.targetCityId?{targetCityId:input.targetCityId}:{}),...(input.sourceCityId?{sourceCityId:input.sourceCityId}:{}),
      ...(input.foodKg?{foodKg:input.foodKg}:{}),issuedDay:world.clock.elapsedDays,arrivalDay:world.clock.elapsedDays+days,
      issuedBy:'主上',note});
    const merged:SimulationReport={...report,pauseReason:null,
      summaries:[...report.summaries,`【诏令】${note}已付驿传，${days} 日后到军中（军中在途，未奉此旨之前不动）`]};
    return[world,merged];
  }
  /**
   * 在途诏令到期：通报「令已到军」。真生效由 advanceWorld 的 arrivalHour 门负责
   * （军队按那一刻开拔），这里只做史官流水与界面提示的收尾。
   * 保留 issueOrder 的异常通道：令到而势已变（部队已溃、城已易主）时如实回报，
   * 不诈称执行——沉默是最坏的选项，玩家会以为自己下过一道管用的令。
   */
  private flushEdicts(w:WorldSnapshot):{world:WorldSnapshot;notes:string[]}{
    const list=w.pendingEdicts||[];if(!list.length)return{world:w,notes:[]};
    const day=Math.floor(w.clock.elapsedDays);const notes:string[]=[];const still:PendingEdict[]=[];
    for(const e of list){
      if(e.arrivalDay>day){still.push(e);continue;}
      // UX-010：下发日是浮点（485.96790810833335），照抄进叙事就是一串小数。全站「第 N 日」
      // 的口径是 floor+1（见 strategy-view 的决策时间），这里同口径取整。
      notes.push(`【诏令到军】${e.note}（${e.issuedBy}之旨，第 ${Math.floor(e.issuedDay)+1} 日所下，今始至）`);
    }
    w.pendingEdicts=still.length?still:undefined;
    return{world:w,notes};
  }
  /** 统一落库：diff 出字段级变更、写事件流水、镜像世界、按需入队绘画。order/advance/jump 三条路径共用。 */
  private commitLocal(runId:string,kind:'order'|'advance'|'decision'|'jump'|'province',input:SimulationCommand|AdvanceCommand|JumpCommand|ProvinceUpdateCommand|{commandId:string;expectedRevision:number;choiceId:string},w:WorldSnapshot,report:SimulationReport,before:WorldSnapshot):ApplyResult {
    // 落库前先淘汰例行代决。字段 diff 只遍历现存 decision，所以被淘汰的条目根本不会
    // 出现在变更里，史官流水不会多出「决策不见了」这种噪声；事件流水则完全不受影响。
    pruneDecisions(w);
    const fingerprint=digest({kind,input}),changes:FieldChange[]=[],related=new Map<string,EntityRef>();
    const units:Record<string,FieldChange['unit']>={troops:'人',foodKg:'kg',morale:'分',fatigue:'分',wounded:'人',dead:'人',captured:'人',deserted:'人',defense:'分'};
    function collect(type:'army'|'city'|'action'|'decision',id:string,old:unknown,next:unknown){
      const previous=(old||{}) as Record<string,JsonValue>;
      for(const [field,after] of Object.entries(next as Record<string,JsonValue>))if(canonical(previous[field]??null)!==canonical(after)){
        // UX-010：reason 只留人话。此前把 rulesVersion（如 hanzhong-local-v1:1）拼在前面，
        // strategy.changes[].reason 玩家可达，6483 条版本号就是这么漏进去的；版本仍随
        // simulationReport（trace）落库，可追溯性不受影响。
        changes.push({entity:{type,id},field,before:previous[field]??null,after,unit:units[field],reason:report.summaries.at(-1)||'本地规则结算'});
        if(type!=='decision')related.set(type+id,{type,id});
      }
    }
    for(const a of Object.values(w.armies)){collect('army',a.id,before.armies[a.id],a);collect('army',a.id,before.simulation!.armies[a.id],w.simulation!.armies[a.id]);}
    for(const c of Object.values(w.cities))collect('city',c.id,before.cities[c.id],c);
    for(const a of Object.values(w.actions))collect('action',a.id,before.actions[a.id],a);
    for(const d of Object.values(w.decisions))collect('decision',d.id,before.decisions[d.id],d);
    if(w.clock.elapsedDays!==before.clock.elapsedDays)changes.push({entity:{type:'clock',id:runId},field:'elapsedDays',before:before.clock.elapsedDays,after:w.clock.elapsedDays,unit:'日',reason:'本地统一时钟'});
    const event:WorldEvent={id:input.commandId,worldId:runId,settlementId:input.commandId,decisionId:kind==='order'?Object.keys(w.decisions).find(id=>!before.decisions[id])||null:null,
      revision:w.revision,fromDay:before.clock.elapsedDays,toDay:w.clock.elapsedDays,source:'rules',
      // 令已下而未到军中：起居注标题要说「诏令在途」，不能写「命令已登记」——
      // 后者会让史官流水看起来这道令已经办完了（实测：玩家据此以为军已出动）。
      title:kind==='order'?(report.summaries.some(s=>s.startsWith('【诏令】'))?'诏令在途':'命令已登记'):report.pauseReason||'本地推演',
      summary:report.summaries.join('\n'),related:[...related.values()],changes,simulationReport:report};
    this.store.db.prepare('INSERT INTO world_events VALUES(?,?,?,?,?)').run(runId,event.id,w.revision,fingerprint,JSON.stringify(event));
    this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(w),runId);this.mirror(runId,w);
    // 廷议心跳：跳转/推进/裁决/国策/省政的结算此前只进起居注，聊天区长期死水（实测
    // 204 日只多 16 条，玩家以为没反应）。落一条史官快报进对话流，以世界版本为去重键；
    // 军令(order)不在此落——localMessage 自己会写结果，重复就是刷屏。
    // UX-108：心跳按「内容+推演日」去重，且围城每小时的常规战损流水（「X交战：N人暂失战力」）
    // 不再触发心跳——实测 810 条消息六成来自围城刷屏。战损照旧全量进起居注（事件流水），
    // 这里只收敛廷议流；节点性事件（暂停落地、城池易主、告急）仍每次都报。
    if(kind!=='order'){
      const day=Math.floor(w.clock.elapsedDays);
      const routine=/交战：\d+人暂失战力/;
      const line=kind==='decision'?report.summaries[0]:[...report.summaries].reverse().find(t=>!routine.test(t));
      if(line){
        const run=this.store.run(runId);
        const fresh=!run.messages.some(m=>m.id==='report-'+w.revision);
        const repeated=run.messages.some(m=>m.day===day&&m.text===line&&m.id.startsWith('report-'));
        if(fresh&&!repeated){
          run.messages.push({id:'report-'+String(w.revision),kind:'npc',name:'史官',text:line,day});
          this.store.saveRun(run);
        }
      }
    }
    // 胜利仪式感（第 4 轮）：终局判定本身工作正常，但胜利那一刻廷议零宣告、成就零解锁、
    // 世界不谢幕——玩家不翻 strategy.verdict 字段根本不知道自己赢了。首次达成 victory 时
    // 史官当廷宣告一句（引终局 summary，带「此局为胜」），以 win-* 消息在档为去重键，只报一次。
    const verdict=worldVerdict(w);
    if(verdict.over&&verdict.outcome==='victory'&&!this.store.run(runId).messages.some(m=>m.id.startsWith('win-'))){
      const run=this.store.run(runId);
      run.messages.push({id:'win-'+String(w.revision),kind:'npc',name:'史官',day:Math.floor(w.clock.elapsedDays),
        text:`【大捷】${verdict.summary}——此局为胜。史官谨拜贺：庙算得人，将士用命，自今日始，大势成矣。`});
      this.store.saveRun(run);
    }
    if(process.env.AGENT_ALLOW_API_GENERATION==='true'){
      // 一张故事板配一次付费调用，所以只能给「真有事发生」的入队：玩家亲手下的军令、
      // 以及长推进途中出现的硬事件（城池易主、投降、被截）。此前每次 advance/jump 都入队，
      // 一局 122 天排了 35 张且几乎全在规划阶段就失败——既烧额度又制造一串失败任务。
      const cityFell=event.changes.some(c=>c.entity.type==='city'&&c.field==='ownerFactionId');
      const notable=/城池归属改变|守军投降|补给被截|部队失去战斗能力/.test(report.pauseReason||'');
      if(kind==='order'||cityFell||notable){
        const run=this.store.run(runId);
        // majorCandidate 是「请分类器判一判」的候选标记，不是结论——入队了就让它判。
        this.store.enqueue(runId,'storyboard','world-'+event.id,{spec:run.spec,event:{id:event.id,confirmed:true,summary:event.summary},world:run.world,worldTime:w.clock,changes:event.changes,majorCandidate:true,recent_messages:run.messages.slice(-12)});
      }
    }
    return{ok:true,alreadyApplied:false,eventId:event.id,appliedRevision:w.revision,currentRevision:w.revision};
  }
  /** 省层更新：太守/治政模式/年度方针。与 order/advance 同一套纪律，但不推进时间。 */
  updateProvince(runId:string,raw:unknown){
    validateProvinceUpdate(raw);
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before,'请先初始化世界',404);
      assert(before.provinces,'当前对局没有省层',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const input=raw as ProvinceUpdateCommand;
      const fingerprint=digest({kind:'province',input}),prior=this.store.db.prepare('SELECT * FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(prior.digest===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      const {world,changes}=applyProvinceUpdate(before,input);
      const province=world.provinces![input.provinceId];
      const summaries=changes.map(c=>`${province.name}·${c.field==='governor'?'太守':c.field==='mode'?'治政模式':'年度方针'}：${c.before} → ${c.after}`);
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'province-update/v1',traces:[],summaries};
      const applied=this.commitLocal(runId,'province',input,world,report,before);
      return{...applied,provinceChanges:changes};
    });
  }
  /**
   * 立项研究一项科技（花科技点）。纪律与 adoptFocus 完全一致：版本锁 + commandId 幂等
   * + 只走本地裁判。推进量恒为 0——科技按研究天书兑现，立项只是「定了课题」。
   */
  adoptTech(runId:string,raw:unknown){
    record(raw,'科技请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'科技请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;techId:string};
    identifier(input.commandId);identifier(input.techId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    const fingerprint=digest({kind:'tech',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      assert(before.techs,'当前对局没有科技层',409);
      const day=before.simulation!.timeHours/24;
      const {state,tech}=adoptTechPure(before.techs,input.techId,day);
      const world=structuredClone(before);world.techs=state;world.revision++;
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'tech/v1',traces:[],
        summaries:[`【科技】立项：${tech.title}——${tech.text.slice(0,40)}…（耗科技点 ${tech.cost}，约 ${tech.days} 日有成，剩 ${Math.floor(state.points)} 点）`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:input.techId},world,report,before);
      return{...applied,tech:{id:tech.id,title:tech.title,cost:tech.cost,days:tech.days},pointsLeft:Math.floor(state.points)};
    });
  }
  /**
   * 点下一个国策（花政治点）。纪律与 order/decision/province/diplomacy 完全一致：
   * 版本乐观锁 + commandId 幂等 + 只走本地裁判。推进量恒为 0——国策是按天兑现的，
   * 点下去只是「定了方向」，生效在之后每一次推进里。
   */
  adoptFocus(runId:string,raw:unknown){
    record(raw,'国策请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'国策请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;focusId:string};
    identifier(input.commandId);identifier(input.focusId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    const fingerprint=digest({kind:'focus',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      assert(before.focuses,'当前对局没有国策层',409);
      const day=before.simulation!.timeHours/24;
      const {state,focus}=adoptFocusPure(before.focuses,input.focusId,day);
      const world=structuredClone(before);world.focuses=state;world.revision++;
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'focus/v1',traces:[],
        summaries:[`【国策】${focus.title}：${focus.startSummary}（耗政治点 ${focus.cost}，约 ${focus.days} 日见成效，剩 ${Math.floor(state.points)} 点）`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:input.focusId},world,report,before);
      return{...applied,focus:{id:focus.id,title:focus.title,cost:focus.cost,days:focus.days},pointsLeft:Math.floor(state.points)};
    });
  }
  /**
   * 点数加急（第 7 轮）：花政治点/科技点缩短进行中国策/科技的天数——封顶后的点数从此有出口。
   * 1 点 = 1 日，单次上限 30 日（expediteFocus/expediteTech 纯函数里 clamp）；
   * 加急到今日即成时由下一次结算自然兑现，不在这里冒充完成。
   */
  expediteFocus(runId:string,raw:unknown){
    record(raw,'国策加急请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'加急请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;focusId:string};
    identifier(input.commandId);identifier(input.focusId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    const fingerprint=digest({kind:'focus-expedite',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      assert(before.focuses,'当前对局没有国策层',409);
      const day=before.simulation!.timeHours/24;
      const {state,focus,cost,daysCut}=expediteFocusPure(before.focuses,input.focusId,day);
      const world=structuredClone(before);world.focuses=state;world.revision++;
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'focus-expedite/v1',traces:[],
        summaries:[`【加急】${focus.title}：花政治点 ${cost}，工期缩短 ${daysCut} 日（剩 ${Math.floor(state.points)} 点）`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:'expedite:'+input.focusId},world,report,before);
      return{...applied,focus:{id:focus.id,title:focus.title},cost,daysCut,pointsLeft:Math.floor(state.points)};
    });
  }
  expediteTech(runId:string,raw:unknown){
    record(raw,'科技加急请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'加急请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;techId:string};
    identifier(input.commandId);identifier(input.techId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    const fingerprint=digest({kind:'tech-expedite',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      assert(before.techs,'当前对局没有科技层',409);
      const day=before.simulation!.timeHours/24;
      const {state,tech,cost,daysCut}=expediteTechPure(before.techs,input.techId,day);
      const world=structuredClone(before);world.techs=state;world.revision++;
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'tech-expedite/v1',traces:[],
        summaries:[`【加急】${tech.title}：花科技点 ${cost}，工期缩短 ${daysCut} 日（剩 ${Math.floor(state.points)} 点）`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:'expedite:'+input.techId},world,report,before);
      return{...applied,tech:{id:tech.id,title:tech.title},cost,daysCut,pointsLeft:Math.floor(state.points)};
    });
  }
  /**
   * 粜粮济民（第 7 轮）：城粮超 20 万公斤后的真实出口——粜 X 公斤换朝望与寒门认可。
   * 每 2.5 万公斤 +1 朝望、+1 寒门认可（单次各上限 +5）；粜后须留 1 万公斤底仓，
   * 防治所裸奔饿死守民。账走 commitLocal decision 流水，与国策/外交同一口径。
   */
  sellGrain(runId:string,raw:unknown){
    record(raw,'粜粮请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'粜粮请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;cityId:string;amountKg:number};
    identifier(input.commandId);identifier(input.cityId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    assert(Number.isFinite(input.amountKg)&&input.amountKg>=10000&&input.amountKg<=1000000,'粜粮数量无效：一次至少 1 万公斤，至多 100 万公斤');
    // sellGrain 的指纹口径必须与 commitLocal 落库时一致（commitLocal 用 kind:'decision'）；
    // 直接用 {kind:'sell-grain',...} 算出的指纹会 mismatch，导致幂等检查误报。
    const eventFingerprint=digest({kind:'decision',input:{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:'sell-grain:'+input.cityId}});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===eventFingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      const world=structuredClone(before);
      const city=world.cities[input.cityId];assert(city,'城池不存在',404);
      assert(city.ownerFactionId===world.simulation!.playerFactionId,'只能粜己方城池的粮',403);
      assert(city.foodKg-input.amountKg>=10000,`${city.name}仓中存粮不足：现储 ${Math.round(city.foodKg)} 公斤，粜后须留 1 万公斤底仓`,409);
      city.foodKg=round(city.foodKg-input.amountKg);
      world.revision++;
      const gain=Math.min(5,Math.floor(input.amountKg/25000));
      let prestigeLine='';
      if(world.politics){
        const pb=world.politics.prestige;
        world.politics.prestige=clamp(round(pb+gain),0,100);
        adjustApproval(world.politics,'commoner',gain);
        prestigeLine=`，朝望 ${Math.round(pb)} → ${Math.round(world.politics.prestige)}，寒门认可 +${gain}`;
      }
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'sell-grain/v1',traces:[],
        summaries:[`【粜粮】${city.name}粜出粮草 ${Math.round(input.amountKg)} 公斤以济民食${prestigeLine}；仓中余 ${Math.round(city.foodKg)} 公斤。`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:'sell-grain:'+input.cityId},world,report,before);
      return{...applied,city:{id:city.id,name:city.name},soldKg:Math.round(input.amountKg),gain,foodLeft:Math.round(city.foodKg)};
    });
  }
  /**
   * 派脑洞决策：读当前局势，问模型要 2—3 条「如果…」岔路，写进快照给玩家点。
   * 只在没有待决事件、且本局还没派过（或已过 30 日）时才派——刷太勤玩家会当广告。
   */
  async refreshWhatIfs(runId:string){
    const run=this.store.run(runId),w=this.getWorld(runId);
    if(!w?.simulation)return{derived:0,reason:'没有本地战役'};
    const ended0=worldVerdict(w);if(ended0.over)return{derived:0,reason:'本局已终局：'+ended0.summary};
    if(w.pendingDecision)return{derived:0,reason:'案上还有待决之事'};
    const lastDay=(w.whatIfsDay??0),nowDay=w.simulation.timeHours/24;
    if(w.whatIfs?.length&&nowDay-lastDay<30)return{derived:0,reason:'脑洞卡刚派过'};
    // BUG-107：如实区分「未配置引擎 / 调用失败 / 模型空手」，不再一律说「想不出新岔路」。
    const {cards,reason}=await deriveWhatIfs(w);
    if(!cards.length)return{derived:0,reason};
    for(const wait of [0,300,900]){
      if(wait)await new Promise(r=>setTimeout(r,wait));
      try{
        return this.store.transaction(()=>{
          const current=this.getWorld(runId);if(!current?.simulation)return{derived:0,reason:'世界已不在'};
          const next:WorldSnapshot={...current,whatIfs:cards,whatIfsDay:round(current.simulation.timeHours/24),revision:current.revision+1};
          this.store.db.prepare('UPDATE world_states SET payload=? WHERE run_id=?').run(JSON.stringify(next),runId);
          this.mirror(runId,next);
          return{derived:cards.length,reason:`军议呈上 ${cards.length} 条岔路`};
        });
      }catch(e){
        if(wait===900){console.error('脑洞决策落库失败：'+(e instanceof Error?e.message:String(e)));return{derived:0,reason:'落库被占用'};}
      }
    }
    return{derived:0,reason:'落库被占用'};
  }
  /** 玩家点下脑洞选项：套效果、记起居注、把卡撤掉。 */
  decideWhatIf(runId:string,raw:unknown){
    record(raw,'脑洞请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'脑洞请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;cardId:string;choiceId:string};
    identifier(input.commandId);identifier(input.cardId);identifier(input.choiceId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    const fingerprint=digest({kind:'whatif',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      const ended0=worldVerdict(before);assert(!ended0.over,'本局已终局：'+ended0.summary+'。请另开新议题。',409);
      assert(before.whatIfs?.length,'当前没有军议呈上的岔路',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      const card=before.whatIfs.find(c=>c.id===input.cardId);assert(card,'这张岔路已经撤了',409);
      const choice=card.choices.find(c=>c.id===input.choiceId);assert(choice,'没有这个选项',400);
      const world=structuredClone(before);
      for(const e of choice.effects)applyDecisionEffect(world,e as never);
      world.whatIfs=(world.whatIfs||[]).filter(c=>c.id!==card.id);
      world.revision++;
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'whatif/v1',traces:[],summaries:[`【脑洞】${whatIfSummary(choice)}`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:input.choiceId+':'+card.id},world,report,before);
      return{...applied,choice:choice.label,summary:whatIfSummary(choice)};
    });
  }
  /**
   * 玩家自己办外交：结盟 / 宣战。此前 diplomacy.ts 的 formAlliance / declareWar 只有
   * AI 指挥官（commander-runtime）能调，玩家看着「关系」面板却没有任何可点的动作——
   * 试玩原话「外交面板是张画」。这里补上玩家这条路，纪律与 decide/province 完全一致
   * （版本乐观锁 + commandId 幂等 + 只走本地裁判），推进量恒为 0。
   */
  diplomacy(runId:string,raw:unknown){
    record(raw,'外交请求');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'外交请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;action:string;targetFactionId:string;reason?:string};
    assert(['alliance','war'].includes(input.action),'外交动作只支持结盟（alliance）与宣战（war）');
    identifier(input.targetFactionId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    const fingerprint=digest({kind:'diplomacy',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      const ended=worldVerdict(before);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      if(blockingDecision(before)){assert(false,`尚有决策未定：${DECISION_EVENTS.find(e=>e.id===before.pendingDecision!.eventId)?.title}。请先裁决，再议军行。`,409);}
      const prior=this.store.db.prepare('SELECT * FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      const {world,summary}=input.action==='alliance'?formAlliance(before,input.targetFactionId):declareWar(before,input.targetFactionId);
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:null,rulesVersion:'diplomacy/v1',traces:[],
        summaries:[`【外交】${summary}${input.reason?'（'+input.reason.slice(0,200)+'）':''}`]};
      const applied=this.commitLocal(runId,'decision',{commandId:input.commandId,expectedRevision:input.expectedRevision,choiceId:input.action+':'+input.targetFactionId},world,report,before);
      return{...applied,diplomacy:summary};
    });
  }
  /**
   * 裁决一条历史决策卡：套用选项效果、记账、清掉待决。与 order/advance 同一套纪律
   * （版本乐观锁 + 相同请求编号幂等 + 只走本地裁判），推进量恒为 0。
   */
  decide(runId:string,raw:unknown){
    record(raw,'本地决策');identifier(raw.commandId);
    assert(raw&&typeof raw==='object'&&!Array.isArray(raw),'决策请求格式无效');
    const input=raw as {commandId:string;expectedRevision:number;choiceId:string};
    identifier(input.choiceId);
    assert(Number.isSafeInteger(input.expectedRevision),'世界版本无效');
    // 指纹口径必须与 commitLocal 落库时一致：commitLocal 记的是 digest({kind,input})，
    // 不是 digest(原始请求)。口径不一致时重复提交会被误判成「相同编号不同内容」。
    const fingerprint=digest({kind:'decision',input});
    return this.store.transaction(()=>{
      const before=this.getWorld(runId);assert(before?.simulation,'此议题尚未配置本地战役',409);
      assert(this.store.run(runId).mode==='standalone','已连接外部引擎的对局不能混用本地裁判',409);
      // 终局后仍允许关掉资讯卡：新闻从来不拦推进与军令（那张卡自己就这么写），
      // 拿「本局已终局」把它死死按在桌面上，玩家看到的是每局都挂着一张永远关不掉的卡。
      // 决策卡照旧拒绝——终局后改不了局势。
      const pendingOnEntry=before.pendingDecision;
      const newsOnEntry=lookupNews(pendingOnEntry?.eventId||'')!==undefined;
      const ended=worldVerdict(before);assert(!ended.over||newsOnEntry,'本局已终局：'+ended.summary+'。请另开新议题。',409);
      // 幂等判定排在最前，且与 order/advance/jump/province 一样查 **world_events**
      // （commands 表只服务 localMessage 的自由对话，写操作的落库处是事件流水）。
      // 同一编号第二次提交时版本已变、待决已清——先把这两条问出来会让客户端重试撞上
      // 409「版本已变化/没有待决之事」，那是在骗调用方。
      const prior=this.store.db.prepare('SELECT digest,revision FROM world_events WHERE run_id=? AND event_id=?').get(runId,input.commandId);
      if(prior){assert(String(prior.digest)===fingerprint,'相同请求编号对应不同内容',409);return{ok:true,alreadyApplied:true,eventId:input.commandId,appliedRevision:Number(prior.revision),currentRevision:before.revision};}
      assert(input.expectedRevision===before.revision,'世界版本已变化，请读取最新状态再提交',409);
      const pending=before.pendingDecision;assert(pending,'当前没有待决之事',409);
      // 新闻没有选项：choiceId 与事件 id 相同即视为「知道了」，不必真给按钮
      const news=lookupNews(pending.eventId);
      const {world,summary,choiceLabel}=applyDecision(before,pending.eventId,news?news.id:input.choiceId);
      const event=news??DECISION_EVENTS.find(e=>e.id===pending.eventId)!;
      const queued=world.pendingDecision?DECISION_EVENTS.find(e=>e.id===world.pendingDecision!.eventId):null;
      const report:SimulationReport={commandId:input.commandId,kind:'advance',advancedHours:0,pauseReason:queued?'待主上决策':null,rulesVersion:'decision/v1',traces:[],
        summaries:[`【决策】${event.title}：${choiceLabel}。${summary}`,...(queued?[`【决策】${queued.title}：${queued.text}`]:[])]};
      const applied=this.commitLocal(runId,'decision',input,world,report,before);
      return{...applied,choice:input.choiceId,summary};
    });
  }
  async localMessage(runId:string,raw:unknown){
    record(raw,'本地消息');identifier(raw.commandId);assert(typeof raw.text==='string'&&raw.text.trim().length>0&&raw.text.length<=2000&&typeof raw.act==='boolean','消息格式无效');
    const fingerprint=digest(raw);
    // 口语理解放在事务外：它可能调模型（一次网络往返），不能占着数据库事务干这事。
    // 语法优先，模型只补语法听不懂的那些话；译不出来就照旧抛写死语法的帮助文本。
    // BUG-112：只有 act=true（要真执行）才需要推演层；问对（act=false）在无推演的
    // 阅览室局照常可问，409 文案也改成明说「本局未附本地推演，仅可问对与阅览」。
    let command:Awaited<ReturnType<typeof understandLocalCommand>>|null=null;
    if(raw.act){
      const w0=this.getWorld(runId);assert(w0?.simulation,'本局未附本地推演，仅可问对与阅览',409);
      try{command=await understandLocalCommand(w0,raw.text as string,raw.commandId as string);}
      catch(e){
        // 廷议活性：识别失败也要留下对话痕迹——玩家原话与史官帮助照常入流（不产生世界
        // 变更），否则玩家只看到一个报错弹层、聊天纹丝不动，观感是「按了没反应」。
        this.store.transaction(()=>{
          const run=this.store.run(runId);
          run.messages.push({id:'player-'+String(raw.commandId),kind:'player',name:'主上',text:raw.text as string},
            {id:'result-'+String(raw.commandId),kind:'npc',name:'史官',text:(e as Error).message});
          this.store.saveRun(run);
        });
        throw e;
      }
    }
    // 第 7 轮：粜粮走自己的事务（sellGrain 内含 BEGIN/COMMIT，事务不可嵌套），先结算
    // 再回来补对话流；幂等由 sellGrain 的 world_events 检查与下方 commands 表检查双保险。
    if(command&&command.kind==='sell-grain'){
      const w0=this.getWorld(runId);assert(w0?.simulation,'本局未附本地推演，仅可问对与阅览',409);
      const old=this.store.db.prepare('SELECT * FROM commands WHERE run_id=? AND command_id=?').get(runId,raw.commandId as string);
      if(old){assert(old.digest===fingerprint&&old.status==='done','相同消息编号内容不一致或未完成',409);return this.store.run(runId);}
      this.sellGrain(runId,{commandId:String(raw.commandId),expectedRevision:w0.revision,cityId:command.cityId,amountKg:command.amountKg});
      const event=this.recentEvents(runId).at(-1)!;
      const resultText=event.summary;
      const run=this.store.run(runId);
      run.messages.push({id:'player-'+String(raw.commandId),kind:'player',name:'主上',text:raw.text as string},
        {id:'result-'+String(raw.commandId),kind:'result',name:'史官',text:resultText});
      this.store.saveRun(run);
      this.store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(runId,raw.commandId as string,fingerprint,'done');
      return run;
    }
    return this.store.transaction(()=>{
      const run=this.store.run(runId),w=this.getWorld(runId);
      if(raw.act)assert(w?.simulation,'本局未附本地推演，仅可问对与阅览',409);
      if(raw.to)assert(run.spec.cast.some(p=>p.id===raw.to),'目标人物不存在');
      const old=this.store.db.prepare('SELECT * FROM commands WHERE run_id=? AND command_id=?').get(runId,raw.commandId as string);
      if(old){assert(old.digest===fingerprint&&old.status==='done','相同消息编号内容不一致或未完成',409);return this.store.run(runId);}
      // UX-002：本地问策不再回同一句冷冰冰的系统说明——给一条有内容的史官答对
      //（开场引导 + 指名人物时附其立场台词）。纯模板，不调模型。
      // BUG-112：无推演的局没有日序/军队/待决卡，问策降级为阅览室口径（counselReply 的 readingRoom 分支）。
      let resultText=command?LOCAL_COMMAND_HELP:counselReply({
        day:Math.floor((w?.simulation?.timeHours??(w?.clock.elapsedDays??0)*24)/24)+1,
        pendingTitle:w?.pendingDecision?lookupEvent(w.pendingDecision.eventId)?.title??null:null,
        persona:raw.to?run.spec.cast.find(p=>p.id===raw.to):undefined,
        firstCommander:w?.simulation?Object.values(w.armies).find(a=>a.factionId===w.simulation!.playerFactionId&&w.simulation!.activeArmyIds.includes(a.id))?.commander.name:undefined,
        readingRoom:!!w&&!w.simulation});
      if(command&&command.kind==='directive'){
        // 玩家这句话是**方针**，不是一次出兵：落成三位大臣的常驻意图（mandate），
        // 之后每次推进都按它代决——微操只是方针之下的修正。
        //（command 只在 act=true 时产生，那一支已断言 w.simulation——此处 w 非空由该守卫保证。）
        const day=Math.floor(w!.simulation!.timeHours/24);
        const current=readCommanderState((run as {commander?:CommanderState}).commander).mandates.filter(m=>m.revokedDay===null);
        const ctx={cities:Object.values(w!.cities).map(c=>({id:c.id,name:c.name})),factions:Object.values(w!.factions).map(f=>({id:f.id,name:f.name}))};
        (run as {commander?:CommanderState}).commander={version:1,mandates:mandatesFrom(command.directive,current,day)};
        this.store.saveRun(run);
        resultText=directiveLine(command.directive)+'｜'+directiveHint(command.directive,ctx);
      }else if(command){this.applyLocalInTransaction(runId,command.kind,command.input);const event=this.recentEvents(runId).at(-1)!;resultText=event.summary;}
      const next=this.store.run(runId);next.messages.push({id:'player-'+String(raw.commandId),kind:'player',name:'主上',text:raw.text as string},{id:'result-'+String(raw.commandId),kind:raw.act?'result':'npc',name:'史官',text:resultText});
      this.store.saveRun(next);this.store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(runId,raw.commandId as string,fingerprint,'done');return next;
    });
  }
  listEvents(runId:string,opts:{decisionId?:string;entityId?:string;afterRevision?:number;limit?:number;latest?:boolean}={}):WorldEvent[] {
    this.store.run(runId);const after=opts.afterRevision??0,limit=opts.limit??50;
    assert(Number.isSafeInteger(after)&&after>=0&&Number.isSafeInteger(limit)&&limit>=1&&limit<=200,'分页参数无效');
    const clauses=['run_id=?','revision>?'];const args:(string|number)[]=[runId,after];
    if(opts.decisionId){clauses.push("json_extract(payload,'$.decisionId')=?");args.push(opts.decisionId);}
    if(opts.entityId){clauses.push("EXISTS(SELECT 1 FROM json_each(json_extract(payload,'$.related')) WHERE json_extract(value,'$.id')=?)");args.push(opts.entityId);}
    args.push(limit);
    // 默认从最早往后取（翻页语义）。latest 取最近若干条——「刚发生了什么」要的是尾部，
    // 而长局的世界事件有几千条，从头翻到尾才能看到最新一条是不可接受的。
    const rows=this.store.db.prepare('SELECT payload FROM world_events WHERE '+clauses.join(' AND ')+' ORDER BY revision '+(opts.latest?'DESC':'ASC')+' LIMIT ?').all(...args);
    return (opts.latest?rows.slice().reverse():rows).map(r=>JSON.parse(String(r.payload)));
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
