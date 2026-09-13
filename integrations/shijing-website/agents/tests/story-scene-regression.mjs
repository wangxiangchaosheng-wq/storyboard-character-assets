import {test} from 'node:test';
import assert from 'node:assert/strict';
import sharp from 'sharp';
import {OpenAIArt,prepare} from '../dist/provider.js';
test('story planning uses scene skill without portrait inputs',async()=>{
 const provider=new OpenAIArt();let call;
 provider.structured=async(...args)=>{call=args;return {prompt:'军帐中讨论北伐的完整场景',summary:'军帐议策，北伐未决',night:false,evidence:[]};};
 provider.request=()=>{throw Error('Network forbidden in this test');};
 await provider.plan({kind:'storyboard',input:{stage:'开场'},feedback:'',priorDesigns:[{marker:'portrait-only'}],transparency:'chroma'});
 assert.equal(call[0],'story_scene_plan');
 assert.match(call[1],/conversation-storyboard/);
 assert.doesNotMatch(call[1],/唯一 Prop Card|Action Signature|逐字复用输入 styleBible|必须按 transparency=chroma/);
 assert.deepEqual(JSON.parse(call[2]),{input:{stage:'开场'},feedback:''});
});
test('story image preparation rejects chroma sheets and accepts ordinary scene colors',async()=>{
 const png=await sharp({create:{width:452,height:801,channels:4,background:'#ff00ff'}}).png().toBuffer();
 await assert.rejects(prepare(png,'storyboard'),/品红/);
 const neutral=await sharp({create:{width:452,height:801,channels:4,background:'#b5a087'}}).png().toBuffer();
 assert.ok((await prepare(neutral,'storyboard')).length);
});
import {mkdtempSync,rmSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';
import {StoryLibrary} from '../dist/story-library.js';
test('saved scenes survive cache removal and different phases miss',async()=>{
 const root=mkdtempSync(join(tmpdir(),'scene-library-'));
 try{const lib=new StoryLibrary(join(root,'library'),join(root,'cache'));const job={id:'test',kind:'storyboard',input:{spec:{title:'军帐议策',scenario:{background:'讨论北伐'},cast:[]},stage:'方案'},plan:{summary:'军帐议策'}};
 const png=await sharp({create:{width:452,height:801,channels:4,background:'#b5a087'}}).png().toBuffer();lib.remember(job,png);rmSync(join(root,'cache'),{recursive:true});
 assert.ok(readdirSync(join(root,'library','自动生成')).some(n=>n.endsWith('.png')));assert.ok((await lib.find(job)).png.equals(png));assert.equal(await lib.find({...job,input:{...job.input,stage:'已执行'}}),undefined);
 }finally{rmSync(root,{recursive:true,force:true});}
});
