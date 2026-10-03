import type {Point} from './world-contracts.js';

export type OrderKind = 'march'|'forced-march'|'garrison'|'resupply'|'attack'|'besiege'|'retreat'|'explore';
export interface RuleParameter {
  value:number; min:number; max:number; unit:string;
  sourceKind:'simulation'; note:string;
}
export interface RulesProfile {
  id:'hanzhong-local-v1'; version:1; status:'experimental';
  parameters:Record<string,RuleParameter>;
  sources:{url:string;note:string}[];
}
export interface Road {
  id:string; from:string; to:string; distanceKm:number; terrainFactor:number;
  capacityPeople:number; open:boolean; waterAccessible:boolean; weatherFactor:number;
  source:string;
}
export interface SimOrder {
  id:string; kind:OrderKind; targetCityId?:string; roadId?:string;
  actionId?:string; sinceHour:number; status:'active'|'completed'|'failed';
  stopReason?:string;
  /** 这道令**到军中**的时刻（世界小时）。主上的诏令要驿传：未到之前部队原地候旨，
   *  不移动、不进军、不接战。undefined/0 = 当即生效（AI 代决与本地守军的常例）。 */
  arrivalHour?:number;
}
export interface ArmyModel {
  fatigue:number; wounded:number; dead:number; captured:number; deserted:number;
  transportPeople:number; initialPeople:number; training:number;
  waterLitres:number; foodDeficitHours:number; waterDeficitHours:number;
  equipment:number; siegePower:number; capacityKg:number;
  roadId:string|null; roadKm:number; atCityId:string|null;
  rationRatio:number; waterRatio:number; lastCombatHour:number;
  order:SimOrder|null; knownRoads:string[];
  effects:{id:string;parameter:'navigation';factor:number;roadId:string;expiresHour:number;group:string}[];
  // Fractional casualty carry avoids systematic rounding-away of small losses.
  lossCarry:number; recoveryCarry:number; desertCarry:number;
  /** BUG-116：本次溃退（士气崩溃解围）已处置的时刻；缺省=未在溃退期，士气回升即清。 */
  routedAtHour?:number;
}
export interface CityModel {
  residents:number; transportAvailable:number; initialResidents:number;
  waterAccessible:boolean; blockadeBy:string[]; gateOpen:boolean;
}
export interface Intelligence {
  observerFactionId:string; enemyArmyId:string; seenHour:number;
  atCityId:string|null; roadId:string|null; roadKm:number; estimatedTroops:number;
}
/** 城市级探索情报的 enemyArmyId 前缀（BUG-121 立、B8 修）。
 *  探索令落的情报语义是「这座城大致有多少守军」，不是「认出了哪支敌军」：enemyArmyId 取
 *  `explore-<cityId>`（不对应任何真实军队），estimatedTroops 是当时全城非本方军队总数。
 *  引擎写、迷雾读，两边共用这一个常量——曾经两边各写各的字面量，fog 只按真实敌军 id
 *  精确匹配，于是「探明城防」点不亮城内守军、summary 恒报「已探明敌军 0 支」（QA B8）。 */
export const EXPLORE_INTEL_PREFIX='explore-';
/** 季节传闻状态（第 5 轮）：传闻卡到案即挂、到期自解（advanceWorld 每步过滤）。
 *  旧存档没有这个字段——可选，validateSimulation 对 undefined 放行。 */
export interface SeasonalState {key:string;untilDay:number}
/** 当前是否挂着某条季节传闻（未到期）。纯查表，引擎/驿传两处共用同一口径。 */
export const seasonalActive=(s:{seasonal?:SeasonalState[];timeHours:number}|undefined,key:string)=>
 !!s?.seasonal?.some(x=>x.key===key&&x.untilDay>s.timeHours/24);
export interface Shipment {
  id:string; sourceCityId:string; targetArmyId:string; factionId:string;
  roadId:string; roadKm:number; targetKm:number; carriers:number;
  cargoKg:number; rationKg:number; waterAccessible:boolean;
  status:'travelling'|'waiting'|'delivered'|'captured'|'returning'|'returned';
  createdHour:number;
}
export interface SimulationState {
  version:1; mode:'local'; profile:RulesProfile; timeHours:number;
  playerFactionId:string; activeArmyIds:string[];
  armies:Record<string,ArmyModel>; cities:Record<string,CityModel>; roads:Record<string,Road>;
  shipments:Record<string,Shipment>; intelligence:Intelligence[];
  /** 在身的季节传闻（key=传闻卡 id，untilDay=到期日）。见 SeasonalState。 */
  seasonal?:SeasonalState[];
  pauseReason:string|null;
  /** ledger 是粮草与人口的收支账。initialFoodKg 含期间产出（accrueProvinceFood 会累加），
   *  所以要「开局存量」得用 initialFoodKg − producedKg。单列产出正是为此。 */
  ledger:{initialFoodKg:number;consumedKg:number;spoiledKg:number;producedKg:number;initialPeople:number;transportCaptured:number};
}
export interface EffectProposal {id:'route-familiarity';factor:number;roadId:string;durationHours:number;reason:string}
export interface SimulationCommand {
  commandId:string; expectedRevision:number; armyId:string; kind:OrderKind;
  targetCityId?:string; sourceCityId?:string; foodKg?:number;
  effects?:EffectProposal[];
}
export interface AdvanceCommand {commandId:string;expectedRevision:number;hours:number}
export interface CalculationTrace {
  rule:string;entityId:string;hours:number;inputs:Record<string,number|string>;result:Record<string,number|string>;
}
export interface SimulationReport {
  commandId:string;kind:'order'|'advance';advancedHours:number;pauseReason:string|null;
  rulesVersion:string; traces:CalculationTrace[]; summaries:string[];
  /** 本段推进跨过的史实锚点行（anchors.ts）。与 summaries 里的【史】行同源；单列一份
   *  是为了让跳转按结构汇总、界面按条目渲染，而不是去 parse 文本。 */
  history?:string[];
  /** 财政结算行（钱/民力/欠饷），由 treasury.settleFiscal 产出。advance 与 jump 两种推进
   *  口径都要填（B4：此前只有 jump 填，单次推进的 fiscal 面板永远是 0）。 */
  fiscal?:string[];
  /** 失败模式预警（哗变/断粮…），由 upheaval.assessUpheaval 产出；tier!=='notable' 的才在列。 */
  alarms?:{kind:string;subjectName:string;risk:number;reason:string;tier:string}[];
}
export const clamp=(value:number,min=0,max=100)=>Math.min(max,Math.max(min,value));
export const round=(value:number)=>Math.round(value*1e8)/1e8;
export function interpolate(a:Point,b:Point,t:number):Point{return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};}
