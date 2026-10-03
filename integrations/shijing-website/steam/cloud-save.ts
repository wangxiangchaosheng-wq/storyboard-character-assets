import {existsSync,mkdirSync,readFileSync,readdirSync,renameSync,rmSync,writeFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {join,resolve} from 'node:path';
import type {WorldSnapshot,WorldEvent} from '../agents/src/world-contracts.js';
import type {Run} from '../agents/src/contracts.js';

/**
 * 云存档 v1：对局档案粒度——导出一局为一段 JSON（run + 世界快照 + 事件流水）。
 *
 * 为什么这样设计：成就只读流水，是「考据」；云存档要的是「把这一局原样搬到另一台机器上
 * 继续说」。事件流水是世界唯一的事实来源（史官七条铁律第一条），所以存档三段齐发：
 * 恢复时世界从快照续推、流水保证史官与成就推导不缺上下文。粒度刻意不做「按 tick 增量」——
 * v1 一局的数据量（百来条事件）一个 JSON 文件就装得下，增量同步是自找的复杂度。
 *
 * 两套后端共用同一命名空间与同一套校验：文件系统（createCloudSave）与 Steam 云端
 * （createSteamCloudSave）只是「字节存到哪」的区别，条目格式、失败语义完全一致。
 */

export interface CloudSaveEntry{gameId:string;title:string;savedAt:string;revision:number;elapsedDays:number;payload:string}
export interface CloudSaveProvider{available:boolean;list():Promise<CloudSaveEntry[]>;read(gameId:string):Promise<CloudSaveEntry|null>;write(entry:CloudSaveEntry):Promise<void>;remove(gameId:string):Promise<void>}

const SAVE_FORMAT='shijing-run/v1';   // payload 内的格式版本号：升级必须换号，旧号一律拒绝恢复，不做静默迁移
const NAMESPACE='cloud-saves';        // 云存档命名空间：文件系统与 Steam 云端用同一相对路径，换后端不改存档位置
const GAME_ID=/^[A-Za-z0-9_-]{1,80}$/; // gameId 直接当文件名：白名单之外一个字符都不放行，一个点号就是目录穿越
const err=(e:unknown)=>e instanceof Error?e.message:String(e);
function assertEntry(e:CloudSaveEntry):void{
  if(!e||typeof e!=='object')throw new Error('云存档条目必须是对象');
  if(!GAME_ID.test(e.gameId))throw new Error(`对局编号「${String(e.gameId)}」含非法字符，不能作为云存档文件名`);
  if(typeof e.title!=='string'||!e.title)throw new Error('云存档缺少标题');
  if(typeof e.savedAt!=='string'||!e.savedAt)throw new Error('云存档缺少保存时间');
  if(!Number.isFinite(e.revision)||e.revision<0)throw new Error('云存档的世界版本无效');
  if(!Number.isFinite(e.elapsedDays)||e.elapsedDays<0)throw new Error('云存档的推演天数无效');
  if(typeof e.payload!=='string'||!e.payload)throw new Error('云存档缺少正文');
}
/** 读到的任何字节都先过这一关：坏文件抛中文错，绝不给半截数据——调用方拿到的一定是完整条目。 */
function parseEntry(raw:string,label:string):CloudSaveEntry{
  let data:unknown;
  try{data=JSON.parse(raw);}catch(e){throw new Error(`云存档 ${label} 已损坏：不是合法 JSON（${err(e)}）`);}
  const o=data as Partial<CloudSaveEntry>|null;
  if(!o||typeof o!=='object'||Array.isArray(o))throw new Error(`云存档 ${label} 已损坏：内容必须是 JSON 对象`);
  const entry:CloudSaveEntry={gameId:String(o.gameId),title:String(o.title),savedAt:String(o.savedAt),revision:Number(o.revision),elapsedDays:Number(o.elapsedDays),payload:String(o.payload)};
  assertEntry(entry);
  return entry;
}
const bySavedAt=(a:CloudSaveEntry,b:CloudSaveEntry)=>a.savedAt<b.savedAt?1:a.savedAt>b.savedAt?-1:a.gameId<b.gameId?-1:a.gameId>b.gameId?1:0; // 新的在前；同秒按编号定序，列举结果才可复现

/** 文件系统实现：<dir>/cloud-saves/<gameId>.json。本地/开发期默认后端，永远 available。 */
export function createCloudSave(dir:string):CloudSaveProvider{
  const root=resolve(dir,NAMESPACE);
  const pathOf=(gameId:string):string=>{if(!GAME_ID.test(gameId))throw new Error(`对局编号「${gameId}」含非法字符，拒绝读写`);return join(root,`${gameId}.json`);};
  return {available:true,
    async list(){if(!existsSync(root))return[];return readdirSync(root).filter(f=>f.endsWith('.json')).map(f=>parseEntry(readFileSync(join(root,f),'utf8'),f)).sort(bySavedAt);},
    async read(gameId){const p=pathOf(gameId);if(!existsSync(p))return null;const e=parseEntry(readFileSync(p,'utf8'),gameId);if(e.gameId!==gameId)throw new Error(`云存档 ${gameId} 与文件名不符`);return e;},
    // 先写 .tmp 再原子改名：写一半掉线只会留下临时文件，不会毁掉上一份好存档
    async write(entry){assertEntry(entry);mkdirSync(root,{recursive:true});const p=pathOf(entry.gameId);writeFileSync(`${p}.tmp`,JSON.stringify(entry),'utf8');renameSync(`${p}.tmp`,p);},
    async remove(gameId){const p=pathOf(gameId);if(existsSync(p))rmSync(p);}, // 幂等：删不存在的存档不算错，重试逻辑才敢反复调
  };
}

/**
 * steamworks.js@0.4.0 的远程存储（cloud 命名空间）真实形状。
 *
 * 踩过的坑：云端后端最初按「模块扁平导出 fileWrite/fileRead/fileDelete/fileIterate/
 * isCloudEnabled」写，那是 0.0.x 的形态。0.4.0 的模块只导出 init 等四项，远程存储在
 * `init().cloud` 命名空间下，且方法名整体不同：readFile / writeFile / deleteFile /
 * fileExists / listFiles，开关是 isEnabledForAccount / isEnabledForApp（没有 isCloudEnabled）。
 * 所以 `typeof mod.fileWrite==='function'` 恒为 false → loadSteamStorage() 恒返回 null →
 * createSteamCloudSave() 恒 unavailable。**接上线也永远不通**，与成就那次是同一类错。
 */
interface SteamCloudRaw{
  readFile(name:string):string|Buffer|null;
  writeFile(name:string,data:string):boolean;
  deleteFile(name:string):boolean;
  fileExists(name:string):boolean;
  listFiles():string[]|{name:string}[]|null;
  isEnabledForAccount?():boolean;
  isEnabledForApp?():boolean;
  FileInfo?(name:string):unknown;
}
/** 内部扁平面：把 cloud 命名空间适配回本项目原来用的名字。 */
interface SteamStorage{
  fileWrite(name:string,data:string):boolean;
  fileRead(name:string):string|Buffer|null;
  fileDelete(name:string):boolean;
  fileExists(name:string):boolean;
  fileIterate():string[];
  isCloudEnabled():boolean;
}
function loadSteamStorage(appId:string|undefined):SteamStorage|null{
  try{
    const require=createRequire(import.meta.url);
    const mod=require('steamworks.js') as {init(appId?:number):{cloud?:SteamCloudRaw};restartAppIfNecessary?(appId:number):boolean};
    if(typeof mod.init!=='function')return null;
    // appid 由调用方显式传入（server.ts 从 initSteam 的返回值里拿）。这里不再自己 require
    // steam.mjs 去探测——ESM 没法被 require 加载，那条路只会静默返回空串，而 Number('')=0
    // 会让 init(0) 失败，表现成「云存档不可用」这种和真实原因无关的怪错。
    const id=Number(appId);
    if(!Number.isFinite(id)||id<=0)return null;
    // 复用同一个 Steam 连接：0.4.0 的 init 幂等性由上游保证（重复调用返回现状）
    const api=mod.init(id);
    const cloud=api?.cloud;
    if(!cloud||typeof cloud.readFile!=='function'||typeof cloud.writeFile!=='function')return null;
    return {
      fileWrite:(name,data)=>cloud.writeFile(name,data),
      fileRead:(name)=>cloud.readFile(name),
      fileDelete:(name)=>cloud.deleteFile(name),
      fileExists:(name)=>cloud.fileExists(name),
      // listFiles 在不同版本返回 string[] 或 {name}[]；统一成 string[]，调用方只认名字
      fileIterate:()=>{
        const raw=cloud.listFiles?.()??[];
        return (Array.isArray(raw)?raw:[]).map((x)=>typeof x==='string'?x:String((x as {name?:string})?.name??''));
      },
      isCloudEnabled:()=>{
        if(typeof cloud.isEnabledForAccount==='function'&&!cloud.isEnabledForAccount())return false;
        if(typeof cloud.isEnabledForApp==='function'&&!cloud.isEnabledForApp())return false;
        return true;
      },
    };
  }catch{return null;}
}
/**
 * Steam 云端实现：命名空间与文件系统后端一致（cloud-saves/<gameId>.json）。
 * 不可用时 available:false 且每个方法抛可读中文错——不静默失败：玩家点了「存档到云端」
 * 却悄无声息地什么都没发生，比明确报错糟糕得多。
 *
 * @param appId 调用方已知的 appid（server.ts 从 initSteam() 的 status.appId 拿）。不给就退回
 *   环境变量 STEAM_APP_ID——与 steam.ts 的探测链同源，但只到环境变量为止：从 exe 目录找
 *   steam_appid.txt 那段逻辑在 steam.ts 里，这里各写一份迟早漂移。
 */
export function createSteamCloudSave(appId?:string):CloudSaveProvider{
  const unavailable=(reason:string):CloudSaveProvider=>({available:false,
    async list(){throw new Error(`Steam 云存档不可用：${reason}`);},
    async read(){throw new Error(`Steam 云存档不可用：${reason}`);},
    async write(){throw new Error(`Steam 云存档不可用：${reason}`);},
    async remove(){throw new Error(`Steam 云存档不可用：${reason}`);}});
  const sw=loadSteamStorage(appId ?? (typeof process!=='undefined'?process.env.STEAM_APP_ID?.trim():undefined));
  if(!sw)return unavailable('未能加载 steamworks.js（未安装或不在 Steam 运行时内）。非 Steam 环境请改用 createCloudSave(dir) 本地目录实现');
  if(typeof sw.isCloudEnabled==='function'&&!sw.isCloudEnabled())return unavailable('Steam 云同步已被用户在客户端关闭');
  const nameOf=(gameId:string):string=>{if(!GAME_ID.test(gameId))throw new Error(`对局编号「${gameId}」含非法字符，拒绝读写`);return `${NAMESPACE}/${gameId}.json`;};
  const boom=(op:string,e:unknown)=>Promise.reject(new Error(`Steam 云存档${op}失败：${err(e)}`));
  return {available:true,
    async list(){
      try{
        const names=typeof sw.fileIterate==='function'?sw.fileIterate():[];
        const out:CloudSaveEntry[]=[];
        for(const n of names||[]){
          if(!n.startsWith(`${NAMESPACE}/`)||!n.endsWith('.json'))continue; // 命名空间之外的云端文件不是本游戏的存档，一概不碰
          const raw=sw.fileRead(n);
          if(raw==null)continue;
          out.push(parseEntry(String(raw),n));
        }
        return out.sort(bySavedAt);
      }catch(e){return boom('列举',e);}
    },
    async read(gameId){
      try{
        const n=nameOf(gameId);
        if(!sw.fileExists(n))return null;
        const raw=sw.fileRead(n);
        if(raw==null)return null;
        const e=parseEntry(String(raw),gameId);
        if(e.gameId!==gameId)throw new Error(`云存档 ${gameId} 与文件名不符`);
        return e;
      }catch(e){return boom('读取',e);}
    },
    async write(entry){
      try{
        assertEntry(entry);
        if(!sw.fileWrite(nameOf(entry.gameId),JSON.stringify(entry)))throw new Error('steamworks.js 拒绝写入（云端配额已满或同步被禁用）');
      }catch(e){return boom('写入',e);}
    },
    async remove(gameId){
      try{
        const n=nameOf(gameId);
        if(sw.fileExists(n)&&!sw.fileDelete(n))throw new Error('steamworks.js 拒绝删除');
      }catch(e){return boom('删除',e);}
    },
  };
}

/** 导出一局：run + 世界快照 + 事件流水三段齐发，payload 自带格式版本号。 */
export function exportRunToSave(run:Run,world:WorldSnapshot,events:WorldEvent[]):CloudSaveEntry{
  return {gameId:run.id,title:run.spec?.title||run.id,savedAt:new Date().toISOString(),revision:world.revision,elapsedDays:world.clock?.elapsedDays??0,
    payload:JSON.stringify({format:SAVE_FORMAT,run,world,events})};
}
/**
 * 恢复一局：逐项强校验，任何一项不过就整体抛中文错——宁可拒绝恢复，也不半截恢复。
 * 半截恢复比拒绝危险得多：世界缺了流水，史官写不出本纪，成就推导还会凭空少算。
 */
export function importRunFromSave(entry:CloudSaveEntry):{run:Run;world:WorldSnapshot;events:WorldEvent[]}{
  assertEntry(entry);
  let data:unknown;
  try{data=JSON.parse(entry.payload);}catch(e){throw new Error(`存档正文不是合法 JSON：${err(e)}`);}
  const o=data as Record<string,unknown>|null;
  if(!o||typeof o!=='object'||Array.isArray(o))throw new Error('存档正文必须是 JSON 对象');
  if(o.format!==SAVE_FORMAT)throw new Error(`存档格式不受支持：期望 ${SAVE_FORMAT}，实际 ${JSON.stringify(o.format)??'缺失'}`);
  const run=o.run as Partial<Run>|null;
  if(!run||typeof run.id!=='string'||!GAME_ID.test(run.id))throw new Error('存档里的对局编号缺失或含非法字符');
  if(!run.spec||typeof run.spec.id!=='string'||typeof run.spec.title!=='string'||!run.spec.scenario)throw new Error('存档里的剧本缺失或不完整');
  if(!run.world||typeof run.world!=='object'||!run.world.metrics||!run.world.cities)throw new Error('存档里的对局世界缺失或不完整');
  if(!Array.isArray(run.messages))throw new Error('存档里的消息流水缺失');
  const world=o.world as Partial<WorldSnapshot>|null;
  if(!world||world.schemaVersion!=='world-state/v1')throw new Error('存档里的世界快照缺失或版本不受支持');
  if(!world.factions||!world.cities||!world.armies||!world.actions||!world.decisions)throw new Error('存档里的世界快照缺项（势力/城池/军队/行动/决策）');
  if(!world.clock||typeof world.clock.elapsedDays!=='number')throw new Error('存档里的世界时钟缺失');
  if(!Array.isArray(o.events))throw new Error('存档里的事件流水缺失');
  for(const [i,e] of (o.events as Partial<WorldEvent>[]).entries()){
    if(!e||typeof e.id!=='string'||typeof e.settlementId!=='string'||typeof e.revision!=='number'||!Array.isArray(e.changes))throw new Error(`存档里第 ${i+1} 条事件不完整：拒绝半截恢复`);
  }
  return {run:run as Run,world:world as WorldSnapshot,events:o.events as WorldEvent[]};
}
