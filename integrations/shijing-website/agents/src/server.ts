import {record} from './world-state.js';
import {WorldAgent} from './world-agent.js';
import {projectStrategy} from './strategy-view.js';
import type {Run} from './contracts.js';
import {createTopicPlan} from './topic.js';
import {createServer,type IncomingMessage} from 'node:http';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {AgentError,assert,parseSpec,type Settlement} from './contracts.js';
import {Store,hash} from './store.js';
import {Worker} from './worker.js';
import {OpenAIArt} from './provider.js';
import {EngineBridge} from './engine.js';
export function view(store:Store,id:string){const run=store.run(id);const worlds=new WorldAgent(store);return{...run,strategy:projectStrategy(worlds.getWorld(id),worlds.recentEvents(id),{title:run.spec.title,runId:id,demo:worlds.basis(id)?.kind==='demo',basisNote:worlds.basis(id)?.note}),generationEnabled:process.env.AGENT_ALLOW_API_GENERATION!=='false',jobs:store.jobs(id).map(({input:_input,...j})=>j),history:store.history(id)};}
async function body(req:IncomingMessage){let size=0;const parts:Buffer[]=[];for await(const part of req){size+=part.length;assert(size<=200000,'请求内容过大',413);parts.push(part);}try{return JSON.parse(Buffer.concat(parts).toString()) as Record<string,unknown>;}catch{throw new AgentError('请求必须为 JSON');}}
export function makeServer(store:Store,worker:Worker){
  const engine=new EngineBridge(store);const worlds=new WorldAgent(store);worlds.bootstrapPendingRuns();
  return createServer(async(req,res)=>{
    try{
      // Local sidecar. Browsers must use the same-origin website proxy; remote deployment needs an authenticated private network.
      assert(!req.headers.origin,'请通过网页同源接口访问',403);
      const secret=process.env.AGENT_SERVICE_TOKEN;
      if(secret){const supplied=req.headers.authorization||'';const wanted=`Bearer ${secret}`;assert(Buffer.byteLength(supplied)===Buffer.byteLength(wanted)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(wanted)),'访问凭证无效',401);}
      const url=new URL(req.url||'/', 'http://localhost');const path=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);const method=req.method;
      let out:unknown;let generationRun:string|undefined;
      if(method==='GET'&&path[0]==='health')out={configured:!!process.env.OPENAI_API_KEY,engineConfigured:!!process.env.SIM_ENGINE_URL,active:worker.active,generationEnabled:process.env.AGENT_ALLOW_API_GENERATION!=='false',libraryCount:worker.library?.entries().length??0};
      else if(method==='GET'&&path[0]==='major-events'){
        store.db.exec('CREATE TABLE IF NOT EXISTS major_ack(job_id TEXT PRIMARY KEY,confirmed_at TEXT NOT NULL)');
        const acknowledged=new Set(store.db.prepare('SELECT job_id FROM major_ack').all().map(r=>String(r.job_id)));
        const runs=store.db.prepare('SELECT payload FROM runs ORDER BY rowid').all().map(r=>JSON.parse(String(r.payload)) as Run);
        const requested=url.searchParams.get('run');
        out={topics:runs.map(r=>({id:r.id,title:r.spec.title})),events:store.jobs().filter(j=>j.majorEvent&&j.status==='succeeded'&&j.asset&&(requested?j.runId===requested:acknowledged.has(j.id))).map(j=>{const run=runs.find(r=>r.id===j.runId);const background=run?.spec.scenario.background||'';const details=j.input as {event?:{summary?:string;cityChanges?:{city:string}[]}};const eventText=(details.event?.summary||'')+' '+(j.plan?.summary||'');const places=[...new Set([...(details.event?.cityChanges||[]).map(c=>c.city),...['长安','汉中','街亭','子午谷','成都','洛阳','荆州','祁山','陈仓','五丈原','剑阁','阴平','绵竹'].filter(p=>eventText.includes(p))])];const match=background.match(/公元(\d+)年/);return {id:j.id,runId:j.runId,topic:run?.spec.title||'',title:j.plan?.summary||'重大事件',year:match?Number(match[1]):0,time:match?'公元'+match[1]+'年（议题起始时间）':'时间未记载',places,aliases:[run?.spec.title||''],image:'/api/agents/assets/'+j.asset,confirmed:acknowledged.has(j.id)};})};
      }
      else if(method==='POST'&&path[0]==='major-events'&&path[2]==='confirm'){
        const job=store.job(path[1]);assert(job.majorEvent&&job.status==='succeeded'&&job.asset,'事件尚未完成',409);
        store.db.exec('CREATE TABLE IF NOT EXISTS major_ack(job_id TEXT PRIMARY KEY,confirmed_at TEXT NOT NULL)');
        store.db.prepare('INSERT OR IGNORE INTO major_ack VALUES(?,?)').run(job.id,new Date().toISOString());out={ok:true};
      }
      else if(method==='POST'&&path[0]==='topic'&&path.length===1)out=await createTopicPlan(await body(req));
      else if(method==='GET'&&path[0]==='assets'&&path.length===2){const image=readFileSync(store.asset(path[1]));res.writeHead(200,{'Content-Type':'image/png','Cache-Control':'private, max-age=31536000, immutable','X-Content-Type-Options':'nosniff'});res.end(image);return;}
      else if(method==='GET'&&path[0]==='strategy-library'&&path.length===1)out=worlds.strategyLibrary(url.searchParams.get('cursor')||'',Number(url.searchParams.get('limit')||100));
      else if(method==='GET'&&path[0]==='runs'&&path.length===1)out={runs:store.runs().map(r=>({id:r.id,title:r.spec.title,mode:r.mode,createdAt:r.createdAt}))};
      else if(method==='POST'&&path[0]==='runs'&&path.length===1){
        const b=await body(req);assert(b.reuseKey===undefined||(typeof b.reuseKey==='string'&&b.reuseKey.length>0&&b.reuseKey.length<=2000),'复用编号无效');
        const key=b.reuseKey?hash(b.reuseKey):undefined;
        const prior=key?store.db.prepare('SELECT * FROM starts WHERE id=?').get(key):undefined;
        if(prior){assert(prior.status==='done'&&prior.run_id,'这份议题正在建立或上次建立已中断；请稍后重连，避免重复创建',409);out=view(store,String(prior.run_id));}
        else{
          if(key)store.db.prepare('INSERT INTO starts VALUES(?,NULL,?)').run(key,'pending');
          try{
            let id:string;
            if(b.spec)id=store.create(parseSpec(b.spec),(b.cities??{}) as Record<string,string>).id;
            else{assert(typeof b.topic==='string'&&b.topic.length>0&&b.topic.length<=20000,'议题内容无效');assert(typeof b.player==='string'&&b.player.length>0&&b.player.length<100,'玩家身份无效');id=(await engine.start(b.topic,b.player)).id;}
            if(key)store.db.prepare("UPDATE starts SET status='done',run_id=? WHERE id=?").run(id,key);out=view(store,id);
          }catch(e){if(key)store.db.prepare("UPDATE starts SET status='interrupted' WHERE id=?").run(key);throw e;}
        }
      }
      else if(method==='POST'&&path[0]==='world-demo'&&path.length===1){const b=await body(req);record(b,'演示请求');out=view(store,worlds.createDemo(b.requestId as string));}
      else if(method==='POST'&&path[0]==='import'){const b=await body(req);assert(typeof b.gameId==='string','需要对局编号');out=view(store,(await engine.import(b.gameId)).id);}
      else if(path[0]==='runs'&&path[1]){
        const id=path[1];store.run(id);
        if(method==='GET'&&path.length===2)out=view(store,id);
        else if(method==='GET'&&path[2]==='strategy-map'&&path.length===3)out=worlds.strategyMap(id,url.searchParams.get('decisionId')||undefined);
        else if(method==='GET'&&path[2]==='world'&&path.length===3)out={world:worlds.getWorld(id),basis:worlds.basis(id)};
        else if(method==='POST'&&path[2]==='world'&&path.length===3){worlds.initializeWorld(id,await body(req));out=view(store,id);}
        else if(method==='GET'&&path[2]==='world-events'&&path.length===3)out={events:worlds.listEvents(id,{decisionId:url.searchParams.get('decisionId')||undefined,entityId:url.searchParams.get('entityId')||undefined,afterRevision:Number(url.searchParams.get('afterRevision')||0),limit:Number(url.searchParams.get('limit')||50)})};
        else if(method==='POST'&&path[2]==='world-events'&&path.length===3){const result=worlds.applySettlement(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='GET'&&path[2]==='world-observation'&&path.length===3)out=worlds.localObservation(id,url.searchParams.get('faction')||undefined);
        else if(method==='POST'&&path[2]==='world-order'&&path.length===3){const result=worlds.localOrder(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='world-advance'&&path.length===3){const result=worlds.localAdvance(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='world-demo-step'&&path.length===3){const b=await body(req);record(b,'演示推进请求');worlds.demoStep(id,b.expectedRevision);out=view(store,id);}
        else if(method==='POST'&&path[2]==='prepare'){
          for(const j of store.jobs(id))if(j.status==='failed'&&j.error==='当前配置为第三方兼容服务，请先确认密钥属于该服务并授权连接。'&&process.env.OPENAI_COMPATIBLE_CONFIRMED==='true')store.retry(j.id);
          generationRun=id;out=view(store,id);
        }
        else if(method==='GET'&&path[2]==='manifest'){out={version:1,entries:[...new Map(store.jobs(id).filter(j=>j.status==='succeeded').map(j=>[`${j.kind}/${j.subjectId}`,j])).values()].map(j=>({key:`${j.kind==='portrait'?'portrait':'event'}/${j.subjectId}`,category:j.kind==='portrait'?'portrait':j.majorEvent?'major-event':'event',file:`/api/agents/assets/${j.asset}`,alt:j.plan?.summary||j.subjectId,w:j.kind==='portrait'?1024:j.majorEvent?1537:904,h:j.kind==='portrait'?1024:j.majorEvent?636:1602}))};}
        else if(method==='POST'&&path[2]==='events'){assert(store.run(id).mode==='standalone','已连接引擎的对局只能同步引擎裁判结果',409);store.apply(id,await body(req) as unknown as Settlement);out=view(store,id);}
        else if(method==='POST'&&path[2]==='sync'){await engine.sync(id);out=view(store,id);}
        else if(method==='POST'&&path[2]==='messages'){const input=await body(req);if(store.run(id).mode==='standalone')worlds.localMessage(id,input);else await engine.message(id,input as Parameters<EngineBridge['message']>[1]);out=view(store,id);}
        else throw new AgentError('接口不存在',404);
      }else if(method==='POST'&&path[0]==='jobs'&&path[2]==='retry'){const job=store.retry(path[1]);generationRun=job.runId;out=job;}
      else throw new AgentError('接口不存在',404);
      res.writeHead(method==='POST'?202:200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(out));
      if(method==='POST'&&path[0]==='runs'&&path[1]&&['events','sync','messages'].includes(path[2])&&!worlds.getWorld(path[1])?.simulation)generationRun=path[1];
      if(generationRun)void worker.drain(generationRun);
    }catch(e){res.writeHead(e instanceof AgentError?e.status:500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:e instanceof AgentError?e.message:'任务处理失败，请查看本机服务状态'}));}
  });
}
