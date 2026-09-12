import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync} from 'node:fs';
import {tmpdir} from 'node:os';import {join,resolve} from 'node:path';
import {StoryLibrary,matchStory} from '../dist/story-library.js';
import {Store} from '../dist/store.js';import {Worker} from '../dist/worker.js';
const spec={id:'test',title:'子午谷奇谋方案',scenario:{background:'魏延提议研究可行性'},cast:[{id:'a',name:'魏延',role:'将领',description:'蜀汉将领'}],metrics:[]};
const job=(title,event)=>({kind:'storyboard',input:{spec:{...spec,title},...(event?{event:{summary:event}}:{})},plan:{summary:'已验收图'}});
test('all eight stages match, incompatible outcomes and mixed topics do not',()=>{
 for(const title of ['汉中誓师','军帐议事','子午谷方案','祁山进军','街亭布防','陈仓攻坚','蜀道运粮','五丈原对峙'])assert.ok(matchStory({...job(title),input:{spec:{...spec,title,scenario:{background:''}}}}),title);
 for(const title of ['街亭失守','子午谷已经攻克长安','大学生穿越到子午谷','不要画子午谷方案','子午谷方案与街亭布防','五丈原病逝'])assert.equal(matchStory(job(title)),undefined,title);
 assert.equal(matchStory(job('子午谷方案','街亭布防')).file,'05-街亭布防.png');
 assert.equal(matchStory(job('子午谷方案','蜀军撤军')),undefined);
});
test('offline worker resolves library before provider and leaves a miss pending',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'story-worker-'));const store=new Store(dir);t.after(()=>{store.close();rmSync(dir,{recursive:true,force:true});});
 const previous=process.env.AGENT_ALLOW_API_GENERATION;process.env.AGENT_ALLOW_API_GENERATION='false';t.after(()=>{if(previous===undefined)delete process.env.AGENT_ALLOW_API_GENERATION;else process.env.AGENT_ALLOW_API_GENERATION=previous;});
 const library=new StoryLibrary(resolve('故事板素材库'),join(dir,'cache'));const worker=new Worker(store,{plan(){assert.fail('no API')},generate(){assert.fail('no API')},review(){assert.fail('no API')}},undefined,library);
 const run=store.create(spec);await worker.drain();let story=store.jobs(run.id).find(j=>j.kind==='storyboard');assert.equal(story.status,'succeeded');assert.equal(story.assetSource,'library');assert.equal(story.attempts,0);assert.ok(readFileSync(store.asset(story.asset)).length>0);
 store.enqueue(run.id,'storyboard','later',{spec,event:{summary:'街亭失守，蜀军撤军'}});await worker.drain();assert.equal(store.jobs(run.id).at(-1).status,'queued');
});
test('accepted generation persists across restart; changed stage or cast never reuses it',async t=>{
 const dir=mkdtempSync(join(tmpdir(),'story-cache-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 const j=job('一座新营地的议事');const png=readFileSync(resolve('故事板素材库/02-军帐议事.png'));new StoryLibrary(resolve('故事板素材库'),dir).remember(j,png);
 const reopened=new StoryLibrary(resolve('故事板素材库'),dir);assert.deepEqual((await reopened.find(j)).png,png);
 assert.equal(await reopened.find(job('一座新营地撤军')),undefined);
 const changed=structuredClone(j);changed.input.spec.cast[0].description='完全不同的人物设定';assert.equal(await reopened.find(changed),undefined);
});
test('reported opening: actual history-page summary resolves retreat despite proposal disclaimer',async t=>{
 const title='诸葛亮首次北伐';const background='蜀军出祁山，街亭失利后退回汉中。魏延的子午谷提议属于方案讨论，不是已经实施的战果。';
 const j={...job(title),input:{spec:{...spec,title,scenario:{background}}}};
 assert.equal(matchStory(j)?.file,'09-街亭失利退回汉中.png');
 const dir=mkdtempSync(join(tmpdir(),'retreat-regression-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));
 assert.ok((await new StoryLibrary(resolve('故事板素材库'),dir).find(j)).png.length>0);
 assert.equal(matchStory(job('假如街亭失利后退回汉中')),undefined);
 assert.equal(matchStory(job('街亭布防'))?.file,'05-街亭布防.png');
});
