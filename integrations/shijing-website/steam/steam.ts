import {existsSync,readFileSync} from 'node:fs';
import {createRequire} from 'node:module';
import {dirname,join} from 'node:path';

/**
 * Steam 集成 v1：没有 Steam 也能跑。
 *
 * 为什么这样设计：Steam 是发售渠道，不是运行前提。非 Steam 用户（直接下包、Steam 外启动、
 * 开发期 npm run）必须能原样玩到全部内容；Steam 相关的一切因此被收敛到「探测 → 失败即
 * no-op」一条路上：探测链上任何一环拿不到东西，就返回 available:false，之后所有 API 都是
 * 安全 no-op（返回 false/null，不抛），绝不让原生模块把游戏拖死。
 *
 * 探测顺序固定为：STEAM_APP_ID 环境变量 → steam_appid.txt（当前目录逐级向上）→ steamworks.js
 * 可否加载并初始化。steamworks.js 是原生模块，不在 dependencies 里：装了才有，没装就走 no-op。
 */

export interface SteamStatus{available:boolean;reason?:string;appId?:string;user?:string}

/**
 * steamworks.js@0.4.0 的真实形状。
 *
 * 踩过的坑：0.4.0 的模块**只**导出 init / restartAppIfNecessary /
 * electronEnableSteamOverlay / SteamCallback 四个东西，完整 API 是 `init()` 的返回值，
 * 而且是 namespaced 的（achievement / stats / localplayer / overlay / utils…）。
 * 早期（2021 年的 0.0.x）是模块扁平导出，那套假设在任何已发布版本上都不成立——照旧写法
 * 装上包只会得到 available:true 而成就/统计全部静默 false。
 */
interface SteamworksRaw{
  achievement:{activate(name:string):boolean;isActivated(name:string):boolean;clear(name:string):boolean};
  stats:{getInt(name:string):number|null;setInt(name:string,value:number):boolean;store():boolean;resetAll(achievementsToo:boolean):boolean};
  localplayer:{getSteamId():{steamId64:bigint;steamId32:string;accountId:number}};
}
interface SteamworksModule{
  init(appId?:number):SteamworksRaw;
  restartAppIfNecessary?(appId:number):boolean;
}
/** 内部扁平接口：把 namespaced API 适配回来，unlockAchievement/setStat/getStat 一行不用动。 */
interface SteamworksClient{
  init(appId:number):boolean;
  activateAchievement(id:string):boolean;
  setStat(name:string,value:number):boolean;
  getStat(name:string):number|null;
  storeStats?():boolean;
  shutdown?():void;
  /** 取不到用户标识时返回 undefined（Steam 未登录 / API 报错），不影响 available。 */
  getSteamId?():string|undefined;
  restartAppIfNecessary?(appId:number):boolean;
}
/**
 * namespaced → 扁平。
 *
 * shutdown 是 no-op：0.4.0 没有全局 shutdown（client.d.ts 里唯一的 shutdown 属于
 * `input` 命名空间，是 Steam Input 的，不是 Steam API 的）。Steam API 随进程退出清理，
 * 所以这里保持接口存在但不做事——上层的退出路径照旧调，行为不变。
 */
function toFlatClient(raw:SteamworksRaw):SteamworksClient{
  return {
    init:()=>true,
    activateAchievement:(id)=>raw.achievement.activate(id),
    setStat:(name,value)=>raw.stats.setInt(name,value),
    getStat:(name)=>raw.stats.getInt(name),
    storeStats:()=>raw.stats.store(),
    shutdown:()=>{},
    getSteamId:()=>{try{return String(raw.localplayer.getSteamId().steamId64);}catch{return undefined;}},
  };
}
const ACHIEVEMENT_ID=/^[a-z0-9_]{1,64}$/; // Steam 成就 API 名规范；不合法的 id 直接拒，别指望上游兜底
const STAT_ID=/^[A-Za-z0-9_]{1,64}$/;     // Steam 统计项 API 名规范
let client:SteamworksClient|null=null;
let status:SteamStatus={available:false,reason:'尚未初始化'};
const err=(e:unknown)=>e instanceof Error?e.message:String(e);
const fail=(reason:string):SteamStatus=>{status={available:false,reason};return status;};

/**
 * appid 探测：环境变量 → steam_appid.txt。两者都没有就交给 init 时报可读的错。
 *
 * `steam_appid.txt` 的搜索起点有**两个**，顺序固定：
 *   1. `dirname(process.execPath)` —— 可执行文件所在目录
 *   2. `process.cwd()` —— 当前工作目录
 *
 * 为什么 1 必须在 2 前面：Steam 客户端启动游戏时，是按官方约定把 `steam_appid.txt`
 * 写在 **exe 旁边**的。而 cwd 由启动者给、代码完全不控制——主进程的 cwd 继承自 Steam
 * 客户端，侧车与静态服务器的 cwd 是固定的 `<安装目录>/resources`。只从 cwd 往上找，
 * 等于把「Steam 客户端把 cwd 设成什么」当成隐性依赖；那一条链本机没有 Steam 客户端、
 * 无法实测。从 exe 目录起找则三种启动形态（npm run / electron 打包 / Steam 启动）
 * 全部确定成立——打包态 sidecar 经 `../../steam/steam.mjs` 落到同一处 resources，向上一级
 * 就是安装目录顶层，与 exe 同目录。
 *
 * 两个方向都逐级向上走完（去重），所以「文件放在任一侧的上级目录」也照样能找到。
 */
function detectAppId():string|null{
  const env=typeof process!=='undefined'?process.env.STEAM_APP_ID?.trim():'';
  if(env)return env;
  if(typeof process==='undefined')return null;
  const starts:string[]=[];
  try{if(process.execPath)starts.push(dirname(process.execPath));}catch{/* 取不到 exe 路径不致命 */}
  if(process.cwd)starts.push(process.cwd());
  for(const start of starts){
    let dir=start;
    for(;;){
      const file=join(dir,'steam_appid.txt');
      if(existsSync(file)){
        const id=readFileSync(file,'utf8').trim();
        if(/^\d+$/.test(id))return id;
      }
      const up=dirname(dir);
      if(up===dir)break;
      dir=up;
    }
  }
  return null;
}
/**
 * 供同目录其他模块复用的 appid 探测（cloud-save 要拿 appid 才知道往哪个 app 的云里写）。
 * 导出而不各写一份：两套探测逻辑迟早会漂移，而漂移的表现是「成就通了云存档不通」这类怪事。
 */
export function detectAppIdForCloudSave():string|null{return detectAppId();}
/** 惰性加载：原生模块只在 initSteam 里被碰一次，模块顶层 import 它会把非 Steam 用户直接挡在门外。 */
function loadSteamworks():SteamworksModule|null{
  try{
    const require=createRequire(import.meta.url);
    const mod=require('steamworks.js') as SteamworksModule&{default?:SteamworksModule};
    return mod&&typeof mod.init==='function'?mod:null;
  }catch{return null;} // 没装、平台不支持、都不抛：调用方按无 Steam 处理
}
export function initSteam(appId?:string):SteamStatus{
  if(status.available)return status; // 幂等：Steam API 只能 init 一次，重复调用直接返回现状
  const id=(appId??detectAppId()??'').trim();
  if(!id)return fail('未找到 appid：请设置 STEAM_APP_ID 环境变量，或在启动目录放置 steam_appid.txt');
  const sw=loadSteamworks();
  if(!sw)return fail('未能加载 steamworks.js：未安装该原生模块，或当前不在 Steam 运行时内');
  let api:SteamworksClient;
  try{
    // 从 Steam 客户端外启动时按官方约定重定向回 Steam；不在 Steam 内运行则原样返回，不影响继续
    sw.restartAppIfNecessary?.(Number(id));
    // 0.4.0 的 init：失败时**抛错**（上游 lib.rs 把 SteamAPIInitError 映射成 napi Error），
    // 成功时返回 namespaced API 对象（不是布尔值）。老版本是返回布尔+模块扁平导出，别照那个写。
    const raw=sw.init(Number(id));
    if(!raw||!raw.achievement||!raw.stats){
      return fail(`steamworks.js 初始化失败（appid ${id}）：Steam 客户端可能未运行或 appid 无效`);
    }
    api=toFlatClient(raw);
  }catch(e){return fail(`steamworks.js 初始化异常：${err(e)}`);}
  client=api;
  let user:string|undefined;
  try{const id64=client.getSteamId?.();if(id64)user=id64;}catch{/* 取不到用户标识不影响可用性 */}
  status={available:true,appId:id,...(user?{user}:{})};
  return status;
}
export const isSteamAvailable=():boolean=>status.available;
/** 全部 API 在无 Steam 时是 no-op（false/null），调用方无需分支判断。 */
export function unlockAchievement(id:string):boolean{
  if(!client||!ACHIEVEMENT_ID.test(id))return false;
  try{const ok=!!client.activateAchievement(id);if(ok)client.storeStats?.();return ok;}catch{return false;}
}
export function setStat(id:string,value:number):boolean{
  if(!client||!STAT_ID.test(id)||!Number.isFinite(value))return false;
  try{const ok=!!client.setStat(id,value);if(ok)client.storeStats?.();return ok;}catch{return false;}
}
export function getStat(id:string):number|null{
  if(!client||!STAT_ID.test(id))return null;
  try{const v=client.getStat(id);return typeof v==='number'&&Number.isFinite(v)?v:null;}catch{return null;}
}
export function shutdownSteam():void{
  const sw=client;client=null;status={available:false,reason:'已关闭'};
  try{sw?.shutdown?.();}catch{/* 关不掉也得关：退出路径上不能因原生模块抛错卡住进程 */}
}
