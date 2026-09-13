import {mkdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve,basename} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import type {Job,Spec} from './contracts.js';

const catalog=[
 {file:'01-汉中誓师.png',title:'汉中整军待发',topic:/汉中/,stage:/誓师|整军|待发|出征/},
 {file:'02-军帐议事.png',title:'军帐议策',topic:/军帐|军议/,stage:/议事|议策|商议|讨论|献策/},
 {file:'03-子午谷险道.png',title:'子午谷方案设想',topic:/子午谷|子午奇谋/,stage:/方案|提议|奇谋|设想|权衡|可行|是否|建议/},
 {file:'04-祁山进军.png',title:'祁山进军',topic:/祁山/,stage:/进军|行军|出兵|出征/},
 {file:'05-街亭布防.png',title:'街亭战前布防',topic:/街亭/,stage:/布防|设防|战前|部署|如何守|防守方案/},
 {file:'06-陈仓攻坚.png',title:'陈仓攻坚未决',topic:/陈仓/,stage:/攻坚|攻城|围攻|攻打|如何攻/},
 {file:'07-蜀道运粮.png',title:'蜀道后勤转输',topic:/蜀道|北伐|秦岭|汉中/,stage:/运粮|转输|运输粮|粮草运输|后勤运输/},
 {file:'08-五丈原对峙.png',title:'五丈原相持屯田',topic:/五丈原/,stage:/对峙|相持|屯田/},
];
// Conservative local recognition: ambiguous or incompatible narratives remain cache misses.
const incompatible=/大学|学子|学生|穿越|现代|赤壁|草船|失守|失利|失败|撤军|撤退|败退|攻克|攻破|占领|胜利|获胜|战败|病逝|阵亡|死亡|粮尽|断粮|不要|不画|而非|不是|假如|假设|如果|已实施|已经|夜|月下/;
export function storyContext(job:Job){
 const input=job.input as {spec?:Spec;event?:{summary?:string};stage?:string;world?:unknown};
 const spec=input.spec;
 // A later confirmed event takes precedence over the opening topic.
 const text=input.event?.summary??[spec?.title,spec?.scenario.background].filter(Boolean).join(' ');
 return {text,spec,event:input.event?.summary,stage:input.stage,world:input.world};
}
export function matchStory(job:Job){
 const c=storyContext(job);

 if(c.spec?.cast.some(p=>/大学|学子|学生|穿越|现代/.test(p.name+' '+p.role+' '+p.description)))return;
 // Resolve the explicit retreat clause before unrelated explanatory notes about proposals.
 const retreat=/街亭(?:失利|失守|战败)[^。！？\n]{0,24}(?:退回|撤回|退归|撤往|撤退至|退守)汉中/.test(c.text);
 if(retreat&&!/大学|学生|学子|穿越|现代|假如|假设|如果|不要|不画|并未|未曾|没有|(?:不是|并非).{0,8}街亭|夜|月下/.test(c.text))return {file:'09-街亭失利退回汉中.png',title:'街亭失利后撤回汉中'};
 if(incompatible.test(c.text))return;
 const found=catalog.filter(e=>e.topic.test(c.text)&&e.stage.test(c.text));
 return found.length===1?found[0]:undefined;
}
export class StoryLibrary{
 constructor(readonly directory:string,readonly cache:string){mkdirSync(cache,{recursive:true});}
 key(job:Job){const c=storyContext(job);return createHash('sha256').update(JSON.stringify({version:2,majorEvent:!!job.majorEvent,text:c.text,stage:c.stage,world:c.world,cast:c.spec?.cast.map(({name,role,description,stance})=>({name,role,description,stance}))})).digest('hex');}
 async find(job:Job){
  const key=this.key(job),library=resolve(this.directory,job.majorEvent?'重大事件':'自动生成'),record=resolve(library,key+'.json');
  if(existsSync(record)){const info=JSON.parse(readFileSync(record,'utf8'));if(typeof info.file==='string'&&basename(info.file)===info.file&&existsSync(resolve(library,info.file)))return {png:readFileSync(resolve(library,info.file)),title:String(info.title),detail:'复用电脑素材库中的故事场景'};}
  const cached=resolve(this.cache,key+'.png'),meta=resolve(this.cache,key+'.json');
  if(existsSync(cached)&&existsSync(meta)){const info=JSON.parse(readFileSync(meta,'utf8'));return {png:readFileSync(cached),title:info.title as string,detail:'复用已验收生成图（相同场景与人物设定）'};}
  if(job.majorEvent)return;
  const entry=matchStory(job);if(!entry)return;
  const file=resolve(this.directory,entry.file);if(!existsSync(file))return;
  const png=readFileSync(file),m=await sharp(png).metadata();
  if(m.format!=='png'||!m.width||!m.height)throw Error('故事板资产文件损坏');
  return {png,title:entry.title,detail:`复用预制故事板：${entry.title}；原图 ${m.width}×${m.height}，等比完整叠加，未认定通过精确比例验收`};
 }
 remember(job:Job,png:Buffer){
  const key=this.key(job),file=resolve(this.cache,key+'.png'),meta=resolve(this.cache,key+'.json');
  const library=resolve(this.directory,job.majorEvent?'重大事件':'自动生成');mkdirSync(library,{recursive:true});
  const title=job.plan?.summary||'故事板',name=title.replace(/[\/\\:*?"<>|\x00-\x1f]/g,'').slice(0,50)||'故事板';
  const saved=name+'-'+key.slice(0,12)+'.png';
  writeFileSync(resolve(library,saved)+'.tmp',png);renameSync(resolve(library,saved)+'.tmp',resolve(library,saved));
  const record=resolve(library,key+'.json');writeFileSync(record+'.tmp',JSON.stringify({file:saved,title,context:storyContext(job),fromJob:job.id,createdAt:new Date().toISOString()},null,2));renameSync(record+'.tmp',record);
  writeFileSync(file+'.tmp',png);renameSync(file+'.tmp',file);
  writeFileSync(meta+'.tmp',JSON.stringify({title:job.plan?.summary||'故事板',context:storyContext(job),fromJob:job.id,createdAt:new Date().toISOString()}));renameSync(meta+'.tmp',meta);
 }
}
