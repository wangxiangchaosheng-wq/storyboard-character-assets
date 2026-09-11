// 领域无关的通用「多智能体推演 / 剧本杀」引擎 —— 核心类型定义
//
// 重要声明：本文件及整个 src/ 均为全新原创实现，仅借鉴《历史模拟器：崇祯》所展示的
// *设计思想*（立场驱动冲突、多智能体辩论、执行衰减、记忆分层、回合状态机），
// 不包含任何被分析产品的源码、提示词或资源。
//
// 本版本把「数值系统」提升为引擎中心：规则如何改变数值、数值如何反馈给大模型、
// 如何让 AI / 开发者快速搭起一套数值与剧本，全部以领域无关的方式建模。

export type Domain = 'history' | 'business' | 'emotion' | 'custom';

export type Stance = string; // 立场 / 动机标签，由领域自定义

export interface Traits {
  competence: number; // 能力 0-100
  loyalty: number;    // 忠诚 0-100
  ambition: number;   // 野心 0-100
  power: number;      // 势力 / 话语权 0-100
}

// 引擎的原子单位：一个角色智能体（对应原版 MinisterResponse，但剥离了特定历史字段）
export interface Persona {
  id: string;
  name: string;
  role: string;          // 身份 / 职位
  stance: Stance;        // 立场 / 动机（冲突的根源）
  influence: number;     // 发言分量权重
  description: string;   // 背景简介
  prompt: string;        // 私有人设 system prompt（核心）
  traits: Traits;
  isPlayerCreated?: boolean;
}

// 议题 / 案件 / 冲突（对应原版 talk-task）
export interface Scenario {
  title: string;
  background: string;    // 背景设定
  conflict: string;      // 核心矛盾（驱动辩论）
  participants: string[];// 入局角色 id（至少 2 个对立立场）
  rounds: number;        // 建议辩论轮数
  decisionPoint: string; // 玩家最终要做的裁决 / 选择
  successCriteria: string;
}

// 每一轮要辩论的子议题
export interface TalkTask {
  round: number;
  topic: string;
  context: string;
}

// ---------------- 数值系统 ----------------

// 一个数值指标的定义（领域无关）。引擎只认这个结构。
export interface MetricDef {
  key: string;           // 程序内键名（英文/拼音均可），如 treasury / 民心
  label: string;         // 展示名
  min: number;
  max: number;
  start: number;         // 初始值
  unit?: string;
  higherIsBetter: boolean; // 越大越好还是越小越好（用于反馈/评分）
  description?: string;  // 含义说明（给 LLM 与人类看）
}

// 某一时刻的全部数值
export type State = Record<string, number>;

// 一次数值变动（带来源与理由 —— 这是「规则→大模型→反馈」链路的可见凭证）
export interface Delta {
  key: string;     // 指标 key
  amount: number;  // 变动量，正=增加
  reason: string;  // 来源说明（给人类与大模型看）
  source: string;  // 触发它的规则 id / 阶段（drift / reaction / decision / threshold）
}

// 规则种类：
//  drift    —— 被动漂移：每回合确定性地改变数值（如"每季开销扣财政"）。
//  reaction —— 反应：由大模型在结算时，依据规则描述与幅度上限，结合剧情算出变动。
//  threshold—— 阈值：当某指标越过边界时触发事件（不改动数值，只发信号）。
export type RuleKind = 'drift' | 'reaction' | 'threshold';

export interface RuleDef {
  id: string;
  kind: RuleKind;
  label: string;
  description: string;          // 人类 / 大模型可读：这条规则在描述什么因果
  appliesTo?: string[];         // 涉及的指标 key（用于提示大模型 / 校验）
  // —— drift 用 ——
  target?: string;              // 单目标指标 key
  formula?: string;             // 安全算术表达式，可引用其他指标；产出该指标的本回合增量
  effect?: (state: State) => Record<string, number>; // 开发者便捷写法（可同时改多个指标）
  // —— reaction 用 ——
  bounds?: number | Record<string, number>; // 该规则对指标的最大变动绝对值；可按指标分别设上限
  // —— threshold 用 ——
  metric?: string;
  op?: '>=' | '<=' | '>' | '<' | '==';
  value?: number;
  fires?: string;               // 触发时的说明 / 事件文案
}

// 阈值触发记录
export interface ThresholdEvent {
  ruleId: string;
  metric: string;
  value: number;
  label: string;
  note: string;
}

// 完整可运行定义：一份 spec = 数值体系 + 规则 + 角色 + 剧本。
// 这是「快速搭建」的载体：开发者 / AI 写一份 spec，引擎即可跑。
export interface ScenarioSpec {
  domain: Domain;
  title: string;
  scenario: Scenario;
  cast: Persona[];
  metrics: MetricDef[];
  rules: RuleDef[];
  seedEvents?: string[];        // 可选开局事件（流程化约束的初始扰动）
  rounds: number;
  /** 数值溯源（docs/01 §6）：每条指标的数值「从哪找真实」——出处/检索路径/估算链 */
  provenance?: ProvenanceNote[];
  /** 公式推导（docs/01 §6）：每条规则为何是这个公式——推导依据/证据 */
  derivations?: DerivationNote[];
  /** 公式审核记录（审校司/确定性校验产出；引擎内部保留，不对用户下发公式原文） */
  formulaAudit?: FormulaAudit[];
}

/** 指标数值的数据来源说明（AI 动态产出；离线兜底给「估算链」） */
export interface ProvenanceNote {
  metric: string;          // 对应 metrics[].key
  source: string;          // 真实数据来源：出典 / 史料 / 统计口径
  how: string;             // 怎么查：检索入口与关键词 / 计算方式
  estimate?: string;       // 无直接记录时的估算链条（含假设）
}

/** 规则公式的推导说明（AI 动态产出；离线兜底给「依据」） */
export interface DerivationNote {
  ruleId: string;          // 对应 rules[].id
  formula?: string;        // 落地后的表达式（引擎内部；可选 = 已走对外脱敏视图）
  why: string;             // 推导过程：为什么是这个公式
  ref?: string;            // 依据的事实 / 史料/ 场景设定
}

/** 公式审核结论（agent 复核「公式是否合理」；对外不下发公式原文，只出结论） */
export interface FormulaAudit {
  ruleId: string;          // 被审规则
  ok: boolean;             // 能否通过理性复核
  issues: string[];        // 人话问题说明（不包含公式原文）
  source: 'rule' | 'llm';  // rule=确定性校验；llm=审校司裁定
}

// 结算结果（叙事 + 数值变动 + 阈值事件）
export interface Settlement {
  narrative: string;            // 执行衰减后的叙事
  factors: { trait: keyof Traits; value: number; effect: string }[];
  deviation: number;            // 执行偏差 0-1（越大越失真）
  deltas: Delta[];              // 本局所有数值变动
  thresholds: ThresholdEvent[]; // 触发的阈值事件
}

export interface Utterance {
  speaker: string;       // persona id 或 'host' / 'player'
  speakerName: string;
  content: string;
  stance?: Stance;
  round: number;
}

export interface Decision {
  text: string;          // 玩家裁决原文
  intent: string;        // 提炼后的意图
}

export interface RoundReport {
  round: number;
  task: TalkTask;
  utterances: Utterance[];
  summary: string;
  stateBefore: State;    // 本轮辩论前的数值
  stateAfter: State;     // 本轮漂移后的数值
  driftDeltas: Delta[];  // 本轮漂移产生的变动
}

export interface SimulationResult {
  spec: ScenarioSpec;
  scenario: Scenario;
  cast: Persona[];
  rounds: RoundReport[];
  decision: Decision;
  settlement: Settlement;
  finalMetrics: State;
  stateTrajectory: { round: number; state: State }[]; // 含 round=0（初始）与终局
  transcript: string;
}

// ---- LLM 抽象 ----
export interface LLMMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface ChatOptions {
  temperature?: number;
  maxTokens?: number;
  stream?: boolean;
}

export interface LLMProvider {
  readonly name: string;
  isReal(): boolean; // false = 规则 / mock 提供；true = 真实 LLM
  chat(messages: LLMMessage[], opts?: ChatOptions): Promise<string>;
}

export type PlayerDecide = (decisionPoint: string) => Promise<Decision>;
