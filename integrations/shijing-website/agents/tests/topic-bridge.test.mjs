import test from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {Store} from '../dist/store.js';
import {EngineBridge} from '../dist/engine.js';
import {WorldAgent} from '../dist/world-agent.js';
test('research import routes Zhihu URL, caches source and keeps local settlement',async()=>{
 const dir=mkdtempSync(join(tmpdir(),'shijing-bridge-'));const store=new Store(dir);const calls=[];
 try {
 const bridge=new EngineBridge(store);
 bridge.request=async(path,body)=>{calls.push({path,body});if(path.endsWith('/ingest'))return {topicId:'https://www.zhihu.com/question/123'};if(path.endsWith('/build'))return {};if(path.endsWith('/status'))return {state:'ready'};if(path.endsWith('/spec'))return {spec:{id:'source',title:'魏延子午谷北伐方案',scenario:{background:'蜀汉诸葛亮讨论汉中北伐。'},cast:[{id:'wy',name:'魏延',role:'将领',description:'讨论参与者'}],metrics:[{key:'power',label:'通用实力',start:99,min:0,max:100}]}};throw Error(path);};
 const topic={title:'https://www.zhihu.com/question/123',description:'',year:228,season:'春',faction:'shu'};
 const run=await bridge.researchTopic(topic);assert.equal(calls[0].body.kind,'url');assert.equal(calls[0].body.researchOnly,true);assert.equal(run.mode,'standalone');assert.deepEqual(run.spec.metrics,[]);assert.match(run.spec.scenario.background,/question\/123/);
 assert.ok(new WorldAgent(store).getWorld(run.id).simulation);
 const count=calls.length;assert.equal((await bridge.researchTopic(topic)).id,run.id);assert.equal(calls.length,count);
 assert.equal(store.db.prepare('SELECT count(*) AS n FROM topic_imports').get().n,1);
 assert.equal(calls.some(c=>c.path.startsWith('/api/games')),false);
 }finally{store.db.close();rmSync(dir,{recursive:true,force:true});}
});
