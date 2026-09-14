import {inspectPortrait,portraitPolicy} from './portrait-acceptance.js';
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
  return ['SKILL.md',...refs.map(n=>`references/${n}.md`)].map(n=>`\n--- ${folder}/${n} ---\n${readFileSync(resolve(root,'skills',folder,n),'utf8')}`).join('\n')+(kind==='portrait'?'\n'+portraitPolicy:'');
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
  const input=resolve(directory,'draft.png'),converted=resolve(directory,'converted.png');
  writeFileSync(input,draft);
  let file=input;
  let alreadyTransparent=false;
  try{await inspectPortrait(draft);alreadyTransparent=true;}catch{}
  if(!alreadyTransparent&&job.transparency==='chroma'){
    await script('chroma_to_alpha.py',[input,converted,'--key','#FF00FF','--mode','all','--allow-bottom-touch','--max-edge-contact','1','--force','--preview-dir',directory],directory);
    file=converted;
  }
  const png=readFileSync(file);
  const metrics=await inspectPortrait(png);
  writeFileSync(resolve(directory,'transparency-check.json'),JSON.stringify({pass:true,policy:'transparent-png-v1',...metrics},null,2));
  await Promise.all(['black','white'].map(async color=>{await sharp(png).flatten({background:color}).png().toFile(resolve(directory,`preview-${color}.png`));}));
  return png;
}
