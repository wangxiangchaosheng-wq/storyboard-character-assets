import {WorldAgent} from './world-agent.js';
import {DatabaseSync} from 'node:sqlite';
import {randomUUID,createHash} from 'node:crypto';
import {mkdirSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {assert,type Run,type Job,type Settlement,type Spec} from './contracts.js';
import {initialWorld,settle} from './world.js';
export const hash=(v:unknown)=>createHash('sha256').update(JSON.stringify(v)).digest('hex');
export class Store {
  db:DatabaseSync; directory:string;
  constructor(directory:string){
    this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true});mkdirSync(resolve(this.directory,'assets'),{recursive:true});
    this.db=new DatabaseSync(resolve(this.directory,'agents.sqlite'));
    this.db.exec(`PRAGMA journal_mode=WAL; PRAGMA busy_timeout=5000;
      CREATE TABLE IF NOT EXISTS runs(id TEXT PRIMARY KEY,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS jobs(id TEXT PRIMARY KEY,run_id TEXT NOT NULL,dedupe TEXT UNIQUE NOT NULL,payload TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS events(run_id TEXT NOT NULL,event_id TEXT NOT NULL,digest TEXT NOT NULL,payload TEXT NOT NULL,PRIMARY KEY(run_id,event_id));
      CREATE TABLE IF NOT EXISTS starts(id TEXT PRIMARY KEY,run_id TEXT,status TEXT NOT NULL);
      CREATE TABLE IF NOT EXISTS commands(run_id TEXT NOT NULL,command_id TEXT NOT NULL,digest TEXT NOT NULL,status TEXT NOT NULL,PRIMARY KEY(run_id,command_id));`);
  }
  transaction<T>(fn:()=>T):T {this.db.exec('BEGIN IMMEDIATE');try{const result=fn();this.db.exec('COMMIT');return result;}catch(e){this.db.exec('ROLLBACK');throw e;}}
  run(id:string):Run {const r=this.db.prepare('SELECT payload FROM runs WHERE id=?').get(id);assert(r,'对局不存在',404);return JSON.parse(String(r.payload));}
  runs():Run[]{return this.db.prepare('SELECT payload FROM runs ORDER BY rowid DESC LIMIT 30').all().map(r=>JSON.parse(String(r.payload)));}
  saveRun(r:Run){this.db.prepare('INSERT OR REPLACE INTO runs VALUES(?,?)').run(r.id,JSON.stringify(r));}
  create(spec:Spec,cities:Record<string,string>={},engine?:{gameId:string;messages:Run['messages'];state:Record<string,number>;turn:number}):Run {
    const r:Run={id:randomUUID(),spec,world:initialWorld(spec,cities),mode:engine?'engine':'standalone',gameId:engine?.gameId,engineTurn:engine?.turn??0,messages:engine?.messages??[],createdAt:new Date().toISOString()};
    if(engine){for(const m of spec.metrics)assert(Number.isFinite(engine.state[m.key])&&engine.state[m.key]>=m.min&&engine.state[m.key]<=m.max,'引擎初始状态无效');r.world.metrics={...engine.state};}
    const worlds=new WorldAgent(this);
    this.transaction(()=>{this.saveRun(r);worlds.bootstrapRunInTransaction(r);for(const p of spec.cast)this.enqueue(r.id,'portrait',p.id,{persona:p,spec});this.enqueue(r.id,'storyboard','opening',{spec,stage:'开场设定；方案仍是设想，不得画成已经胜利',world:this.run(r.id).world});});return this.run(r.id);
  }
  enqueue(runId:string,kind:Job['kind'],subjectId:string,input:unknown):Job {
    const dedupe=hash([runId,kind,subjectId,input]); const existing=this.db.prepare('SELECT payload FROM jobs WHERE dedupe=?').get(dedupe);if(existing)return JSON.parse(String(existing.payload));
    const now=new Date().toISOString();const j:Job={id:randomUUID(),runId,kind,subjectId,majorEvent:!!(input as {majorEvent?:boolean}).majorEvent,majorCandidate:!!(input as {majorCandidate?:boolean}).majorCandidate,status:'queued',attempts:0,input,feedback:'',createdAt:now,updatedAt:now,trace:[]};
    this.db.prepare('INSERT INTO jobs VALUES(?,?,?,?)').run(j.id,runId,dedupe,JSON.stringify(j));return j;
  }
  jobs(runId?:string):Job[]{return(runId?this.db.prepare('SELECT payload FROM jobs WHERE run_id=? ORDER BY rowid').all(runId):this.db.prepare('SELECT payload FROM jobs ORDER BY rowid').all()).map(r=>JSON.parse(String(r.payload)));}
  job(id:string):Job {const row=this.db.prepare('SELECT payload FROM jobs WHERE id=?').get(id);assert(row,'任务不存在',404);return JSON.parse(String(row.payload));}
  saveJob(j:Job){j.updatedAt=new Date().toISOString();this.db.prepare('UPDATE jobs SET payload=? WHERE id=?').run(JSON.stringify(j),j.id);}
  step(j:Job,status:Job['status'],detail:string){j.status=status;j.trace.push({at:new Date().toISOString(),step:status,detail});this.saveJob(j);}
  recover(){this.db.prepare("UPDATE starts SET status='interrupted' WHERE status='pending'").run();for(const j of this.jobs())if(['planning','generating','checking'].includes(j.status)){j.resumeDraft=j.status==='checking'&&j.draftAttempt!==undefined&&existsSync(this.draftPath(j));j.error=j.resumeDraft?'检查中断，草稿已保存；重试只继续检查，不重新生图。':'服务中断，可能已产生调用费用。请手动重试此项。';this.step(j,'interrupted',j.error);}}
  retry(id:string){const j=this.job(id);assert(['failed','interrupted'].includes(j.status),'只有失败或中断任务可重试',409);j.error=undefined;if(j.kind==='portrait'&&!j.transparency&&j.trace.some(t=>t.detail.includes('[ALPHA]')))j.transparency='chroma';this.step(j,'queued','用户重试');return j;}
  draftDirectory(j:Job){return resolve(this.directory,'qa',j.id,`attempt-${j.draftAttempt}`);}
  draftPath(j:Job){return resolve(this.draftDirectory(j),'draft.png');}
  saveDraft(j:Job,data:Buffer){j.draftAttempt=j.attempts;const dir=this.draftDirectory(j);mkdirSync(dir,{recursive:true});writeFileSync(resolve(dir,'draft.png'),data);writeFileSync(resolve(dir,'plan.json'),JSON.stringify(j.plan,null,2));return dir;}
  saveAsset(j:Job,data:Buffer){const name=`${j.id}.png`;const path=resolve(this.directory,'assets',name);writeFileSync(path+'.tmp',data);renameSync(path+'.tmp',path);j.asset=name;}
  asset(name:string){assert(/^[a-f0-9-]{36}\.png$/.test(name),'素材路径无效');const p=resolve(this.directory,'assets',name);assert(existsSync(p),'素材不存在',404);return p;}
  apply(runId:string,event:Settlement):Run {return this.transaction(()=>{
    const r=this.run(runId); const old=this.db.prepare('SELECT digest FROM events WHERE run_id=? AND event_id=?').get(runId,event.id);
    if(old){assert(old.digest===hash(event),'相同事件编号对应不同内容',409);return r;}
    assert(!this.db.prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='world_states'").get()||!this.db.prepare('SELECT 1 FROM world_states WHERE run_id=?').get(runId),'此局已接入世界状态 Agent，请改用 world-events 结构化结算接口',409);
    const before=r.world;r.world=settle(before,event,r.spec);
    this.db.prepare('INSERT INTO events VALUES(?,?,?,?)').run(runId,event.id,hash(event),JSON.stringify({event,before,after:r.world}));
    this.saveRun(r);if(event.significant)this.enqueue(runId,'storyboard',event.id,{spec:r.spec,event,world:r.world,majorEvent:true});return r;
  });}
  history(id:string){this.run(id);return this.db.prepare('SELECT payload FROM events WHERE run_id=? ORDER BY rowid').all(id).map(x=>JSON.parse(String(x.payload)));}
  close(){this.db.close();}
}
