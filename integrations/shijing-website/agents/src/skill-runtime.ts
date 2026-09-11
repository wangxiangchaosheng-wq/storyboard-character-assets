import {readFileSync,mkdirSync,writeFileSync} from 'node:fs';
import {resolve} from 'node:path';
import {fileURLToPath} from 'node:url';
import {execFile} from 'node:child_process';
import {promisify} from 'node:util';
import sharp from 'sharp';
import {AgentError,type Job} from './contracts.js';
const root=fileURLToPath(new URL('../..',import.meta.url));
const exec=promisify(execFile);
export const characterReferences=['atomicity-contract','transparency-contract','transparency-workflow','historical-props','action-signature','character-selection','prompt-template','quality-standard'];
export function loadMajorSkill(){return ['SKILL.md','references/agent-contract.md','references/behavior-cases.md'].map(n=>readFileSync(resolve(root,'skills/major-story-event-assets',n),'utf8')).join('\n');}
export function loadSkill(kind:Job['kind']) {
  const folder=kind==='portrait'?'storyboard-character-assets':'conversation-storyboard';
  const refs=kind==='portrait'?characterReferences:['context-routing','visual-production','output-contract'];
  return ['SKILL.md',...refs.map(n=>`references/${n}.md`)].map(n=>`\n--- ${folder}/${n} ---\n${readFileSync(resolve(root,'skills',folder,n),'utf8')}`).join('\n')+(kind==='portrait'?'\n用户最新覆盖规则：取消人物和道具靠边缘限制，不要求顶部左右8%或任何固定安全边距；允许靠近边缘。不得因留白不足判失败。头冠、双手和唯一道具仍须完整可见，不得实际裁断。本规则优先于以上文档及旧计划中的边距要求。':'');
}
export async function script(name:string,args:string[],directory:string){
  try{
    const result=await exec(process.env.PYTHON_BIN||'python3',[resolve(root,'skills/storyboard-character-assets/scripts',name),...args],{timeout:90000,maxBuffer:1024*1024});
    writeFileSync(resolve(directory,name+'.log'),result.stdout+result.stderr);
  }catch(e){
    const x=e as Error&{code?:string;stdout?:string;stderr?:string};
    writeFileSync(resolve(directory,name+'.log'),(x.stdout||'')+(x.stderr||x.message));
    if(x.code==='ENOENT')throw new AgentError('找不到 Python 3，原 Skill 的透明校验脚本无法执行。请安装 Python 3 后再启动。',503);
    throw new AgentError(`原 Skill 校验未通过（${name}）：${((x.stdout||'')+(x.stderr||x.message)).slice(-1400)}`,422);
  }
}
export async function prepareCharacter(job:Job,draft:Buffer,directory:string){
  mkdirSync(directory,{recursive:true});
  const input=resolve(directory,'draft.png'),converted=resolve(directory,'converted.png'),aligned=resolve(directory,'aligned.png');
  writeFileSync(input,draft);
  let file=input;
  if(job.transparency==='chroma'){
    await script('chroma_to_alpha.py',[input,converted,'--key','#FF00FF','--mode','all','--allow-bottom-touch','--preview-dir',directory],directory);
    file=converted;
    // The supplied script rejects rounded/narrow crops; it never forces a new silhouette.
    await script('align_bottom_crop.py',[file,aligned],directory);file=aligned;
  }
  const metadata=await sharp(file).metadata();
  if(!metadata.hasAlpha)throw new AgentError('[ALPHA] 原生图片没有透明通道，需要纯色幕布校准',422);
  const {data,info}=await sharp(file).ensureAlpha().raw().toBuffer({resolveWithObject:true});
  let clear=0;for(let i=3;i<data.length;i+=4)if(data[i]<10)clear++;
  if(clear/(info.width*info.height)<0.2)throw new AgentError('[ALPHA] 图片没有足够清晰透明区域，需要纯色幕布校准',422);
  await script('validate_character_assets.py',['--require-bottom-touch',file],directory);
  const png=readFileSync(file);
  await Promise.all(['black','white'].map(async color=>{await sharp(png).flatten({background:color}).png().toFile(resolve(directory,`preview-${color}.png`));}));
  return png;
}
