import type {Point} from './world-contracts.js';

export type OrderKind = 'march'|'forced-march'|'garrison'|'resupply'|'attack'|'besiege'|'retreat';
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
}
export interface CityModel {
  residents:number; transportAvailable:number; initialResidents:number;
  waterAccessible:boolean; blockadeBy:string[]; gateOpen:boolean;
}
export interface Intelligence {
  observerFactionId:string; enemyArmyId:string; seenHour:number;
  atCityId:string|null; roadId:string|null; roadKm:number; estimatedTroops:number;
}
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
  pauseReason:string|null;
  ledger:{initialFoodKg:number;consumedKg:number;spoiledKg:number;initialPeople:number;transportCaptured:number};
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
}
export const clamp=(value:number,min=0,max=100)=>Math.min(max,Math.max(min,value));
export const round=(value:number)=>Math.round(value*1e8)/1e8;
export function interpolate(a:Point,b:Point,t:number):Point{return{x:a.x+(b.x-a.x)*t,y:a.y+(b.y-a.y)*t};}
