import {record,worldVerdict} from './world-state.js';
import {WorldAgent} from './world-agent.js';
import {buildObservation,currentDay,grantMandate,revokeMandate,mandatesFor,planDecisions,decisionsToCommands,commanderSummary,readCommanderState,COMMANDER_ROLES,COMMANDER_LABELS,type CommanderState,type CommanderReject,type CommanderRole} from './agent-commander.js';
import {loadModBundle,validateManifest,modSummary,assertNoSecrets} from './mods.js';
import {readdirSync,existsSync} from 'node:fs';
import {join} from 'node:path';
import {buildChronicle,renderChronicleMarkdown} from './historian.js';
import {projectStrategy} from './strategy-view.js';
import type {Run} from './contracts.js';
import {createTopicPlan} from './topic.js';
import {createServer,type IncomingMessage} from 'node:http';
import {readFileSync} from 'node:fs';
import {timingSafeEqual} from 'node:crypto';
import {AgentError,assert,parseSpec,type Settlement} from './contracts.js';
import {Store,hash} from './store.js';
import {Worker} from './worker.js';
import {OpenAIArt,setRuntimeKey,clearRuntimeKey,runtimeKeyInfo} from './provider.js';
import {EngineBridge} from './engine.js';
import {evaluateForRun,commitUnlocks} from './achievement-runtime.js';
import {MAX_SLOTS,listSlots,writeSlot,readSlotFile,clearSlot,nextFreeSlot,type CloudSaveEntry,type SlotWrite} from './save-slots.js';
import type {WorldEvent,WorldSnapshot} from './world-contracts.js';
import {createRequire} from 'node:module';
export function view(store:Store,id:string){const run=store.run(id);const worlds=new WorldAgent(store);return{...run,strategy:projectStrategy(worlds.getWorld(id),worlds.recentEvents(id),{title:run.spec.title,runId:id,demo:worlds.basis(id)?.kind==='demo',basisNote:worlds.basis(id)?.note}),generationEnabled:process.env.AGENT_ALLOW_API_GENERATION!=='false',jobs:store.jobs(id).map(({input:_input,...j})=>j),history:store.history(id)};}
async function body(req:IncomingMessage){let size=0;const parts:Buffer[]=[];for await(const part of req){size+=part.length;assert(size<=200000,'请求内容过大',413);parts.push(part);}const raw=Buffer.concat(parts);
 // BUG-109：GBK 等非 UTF-8 字节此前被 toString() 照单全收，乱码文本入了库才在「世界
 // 引导」处爆 422，玩家照提示改名也治不好，还留下一堆乱码孤儿局。入库前先做 fatal 解码
 // 与 U+FFFD 扫描，非法字节就地 400，一句话说清是编码问题。
 let text:string;try{text=new TextDecoder('utf-8',{fatal:true}).decode(raw);}catch{throw new AgentError('请求内容不是有效的 UTF-8 编码；请让客户端以 UTF-8 提交（检查是否误用 GBK/ANSI）。',400);}
 if(text.includes('\uFFFD'))throw new AgentError('请求内容含有无效字符（U+FFFD）：编码疑似不是 UTF-8，请以 UTF-8 重新提交。',400);
 try{return JSON.parse(text) as Record<string,unknown>;}catch{throw new AgentError('请求必须为 JSON');}}
/** MOD 目录：数据包放这里，服务启动时列出，不进代码库。 */
function modsDir():string{return process.env.MODS_DIR||join(process.cwd(),'mods');}
function listMods(){
 const dir=modsDir();if(!existsSync(dir))return{dir,mods:[]};
 const mods=[];for(const f of readdirSync(dir).filter((x:string)=>x.endsWith('.json'))){
  // loadModBundle 内部会跑 validateManifest，直接取 bundle.manifest——不能在包对象上再跑一次 manifest 校验
  try{const raw=JSON.parse(readFileSync(join(dir,f),'utf8'));assertNoSecrets(raw);const bundle=loadModBundle(raw);mods.push({file:f,...bundle.manifest,summary:modSummary(bundle)});}
  catch(e){mods.push({file:f,error:e instanceof Error?e.message:'MOD 无法解析'});}
 }
 return {dir,mods};
}
function validateModPayload(raw:unknown){
  assertNoSecrets(raw);
  const bundle=loadModBundle(raw);
  return {ok:true,manifest:bundle.manifest,summary:modSummary(bundle)};
}
/* steam/ 交付在 agents 构建（tsconfig rootDir=src）之外：静态 import 会炸 tsc（TS6059），
   而 Node ≥22.18 能类型剥离直接加载 .ts，故与 achievement-runtime/save-slots 同一套运行时桥接。 */
const require=createRequire(import.meta.url);
/** 优先加载预编译的 .mjs：打包态 sidecar 跑在 Electron 自带的 Node 20 上，没有类型剥离能力，
  *  加载 .ts 会直接 SyntaxError。开发态没跑 steam:build 时回落 .ts（Node 24 可剥离）。
  *  两份都由 steam/build.mjs 从同一份 .ts 产出，形状一致。 */
function steamModule(base:string):unknown{
 try{return require(`../../steam/${base}.mjs`);}
 catch{return require(`../../steam/${base}.ts`);}
}
/** 云存档提供者：字段与文件系统后端完全一致（同一个 createCloudSave 的形状），
 *  createSteamCloudSave 是同一套接口的 Steam 云端实现，返回的条目格式、失败语义都相同。 */
type CloudProvider={available:boolean;list():Promise<CloudSaveEntry[]>;read(gameId:string):Promise<CloudSaveEntry|null>;write(entry:CloudSaveEntry):Promise<void>;remove(gameId:string):Promise<void>};
const cloudSave=()=>steamModule('cloud-save') as {exportRunToSave(run:Run,world:WorldSnapshot,events:WorldEvent[]):SlotWrite;importRunFromSave(entry:unknown):{run:Run;world:WorldSnapshot;events:WorldEvent[]};createCloudSave(dir:string):CloudProvider;createSteamCloudSave(appId?:string):CloudProvider};
const steamApi=()=>steamModule('steam') as {initSteam(appId?:string):{available:boolean;appId?:string};isSteamAvailable():boolean;unlockAchievement(id:string):boolean;setStat(id:string,value:number):boolean};
let steamProbed=false;let steamStatus:{available:boolean;appId?:string}={available:false};
/** sidecar 是 electron 壳拉起的独立进程，壳里 init 的 Steam 连接不跨进程共享：首次碰 Steam 时自 init 一次
   （探测链任何一环失败都是安全的 unavailable）。只探一次——重复 init 同一个原生连接没有意义，
   而每次请求都探会把一次失败重试成多次。@returns Steam 是否可用。 */
function ensureSteamProbed():boolean{
  if(!steamProbed){steamProbed=true;try{steamStatus=steamApi().initSteam();}catch{steamStatus={available:false};}}
  try{if(steamStatus.available)return true;return steamApi().isSteamAvailable();}catch{return false;}
}
/** 成就推送：无 Steam 时 unlockAchievement 恒为 false——一个都不抛，绝不让原生模块把成就接口拖死。 */
function pushAchievementsToSteam(ids:string[]):boolean{
  const available=ensureSteamProbed();
  try{const steam=steamApi();if(available)for(const id of ids)steam.unlockAchievement(id);return available;}catch{return false;}
}
/** 统计项推送：与成就同一套失败语义——无 Steam 时 setStat 恒为 false、一个都不抛；
 *  Steamworks 后台没配这个统计项时也是静默 false（steam.ts 的 setStat 内部兜底），
 *  绝不让统计写入把成就路由拖垮。setStat 是覆盖写，同一值重复推无副作用。 */
function pushStatsToSteam(stats:Record<string,number>):boolean{
  const available=ensureSteamProbed();
  try{const steam=steamApi();if(available)for(const [id,value] of Object.entries(stats))steam.setStat(id,value);return available;}catch{return false;}
}
/**
 * 云存档后端选择：Steam 可用就走云端，否则回落本地目录。
 *
 * 为什么必须有这一条：createSteamCloudSave 早就实现并导出了，但没有任何地方调用它——
 * 云端存档在 Steam 版里等于没接，玩家存档只落本地磁盘，商店页的「Steam Cloud」是空的。
 * 两个后端共用同一命名空间（`cloud-saves/<对局编号>.json`）和同一套校验，换后端不改存档
 * 位置、不用迁移，所以「按可用性选一个」不会让旧存档读不出来。
 *
 * appid 必须从 initSteam 的返回值传给云端后端：它内部要 init(appid) 才知道往哪个 app 的
 * 云里写。自己再去探一遍是条死路——ESM 模块加载不了，异常被 catch 吞掉后返回空串，
 * Number('')=0 让 init(0) 失败，表现成「云存档不可用」这种和真实原因无关的怪错。
 *
 * 无 Steam 时本地路径一行不变——非 Steam 用户（直接下包、Steam 外启动、开发期）行为与之前一致。
 */
function cloudProvider(directory:string):CloudProvider{
  try{if(ensureSteamProbed()){
    const steam=cloudSave().createSteamCloudSave(steamStatus.appId);
    if(steam.available)return steam;
  }}catch{/* 云端不可用不致命，回落本地 */}
  return cloudSave().createCloudSave(directory);
}
export function makeServer(store:Store,worker:Worker){
 const engine=new EngineBridge(store);const worlds=new WorldAgent(store);worlds.bootstrapPendingRuns();
 // 开局派生国策（异步）：bootstrap 时先用关键词兜底保证「立刻有得点」，这里再按议题文本
 // 补一份真正贴合玩家意图的。失败不碰世界，慢一点也不卡开局——一次网络往返而已。
 void (async()=>{
  for(const row of store.db.prepare("SELECT id FROM runs WHERE json_extract(payload,'$.world.cities') IS NOT NULL").all().slice(-8)){
   try{await worlds.refreshDerivedAnchors(String(row.id));}catch{/* 读不出就本局不设史实新闻 */}
   try{await worlds.refreshDerivedFocuses(String(row.id));}catch{/* 读不出来就保留兜底清单 */}
  }
 })();
 /** 全量事件流水：成就判定与存档都要完整流水，listEvents 的 200 条上限会把早期事件切掉（首夺城池、初次请旨都在早期）。 */
 const allEvents=(id:string):WorldEvent[]=>store.db.prepare('SELECT payload FROM world_events WHERE run_id=? ORDER BY revision').all(id).map(r=>JSON.parse(String(r.payload)));
 /** AI 大臣的 mandate 簿挂在 run payload 上随 saveRun 整体落库：授权是元数据不是世界状态，不值得单开一张表；读不到的旧对局按空簿开局。 */
 type CommanderCarrier={commander?:CommanderState};
 const carrier=(id:string)=>store.run(id) as unknown as Run&CommanderCarrier;
 const readCommander=(id:string)=>readCommanderState(carrier(id).commander);
 const saveCommander=(id:string,s:CommanderState)=>{const r=carrier(id);r.commander=s;store.saveRun(r);}
  return createServer(async(req,res)=>{
    try{
      // Local sidecar. Browsers must use the same-origin website proxy; remote deployment needs an authenticated private network.
      assert(!req.headers.origin,'请通过网页同源接口访问',403);
      const secret=process.env.AGENT_SERVICE_TOKEN;
      if(secret){const supplied=req.headers.authorization||'';const wanted=`Bearer ${secret}`;assert(Buffer.byteLength(supplied)===Buffer.byteLength(wanted)&&timingSafeEqual(Buffer.from(supplied),Buffer.from(wanted)),'访问凭证无效',401);}
      const url=new URL(req.url||'/', 'http://localhost');const path=url.pathname.split('/').filter(Boolean).map(decodeURIComponent);const method=req.method;
      let out:unknown;let generationRun:string|undefined;
      if(method==='POST'&&path[0]==='generation-key'&&path.length===1){const b=await body(req);
        // 玩家自带生图密钥：只进进程内存，不落盘、不写日志、不入库
        if(b&&b.clear)clearRuntimeKey();
        else setRuntimeKey(String((b&&b.baseUrl)||''),String((b&&b.apiKey)||''));
        out={ok:true,...runtimeKeyInfo()};
      }
      else if(method==='GET'&&path[0]==='health')out={...runtimeKeyInfo(),engineConfigured:!!process.env.SIM_ENGINE_URL,active:worker.active,generationEnabled:process.env.AGENT_ALLOW_API_GENERATION!=='false',libraryCount:worker.library?.entries().length??0};
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
      else if(method==='POST'&&path.length===2&&path[0]==='mods'&&path[1]==='validate'){out=validateModPayload(await body(req));}
      else if(method==='GET'&&path.length===1&&path[0]==='mods'){out=listMods();}
      else if(method==='GET'&&path[0]==='runs'&&path.length===1){
        const limit=Math.min(Math.max(Number(url.searchParams.get('limit'))||30,1),200),offset=Math.max(Number(url.searchParams.get('offset'))||0,0);
        const page=store.runs(limit,offset);
        out={runs:page.map(r=>({id:r.id,title:r.spec.title,mode:r.mode,createdAt:r.createdAt})),...(page.length===limit?{nextOffset:offset+limit}:{})};
      }
      else if(method==='POST'&&path[0]==='runs'&&path.length===1){
        const b=await body(req);assert(b.reuseKey===undefined||(typeof b.reuseKey==='string'&&b.reuseKey.length>0&&b.reuseKey.length<=2000),'复用编号无效');
        const key=b.reuseKey?hash(b.reuseKey):undefined;
        const prior=key?store.db.prepare('SELECT * FROM starts WHERE id=?').get(key):undefined;
        if(prior){assert(prior.status==='done'&&prior.run_id,'这份议题正在建立或上次建立已中断；请稍后重连，避免重复创建',409);out=view(store,String(prior.run_id));}
        else{
          if(key)store.db.prepare('INSERT INTO starts VALUES(?,NULL,?)').run(key,'pending');
          try{
            let id:string;
            if(b.researchTopic)id=(await engine.researchTopic(b.researchTopic)).id;
            // {spec} 这条路一律开本地对局（无第三个参数的 create 全是 standalone），而本地
            // 世界不要指标：buildInitialWorld 见到 metrics 就返回 null。与 engine.researchTopic、
            // onboarding 的 toRunSpec 同口径，先剥掉再建——否则客户端带上游指标数组就会吃一条
            // 「没有三国人物」的 422，那条建议根本治不了这个病。
            else if(b.spec)id=store.create(parseSpec({...b.spec,metrics:[]}),(b.cities??{}) as Record<string,string>).id;
            else{assert(typeof b.topic==='string'&&b.topic.length>0&&b.topic.length<=20000,'议题内容无效');assert(typeof b.player==='string'&&b.player.length<100,'玩家身份无效');id=(await engine.start(b.topic,b.player)).id;}
            // 这条只挡**玩家从 UI 自助建局**这条路：本地的 {spec} 建局期望世界被自动引导出来，
            // 而 buildInitialWorld 对议题文案有文本门槛（题目+背景要命中三国人物/势力/地名，
            // 且背景里要有「公元N年」），够不着就静默返回 null。此前这里不检查，于是玩家看到
            // 的是「建局 202、读世界 200 但 world=null」：地图全空、下令与跳转全部 409，且
            // 没有任何解释——只会觉得这游戏玩不起来。真机试玩时用口语化议题一测就中招。
            // 现在明确报 422 并说清怎么改。
            // （不在 store.create 里断言：那里的 world=null 是合法态，上游引擎局与测试fixture
            //  都指望随后经 initializeWorld 显式给世界。）
            // 两种原因都会走到这里，报错时都要说清：实测 spec.id 写成 'bad id!!' 时只提示
            // 「没有三国人物」，玩家按那条建议改了半天地名也治不好这个病。
            if(!worlds.getWorld(id)){
              // BUG-109：引导失败的局不留孤儿——刚建的 run 连带 jobs/世界数据一并清掉，
              // starts 行也删（同 reuseKey 重试可重新建局），再 422 说清两条原因。
              store.deleteRun(id);if(key)store.db.prepare('DELETE FROM starts WHERE id=?').run(key);
              assert(false,'本地世界没能初始化：① 题目与背景里没有可识别的三国人物、势力或地名（试试点名「诸葛亮／魏延／曹操」，或写「汉中／长安／官渡」等地名），并且背景里需要有一处「公元N年」；② spec.id 只能是 1–120 位字母、数字、下划线或短横线。请按这两条核对。',422);
            }
            if(key)store.db.prepare("UPDATE starts SET status='done',run_id=? WHERE id=?").run(id,key);out=view(store,id);
            // 建局即派生国策（不等重启）：启动时那次自动刷新只覆盖「已存在的对局」，
            // 玩家新建的议题就永远只拿关键词兜底。这里补一次，fire-and-forget 不卡响应。
            void worlds.refreshDerivedFocuses(id).catch(()=>{/* 读不出就保留兜底清单 */});
            void worlds.refreshDerivedAnchors(id).catch(()=>{/* 读不出就本局不设史实新闻 */});
          }catch(e){if(key)store.db.prepare("UPDATE starts SET status='interrupted' WHERE id=?").run(key);throw e;}
        }
      }
      else if(method==='POST'&&path[0]==='world-demo'&&path.length===1){const b=await body(req);record(b,'演示请求');out=view(store,worlds.createDemo(b.requestId as string));}
      else if(method==='POST'&&path[0]==='import'){const b=await body(req);assert(typeof b.gameId==='string','需要对局编号');out=view(store,(await engine.import(b.gameId)).id);}
      else if(path[0]==='runs'&&path[1]){
        const id=path[1];store.run(id);
        // UX-007：删除议题。整局删除（连带世界/任务/事件），删完即不可恢复——前端有二次确认。
        if(method==='DELETE'&&path.length===2){store.deleteRun(id);out={ok:true};}
        else if(method==='GET'&&path.length===2)out=view(store,id);
        else if(method==='GET'&&path[2]==='strategy-map'&&path.length===3)out=worlds.strategyMap(id,url.searchParams.get('decisionId')||undefined);
        else if(method==='GET'&&path[2]==='world'&&path.length===3)out={world:worlds.getWorld(id),basis:worlds.basis(id)};
        else if(method==='POST'&&path[2]==='world'&&path.length===3){worlds.initializeWorld(id,await body(req));out=view(store,id);}
        else if(method==='GET'&&path[2]==='world-events'&&path.length===3)out={events:worlds.listEvents(id,{decisionId:url.searchParams.get('decisionId')||undefined,entityId:url.searchParams.get('entityId')||undefined,afterRevision:Number(url.searchParams.get('afterRevision')||0),limit:Number(url.searchParams.get('limit')||50),latest:url.searchParams.get('latest')==='1'})};
        else if(method==='POST'&&path[2]==='world-events'&&path.length===3){const result=worlds.applySettlement(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='GET'&&path[2]==='world-observation'&&path.length===3)out=worlds.localObservation(id,url.searchParams.get('faction')||undefined);
        // 成就：算 → 落盘 → 推 Steam，一次请求同源完成。GET 带副作用是有意的——玩家每次进场、每次跳转
        // 都该看到「刚解锁了什么」；判定、求差、落盘拆成两步，就会出现「报了但没记住」的两处账本
        else if(method==='GET'&&path[2]==='achievements'&&path.length===3){
          const w=worlds.getWorld(id);assert(w,'此议题尚未初始化世界',409);
          // 「五局老将」是跨局累计，v1 由宿主按「库里出现过几局」经 stats 供给：schema 里没有终局标记，不另立一本账
          const runsCompleted=Number(store.db.prepare('SELECT COUNT(*) AS n FROM runs').get()?.n??0);
          const snapshot=evaluateForRun({runId:id,world:w,events:allEvents(id),stats:{runs_completed:runsCompleted},dir:store.directory});
          commitUnlocks(store.directory,snapshot.newlyUnlocked);
          const steamAvailable=pushAchievementsToSteam(snapshot.newlyUnlocked.map(a=>a.id));
          // 同一个 runs_completed 也写一份 Steam 统计项：后台统计页配了项才有数据（覆盖写，重复推无副作用）
          pushStatsToSteam({runs_completed:runsCompleted});
          out={...snapshot,steamAvailable};
        }
        else if(method==='POST'&&path[2]==='cloud-save'&&path.length===3){
          // 云存档：Steam 可用时落 Steam 云端，否则落 <AGENT_DATA_DIR>/cloud-saves/<对局编号>.json。
          // 两个后端共用命名空间与条目格式，换后端不改存档位置（见 cloudProvider 注释）。
          const w=worlds.getWorld(id);assert(w,'此议题尚未初始化世界',409);
          const provider=cloudProvider(store.directory);
          await provider.write(cloudSave().exportRunToSave(store.run(id),w,allEvents(id)));
          out={ok:true,available:provider.available,cloud:provider.available&&ensureSteamProbed()?'steam':'local'};
        }
        else if(method==='GET'&&path[2]==='cloud-saves'&&path.length===3){const provider=cloudProvider(store.directory);out={saves:await provider.list(),available:provider.available,cloud:provider.available&&ensureSteamProbed()?'steam':'local'};}
        // AI 指挥官：玩家侧的「方针—执行分离」。读视野与方略簿只读不改；授权/撤销走 payload 事务；plan 只规划不下单——执行仍走 world-order 过同一道工具闸门。
        else if(method==='GET'&&path[2]==='commander'&&path.length===3){
          const w=worlds.getWorld(id);assert(w,'此议题尚未初始化世界',409);const state=readCommander(id);
          out={roles:COMMANDER_ROLES.map(r=>({role:r,label:COMMANDER_LABELS[r],mandate:mandatesFor(state,r)})),mandates:state.mandates,observation:buildObservation(w)};
        }
        else if(method==='POST'&&path[2]==='commander'&&path[3]==='mandate'&&path.length===4){
          const b=await body(req),role=String(b.role??'');assert(COMMANDER_ROLES.includes(role as CommanderRole),'受命大臣只能是 丞相/太尉/太傅/司徒');
          assert(typeof b.intent==='string'&&b.intent.trim().length>0&&b.intent.length<=2000,'方略原话应为 1—2000 字');
          const constraints=Array.isArray(b.constraints)?b.constraints.map((c:unknown)=>String(c??'').slice(0,200)).filter((c:string)=>c.length>0):[];
          const w=worlds.getWorld(id),day=w?currentDay(w):0;
          // B6（QA 实测）：终局后 mandate/revoke 仍在改写授权簿，而其余 14 条写路径都已 409。
          if(w){const ended=worldVerdict(w);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);}
          out=store.transaction(()=>{const next=grantMandate(readCommander(id),role as CommanderRole,(b.intent as string).trim(),constraints,day);saveCommander(id,next);return{...next,day};});
        }
        else if(method==='POST'&&path[2]==='commander'&&path[3]==='revoke'&&path.length===4){
          const b=await body(req),role=String(b.role??'');assert(COMMANDER_ROLES.includes(role as CommanderRole),'受命大臣只能是 丞相/太尉/太傅/司徒');
          const w=worlds.getWorld(id),day=w?currentDay(w):0;
          // B6：同上——终局后不得再改授权簿。
          if(w){const ended=worldVerdict(w);assert(!ended.over,'本局已终局：'+ended.summary+'。请另开新议题。',409);}
          out=store.transaction(()=>{const next=revokeMandate(readCommander(id),role as CommanderRole,day);saveCommander(id,next);return{...next,day};});
        }
        else if(method==='POST'&&path[2]==='commander'&&path[3]==='plan'&&path.length===4){
          const b=await body(req),role=String(b.role??'');assert(COMMANDER_ROLES.includes(role as CommanderRole),'受命大臣只能是 丞相/太尉/太傅/司徒');
          const w=worlds.getWorld(id);assert(w,'此议题尚未初始化世界',409);
          // 朝堂状态与上一轮执行记录由调用方持有：UI 知道陛下在做什么，执行方知道哪条命令已经下过
          const court=(b.court==='attending'||b.court==='indulging')?b.court:'delegated';
          const recent=Array.isArray(b.recentActions)?b.recentActions.map((x:unknown)=>String(x).slice(0,200)):[];
          const state=readCommander(id);
          const decisions=planDecisions({role:role as CommanderRole,mandate:mandatesFor(state,role as CommanderRole),observation:buildObservation(w),court,recentActions:recent});
          const rejected:CommanderReject[]=[],commands=decisionsToCommands(decisions,w.revision,rejected);
          out={role,day:currentDay(w),decisions,commands,rejected,summary:commanderSummary(decisions)};
        }
        else if(method==='POST'&&path[2]==='world-order'&&path.length===3){const result=worlds.localOrder(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='world-advance'&&path.length===3){const result=worlds.localAdvance(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='world-jump'&&path.length===3){const result=worlds.localJump(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='province-update'&&path.length===3){const result=worlds.updateProvince(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='decision'&&path.length===3){const result=worlds.decide(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='diplomacy'&&path.length===3){const result=worlds.diplomacy(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='focus'&&path.length===3){const result=worlds.adoptFocus(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='tech'&&path.length===3){const result=worlds.adoptTech(id,await body(req));out={...view(store,id),worldResult:result};}
        // 第 7 轮：点数加急（封顶后的消费出口）与粜粮济民（城粮堆积的出口）。三个都走
        // world-agent 的事务方法，与 adoptFocus 同口径——版本锁、幂等、决策簿留痕。
        else if(method==='POST'&&path[2]==='focus-expedite'&&path.length===3){const result=worlds.expediteFocus(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='tech-expedite'&&path.length===3){const result=worlds.expediteTech(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='sell-grain'&&path.length===3){const result=worlds.sellGrain(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='focus-refresh'&&path.length===3){out=await worlds.refreshDerivedFocuses(id);}
        // 史实时间线重拉：派生是异步的，失败了玩家能看到「本局暂无史实时间线」，给一次手动重试。
        else if(method==='POST'&&path[2]==='anchor-refresh'&&path.length===3){out=await worlds.refreshDerivedAnchors(id);}
        else if(method==='POST'&&path[2]==='whatif-refresh'&&path.length===3){out=await worlds.refreshWhatIfs(id);}
        else if(method==='POST'&&path[2]==='whatif'&&path.length===3){const result=worlds.decideWhatIf(id,await body(req));out={...view(store,id),worldResult:result};}
        else if(method==='POST'&&path[2]==='world-demo-step'&&path.length===3){const b=await body(req);record(b,'演示推进请求');worlds.demoStep(id,b.expectedRevision);out=view(store,id);}
        else if(method==='POST'&&path[2]==='prepare'){
          for(const j of store.jobs(id))if(j.status==='failed'&&j.error==='当前配置为第三方兼容服务，请先确认密钥属于该服务并授权连接。'&&process.env.OPENAI_COMPATIBLE_CONFIRMED==='true')store.retry(j.id);
          generationRun=id;out=view(store,id);
        }
        else if(method==='GET'&&path[2]==='chronicle'){
          // 史官：从事件流水提炼一局记录，输出给 LLM 读的因果材料。只读，不推进、不生图。
          const run=store.run(id),found=worlds.getWorld(id);assert(found,'此议题尚未初始化世界',409);const w=found;
          // 终局判据统一走 worldVerdict：这里曾自己按「城池归属势力数」重算一遍，
          // 于是新增的 scenario-complete（推进到剧本年限）在史官志里永远不被承认——
          // 玩家刚打完一局，导出的记录却写「本局尚无终局判定」，verdict=null。
          const verdict=worldVerdict(w);
          const ending=verdict.over
            ?{title:run.spec.title,summary:verdict.summary,verdict:verdict.outcome}
            :{title:run.spec.title,summary:'本局尚无终局判定。',verdict:null};
          const record=buildChronicle({events:allEvents(id),world:w,cast:run.spec.cast.map(p=>({id:p.id,name:p.name,role:p.role})),openingPrompt:run.spec.scenario.background,ending});
          out={record,markdown:renderChronicleMarkdown(record)};
        }
        else if(method==='GET'&&path[2]==='manifest'){out={version:1,entries:[...new Map(store.jobs(id).filter(j=>j.status==='succeeded').map(j=>[`${j.kind}/${j.subjectId}`,j])).values()].map(j=>{
          // 尺寸按**文件真实宽高**报：此前一律写死 1024x1024，而库里立绘有 2048、1254 等规格，
          // 前端按 manifest 排版会整体错位。PNG 头 16—24 字节就是宽高，读不到才退回按类型的默认值。
          const fallback={w:j.kind==='portrait'?1024:j.majorEvent?1537:904,h:j.kind==='portrait'?1024:j.majorEvent?636:1602};
          let size=fallback;try{if(j.asset){const head=readFileSync(store.asset(j.asset)).subarray(16,24);size={w:head.readUInt32BE(0),h:head.readUInt32BE(4)};}}catch{}
          return {key:`${j.kind==='portrait'?'portrait':'event'}/${j.subjectId}`,category:j.kind==='portrait'?'portrait':j.majorEvent?'major-event':'event',file:`/api/agents/assets/${j.asset}`,alt:j.plan?.summary||j.subjectId,...size};
        })};}
        else if(method==='POST'&&path[2]==='events'){assert(store.run(id).mode==='standalone','已连接引擎的对局只能同步引擎裁判结果',409);store.apply(id,await body(req) as unknown as Settlement);out=view(store,id);}
        else if(method==='POST'&&path[2]==='sync'){await engine.sync(id);out=view(store,id);}
        else if(method==='POST'&&path[2]==='messages'){const input=await body(req);if(store.run(id).mode==='standalone'){if(input.act===false&&process.env.SIM_ENGINE_URL)await engine.discussLocal(id,input as Parameters<EngineBridge['discussLocal']>[1]);else await worlds.localMessage(id,input);}else await engine.message(id,input as Parameters<EngineBridge['message']>[1]);out=view(store,id);}
        else throw new AgentError('接口不存在',404);
      }else if(method==='POST'&&path[0]==='jobs'&&path[2]==='retry'){const job=store.retry(path[1]);generationRun=job.runId;out=job;}
      else if(method==='GET'&&path[0]==='saves'&&path.length===1)out={slots:listSlots(store.directory)};
      else if(method==='POST'&&path[0]==='saves'&&path.length===1){
        const b=await body(req),slot=Number(b.slot);
        // slot:0 = 自动选槽：优先空槽，全满则覆盖最早的自动槽（终局自动存档走这条）；选槽只保留服务端一份，客户端不先算位置
        assert(Number.isInteger(slot)&&slot>=0&&slot<=MAX_SLOTS,'槽位应为 1—8 的整数，或填 0 自动选槽');
        const runId=String(b.runId??'');assert(runId,'需要对局编号');store.run(runId);
        const w=worlds.getWorld(runId);assert(w,'此议题尚未初始化世界',409);
        const target=slot||nextFreeSlot(store.directory);assert(target>0,'八个槽位都已存满，请先清空一个',409);
        // court 只活在界面上（朝政状态），世界快照里没有它：由调用方随存档一起交存，读档时原样展示
        const court=typeof b.court==='string'&&b.court.length<=20?b.court:'';
        out={slot:writeSlot(store.directory,target,{...cloudSave().exportRunToSave(store.run(runId),w,allEvents(runId)),court,auto:b.auto===true})};
      }
      else if(method==='POST'&&path[0]==='saves'&&path[1]==='load'&&path.length===2){
        const b=await body(req),slot=Number(b.slot);
        assert(Number.isInteger(slot)&&slot>=1&&slot<=MAX_SLOTS,'槽位应是 1—8 的整数');
        const found=readSlotFile(store.directory,slot);assert(found,'这个槽位是空的',404);
        // restore:true = 本局读档回滚（BUG-114）：后端负责把快照写回，前端拿到的直接是新 view；
        // 不带 restore 的旧语义保留（跨局跳转走前端重定向），槽号/朝政照常展示。
        if(b.restore===true){
          const restored=cloudSave().importRunFromSave(found);
          assert(typeof b.runId==='string'&&b.runId,'需要对局编号');
          assert(restored.run.id===b.runId,`这个槽存的是另一局（${restored.run.id}），本局只能读自己阵营的槽`,409);
          worlds.restoreRun(String(b.runId),restored);
          out={restored:true,run:view(store,String(b.runId)),entry:found};
        }else out={entry:found};
      }
      else if(method==='DELETE'&&path[0]==='saves'&&path.length===2){
        const slot=Number(path[1]);assert(Number.isInteger(slot)&&slot>=1&&slot<=MAX_SLOTS,'槽位应是 1—8 的整数');
        clearSlot(store.directory,slot);out={ok:true};
      }
      else throw new AgentError('接口不存在',404);
      res.writeHead(method==='POST'?202:200,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify(out));
      if(method==='POST'&&path[0]==='runs'&&path[1]&&['events','sync','messages','world-order','world-advance','world-jump','province-update','decision','diplomacy','focus','tech','whatif'].includes(path[2])&&(process.env.AGENT_ALLOW_API_GENERATION==='true'||!worlds.getWorld(path[1])?.simulation))generationRun=path[1];
      if(generationRun)void worker.drain(generationRun);
    }catch(e){
      // BUG-110：非 AgentError 的异常此前被吞成「任务处理失败，请查看本机服务状态」，
      // 玩家无从下手。真实原因（上游错误摘要）照实透传，完整堆栈只进服务端日志。
      if(!(e instanceof AgentError))console.error('[server] 请求处理失败（透传原因给前端）：',e);
      const message=e instanceof AgentError?e.message:`任务处理失败：${(e instanceof Error?e.message:String(e)).slice(0,300)}`;
      res.writeHead(e instanceof AgentError?e.status:500,{'Content-Type':'application/json; charset=utf-8','Cache-Control':'no-store'});res.end(JSON.stringify({error:message}));
    }
  });
}
