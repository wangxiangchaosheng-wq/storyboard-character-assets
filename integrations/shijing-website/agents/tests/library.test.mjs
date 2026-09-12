import {fileURLToPath} from 'node:url';
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,readFileSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {AssetLibrary} from '../dist/asset-library.js';
import {Worker} from '../dist/worker.js';
import {Store} from '../dist/store.js';
const library=new AssetLibrary(fileURLToPath(new URL('../../人物素材库/',import.meta.url)));
const spec=JSON.parse(readFileSync(new URL('../examples/ziwu.json',import.meta.url))).spec;
test('library: all 30 portraits have usable transparent PNGs; explicit aliases keep genders separate',async()=>{
 assert.equal(library.entries().filter(e=>e.source==='provided').length,30);
 for(const entry of library.entries())assert.ok(await library.find({name:entry.name}));
 assert.equal((await library.find({name:'曹睿'})).entry.name,'曹叡');
 assert.equal((await library.find({name:'人大政治专业大三学生'})).entry.name,'穿越大学生');
 assert.equal((await library.find({name:'穿越女大学生'})).entry.name,'女大学生');
 assert.equal(await library.find({name:'大学生'}),undefined);
});
test('library: paused API still resolves existing portraits, missing people and story stay queued without provider calls',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shijing-library-test-')),store=new Store(dir);
 const old=process.env.AGENT_ALLOW_API_GENERATION;
 process.env.AGENT_ALLOW_API_GENERATION='false';
 try{
  const names=['库里没有的人物','诸葛亮','刘禅','赵云','曹叡','人大政治专业大三学生'];
  const run=store.create({...spec,cast:names.map((name,i)=>({...spec.cast[0],id:'person-'+i,name}))});
  const forbidden=async()=>assert.fail('Must not call generation service');
  await new Worker(store,{plan:forbidden,generate:forbidden,review:forbidden},library).drain();
  const jobs=store.jobs(run.id);
  assert.equal(jobs.filter(j=>j.status==='succeeded').length,5);
  for(const job of jobs){assert.equal(job.attempts,0);if(job.status!=='succeeded')assert.equal(job.status,'queued');}
 }finally{store.close();rmSync(dir,{recursive:true,force:true});if(old===undefined)delete process.env.AGENT_ALLOW_API_GENERATION;else process.env.AGENT_ALLOW_API_GENERATION=old;}
});
test('local topic: no-key fresh run loads presets through HTTP and serves the actual PNG bytes',async()=>{
 const {localTopicSpec}=await import('../dist/local-topic.js');
 const {makeServer}=await import('../dist/server.js');
 const topic={title:'北伐议题：人大政治专业大三学生能否帮助诸葛亮？',description:'北伐讨论',year:228,season:'春',faction:'shu'};
 const local=localTopicSpec(topic);
 assert.ok(local.cast.some(p=>p.name==='穿越大学生'));
 assert.ok(localTopicSpec({...topic,title:'女大学生参与北伐'}).cast.some(p=>p.name==='女大学生'));
 const dir=mkdtempSync(join(tmpdir(),'shijing-local-http-')),store=new Store(dir),old=process.env.AGENT_ALLOW_API_GENERATION;
 process.env.AGENT_ALLOW_API_GENERATION='false';
 const forbidden=async()=>assert.fail('No API calls allowed');
 const worker=new Worker(store,{plan:forbidden,generate:forbidden,review:forbidden},library);
 const server=makeServer(store,worker);
 try{
  await new Promise(r=>server.listen(0,'127.0.0.1',r));
  const base='http://127.0.0.1:'+server.address().port;
  const start=await fetch(base+'/runs',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({reuseKey:'offline-first-test',spec:local})});
  assert.equal(start.status,202);const run=await start.json();
  await fetch(base+'/runs/'+run.id+'/prepare',{method:'POST'});
  let current;
  for(let n=0;n<50;n++){
   current=await (await fetch(base+'/runs/'+run.id)).json();
   if(current.jobs.filter(j=>j.kind==='portrait').every(j=>j.status==='succeeded'))break;
   await new Promise(r=>setTimeout(r,30));
  }
  const portraits=current.jobs.filter(j=>j.kind==='portrait');assert.equal(portraits.length,5);
  for(const j of portraits){assert.equal(j.status,'succeeded');const image=await fetch(base+'/assets/'+j.asset);assert.equal(image.status,200);const bytes=Buffer.from(await image.arrayBuffer());assert.deepEqual([...bytes.subarray(0,8)],[137,80,78,71,13,10,26,10]);}
 }finally{server.closeAllConnections();await new Promise(r=>server.close(r));store.close();rmSync(dir,{recursive:true,force:true});if(old===undefined)delete process.env.AGENT_ALLOW_API_GENERATION;else process.env.AGENT_ALLOW_API_GENERATION=old;}
});

test('local cast: exact user wording includes the student and unique named people with meaningful roles',async()=>{
 const {localTopicSpec}=await import('../dist/local-topic.js');
 for(const text of ['人民大学的大三学子穿越到诸葛亮身边能否取得北伐胜利','人民大学大三学子如果穿越到北伐诸葛亮身边，能否帮助北伐胜利']){
  const s=localTopicSpec({title:text,description:'',year:228,season:'春',faction:'shu'});
  assert.deepEqual(s.cast.map(p=>p.name),['诸葛亮','穿越大学生','魏延','杨仪','姜维']);
  assert.equal(new Set(s.cast.map(p=>p.name)).size,5);
  assert.ok(s.cast.every(p=>p.role!=='本地讨论人物'));
  assert.equal(s.cast[1].role,'人大大三学子');
 }
});
