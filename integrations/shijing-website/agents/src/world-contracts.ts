import type {SimulationState,SimulationReport} from './simulation-types.js';
import type {PoliticalState} from './politics.js';
import type {DiplomaticState} from './diplomacy.js';
import type {FiscalState} from './treasury.js';
import type {FocusState} from './focuses.js';
import type {TechState} from './techs.js';
export type {PoliticalState,DiplomaticState,FiscalState,FocusState,TechState};
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

/**
 * 省：战略层唯一空间单位。聚合层，不替代城池/道路/军队。
 * ownerFactionId 必须与治所一致；产出底数恒定，加成% 由经济层另行接入。
 */
export type ProvinceMode = 'unset' | 'colonize' | 'conscript' | 'horse' | 'workshop' | 'commerce';
export interface Province {
  id: Id;
  name: string;
  seatCityId: Id;
  memberCityIds: Id[];
  ownerFactionId: Id;
  governor: { id: Id; name: string } | null;
  /** 治政模式槽；同省同时只生效一个 */
  mode: ProvinceMode;
  /** 玩家的年度方针原话；逐字入档，供 AI 大臣与史官使用 */
  policy: string | null;
  agriculture: number;
  commerce: number;
  /** 兵役底数：有人口的省由「人口 × levyRate」导出，见 province.ts buildProvinces */
  manpower: number;
  specialties: string[];
  source: string;
  /** 真实户口（史实，见 province.ts 的口径说明）。旧存档没有它。 */
  census?: { households: number; population: number; source: string };
  /** 可征召率：显式参数而非隐藏常数——「凉州近一成、扬州不足二成之一」是设计而非巧合 */
  levyRate?: number;
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

/**
 * 剧本题目的终局条件。由 buildInitialWorld 按剧本注入，之后不被修改。
 *
 * 为什么不用「统一十二城」当唯一终局：本剧本只有一个可扩张方向（汉中→长安）、又没有攻城
 * 器械，玩家实际打不到统一。于是三种打法全部玩到「推不动」为止，从未见过收尾——实测反馈
 * 里玩家最大的困惑就是「我到底打完了吗？这游戏怎么结束？」。按剧本建议年数收尾，才让
 * 「一局」有明确边界；统一/覆灭仍是更高优先级的判据，先于它。
 */
export interface ScenarioGoal {
  /** 剧本建议玩的年数（来自 ScenarioPreset.targetYears） */
  years: number;
  /** 一句话说明这一局争的是什么，收尾时回显给玩家 */
  premise: string;
}

export interface WorldSnapshot {
  simulation?: SimulationState;
  schemaVersion: 'world-state/v1';
  worldId: Id;
  scenarioId: Id;
  mapId: Id;
  /** 可选：本剧本题目的终局条件。旧存档没有它，读取时按「只有统一/覆灭两条判据」处理。
   *  为什么需要：实测三种打法都到不了原有终局（统一十二城或尽失州郡），因为本剧本只有一个
   *  可扩张方向且没有攻城器械——玩家玩到「推不动」为止，从未见过收尾。 */
  scenarioGoal?: ScenarioGoal;
  /** 开局时本方掌控的城池 id。史官的「初始国力」要用它，不能按记事时点的当前归属数——
   *  后者会把「打下来多少」算成「开局有多少」。旧存档没有它，读取时按当前归属兜底。 */
  openingCities?: Id[];
  /** 本局实际使用的史实时间线（锚点）。**必须跟着剧本年份走**：228 年北伐的 36 条锚点
   *  不能喂给一个公元 200 年官渡的议题——玩家会在官渡开局第二天收到「街亭之败」的新闻。
   *  旧存档没有它，读取时回落 HISTORY_ANCHORS 并按起始年份过滤。 */
  anchors?: import('./anchors.js').HistoryAnchor[];
  /** 起始公元年份，供时间线过滤与「这是哪个时代」回显用。 */
  startYear?: number;
  /** 待主上决策的历史事件（decisions.ts）。非 null 时推进与军令一律拒绝——先决此事，再议军行。 */
  pendingDecision?: { eventId: Id; day: number };
  /** 已决事件：eventId → choiceId，起居注与策略库据此还原玩家当时选了什么。 */
  resolvedDecisions?: Record<Id, Id>;
  revision: number; // 每个成功提交的结算 +1；不是经过天数
  clock: WorldClock;
  factions: Record<Id, Faction>;
  armies: Record<Id, Army>;
  cities: Record<Id, City>;
  /** 可选：旧存档没有省层，读取时按无省处理，不阻断推演。 */
  provinces?: Record<Id, Province>;
  /** 可选：旧存档没有派系层，读取时按无派系处理。 */
  politics?: PoliticalState;
  /** 可选：旧存档没有外交层，读取时按无外交处理。 */
  diplomacy?: DiplomaticState;
  /** 可选：旧存档没有国库，读取时按无国库处理。 */
  fiscal?: FiscalState;
  /** 可选：旧存档没有国策层（政治点国策），读取时按无国策处理。 */
  focuses?: FocusState;
  /** 可选：旧存档没有科技层（科技树），读取时按无科技处理。 */
  techs?: TechState;
  /** 脑洞决策卡：LLM 从当前局势读出的「如果…」岔路。旧存档没有就为空。 */
  whatIfs?: import('./whatif.js').WhatIfCard[];
  /** 上一次派脑洞卡的日子（30 日冷却，别刷成广告）。 */
  whatIfsDay?: number;
  /** 在途驿报：已发生、但还没送到御前的决策卡与新闻。古代没有电报——
   *  事情在第 N 天发生，主上要到第 N + 驿传天数才知道。旧存档没有就为空。 */
  incomingEvents?: import('./courier.js').IncomingEvent[];
  /** 在途诏令：主上（或太尉）已下、但还没到军中的军令。军中在道，令也在道。 */
  pendingEdicts?: import('./courier.js').PendingEdict[];
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
