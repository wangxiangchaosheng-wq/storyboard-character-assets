import test from 'node:test';import assert from 'node:assert/strict';import sharp from 'sharp';
import {OpenAIArt,prepare} from '../dist/provider.js';import {loadMajorSkill} from '../dist/skill-runtime.js';import {preparationReady} from '../dist/preparation.js';
test('major skill uses supplied landscape contract and never the portrait storyboard contract',()=>{const s=loadMajorSkill();assert.match(s,/1537:636/);assert.match(s,/尚未落定/);assert.match(s,/架空推演/);});
test('major event image is validated and fitted to exact landscape dimensions',async()=>{const png=await sharp({create:{width:1536,height:640,channels:3,background:'#ddd'}}).png().toBuffer();const out=await prepare(png,'storyboard',true);const m=await sharp(out).metadata();assert.equal(m.width*636,m.height*1537);await assert.rejects(()=>prepare(awaitable,'storyboard',true));});
const awaitable=await sharp({create:{width:904,height:1602,channels:3,background:'#ddd'}}).png().toBuffer();
test('major generation requests landscape and classification uses only confirmed result context',async()=>{
 const p=new OpenAIArt();let body;p.request=async(path,b)=>{body=b;return {data:[{b64_json:Buffer.from('fixture').toString('base64')}]};};
 await p.generate({kind:'storyboard',majorEvent:true,plan:{prompt:'已确认结果，架空推演，公元228年',summary:'关键战局逆转',night:false}});assert.equal(body.size,'1536x640');assert.match(body.prompt,/1537:636/);assert.doesNotMatch(body.prompt,/452:801/);
 p.structured=async(name,instructions)=>{assert.match(instructions,/未决方案/);return {major:false};};assert.equal(await p.classifyMajor({input:{event:{summary:'只是提出计划'}}}),false);
});
test('major event does not replace ordinary story or reopen initial preparation',()=>{const jobs=[{kind:'portrait',subjectId:'p',status:'succeeded',asset:'p'},{kind:'storyboard',status:'succeeded',asset:'s'},{kind:'storyboard',majorEvent:true,status:'generating'}];assert.equal(preparationReady(['p'],jobs,['/api/agents/assets/p','/api/agents/assets/s']),true);});
