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
