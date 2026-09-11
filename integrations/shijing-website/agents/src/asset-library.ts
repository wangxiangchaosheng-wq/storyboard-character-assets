import {mkdirSync,readdirSync,readFileSync,writeFileSync,renameSync,existsSync} from 'node:fs';
import {resolve} from 'node:path';
import {createHash} from 'node:crypto';
import sharp from 'sharp';
import {assert,type Persona,type Job} from './contracts.js';
const normalize=(value:string)=>value.normalize('NFKC').trim();
export type LibraryEntry={name:string;file:string;source:'provided'|'generated';aliases?:string[];createdAt?:string;fromJob?:string;};
export class AssetLibrary {
  directory:string;
  constructor(directory:string){this.directory=resolve(directory);mkdirSync(this.directory,{recursive:true});mkdirSync(resolve(this.directory,'自动生成'),{recursive:true});}
  entries():LibraryEntry[]{
    const provided=readdirSync(this.directory,{withFileTypes:true}).filter(p=>p.isFile()&&p.name.toLowerCase().endsWith('.png')).map(p=>({name:normalize(p.name.slice(0,-4)),file:p.name,source:'provided' as const}));
    const catalog=resolve(this.directory,'人物索引.json');
    const aliases:Record<string,string[]>=existsSync(catalog)?JSON.parse(readFileSync(catalog,'utf8')).aliases||{}:{};
    for(const entry of provided)(entry as LibraryEntry).aliases=aliases[entry.name]||[];
    let saved:LibraryEntry[]=[];const file=resolve(this.directory,'自动生成','index.json');if(existsSync(file)){const raw=JSON.parse(readFileSync(file,'utf8'));assert(Array.isArray(raw),'资产库索引损坏，请恢复 index.json',503);saved=raw;}
    return [...provided,...saved];
  }
  async find(persona:Persona){
    const name=normalize(persona.name);const entry=this.entries().find(e=>normalize(e.name)===name||e.aliases?.some(a=>normalize(a)===name));if(!entry)return;
    const path=resolve(this.directory,entry.file);assert(path.startsWith(this.directory+'/'),'素材路径不能越出人物素材库',503);
    const png=readFileSync(path);const meta=await sharp(png,{limitInputPixels:16000000}).metadata();assert(meta.format==='png'&&meta.hasAlpha,`人物库里的「${entry.name}」需要带透明通道的 PNG`,503);
    const {data,info}=await sharp(png).ensureAlpha().raw().toBuffer({resolveWithObject:true});let clear=0,visible=0;for(let i=3;i<data.length;i+=4){if(data[i]<10)clear++;if(data[i]>128)visible++;}
    assert(clear/(info.width*info.height)>0.15&&visible/(info.width*info.height)>0.1,`人物库里的「${entry.name}」不是有效免抠图`,503);
    return {entry,png};
  }
  remember(persona:Persona,png:Buffer,job:Job){
    const hash=createHash('sha256').update(normalize(persona.name)).digest('hex').slice(0,20);
    const file=`自动生成/${hash}-${job.id}.png`;writeFileSync(resolve(this.directory,file),png);
    const index=resolve(this.directory,'自动生成','index.json');const records=this.entries().filter(e=>e.source==='generated'&&normalize(e.name)!==normalize(persona.name));
    records.push({name:normalize(persona.name),file,source:'generated',fromJob:job.id,createdAt:new Date().toISOString()});
    writeFileSync(index+'.tmp',JSON.stringify(records,null,2));renameSync(index+'.tmp',index);
  }
}
