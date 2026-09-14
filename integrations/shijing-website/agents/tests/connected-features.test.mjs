import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {EngineBridge} from '../dist/engine.js';
import {WorldAgent} from '../dist/world-agent.js';
const spec={id:'north',title:'诸葛亮北伐',scenario:{background:'公元228年，汉中向长安进军。'},cast:[{id:'wy',name:'魏延',role:'将领',description:'谨慎讨论补给'}],metrics:[]};
function setup(t){const dir=mkdtempSync(join(tmpdir(),'connected-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true})});return{store,id:store.create(spec).id,worlds:new WorldAgent(store)}}
test('teammate reply is idempotent and cannot overwrite world numbers',async t=>{
 const {store,id,worlds}=setup(t),bridge=new EngineBridge(store);let calls=0;const before=worlds.getWorld(id);
 bridge.request=async(path,body)=>{calls++;assert.equal(path,'/api/local-world/reply');assert.ok(!JSON.stringify(body.observation).includes('army-changan'));return{speaker:'wy',reply:'先保障补给，再议进军。',troops:999999}};
 const q={commandId:'q',text:'如何补给？',to:'wy',act:false};await bridge.discussLocal(id,q);await bridge.discussLocal(id,q);
 assert.equal(calls,1);assert.deepEqual(worlds.getWorld(id),before);assert.equal(store.run(id).messages.at(-1).name,'魏延');
});
test('confirmed local action queues one scene candidate; duplicate does not enqueue twice',t=>{
 const old=process.env.AGENT_ALLOW_API_GENERATION;process.env.AGENT_ALLOW_API_GENERATION='true';t.after(()=>{if(old===undefined)delete process.env.AGENT_ALLOW_API_GENERATION;else process.env.AGENT_ALLOW_API_GENERATION=old});
 const {store,id,worlds}=setup(t),cmd={commandId:'march',expectedRevision:0,armyId:'army-wei-yan',kind:'march',targetCityId:'changan'};
 worlds.localOrder(id,cmd);worlds.localOrder(id,cmd);
 const jobs=store.jobs(id).filter(j=>j.subjectId==='world-march');assert.equal(jobs.length,1);assert.equal(jobs[0].majorCandidate,true);assert.equal(jobs[0].input.event.confirmed,true);
});
