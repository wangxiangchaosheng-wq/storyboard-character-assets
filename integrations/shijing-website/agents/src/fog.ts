import type {Army,WorldSnapshot} from './world-contracts.js';
import {EXPLORE_INTEL_PREFIX,type Intelligence} from './simulation-types.js';
import type {MatterTier} from './court.js';

/**
 * 战争迷雾与信息隔离 v1：玩家坐在后方，对前线——包括自己的军队——没有实时全知视野。
 *
 * 设计取舍：三档视野 full/partial/hidden；partial 只给兵力段位，不给精确数；
 * 情报与军报都要过信使延迟（按道路公里折日），超过 INTEL_STALE_DAYS 未更新即作废。
 * 本方军队 tier 恒为 full（自己的兵看得清人数），但同样要过信使延迟——报告上的
 * seenDay 是军报送达前日的产生日；路远到「最新军报送到时也已过期」的军队，按
 * 音讯全无降为 hidden：过期情报比没有情报更误导指挥。
 *
 * 全部确定性、无随机项：同一世界两次调用必须深相等，玩家与 AI 才能事先推演
 * 「我现在知道什么、不知道什么」。只读世界，不修改入参。
 */

/** 模拟设定：信使日行 60 km——加急军报的乡间官道速度，不是太平驿传的极速。 */
export const COURIER_KM_PER_DAY = 60;
/** 模拟设定：情报 30 日不更新即作废；过期情报不可靠，宁可当作没有。 */
export const INTEL_STALE_DAYS = 30;

export type VisibilityTier='full'|'partial'|'hidden';

export interface ObservedArmy {
  id:string; name:string; factionId:string; factionName:string;
  tier:VisibilityTier;
  /** full 才给精确数 */
  troops?:number;
  /** partial 给段位，如「数千」 */
  troopsBand?:string;
  location?:string;
  /** 情报对应的推演日（已折算信使延迟前的产生日） */
  seenDay:number;
  /** 是否已过期：过期则 tier 降级 */
  stale:boolean;
}

export interface ObservedCity {
  id:string; name:string;
  tier:VisibilityTier;
  controller?:string;
  garrisonBand?:string;
  seenDay:number;
  stale:boolean;
}

export interface FogReport {
  observerFactionId:string;
  /** 报告对应的推演日 */
  asOfDay:number;
  armies:ObservedArmy[];
  cities:ObservedCity[];
  /** 本次报告的信使延迟天数 */
  courierDays:number;
  summary:string[];
}

/**
 * 兵力段位化：与 historian.bandTroops 同口径，但刻意不 import——
 * 史官模块带输入断言，迷雾层要能从坏存档里读出段位，而不是在半路抛错。
 */
export function bandTroops(n:number):string{
 const v=Number.isFinite(n)?Math.max(0,n):0;
 if(v<500)return '数百';
 if(v<2000)return '千余';
 if(v<10000)return '数千';
 if(v<50000)return '数万';
 if(v<200000)return '十数万';
 return '数十万众';
}

/**
 * 信使延迟天数：按道路公里数折成天数。无直达路时走「最长路」近似——
 * 取两城各自连通的最长一段路相加当绕行距离，宁可让玩家晚几天收到，不可早。
 * 道路开闭不进本模型：围城封锁是小时级战术，信使延迟只认距离这一个粗粒度。
 * 城市不存在、或两城都无路可通（旧存档没有道路层）记 0。
 */
export function courierDelayDays(fromCityId:string,toCityId:string,w:WorldSnapshot):number{
 if(fromCityId===toCityId)return 0;                                    // 同城：没有路程
 if(!w.cities[fromCityId]||!w.cities[toCityId])return 0;               // 城不存在：无处起程
 const roads=Object.values(w.simulation?.roads??{});
 const direct=roads.find(r=>r.from===fromCityId&&r.to===toCityId||r.from===toCityId&&r.to===fromCityId);
 if(direct)return Math.ceil(direct.distanceKm/COURIER_KM_PER_DAY);
 const longest=(cityId:string)=>roads.filter(r=>r.from===cityId||r.to===cityId).reduce((m,r)=>Math.max(m,r.distanceKm),0);
 const km=longest(fromCityId)+longest(toCityId);
 return km>0?Math.ceil(km/COURIER_KM_PER_DAY):0;
}

/**
 * 三档视野纯函数：本方资产恒 full；敌方有未过期情报记 partial；其余 hidden。
 * intelAgeDays 恰等于 INTEL_STALE_DAYS 记未过期——过期线是含端点的。
 */
export function visibilityTier(args:{own:boolean;hasIntel:boolean;intelAgeDays:number}):VisibilityTier{
 if(args.own)return 'full';
 return args.hasIntel&&args.intelAgeDays<=INTEL_STALE_DAYS?'partial':'hidden';
}

/** 覆没与空壳军队不占迷雾视野：它们的结局由战报层告知，不是前线未知。 */
const viable=(a:Army)=>a.troops>0&&a.status!=='destroyed';
const factionName=(w:WorldSnapshot,id:string)=>w.factions[id]?.name??id;
const byId=(x:{id:string},y:{id:string})=>x.id<y.id?-1:x.id>y.id?1:0;

/** 本方军队位置只报到「城名 / 行军途中 / 野地名」——路上的精确里程是引擎内部账，不上报。 */
function armyLocationLabel(a:Army,w:WorldSnapshot):string|undefined{
 if(a.location.kind==='city')return w.cities[a.location.cityId]?.name;
 if(a.location.kind==='route')return '行军途中';
 return a.location.label;
}

/** 军报送达的延迟以「军队此刻在哪」为起点：驻城记该城，行军记目标/出发城，野地取最近城。 */
function armyRefCity(a:Army,w:WorldSnapshot):string|undefined{
 const loc=a.location;
 if(loc.kind==='city')return loc.cityId;
 if(loc.kind==='route'){const act=w.actions[loc.actionId];return act?.target.cityId??act?.origin.cityId??undefined;}
 const near=Object.values(w.cities).map(c=>({id:c.id,d:(c.point.x-loc.point.x)**2+(c.point.y-loc.point.y)**2})).sort((x,y)=>x.d-y.d||byId(x,y));
 return near[0]?.id;
}

/** 同一支敌军的多条情报取最新一条：探马不会一天内改口，重复记录是刷新产生的。 */
function freshestIntel(w:WorldSnapshot,observer:string,enemyArmyId:string):Intelligence|undefined{
  let best:Intelligence|undefined;
  for(const i of w.simulation?.intelligence??[])if(i.observerFactionId===observer&&i.enemyArmyId===enemyArmyId&&(!best||i.seenHour>best.seenHour))best=i;
  return best;
}
/**
 * B8：某城最新的**城市级**探索情报（enemyArmyId 形如 explore-<city>，见 EXPLORE_INTEL_PREFIX）。
 * 探索令探的是「这座城有多少守军」而不是哪支敌军，freshestIntel 按真实敌军 id 精确匹配
 * 永远取不到它——城内守军因此永远是 hidden、summary 恒报「已探明敌军 0 支」，与探索回执
 * 「获悉守军规模」自相矛盾。这里按城市取，供 armies 层把城内守军点亮成段位。
 */
function freshestCityIntel(w:WorldSnapshot,observer:string,cityId:string):Intelligence|undefined{
  let best:Intelligence|undefined;
  for(const i of w.simulation?.intelligence??[])if(i.observerFactionId===observer&&i.atCityId===cityId&&i.enemyArmyId.startsWith(EXPLORE_INTEL_PREFIX)&&(!best||i.seenHour>best.seenHour))best=i;
  return best;
}

export function fogReport(w:WorldSnapshot,asOfDay?:number,observerFactionId?:string):FogReport{
 const day=asOfDay??(w.simulation?Math.floor(w.simulation.timeHours/24):w.clock.elapsedDays);
 const observer=observerFactionId??w.simulation?.playerFactionId??Object.keys(w.factions)[0];
 if(!observer)return {observerFactionId:'',asOfDay:day,armies:[],cities:[],courierDays:0,summary:[]};
 // v1 没有都城字段：本方按 id 排序的第一座城即「后方」——确定性优先，接入都城概念后替换
 const seat=Object.values(w.cities).filter(c=>c.ownerFactionId===observer).map(c=>c.id).sort()[0];
 const intelDelay=(i:Intelligence)=>{
  if(!seat)return 0;
  if(i.atCityId)return courierDelayDays(i.atCityId,seat,w);
  const road=i.roadId?w.simulation?.roads[i.roadId]:undefined;   // 在途军报：取道路两端到后方较近的一段
  return road?Math.min(courierDelayDays(road.from,seat,w),courierDelayDays(road.to,seat,w)):0;
 };
 const armies:ObservedArmy[]=[];
 for(const a of Object.values(w.armies)){
  if(!viable(a))continue;
  const base={id:a.id,name:a.name,factionId:a.factionId,factionName:factionName(w,a.factionId)};
  if(a.factionId!==observer){
   const intel=freshestIntel(w,observer,a.id);
   const age=intel?day-Math.floor(intel.seenHour/24):Infinity;
   // 存在与名号是瞒不住的（大军过境，商旅皆闻）；兵力与位置才过迷雾
   if(intel&&visibilityTier({own:false,hasIntel:true,intelAgeDays:age})==='partial')armies.push({...base,tier:'partial',
    troopsBand:bandTroops(intel.estimatedTroops),location:intel.atCityId?w.cities[intel.atCityId]?.name:intel.roadId?'行军途中':undefined,
    seenDay:Math.floor(intel.seenHour/24),stale:false});
   else{
    // B8：没有这支军队的**精确**情报时，看它所在城池有没有新鲜的探索情报。探明一座城的
    // 守军规模，就该知道城里「有兵、大致多少」——存在与名号瞒不过商旅，精确兵力与番号
    // 归属才过迷雾。城内每支敌军按**该城守军总数**的段位升 partial（v1 每城通常只有一支
    // 守军；多支并存时段位是全城合计，宁可说得大一些，也绝不给精确数）。位置即该城——
    // 探索情报记的就是城池，路上的军队没有城级情报可依。
    const cityId=a.location.kind==='city'?a.location.cityId:undefined;
    const cityIntel=cityId?freshestCityIntel(w,observer,cityId):undefined;
    const cityAge=cityIntel?day-Math.floor(cityIntel.seenHour/24):Infinity;
    if(cityIntel&&visibilityTier({own:false,hasIntel:true,intelAgeDays:cityAge})==='partial')
     armies.push({...base,tier:'partial',troopsBand:bandTroops(cityIntel.estimatedTroops),
      location:w.cities[cityId!]?.name,seenDay:Math.floor(cityIntel.seenHour/24),stale:false});
    // 过期情报比没有情报更误导：城级情报也过期时如实标 stale（曾探明，如今瞎了）
    else armies.push({...base,tier:'hidden',seenDay:0,stale:!!intel&&age>INTEL_STALE_DAYS||!!cityIntel&&cityAge>INTEL_STALE_DAYS});
   }
   continue;
  }
  const label=armyLocationLabel(a,w);
  // 位置无从核实（城池已从簿册上消失）＝音讯全无：军报送不到，后方就不知道它在哪
  if(label===undefined){armies.push({...base,tier:'hidden',seenDay:0,stale:false});continue;}
  const ref=armyRefCity(a,w);
  const delay=seat&&ref?courierDelayDays(seat,ref,w):0;
  // 最新军报走到后方时也已过期：音讯全无，降 hidden——本方也不是全知
  if(delay>INTEL_STALE_DAYS){armies.push({...base,tier:'hidden',seenDay:0,stale:true});continue;}
  armies.push({...base,tier:'full',troops:a.troops,location:label,seenDay:Math.max(0,day-delay),stale:false});
 }
 const cities:ObservedCity[]=[];
 for(const c of Object.values(w.cities)){
  if(c.ownerFactionId!==observer){
   const seen=(w.simulation?.intelligence??[]).filter(i=>i.observerFactionId===observer&&i.atCityId===c.id);
   const fresh=seen.filter(i=>day-Math.floor(i.seenHour/24)<=INTEL_STALE_DAYS);
   // 城池归属是地图上的公开信息；hidden 则一无所知，连城是谁的都不写
   if(fresh.length)cities.push({id:c.id,name:c.name,tier:'partial',controller:factionName(w,c.ownerFactionId),
    garrisonBand:bandTroops(fresh.reduce((n,i)=>n+i.estimatedTroops,0)),seenDay:Math.max(...fresh.map(i=>Math.floor(i.seenHour/24))),stale:false});
   else cities.push({id:c.id,name:c.name,tier:'hidden',seenDay:0,stale:seen.length>0});
   continue;
  }
  // 守军也段位化：连自己城里有多少兵都要靠军报送，这才有「后方不知前线」的味
  const garrison=Object.values(w.armies).filter(a=>a.factionId===observer&&viable(a)&&a.location.kind==='city'&&a.location.cityId===c.id).reduce((n,a)=>n+a.troops,0);
  cities.push({id:c.id,name:c.name,tier:'full',controller:factionName(w,c.ownerFactionId),garrisonBand:bandTroops(garrison),seenDay:day,stale:false});
 }
 // 报告只报一个代表性延迟：取最新一条情报从其见报地到后方的传递天数；没有情报则 0
 let latest:Intelligence|undefined;
 for(const i of w.simulation?.intelligence??[])if(i.observerFactionId===observer&&(!latest||i.seenHour>latest.seenHour||i.seenHour===latest.seenHour&&i.enemyArmyId<latest.enemyArmyId))latest=i;
 const courierDays=latest?intelDelay(latest):0;
 armies.sort(byId);cities.sort(byId);   // 排序不依赖引擎键序：同一世界的两份序列化副本必须给出同一份报告
 return {observerFactionId:observer,asOfDay:day,armies,cities,courierDays,summary:[
  `本方 ${armies.filter(a=>a.factionId===observer).length} 军 · 已探明敌军 ${armies.filter(a=>a.factionId!==observer&&a.tier==='partial').length} 支 · 不明 ${armies.filter(a=>a.factionId!==observer&&a.tier==='hidden').length} 支`,
  `信使延迟 ${courierDays} 日`]};
}

/**
 * 把迷雾状态翻译成「该不该惊动玩家」：本方军队音讯全无（hidden）是「后方不知前线」
 * 的极致形态，必须让玩家知道。只提示、不改世界；级别取 major 而非 critical——
 * 惊动但不惊慌，与 court.surfacesToPlayer 的 major 分支是同一条约定。
 */
export function fogForCourt(w:WorldSnapshot):{critical:MatterTier[];notes:string[]}{
 const report=fogReport(w);
 const lost=report.armies.filter(a=>a.factionId===report.observerFactionId&&a.tier==='hidden');
 const critical:MatterTier[]=[],notes:string[]=[];
 if(lost.length>0){critical.push('major');notes.push(`有 ${lost.length} 支本方军队音讯全无`);}
 return {critical,notes};
}
