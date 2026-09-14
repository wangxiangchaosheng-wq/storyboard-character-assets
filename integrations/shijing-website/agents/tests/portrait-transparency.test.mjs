import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import sharp from 'sharp';
import {inspectPortrait} from '../dist/portrait-acceptance.js';
import {prepareCharacter} from '../dist/skill-runtime.js';
import {OpenAIArt} from '../dist/provider.js';
import {Store} from '../dist/store.js';
import {Worker} from '../dist/worker.js';
import {parseSpec} from '../dist/contracts.js';

const rounded = async (background='#00000000') => sharp({create:{width:512,height:512,channels:4,background}})
  .composite([{input:Buffer.from('<svg width="512" height="512"><ellipse cx="256" cy="230" rx="150" ry="180" fill="#ad8040"/></svg>')}]).png().toBuffer();
function directory(t){const p=mkdtempSync(join(tmpdir(),'portrait-alpha-'));t.after(()=>rmSync(p,{recursive:true,force:true}));return p;}

test('transparent rounded portrait with a bottom gap passes; opaque and empty PNGs fail',async()=>{
  await inspectPortrait(await rounded());
  await assert.rejects(inspectPortrait(await rounded('#ffffff')),/ALPHA/);
  const empty=await sharp({create:{width:512,height:512,channels:4,background:'#00000000'}}).png().toBuffer();
  await assert.rejects(inspectPortrait(empty),/主体/);
});

test('already transparent draft is preserved exactly even when job requests chroma',async t=>{
  const draft=await rounded(),dir=directory(t);
  assert.deepEqual(await prepareCharacter({transparency:'chroma'},draft,dir),draft);
  assert.equal(existsSync(join(dir,'converted.png')),false);
  assert.equal(existsSync(join(dir,'aligned.png')),false);
});

test('chroma draft with curved hem converts without forced crop, including rechecking same attempt',async t=>{
  const draft=await rounded('#ff00ff'),dir=directory(t);
  const first=await prepareCharacter({transparency:'chroma'},draft,dir);
  await inspectPortrait(first);
  assert.deepEqual(await prepareCharacter({transparency:'chroma'},draft,dir),first);
  assert.equal(existsSync(join(dir,'aligned.png')),false);
});

test('old plan demanding magenta cannot override final alpha check or trigger a model call',async()=>{
  const provider=new OpenAIArt();
  provider.request=async()=>assert.fail('portrait acceptance must not call a paid model');
  const job={kind:'portrait',plan:{prompt:'必须补回纯品红#FF00FF背景，底部必须平直'},input:{}};
  const png=await rounded();
  assert.equal((await provider.preflight(job,png)).pass,true);
  assert.equal((await provider.review(job,png)).pass,true);
  await assert.rejects(provider.review(job,await rounded('#ff00ff')),/ALPHA/);
});

test('manual retry rechecks the saved failed portrait without regenerating it',async t=>{
  const dir=directory(t),store=new Store(dir);t.after(()=>store.close());
  const spec=parseSpec(JSON.parse(readFileSync(new URL('../examples/ziwu.json',import.meta.url))).spec);
  const run=store.create({...spec,cast:[spec.cast[0]]});
  const job=store.jobs(run.id).find(j=>j.kind==='portrait');
  job.plan={prompt:'旧计划要求品红背景',summary:'',night:false,evidence:[]};job.attempts=3;
  store.saveDraft(job,await rounded());job.feedback='下摆不平直';job.error='缺少品红底';
  store.step(job,'failed',job.error);
  for(const j of store.jobs(run.id).filter(j=>j.kind==='storyboard'))store.step(j,'succeeded','unrelated fixture');
  store.retry(job.id);
  const provider=new OpenAIArt();
  provider.generate=provider.plan=provider.request=async()=>assert.fail('must reuse the saved image without a network call');
  await new Worker(store,provider).drain(run.id);
  assert.equal(store.job(job.id).status,'succeeded');
  await inspectPortrait(readFileSync(store.asset(store.job(job.id).asset)));
});
