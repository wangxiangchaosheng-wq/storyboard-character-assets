import type {SimulationState,SimulationReport} from './simulation-types.js';
/** 世界状态 v1：独立契约。无网络、数据库或模型依赖。 */
export type Id = string;
export interface Point { x: number; y: number } // 地图内容区域的归一化坐标，均为 0..1
export type EntityRef =
  | { type: 'army'; id: Id }
  | { type: 'city'; id: Id }
  | { type: 'action'; id: Id };

export interface WorldClock {
  startLabel: string; // 例如“建兴六年 · 公元228年 · 春”，不伪造月日
  elapsedDays: number; // 非负整数；0 显示“推演第1日”
}

export interface Faction { id: Id; name: string; color: string }
export type ArmyLocation =
  | { kind: 'city'; cityId: Id }
  | { kind: 'route'; actionId: Id }
  | { kind: 'field'; point: Point; label: string };

export interface Army {
  id: Id;
  name: string;
  factionId: Id;
  commander: { id: Id; name: string }; // 只存引用与显示名；人格归队友维护
  troops: number; // 人，非负整数
  foodKg: number; // 千克，非负有限数；一局统一此单位
  morale: number; // 0..100；明确是模拟指标
  location: ArmyLocation;
  status: 'stationed' | 'marching' | 'besieging' | 'fighting' | 'resting' | 'destroyed';
}

export interface City {
  id: Id;
  name: string;
  kind: 'city' | 'pass';
  point: Point;
  ownerFactionId: Id;
  governor: { id: Id; name: string } | null;
  foodKg: number;
  defense: number; // 0..100，模拟指标
  // 不存 garrisonTroops：从 location.kind=city 的军队汇总，防止重复计数
}

export interface Action {
  id: Id;
  decisionId: Id;
  armyId: Id; // v1 一行动一军队；多军队协同用同一 decisionId 关联
  kind: 'march' | 'attack' | 'retreat' | 'resupply';
  origin: { cityId: Id | null; point: Point; label: string };
  target: { cityId: Id | null; point: Point; label: string };
  route: Point[]; // 至少两点，首尾须与 origin/target 一致；展示路径，非地理距离
  status: 'planned' | 'active' | 'completed' | 'failed' | 'cancelled';
  startedDay: number | null;
  estimatedArrivalDay: number | null; // 估计值，不自动触发到达或胜负
  endedDay: number | null;
  progress: number; // 0..1；只由已确认结算更新，不随浏览器时间增长
}

export interface Decision {
  id: Id;
  title: string;
  orderText: string;
  issuedDay: number;
  issuerId: Id;
  status: 'issued' | 'executing' | 'completed' | 'failed' | 'cancelled';
  related: EntityRef[];
}

export interface WorldSnapshot {
  simulation?: SimulationState;
  schemaVersion: 'world-state/v1';
  worldId: Id;
  scenarioId: Id;
  mapId: Id;
  revision: number; // 每个成功提交的结算 +1；不是经过天数
  clock: WorldClock;
  factions: Record<Id, Faction>;
  armies: Record<Id, Army>;
  cities: Record<Id, City>;
  actions: Record<Id, Action>;
  decisions: Record<Id, Decision>;
}

/** 只允许明确列出的操作，不接受模型输出的任意 JSON 路径写入。 */
export type Mutation =
  | { kind: 'resource.transfer'; resource: 'foodKg' | 'troops'; from: { type: 'army' | 'city'; id: Id }; to: { type: 'army' | 'city'; id: Id }; amount: number; reason: string }
  | { kind: 'army.adjust'; armyId: Id; troopsDelta?: number; foodKgDelta?: number; moraleDelta?: number; reason: string }
  | { kind: 'army.move'; armyId: Id; location: ArmyLocation; status: Army['status']; reason: string }
  | { kind: 'army.create'; army: Army; reason: string }
  | { kind: 'city.adjust'; cityId: Id; foodKgDelta?: number; defenseDelta?: number; reason: string }
  | { kind: 'city.capture'; cityId: Id; ownerFactionId: Id; governor: City['governor']; reason: string }
  | { kind: 'action.create'; action: Action; reason: string }
  | { kind: 'action.update'; actionId: Id; patch: Partial<Pick<Action, 'status' | 'progress' | 'startedDay' | 'estimatedArrivalDay' | 'endedDay'>>; reason: string }
  | { kind: 'decision.create'; decision: Decision; reason: string }
  | { kind: 'decision.update'; decisionId: Id; status: Decision['status']; reason: string };

/** 输入来自授权的裁判/编排层，绝不直接来自网页点击或用户自然语言。 */
export interface SettlementInput {
  settlementId: Id; // 幂等键：同一 worldId 内唯一
  expectedRevision: number;
  decisionId: Id | null; // 自然事件可为 null
  source: 'referee' | 'rules' | 'demo'; // 仅来源标签，不代表授权凭据
  elapsedDays: number; // 本次推进天数；0 表示同一模拟日
  title: string;
  summary: string; // 描述已确认结果，不用于反向解析数值
  mutations: Mutation[];
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export interface FieldChange {
  entity: EntityRef | { type: 'decision'; id: Id } | { type: 'clock'; id: Id };
  field: string;
  before: JsonValue;
  after: JsonValue;
  unit?: '人' | 'kg' | '分' | '日';
  reason: string;
}

/** 输出由状态模块根据实际修改生成，不能照抄裁判提交的前后值。 */
export interface WorldEvent {
  simulationReport?: SimulationReport;
  id: Id;
  worldId: Id;
  settlementId: Id;
  decisionId: Id | null;
  revision: number;
  fromDay: number;
  toDay: number;
  source: SettlementInput['source'];
  title: string;
  summary: string;
  related: EntityRef[];
  changes: FieldChange[];
}

export type ApplyResult = { ok: true; alreadyApplied: boolean; eventId: Id; appliedRevision: number; currentRevision: number };

export interface InitialWorldInput {
  initializationId: Id;
  snapshot: WorldSnapshot; // 新世界 revision=0；禁止用初始化覆盖已有对局
  basis: { kind: 'demo' | 'research' | 'mixed'; note: string };
}

/** 本地同步工具入口；HTTP 适配层负责异步传输。校验失败抛出 AgentError。 */
export interface WorldStateService {
  initializeWorld(worldId: Id, input: unknown): WorldSnapshot;
  getWorld(worldId: Id): WorldSnapshot | null;
  applySettlement(worldId: Id, input: unknown): ApplyResult;
  listEvents(worldId: Id, filter?: {
    decisionId?: Id;
    entityId?: Id;
    afterRevision?: number;
    limit?: number;
  }): WorldEvent[];
}
