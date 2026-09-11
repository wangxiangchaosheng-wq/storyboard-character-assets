/**
 * 游戏回合 DTO（docs/02 §3 + docs/05 §3 收敛真源）。
 * 服务端把引擎内部结构投影成这些稳定形状；前端只认这里。
 * 引擎类型仍以 @sim/engine-core 为准；本文件只管「对外接口形态」。
 */

/** 一局的状态机（服务端会话视角） */
export type SessionStatus = 'pending' | 'awaiting' | 'running' | 'final';

/** 指标条目标题/区间信息（画条用） */
export interface MetricRange {
  key: string;
  min: number;
  max: number;
  label?: string;
}

/** 单条辩论发言 */
export interface DebateLine {
  speaker: string;
  name: string;
  content: string;
  stance?: string;
}

// ---------- 对话式推演（聊天模型） ----------

/** 一条聊天消息（对外投影；服务端存档 + SSE 复用） */
export interface ChatMessage {
  id: string;
  kind: 'system' | 'narrator' | 'player' | 'agent' | 'result' | 'event';
  /** agent 消息：对应 persona id */
  from?: string;
  name?: string;          // 显示名（agent = 人名；narrator/result = 角色标签）
  stance?: string;
  /** player 消息：true = 文策（诏令/改令，结算落定）；false/缺省 = 廷议问策（仅对话） */
  act?: boolean;
  text: string;
  deltas?: GameDelta[];   // result 消息的数值变动
  at: number;             // epoch ms
}

/** 动态机制：由本局 spec 派生（身份机制 + 规则机制），随对局不同而不同 */
export interface Directive {
  key: string;
  kind: 'consult' | 'decree' | 'countersign';
  label: string;
  hint: string;
  personaId?: string;     // consult：被询问的角色
}

/** POST /api/games/:id/message —— 玩家一条对话/一道诏令 */
export interface MessageReq {
  text: string;
  /** 发向指定角色（无 = 全体在场） */
  to?: string;
  /** true = 下诏执行（结算数值）；false = 问策（仅对话） */
  act?: boolean;
}

/** 一条对话的结果：新增消息 + 状态快照 */
export interface MessageReply {
  gameId: string;
  turn: number;              // 已结算诏令数（无上限）
  status: SessionStatus;
  messages: ChatMessage[];
  state: Record<string, number>;
  ended?: EndingView;
}

/** 数值漂移/结算变动（同 engine Delta 形状，避免前端引引擎） */
export interface GameDelta {
  metric: string;
  by: number;
  why: string[];
}

/** 一回合的对外快照（docs/02 TurnView 最小集） */
export interface TurnView {
  turn: number;
  title: string;                       // 本回合议题
  lines: DebateLine[];
  summary: string;                     // 会议摘要
  stateBefore: Record<string, number>;
  stateAfter: Record<string, number>;
  driftDeltas: GameDelta[];            // 规则漂移（辩论后、裁决前）
  decided?: {
    intent: string;
    narrative: string;                 // 执行衰减叙事
    deviation: number;                 // 0..1
    deltas: GameDelta[];               // 结算数值变动
    deviations: string[];              // 偏差来源
  };
}

/** GET /api/games/:id/state —— 局级对外真值（含对话流；无固定轮数上限） */
export interface GameView {
  gameId: string;
  specId: string;
  title: string;
  player: string;
  kind: 'history' | 'business' | 'emotion' | 'custom' | string;
  status: 'pending' | 'awaiting' | 'running' | 'final';
  turn: number;                        // 已结算诏令数（无上限）
  state: Record<string, number>;
  metrics: MetricRange[];
  directives: Directive[];             // 本局动态机制
  chat: ChatMessage[];                 // 全量对话
  endedAt?: string;
}

/** 玩家可选行动（docs/02 §外部输入槽被 03 裁判装修后的选项） */
export interface GameOption {
  key: string;
  title: string;
  intent: string;   // 进 Decision.intent 的提炼意图
  hint: string;     // 提示文案（效果方向）
  affects: string[]; // 影响的指标名
}

/** GET /api/games/:id/options */
export interface OptionsView {
  gameId: string;
  turn: number;       // 当前待裁决回合
  status: SessionStatus;
  options: GameOption[];
}

/** GET /api/games/:id/player-view —— 04 投影：只暴露公开历史 + 选项 */
export interface PlayerView {
  gameId: string;
  title: string;
  turn: number;
  status: SessionStatus;
  log: HistoryEntry[];
  options: GameOption[];
}

/** 历史条目（公开）—— 统一渲染卡片用 */
export interface HistoryEntry {
  turn: number;
  kind: 'debate' | 'drift' | 'decision' | 'settle' | 'ending';
  title: string;
  text: string;
  deltas?: GameDelta[];
}

/** GET /api/games/:id/storyboard —— 时间线锚点 */
export interface StoryView {
  beats: { turn: number; title: string; summary: string }[];
}

/** GET /api/games/:id/ending —— 终局判定 */
export interface EndingView {
  gameId: string;
  verdict: 'victory' | 'defeat' | 'open';
  title: string;
  narrative: string;
  metrics: Record<string, number>;
}

// ---------- 请求 ----------

/** POST /api/games */
export interface CreateGameReq {
  specId: string;
  player: string;
}

/** POST /api/games/:id/decide */
export interface DecideReq {
  option: string;      // GameOption.key
  /** 可选：玩家自由输入文本（替代选项） */
  text?: string;
}