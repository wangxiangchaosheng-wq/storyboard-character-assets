import {WorldAgent} from './world-agent.js';
import {parseTopic} from './topic-contract.js';
import {Store,hash} from './store.js';
import {AgentError,assert,parseSpec,type Message,type Run,type Settlement} from './contracts.js';
export type EngineState={gameId:string;turn:number;state:Record<string,number>;chat:Message[];spec:unknown};
export class EngineBridge {
  store:Store;busy=new Set<string>();constructor(store:Store){this.store=store;}
  async request(path:string,body?:unknown):Promise<unknown>{
    const base=process.env.SIM_ENGINE_URL;assert(base,'请先配置队友推演服务的 SIM_ENGINE_URL；可先导入剧本测试四个模块',503);
    assert(/^https?:\/\//.test(base),'推演服务地址无效',503);
    let res:Response;try{res=await fetch(base.replace(/\/$/,'')+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(240000),redirect:'error'});}catch{throw new AgentError('推演服务连接中断，执行结果可能已保存，请先同步状态',502);}
    if(!res.ok)throw new AgentError(`推演服务返回 ${res.status}，请检查服务运行情况`,502);return res.json();
  }
  /** Import research once; local world rules remain the only settlement owner. */
  async researchTopic(value:unknown){
    const topic=parseTopic(value);
    const text=topic.title+'\n'+topic.description;
    const links=text.match(/https?:\/\/[^\s<>"，。！？]+/g)||[];
    const urls=links.map(raw=>{try{return new URL(raw);}catch{return null;}}).filter((u):u is URL=>!!u);
    const zhihu=urls.filter(u=>(u.hostname==='www.zhihu.com'||u.hostname==='zhihu.com')&&/^\/question\/\d+(?:\/|$)/.test(u.pathname));
    assert(zhihu.length<=1,'一次只能导入一个知乎问题');
    const input=zhihu.length?{kind:'url',url:'https://www.zhihu.com/question/'+zhihu[0].pathname.split('/')[2]}:{kind:'text',text};
    this.store.db.exec('CREATE TABLE IF NOT EXISTS topic_imports (id TEXT PRIMARY KEY, run_id TEXT NOT NULL, payload TEXT NOT NULL)');
    const key=hash({input,year:topic.year,season:topic.season,faction:topic.faction});
    const prior=this.store.db.prepare('SELECT run_id FROM topic_imports WHERE id=?').get(key);
    if(prior)return this.store.run(String(prior.run_id));
    const {topicId}=await this.request('/api/topics/ingest',{...input,researchOnly:true}) as {topicId:string};
    assert(typeof topicId==='string'&&topicId.length>0,'议题服务未返回编号',502);
    await this.request(`/api/topics/${encodeURIComponent(topicId)}/build`,{});
    let ready=false;
    for(let i=0;i<180;i++){
      const {state}=await this.request(`/api/topics/${encodeURIComponent(topicId)}/status`) as {state:string};
      if(state==='ready'){ready=true;break;}
      assert(state!=='failed','议题整理失败，请检查知乎授权或议题服务日志',502);
      await new Promise(r=>setTimeout(r,1000));
    }
    assert(ready,'议题整理尚未完成，请稍后重试',504);
    const {spec:raw}=await this.request(`/api/topics/${encodeURIComponent(topicId)}/spec`) as {spec:Record<string,unknown>};
    assert(raw&&typeof raw==='object','议题服务没有返回剧本',502);
    const upstream=parseSpec({...raw,id:'research-'+key});
    const source=input.kind==='url'?input.url:'用户输入文本';
    const spec=parseSpec({...upstream,metrics:[],scenario:{background:`公元${topic.year}年${topic.season}（用户选择的推演起始时间）。\n${upstream.scenario.background.slice(0,18000)}\n资料入口：${source}。背景与人物由议题服务整理，尚不等同于核实史实；战役数值使用本地模拟设定，上游通用指标未自动转换为兵力或粮草。`}});
    const existing=this.store.db.prepare('SELECT run_id FROM topic_imports WHERE id=?').get(key);
    if(existing)return this.store.run(String(existing.run_id));
    return this.store.create(spec,{},undefined,run=>{
      this.store.db.prepare('INSERT INTO topic_imports VALUES(?,?,?)').run(key,run.id,JSON.stringify({input,topicId,spec:raw,importedAt:new Date().toISOString()}));
    });
  }

  async discussLocal(runId:string,input:{commandId:string;text:string;to?:string;act:boolean}){
    assert(typeof input.commandId==='string'&&input.commandId.length>0&&input.commandId.length<=200,'缺少请求编号');
    assert(input.act===false&&typeof input.text==='string'&&input.text.trim().length>0&&input.text.length<=2000,'讨论内容无效');
    const digest=hash(input),old=this.store.db.prepare('SELECT * FROM commands WHERE run_id=? AND command_id=?').get(runId,input.commandId);
    if(old){assert(old.digest===digest&&old.status==='done','请求编号冲突',409);return this.store.run(runId);}
    assert(!this.busy.has(runId),'正在处理上一条消息，请稍候',409);this.busy.add(runId);
    try{
      const run=this.store.run(runId),worlds=new WorldAgent(this.store),w=worlds.getWorld(runId);
      assert(w?.simulation,'本地世界尚未初始化',409);
      const persona=run.spec.cast.find(p=>p.id===input.to)||(!input.to?run.spec.cast[0]:undefined);assert(persona,'目标人物不存在');
      const latestScene=this.store.jobs(runId).filter(j=>j.kind==='storyboard').at(-1);
      const currentScene=String((latestScene?.input as {active_topic?:string})?.active_topic||latestScene?.plan?.summary||run.spec.title).slice(0,2000);
      const result=await this.request('/api/local-world/reply',{persona,currentScene,topic:run.spec.title,background:run.spec.scenario.background,text:input.text,history:run.messages.slice(-12).map(m=>m.name+': '+m.text).join('\n').slice(-16000),observation:worlds.localObservation(runId)}) as {reply:string;speaker:string;scene?:{changed:boolean;summary:string}};
      assert(result.speaker===persona.id&&typeof result.reply==='string'&&result.reply.length>0&&result.reply.length<=12000,'角色回复格式无效',502);
      return this.store.transaction(()=>{
        assert(worlds.getWorld(runId)?.revision===w.revision,'局势已变化，请重新询问',409);
        const next=this.store.run(runId);next.messages.push({id:'player-'+input.commandId,kind:'player',name:'主上',text:input.text},{id:'npc-'+input.commandId,kind:'npc',name:persona.name,text:result.reply});
        this.store.saveRun(next);
        if(process.env.AGENT_ALLOW_API_GENERATION==='true'&&result.scene?.changed===true&&typeof result.scene.summary==='string'&&result.scene.summary.length>0&&result.scene.summary.length<=100){
          this.store.enqueue(runId,'storyboard','discussion-'+input.commandId,{spec:next.spec,active_topic:result.scene.summary,stage:'讨论中的主题或方案，未确认结果',world:next.world,recent_messages:next.messages.slice(-12)});
        }
        this.store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(runId,input.commandId,digest,'done');return next;
      });
    }finally{this.busy.delete(runId);}
  }

  async start(text:string,player:string){
    const {topicId}=await this.request('/api/topics/ingest',{kind:'text',text}) as {topicId:string};
    await this.request(`/api/topics/${encodeURIComponent(topicId)}/build`,{});
    let ready=false;
    for(let i=0;i<180;i++){const {state}=await this.request(`/api/topics/${encodeURIComponent(topicId)}/status`) as {state:string};if(state==='ready'){ready=true;break;}assert(state!=='failed','剧本生成失败',502);await new Promise(r=>setTimeout(r,1000));}
    assert(ready,'剧本仍在生成，请稍后在推演服务查看',504);
    const {gameId}=await this.request('/api/games',{specId:topicId,player}) as {gameId:string};return this.import(gameId);
  }
  async import(gameId:string){
    assert(typeof gameId==='string'&&gameId.length>0&&gameId.length<200,'对局编号无效');
    const prior=this.store.runs().find(r=>r.gameId===gameId&&r.mode==='engine');if(prior)return this.sync(prior.id);
    const state=await this.request(`/api/games/${encodeURIComponent(gameId)}/state`) as EngineState;
    const raw=state.spec as Record<string,unknown>;const spec=parseSpec({...raw,id:raw.id||gameId});
    return this.store.create(spec,{}, {gameId,messages:state.chat,state:state.state,turn:state.turn});
  }
  async sync(runId:string):Promise<Run>{
    const run=this.store.run(runId);assert(run.gameId,'此对局未绑定推演服务');
    const data=await this.request(`/api/games/${encodeURIComponent(run.gameId)}/state`) as EngineState;
    assert(Number.isInteger(data.turn)&&data.turn>=run.engineTurn,'推演服务状态比本地旧，拒绝覆盖',409);
    const raw=data.spec as Record<string,unknown>;const spec=parseSpec({...raw,id:raw.id||run.spec.id});
    assert(Array.isArray(data.chat),'推演服务消息格式错误',502);
    // Existing engine owns its numeric rules. Mirror confirmed snapshots, never settle them a second time.
    for(const m of spec.metrics)assert(Number.isFinite(data.state[m.key])&&data.state[m.key]>=m.min&&data.state[m.key]<=m.max,'推演状态越界',502);
    return this.store.transaction(()=>{
      const current=this.store.run(runId);assert(current.engineTurn<=data.turn,'同步版本冲突',409);
      const before=structuredClone(current.world);const priorIds=new Set(current.messages.map(m=>m.id));
      const results=data.chat.filter(m=>m.kind==='result'&&!priorIds.has(m.id));
      const changed=hash(current.world.metrics)!==hash(data.state)||data.turn!==current.engineTurn;
      current.spec=spec;current.world.metrics={...data.state};if(changed)current.world.version++;current.engineTurn=data.turn;current.messages=data.chat;this.store.saveRun(current);
      if(changed){const id=`engine-snapshot-${data.turn}`;const payload={event:{id,summary:results.map(m=>m.text).join('\n')||'从推演服务恢复最新状态',source:'engine'},before,after:current.world};this.store.db.prepare('INSERT OR IGNORE INTO events VALUES(?,?,?,?)').run(runId,id,hash(payload),JSON.stringify(payload));}
      for(const p of spec.cast)this.store.enqueue(runId,'portrait',p.id,{persona:p,spec});
      for(const m of results)this.store.enqueue(runId,'storyboard',m.id,{spec,event:{id:m.id,confirmed:true,summary:m.text},world:current.world,majorCandidate:true,recent_messages:data.chat.slice(-12)});
      return current;
    });
  }
  async message(runId:string,input:{commandId:string;text:string;to?:string;act:boolean}){
    const run=this.store.run(runId);assert(run.gameId,'尚未连接角色与裁判引擎',409);
    assert(typeof input.commandId==='string'&&input.commandId.length>0&&input.commandId.length<=200,'缺少请求编号');
    assert(typeof input.text==='string'&&input.text.trim().length>0&&input.text.length<=2000&&typeof input.act==='boolean','消息格式无效');
    if(input.to)assert(run.spec.cast.some(p=>p.id===input.to),'目标人物不存在');
    const digest=hash(input);const old=this.store.db.prepare('SELECT * FROM commands WHERE run_id=? AND command_id=?').get(runId,input.commandId);
    if(old){assert(old.digest===digest,'相同请求编号内容不同',409);assert(old.status==='done','该请求结果尚未确认；请先同步，禁止自动重复执行',409);return this.store.run(runId);}
    assert(!this.busy.has(runId),'对局正在处理上一条消息',409);this.busy.add(runId);
    this.store.db.prepare('INSERT INTO commands VALUES(?,?,?,?)').run(runId,input.commandId,digest,'pending');
    try{await this.request(`/api/games/${encodeURIComponent(run.gameId)}/message`,{text:input.text,to:input.to,act:input.act});const result=await this.sync(runId);this.store.db.prepare("UPDATE commands SET status='done' WHERE run_id=? AND command_id=?").run(runId,input.commandId);return result;}finally{this.busy.delete(runId);}
  }
}
