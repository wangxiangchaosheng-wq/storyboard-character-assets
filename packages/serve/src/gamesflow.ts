/**
 * 对话式推演适配层（docs/02 §3 + docs/05 §3 聊天模型重构）：
 * 不再有「固定总轮数」—— 玩家与角色 agent 直接对话，点名问策或当廷下诏。
 * 建局即展开朝局（史官开场 + 群臣各自陈情），随后每次 POST /message 推进一段对话：
 *   - 问策（act=false）：指定角色（未指定则立场冲突双方）回应；
 *   - 下诏（act=true）：整诏落入结算：先规则漂移 → 再反应规则数值 + 阈值事件 → 诏令数 +1；
 *   - 终局：玩家主动退朝（POST /end）才定局；若不退朝，对话可以无限延续（无轮数上限）。
 * 全部 LLM 交互走 @sim/engine-core；会话持久化：kv（state/memory/chat）+ games 行投影。
 */
import type { ChatProvider } from '@sim/llm';
import type {
  ScenarioSpec, State, Persona, LLMProvider, LLMMessage, MemoryBank,
  Utterance, Tool, TalkTask,
} from '@sim/engine-core';
import {
  createState, formatState, applyDrift, applyDeltas, initMemory,
  computeSettlement, askPersona, deriveDirectives, talkTaskFor,
  runDebateRound, validateSpec,
} from '@sim/engine-core';
import { FeasibilityEngine } from '@sim/engine-core';
import type { DirectivePlan } from '@sim/engine-core';
import type { ChatMessage, GameDelta, GameView, Directive, EndingView, MessageReq } from '@sim/contracts';
import { AppError, ERROR_CODES } from '@sim/contracts';
import type { Store } from './store.ts';
import { kvSet, kvGet, appendTurn, getTopic } from './store.ts';
import type { SearchProvider } from '@sim/llm';

// ---------- 会话活性态（内存 + kv 持久化） ----------

export interface SessionRuntime {
  gameId: string;
  specId: string;          // topics 行的 id（spec 的引出键）
  spec: ScenarioSpec;      // 运行时引用（不落 kv；loadRt 以参数重建）
  player: string;
  state: State;
  initialState: State;     // 终局得分基准
  turn: number;            // 已结算诏令数（无上限）
  chat: ChatMessage[];     // 全量对话（system/agent/player/result/event）
  seq: number;             // 消息序号（自增 id）
  memory: MemoryBank;
  status: 'awaiting' | 'final';
  endedAt: number | null;
  search?: SearchProvider; // 考据司搜索结果（可选，供可行性检查使用）
  prevNarrative?: string;  // 上一回合的决策落定叙事（供下轮廷议参考）
  prevState?: State;       // 上一回合结束时的数值快照
}

const RT_KEY = (id: string) => 'game:rt:' + id;
const ENDING_KEY = (id: string) => 'game:ending:' + id;
const MEM_HISTORY_CAP = 32;
const MEM_DIGEST_LEN = 200;

/** 从 topics 表恢复考据司产出（史实/估算条目），供可行性引擎使用。 */
export function getTopicFill(store: Store, specId: string): { claims: string[] } | undefined {
  const row = getTopic(store, specId);
  if (!row?.fill) return undefined;
  try {
    const fill = JSON.parse(row.fill) as { facts?: Array<{ claim: string }> } | undefined;
    return { claims: (fill?.facts ?? []).map((f) => f.claim) };
  } catch {
    return undefined;
  }
}

/** ChatProvider → engine LLMProvider 适配（消息结构同构，仅类型不同）。 */
export function asLlm(chat: ChatProvider): LLMProvider {
  return {
    name: chat.name,
    isReal: () => chat.isReal(),
    chat: (messages: LLMMessage[], opts?: { maxTokens?: number }) =>
      chat.generate(
        messages.map((m) => ({ role: m.role, content: m.content })),
        { jsonMode: false, maxTokens: opts?.maxTokens },
      ),
  };
}

// ---------- 消息工具 ----------

function makeMsg(
  rt: SessionRuntime,
  kind: ChatMessage['kind'],
  text: string,
  extra: Partial<ChatMessage> = {},
): ChatMessage {
  const id = 'm' + (rt.seq + 1);
  rt.seq += 1;
  return { id, kind, text, at: Date.now(), ...extra } as ChatMessage;
}

/** 引擎 Delta → 对外 GameDelta（reason 并入 why）。 */
export function toDelta(d: { key: string; amount: number; reason?: string }): GameDelta {
  return { metric: d.key, by: d.amount, why: d.reason ? [d.reason] : [] };
}

/** 从最近对话中截一段「朝议笔录」作结算摘要（不灌整段上下文）。 */
function recentDiscourse(rt: SessionRuntime, n = 10): string {
  return rt.chat
    .filter((m) => m.kind === 'player' || m.kind === 'agent')
    .slice(-n)
    .map((m) => (m.kind === 'player' ? '主上：' : (m.name ?? '臣') + '（' + (m.stance ?? '') + '）：' + m.text))
    .join('\n');
}

// ---------- 角色工具（真实 LLM 才可调用；mock 路径经 isReal 门控不触碰） ----------

function buildTools(rt: SessionRuntime): Tool[] {
  return [
    {
      name: 'view_state',
      description: '查看当前朝局各项数值（如民户、兵额、岁入等），掌握真实家底后再表态',
      run: async () => formatState(rt.state, rt.spec.metrics),
    },
    {
      name: 'inspect_recent',
      description: '翻阅最近几则朝议笔录（主上与同僚发言），以接住前文、回应他人',
      run: async (args: Record<string, unknown>) => {
        const n = Math.min(10, Math.max(1, Number(args?.n ?? 5) || 5));
        return recentDiscourse(rt, n);
      },
    },
  ];
}

/** 层级记忆：把一轮廷议写回记忆 —— 按发言者各自摘录自己的话，
 *  而不是给全员塞同一条；角色在后续回合只带回与自己相关的记忆。 */
function absorbUtterances(memory: MemoryBank, cast: Persona[], utterances: Utterance[]): MemoryBank {
  const out: MemoryBank = { ...memory };
  for (const u of utterances) {
    const p = cast.find((c) => c.id === u.speaker);
    if (!p) continue;
    const mem = out[u.speaker] ?? { longTerm: p.prompt, currentTurn: [], history: [] };
    const digest = `${u.speakerName}（${u.stance ?? ''}）：${u.content.slice(0, MEM_DIGEST_LEN)}…`;
    out[u.speaker] = { ...mem, history: [...(mem.history ?? []), digest].slice(-MEM_HISTORY_CAP) };
  }
  return out;
}

// ---------- 持久化 ----------

function saveRt(store: Store, rt: SessionRuntime): void {
  kvSet(store, RT_KEY(rt.gameId), {
    state: rt.state,
    initialState: rt.initialState,
    turn: rt.turn,
    chat: rt.chat,
    seq: rt.seq,
    memory: rt.memory,
    player: rt.player,
    status: rt.status,
    endedAt: rt.endedAt,
    prevNarrative: rt.prevNarrative,
    prevState: rt.prevState,
  });
}

function normalizeMemory(memory: MemoryBank | undefined, cast: Persona[]): MemoryBank {
  const out: MemoryBank = { ...(memory ?? {}) };
  for (const p of cast) {
    if (!out[p.id]) {
      out[p.id] = { longTerm: p.prompt, currentTurn: [], history: [] };
    }
  }
  return out;
}

function loadRt(store: Store, spec: ScenarioSpec, specId: string, gameId: string, search?: SearchProvider): SessionRuntime {
  const base = kvGet(store, RT_KEY(gameId)) as
    | {
        state?: State; initialState?: State; turn?: number; chat?: ChatMessage[];
        seq?: number; memory?: MemoryBank; player?: string;
        status?: SessionRuntime['status']; endedAt?: number | null;
        search?: SearchProvider;
        prevNarrative?: string;
        prevState?: State;
      }
    | undefined;
  return {
    gameId,
    specId,
    spec,
    player: base?.player ?? '',
    state: base?.state ?? createState(spec.metrics),
    initialState: base?.initialState ?? createState(spec.metrics),
    turn: base?.turn ?? 0,
    chat: base?.chat ?? [],
    seq: base?.seq ?? 0,
    memory: normalizeMemory(base?.memory, spec.cast),
    status: base?.status ?? 'awaiting',
    endedAt: base?.endedAt ?? null,
    search: base?.search ?? search,
    prevNarrative: base?.prevNarrative,
    prevState: base?.prevState,
  };
}

// ---------- 建局 / 对话 / 下诏 ----------

function openingNarrative(spec: ScenarioSpec): string {
  const L: string[] = [];
  L.push('朝议如昨，今晨开奏。');
  L.push(spec.scenario.background);
  L.push(spec.scenario.conflict);
  if (spec.seedEvents?.length) L.push('开局即临：' + spec.seedEvents.join('；'));
  L.push('『' + spec.scenario.decisionPoint + '』');
  return L.join('\n');
}

/** 建局：初始状态 + 史官开场 + 全员一轮廷议（后发言者接住前文，而非各说各话）。 */
export async function startSession(
  store: Store,
  llm: LLMProvider,
  spec: ScenarioSpec,
  specId: string,
  gameId: string,
  player: string,
  search?: SearchProvider,
): Promise<SessionRuntime> {
  const rt: SessionRuntime = {
    gameId,
    specId,
    spec,
    player,
    state: createState(spec.metrics),
    initialState: createState(spec.metrics),
    turn: 0,
    chat: [],
    seq: 0,
    memory: initMemory(spec.cast),
    status: 'awaiting',
    endedAt: null,
    search,
  };

  rt.chat.push(makeMsg(rt, 'system', openingNarrative(spec), { name: '史官' }));

  // 开局廷议：全员按影响力顺序轮流入场，真实 LLM 能看到前一位发言并可调用工具查看朝纲（真实家底）
  const task = talkTaskFor(spec, 1);
  const stateBlock = formatState(rt.state, spec.metrics);
  const utterances = await runDebateRound(spec.cast, task, llm, rt.memory, {
    stateBlock,
    passes: 2, // 表态 + 交锋：全员针对对立立场回应，真正的廷议对弈
    tools: llm.isReal() ? buildTools(rt) : undefined,
  });
  for (const u of utterances) {
    rt.chat.push(makeMsg(rt, 'agent', u.content, { from: u.speaker, name: u.speakerName, stance: u.stance }));
  }
  rt.memory = absorbUtterances(rt.memory, spec.cast, utterances);

  saveRt(store, rt);
  // 开局即留第 0 帧：指标走势的起点（否则曲线少一个锚点）
  appendTurn(store, gameId, 0, {
    state: rt.state,
    narrative: '开局 · ' + spec.title + ' —— 群臣入朝，廷议初开。',
    at: Date.now(),
  });
  return rt;
}

function assertPersona(rt: SessionRuntime, personaId: string | undefined): void {
  if (!personaId) return;
  if (!rt.spec.cast.some((p) => p.id === personaId)) {
    throw new AppError(ERROR_CODES.BAD_INPUT, '朝中并无「' + personaId + '」此人');
  }
}

function pushMemory(memory: MemoryBank, cast: Persona[], entry: string): MemoryBank {
  const out: MemoryBank = { ...memory };
  for (const p of cast) {
    const mem = out[p.id] ?? { longTerm: p.prompt, currentTurn: [], history: [] };
    out[p.id] = { ...mem, history: [...(mem.history ?? []), entry].slice(-MEM_HISTORY_CAP) };
  }
  return out;
}

/** 玩家一条消息：问策（对话）或下诏（结算数值）。返回会话与新增消息。 */
export async function handleMessage(
  store: Store,
  llm: LLMProvider,
  spec: ScenarioSpec,
  specId: string,
  gameId: string,
  req: MessageReq,
  search?: SearchProvider,
): Promise<{ rt: SessionRuntime; added: ChatMessage[] }> {
  const rt = loadRt(store, spec, specId, gameId, search);
  if (rt.status === 'final') {
    throw new AppError(ERROR_CODES.INVALID_ACTION, '本局已定谶，兵销人散');
  }
  const text = (req.text ?? '').trim();
  if (!text) {
    throw new AppError(ERROR_CODES.BAD_INPUT, '消息内容不可为空');
  }
  assertPersona(rt, req.to);
  if (text.length > 800) {
    throw new AppError(ERROR_CODES.BAD_INPUT, '一言尽意，单条消息请勿超过 800 字');
  }

  const playerMsg = makeMsg(rt, 'player', text, { act: req.act ?? false });
  rt.chat.push(playerMsg);
  const added: ChatMessage[] = [playerMsg];

  if (req.act) {
    // ---- 下诏：先让群臣就这道诏令廷议一轮（后发言者接前文），再规则漂移、再结算 ----
    const tools = llm.isReal() ? buildTools(rt) : undefined;
    // 注入上一回合的决策落定叙事和数值变化，让本轮廷议有上下文
    const prevContext = rt.prevNarrative
      ? `\n【上回合政令落定】${rt.prevNarrative.slice(0, 400)}`
      : '';
    const prevStat = rt.prevState
      ? `\n【上回合终局数值】民户${rt.prevState['m1']?.toFixed(0)}万/岁入${rt.prevState['m3']?.toFixed(0)}万两/粮储${rt.prevState['m2']?.toFixed(0)}万石/兵额${rt.prevState['m4']?.toFixed(0)}万`
      : '';
    const decreeTask: TalkTask = {
      round: rt.turn + 1,
      topic: `主上下诏：「${text.slice(0, 30)}」—— 群臣既奉诏命，先论可否得失。`,
      context: `主上（玩家）刚颁布诏令：「${text}」\n此诏关乎朝局，诸臣议论后交由主上裁决落地。${prevContext}${prevStat}`,
    };
    const stateBlock = formatState(rt.state, spec.metrics);
    const council = await runDebateRound(spec.cast, decreeTask, llm, rt.memory, {
      stateBlock,
      passes: 2, // 表态 + 交锋
      tools,
      questionSeed: text, // 让 mock 就诏令原话对答，而非复读老台词
    });
    for (const u of council) {
      const m = makeMsg(rt, 'agent', u.content, { from: u.speaker, name: u.speakerName, stance: u.stance });
      rt.chat.push(m);
      added.push(m);
    }
    rt.memory = absorbUtterances(rt.memory, spec.cast, council);

    // 时势自然脉动（规则漂移），再进入执行结算
    const driftDeltas = applyDrift(rt.state, spec.rules, spec.metrics);
    const drifted = applyDeltas(rt.state, driftDeltas, spec.metrics);
    const debateSummary = recentDiscourse(rt);

    // 可行性检查：下诏决策前检索史实，评估是否可行
    let feasibilityMsg: ChatMessage | undefined;
    if (rt.search) {
      try {
        const fe = new FeasibilityEngine(rt.search, llm);
        const feResult = await fe.assess(
          { text, intent: text },
          spec.cast,
          drifted,
          spec.metrics,
          spec.scenario,
          spec.rules,
          debateSummary,
          spec.title,
        );
        if (!feResult.feasible) {
          feasibilityMsg = makeMsg(rt, 'event',
            `【可行性警示】${feResult.level}（置信度 ${Math.round(feResult.confidence * 100)}%）`
            + `：${feResult.reasoning}`
            + (feResult.rejectionReason ? `。${feResult.rejectionReason}` : '')
            + (feResult.suggestion ? `。建议：${feResult.suggestion}` : ''),
            { name: '史官' });
          rt.chat.push(feasibilityMsg);
          added.push(feasibilityMsg);
        }
      } catch {
        // 可行性检查失败不阻塞游戏流程
      }
    }

    const { settlement, stateAfter } = await computeSettlement(
      llm, spec.metrics, spec.rules, drifted, spec.scenario, spec.cast,
      { text, intent: text },
      debateSummary,
    );

    const deltas = [...driftDeltas, ...settlement.deltas].map(toDelta);
    const msg = makeMsg(rt, 'result', settlement.narrative, { name: '政令颁行', deltas });
    rt.chat.push(msg);
    added.push(msg);
    for (const t of settlement.thresholds) {
      const ev = makeMsg(rt, 'event', t.note, { name: '烽火' });
      rt.chat.push(ev);
      added.push(ev);
    }

    rt.state = stateAfter;
    rt.turn += 1;
    // 保存上一回合的叙事和数值快照，供下轮廷议引用
    rt.prevNarrative = settlement.narrative;
    rt.prevState = { ...rt.state };
    rt.memory = pushMemory(rt.memory, spec.cast,
      '命令' + rt.turn + '「' + text.slice(0, 60) + '」：' + settlement.narrative);
    saveRt(store, rt);
    // 每道诏令落定即存一帧快照：指标波形 / 时势时间线 / 复盘全靠它
    appendTurn(store, rt.gameId, rt.turn, {
      state: rt.state,
      deltas,
      narrative: settlement.narrative,
      at: Date.now(),
    });
    return { rt, added };
  }

  // ---- 问策：只对话，改动数值的一律走上面 ----
  const stateBlock = formatState(rt.state, spec.metrics);
  const task = talkTaskFor(spec, rt.turn + 1);
  const replies = await askPersona(spec.cast, req.to, task, llm, rt.memory, text, stateBlock, {
    tools: llm.isReal() ? buildTools(rt) : undefined,
    passes: 2,
  });
  for (const r of replies) {
    const m = makeMsg(rt, 'agent', r.content, {
      from: r.speaker, name: r.speakerName, stance: r.stance,
    });
    rt.chat.push(m);
    added.push(m);
  }
  if (req.to) {
    // 点名：只给这位朝臣沉淀本次对答（分层记忆：他人不掺和）
    const mem = rt.memory[req.to];
    if (mem) {
      rt.memory = {
        ...rt.memory,
        [req.to]: { ...mem, history: [...(mem.history ?? []), text + ' → ' + (replies[0]?.content ?? '')].slice(-MEM_HISTORY_CAP) },
      };
    }
  } else {
    // 全场：廷议已在 askPersona 内完成，记忆按各角色自己的发言分别沉淀
    rt.memory = absorbUtterances(
      rt.memory,
      spec.cast,
      replies.map((r) => ({
        speaker: r.speaker,
        speakerName: r.speakerName,
        content: r.content,
        stance: r.stance,
        round: rt.turn + 1,
      })),
    );
  }
saveRt(store, rt);
  return { rt, added };
}

// ---------- 终局 ----------

/** 终局判定：相对初始值的累积得分（按 higherIsBetter 加权，区间归一）。 */
function judgeVerdict(spec: ScenarioSpec, start: State, final: State): EndingView['verdict'] {
  let score = 0;
  for (const m of spec.metrics) {
    const span = Math.max(1e-6, m.max - m.min);
    const dir = m.higherIsBetter ? 1 : -1;
    score += dir * ((final[m.key] ?? m.start) - (start[m.key] ?? m.start)) / span;
  }
  if (score >= 0.25) return 'victory';
  if (score <= -0.25) return 'defeat';
  return 'open';
}

function stateAsRecord(state: State): Record<string, number> {
  return { ...state };
}

const VERDICT_WORDS: Record<EndingView['verdict'], string> = {
  victory: '大获全胜', defeat: '黯然收场', open: '胜负未分',
};

/** 玩家主动退朝定局：判定结局 + 史官落笔。 */
export async function endSession(
  store: Store,
  spec: ScenarioSpec,
  specId: string,
  gameId: string,
): Promise<{ rt: SessionRuntime; ending: EndingView }> {
  const rt = loadRt(store, spec, specId, gameId);
  if (rt.status === 'final') {
    throw new AppError(ERROR_CODES.INVALID_ACTION, '本局已定谥（终局判定不可重复）');
  }
  const verdict = judgeVerdict(spec, rt.initialState, rt.state);
  const words = VERDICT_WORDS[verdict];
  const narrative =
    '—— 史官落笔 ——\n' +
    words + '\n\n' +
    '终局判定：' + spec.scenario.successCriteria + '\n' +
    '诏令执笔 ' + rt.turn + ' 道，主上于「' + spec.title + '」间定夺，朝局终有所归。';

  const ev = makeMsg(rt, 'event', narrative, { name: '终章' });
  rt.chat.push(ev);
  rt.status = 'final';
  rt.endedAt = Date.now();
  saveRt(store, rt);
  // 终局定格一帧，让波形曲线完整收尾
  appendTurn(store, rt.gameId, rt.turn + 1, {
    state: rt.state,
    narrative: '终局：' + words,
    at: rt.endedAt,
  });

  const ending: EndingView = {
    gameId,
    verdict,
    title: spec.title,
    narrative,
    metrics: { ...rt.state },
  };
  kvSet(store, ENDING_KEY(gameId), ending);
  return { rt, ending };
}

// ---------- 对外投影 ----------

function toDirectives(spec: ScenarioSpec): Directive[] {
  const plans: DirectivePlan[] = deriveDirectives(spec.cast, spec.rules, spec.metrics);
  return plans.map((p) => ({
    key: p.key,
    kind: p.kind,
    label: p.label,
    hint: p.hint,
    personaId: p.personaId,
  }));
}

/** SessionRuntime → 对外 GameView（前端/恢复共用）。 */
export function toGameView(rt: SessionRuntime, spec: ScenarioSpec): GameView {
  return {
    gameId: rt.gameId,
    specId: rt.specId,
    title: spec.title,
    player: rt.player,
    kind: spec.domain as GameView['kind'],
    status: rt.status === 'final' ? 'final' : 'awaiting',
    turn: rt.turn,
    state: stateAsRecord(rt.state),
    metrics: spec.metrics.map((m) => ({ key: m.key, min: m.min, max: m.max, label: m.label })),
    directives: toDirectives(spec),
    chat: rt.chat,
    endedAt: rt.endedAt != null ? new Date(rt.endedAt).toISOString() : undefined,
  };
}

/** 从 kv 恢复会话（供路由投影用）。 */
export function loadSession(store: Store, spec: ScenarioSpec, specId: string, gameId: string): SessionRuntime {
  return loadRt(store, spec, specId, gameId);
}

/** 从 topics 表取出已构建的 spec（作为建局输入）。 */
export function loadSpec(store: Store, specId: string): ScenarioSpec | undefined {
  const row = store
    .prepare('SELECT spec FROM topics WHERE id = ?')
    .get(specId) as { spec: string | null } | undefined;
  if (!row?.spec) return undefined;
  try {
    return JSON.parse(row.spec) as ScenarioSpec;
  } catch {
    return undefined;
  }
}

// ---------- 鼎新改局：玩家一段话改写任意区域（年代 / 人物 / 矛盾） ----------
// 原则：引擎与 mock 都不写死任何人物——改令里点谁是谁；没点名就按主题派生继任者。

const GAME_SPEC_KEY = (id: string) => 'game:spec:' + id;

/** 本局生效的 spec：鼎新后的覆盖版（与该局绑定，不串同话题其他对局）。 */
export function loadGameSpec(store: Store, specId: string, gameId: string): ScenarioSpec | undefined {
  const override = kvGet(store, GAME_SPEC_KEY(gameId)) as ScenarioSpec | undefined;
  return override ?? loadSpec(store, specId);
}

function saveGameSpec(store: Store, gameId: string, spec: ScenarioSpec): void {
  kvSet(store, GAME_SPEC_KEY(gameId), spec);
}

/**
 * 改令解释 = 通用文本机制，不是动词清单：
 *  - 在朝人物识别：改令与名册「双向包含」匹配（含去主题前缀形），任何说法只要指到人就算数；
 *  - 新人名字：改令 n-元扫描，剔除功能字/常用朝政词/已见于剧本的旧词，最长者即新名候选；
 *    ——用户说「擢」「换」「拜」还是自创说法都无所谓，机制只看「这个名字是新的」；
 *  - 年代：数字解析（阿拉伯/中文/「几十年」），通用；
 *  - 立场/风向：极性词打分（进取 ↔ 稳守），量化为 -1..1；
 *  - 保底：无论结构识别成败，矛盾必重书、全员记忆必注入、影响力按极性必微调——
 *    任何一句改令都可见地改变世界，不存在「解析失败所以无事发生」。
 */
interface ReformPlan {
  years: number;             // 推移年数（0 = 不推年代）
  removeTargetIds: string[]; // 名册双向匹配到的在朝人物 id
  addNames: string[];        // 新名候选（n-元机制抽取）
  stanceHint: string;        // 进取/稳守/客观（空 = 自动补位）
  polarity: number;          // -1..1：负=趋向稳守，正=趋向进取
  summary: string;           // 原话（织入叙事与记忆）
}

/** 名字候选过滤：功能字/单字动词（出现在候选里即非人名） */
const FUNCTION_CHARS = new Set(
  '的了呢吧吗啊呀哦把将被对着从往在于是而或并并且与和及以之乎者也很更最皆都还又再便就则即才只不没未无让使令请来去出入上下中里内外前后为任掌领守将相帅臣卿吾我你他她它谁何哪这那各每某本该其此乎中换罢废贬拜封选提擢调征召遣派主向接',
);

/** 名字候选过滤：常见朝政/叙事/副词（作为「确定不是名字」的跨度被消耗掉，绝不入名） */
const NAME_CANDIDATE_STOP = new Set([
  '老臣', '旧臣', '新人', '新锐', '群臣', '朝中', '朝廷', '主上', '陛下', '天子',
  '天下', '社稷', '江山', '诸卿', '诸位', '众人', '此局', '本局', '新政', '旧制',
  '时序', '年代', '之后', '以来', '凋零', '谢幕', '离朝', '入朝', '补位', '换代',
  '鼎新', '更张', '更迭', '改局', '均衡', '治理',
  '辅政', '主政', '执掌', '领兵', '统领', '兵事', '为将', '为相', '总督', '谋主',
  '换成', '改由', '交由', '任命', '擢升', '起用', '启用', '起复', '改任', '废黜',
  '革职', '斥退', '致仕', '加入', '新增', '登场', '锐意', '大力', '尽快', '全力',
  '倾力', '重心', '转向', '年轻', '局面', '方向', '推动', '推行', '如今', '当下',
  '今日', '此后', '保守', '稳健', '谨慎', '进取', '改革', '开拓', '积极', '客观',
  '居中', '仲裁', '权衡', '政令', '朝议', '风向', '声势',
  // 朝政类抽象词（两字时极易被当人名候选，整段消耗；与后台年代词同理）
  '鼎新', '更张', '更迭', '改局', '均衡', '治理',
]);

/** 年代短语（候选扫描前整段消耗，防「三十年」被当人名） */
const ERA_SPAN_RE = /[0-9]+\s*年(后|之后)?|几十\s*年|[一两二三四五六七八九十百千]+\s*年(后|之后)?/g;

/** 「三十年后」「二十年」→ 30 / 20（中文数字组合 + 阿拉伯数字 + “几十年”默认 30） */
function yearsFromText(text: string): number {
  const ar = text.match(/([0-9]+)\s*年/);
  if (ar) return Number(ar[1]) || 0;
  if (/几十\s*年/.test(text)) return 30;
  const cn = text.match(/([一两二三四五六七八九十百千]+)\s*年/);
  if (!cn) return 0;
  const digits: Record<string, number> = {
    一: 1, 两: 2, 二: 2, 三: 3, 四: 4, 五: 5, 六: 6, 七: 7, 八: 8, 九: 9,
  };
  let section = 0;
  let current = 0;
  for (const ch of cn[1]) {
    if (digits[ch] !== undefined) { current = digits[ch]; continue; }
    if (ch === '十') { section += (current || 1) * 10; current = 0; }
    else if (ch === '百') { section += (current || 1) * 100; current = 0; }
    else if (ch === '千') { section += (current || 1) * 1000; current = 0; }
  }
  return section + current;
}

/** 在朝人物识别：改令原文包含其名，或包含其「去主题前缀」的短名（「子午谷奇谋推进方」↔「推进方」） */
function matchRemoveTargets(text: string, spec: ScenarioSpec): string[] {
  const theme = themeWordOf(spec);
  const ids: string[] = [];
  for (const p of spec.cast) {
    const full = p.name;
    const short = full.startsWith(theme) && full.length - theme.length >= 2
      ? full.slice(theme.length)
      : full;
    if (text.includes(full) || (short !== full && text.includes(short))) {
      ids.push(p.id);
    }
  }
  return ids;
}

/**
 * 新名候选 = 跨度消耗 + 功能字切段：
 * 先把「确定不是名字」的跨度整段遮掉（年代短语 / 极性与朝政常词 / 在朝名册 / 剧本旧词），
 * 再按功能字、标点、数字把余文切成不可再分的语义段 —— 2~3 字的段才像人名。
 * 用户用什么动词都无所谓（动词要么在功能字表、要么在常词表里被消耗），机制只认「这个名字是新的」。
 */
function novelNameCandidates(text: string, spec: ScenarioSpec): string[] {
  const knownText = [
    spec.title, spec.scenario.background, spec.scenario.conflict,
    ...spec.cast.flatMap((p) => [p.name, p.role, p.stance]),
  ].join('|');

  // ① 消耗非名字跨度
  let masked = text.replace(ERA_SPAN_RE, '　');
  for (const w of [...NAME_CANDIDATE_STOP, ...POLARITY_PUSH, ...POLARITY_HOLD]) {
    if (w.length >= 2) masked = masked.split(w).join('　');
  }
  for (const p of spec.cast) {
    if (p.name.length >= 2) masked = masked.split(p.name).join('　');
  }

  // ② 按功能字/标点/数字/空白切段
  const isSep = (ch: string) =>
    FUNCTION_CHARS.has(ch) || /[，。、；：！？,.:;!?（）\[\]{}“”‘’"\s0-9　]/.test(ch);
  const runs: { name: string; at: number }[] = [];
  let cur = '';
  let start = -1;
  for (let i = 0; i < masked.length; i++) {
    const ch = masked[i];
    if (isSep(ch)) {
      if (cur) { runs.push({ name: cur, at: start }); cur = ''; start = -1; }
    } else {
      if (start < 0) start = i;
      cur += ch;
    }
  }
  if (cur) runs.push({ name: cur, at: start });

  // ③ 人名先验 2~3 字 + 剔剧本旧词 + 动宾三字段剥动词前缀（「换田丰」→「田丰」）；
  //    位置靠后者优先（受任者常跟在动作之后）
  return runs
    .filter((r) => r.name.length >= 2 && r.name.length <= 3)
    .filter((r) =>
      !knownText.includes(r.name) &&
      !spec.cast.some((p) => p.name.includes(r.name) || r.name.includes(p.name)))
    .map((r) => (r.name.length === 3 && FUNCTION_CHARS.has(r.name[0]) ? { ...r, name: r.name.slice(1) } : r))
    .filter((r) => r.name.length >= 2)
    .sort((a, b) => b.at - a.at)
    .slice(0, 2)
    .map((r) => r.name);
}

const POLARITY_PUSH = ['进取', '主战', '推进', '改革', '开拓', '积极', '激进', '快刀', '当断'];
const POLARITY_HOLD = ['稳守', '持重', '保守', '稳健', '谨慎', '缓行', '观望', '按兵', '从长', '主守'];

function parseReformPlan(text: string, spec: ScenarioSpec): ReformPlan {
  const push = POLARITY_PUSH.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  const hold = POLARITY_HOLD.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  const polarity = Math.max(-1, Math.min(1, (push - hold) / 2));
  const stanceHint = polarity > 0.2 ? '进取' : polarity < -0.2 ? '稳守' : '';
  return {
    years: yearsFromText(text),
    removeTargetIds: matchRemoveTargets(text, spec),
    addNames: novelNameCandidates(text, spec),
    stanceHint,
    polarity,
    summary: text,
  };
}

// —— 确定性小工具（FNV-1a + 种子随机；不引引擎内部） ——

function hashText32(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seededFrom(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + (t ^ (t >>> 7) | 61)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 新人立卡：名字来自改令（或主题派生），数值确定性生成，不写死任何人物 */
function mintPersona(id: string, name: string, role: string, stance: string, seed: string): Persona {
  const rnd = seededFrom(hashText32(seed + ':' + name));
  return {
    id,
    name,
    role,
    stance,
    influence: Math.round(45 + rnd() * 40),
    description: '由主上改令擢入朝堂',
    prompt:
      `你是${name}（${role}），立场${stance}。新近入朝，锐意任事。` +
      '发言符合身份与立场，引用当下时局与同僚前话，不编造史实。',
    traits: {
      competence: Math.round(55 + rnd() * 35),
      loyalty: Math.round(50 + rnd() * 40),
      ambition: stance === '进取' ? Math.round(60 + rnd() * 30) : Math.round(35 + rnd() * 35),
      power: Math.round(40 + rnd() * 40),
    },
  };
}

/** 主题词（给主题派生的继任者命名用，不硬造人名） */
function themeWordOf(spec: ScenarioSpec): string {
  const c = spec.scenario.conflict || spec.title;
  const q = c.match(/「([^」]{2,8})」/);
  if (q) return q[1];
  return (spec.title || '朝局').replace(/^话题推演[:：]?/, '').slice(0, 4) || '朝局';
}

/** 阵营补位：缺哪派补哪派，保证对立仍在 */
function missingStance(cast: Persona[]): string {
  const have = new Set(cast.map((p) => p.stance));
  if (!have.has('进取')) return '进取';
  if (!have.has('稳守')) return '稳守';
  return '客观';
}

/** mock 改局：全部由机制派生 —— 名册匹配罢免 / 年代加权随机退役 / n-元新名 / 极性微调；任何改令必有效果 */
function mockReformSpec(
  spec: ScenarioSpec,
  plan: ReformPlan,
): { spec: ScenarioSpec; removed: string[]; added: string[]; years: number; shifted: boolean } {
  let cast = spec.cast.map((p) => ({ ...p }));
  const removed: string[] = [];
  const added: string[] = [];
  const years = plan.years;

  // ① 名册双向匹配到的在朝人物直接离朝（保持 ≥2）
  if (plan.removeTargetIds.length) {
    const keep = Math.max(2, cast.length - plan.removeTargetIds.length);
    for (const id of plan.removeTargetIds) {
      if (cast.length <= keep) break;
      const idx = cast.findIndex((p) => p.id === id);
      if (idx >= 0) {
        removed.push(cast[idx].name);
        cast.splice(idx, 1);
      }
    }
  }

  // ② 年代推移：加权随机退役 —— 影响力越小越可能谢幕，种子随改令文本（同一改令同结果，不同改令不同命运）
  if (years >= 5 && cast.length > 2) {
    const retireCount = Math.min(cast.length - 2, years >= 30 ? 2 : 1);
    for (let n = 0; n < retireCount; n++) {
      const weights = cast.map((p) => 110 - p.influence);
      const total = weights.reduce((a, b) => a + b, 0);
      let roll = (seededFrom(hashText32(plan.summary + ':' + n + ':' + cast.length))() * total);
      let idx = 0;
      for (; idx < cast.length - 1 && roll > weights[idx]; idx++) roll -= weights[idx];
      removed.push(cast[idx].name);
      cast.splice(idx, 1);
    }
  }

  // ③ 新人入朝：机制抽到的新名优先；有人谢幕但没抽到名字 → 主题派生继任（不硬造人名）
  const newNames = plan.addNames.filter((n) => !removed.some((r) => r.includes(n) || n.includes(r)));
  if (removed.length > newNames.length) {
    newNames.push(cast.length % 2 === 0 ? themeWordOf(spec) + '新锐' : themeWordOf(spec) + '继任');
  }
  for (const name of newNames.slice(0, Math.max(2, removed.length))) {
    const role = /武|将|军|兵|战/.test(plan.summary) ? '统领兵事' : '入朝辅政';
    const stance = plan.stanceHint || missingStance(cast);
    cast.push(mintPersona('r' + hashText32(name).toString(16).slice(0, 5), name, role, stance, plan.summary));
    added.push(name);
  }

  // ④ 极性微调（保底机制之一）：改令风向推移各人影响力，进取↔稳守反向移动
  let shifted = false;
  if (plan.polarity !== 0) {
    cast = cast.map((p) => {
      const s = p.stance || '';
      const dir = POLARITY_PUSH.some((w) => s.includes(w)) ? 1
        : POLARITY_HOLD.some((w) => s.includes(w)) ? -1
        : 0;
      if (dir === 0) return p;
      const next = Math.max(1, Math.min(100, p.influence + Math.round(plan.polarity * 6 * dir)));
      if (next !== p.influence) shifted = true;
      return { ...p, influence: next };
    });
  }

  // ⑤ 矛盾必重书（保底机制之二）：改令原话织入核心矛盾，无论结构识别成败
  const background = years >= 5
    ? spec.scenario.background + '\n（时序推移 ' + years + ' 年，朝中人物已然换代。）'
    : spec.scenario.background;
  const conflict = `鼎新改局：${plan.summary.slice(0, 60)}——${cast[0]?.name ?? '当轴'}与${cast[1]?.name ?? '群僚'}各执一词，主上亲裁。`;

  return {
    spec: {
      ...spec,
      scenario: { ...spec.scenario, background, conflict, participants: cast.map((p) => p.id) },
      cast,
    },
    removed,
    added,
    years,
    shifted,
  };
}

// —— 真实 LLM 改局（同 schema JSON，失败回落 mock 解析） ——

const REFORM_PROMPT = [
  '你是历史推演引擎的「鼎新司」：主上（玩家）用一段话改写进行中的朝局。',
  '可以改写任意区域：年代跨度（如「三十年后」→ 旧人凋零换代）、罢免/替换/新增任意人物、改写核心矛盾。',
  '只输出 JSON（不要代码块）：',
  '{"years":0,"note":"一两句换代叙事","cast":[{"name":"人名","role":"职务","stance":"进取或稳守或客观","influence":0-100,"description":"简介","prompt":"该角色的私有人设指令","traits":{"competence":0-100,"loyalty":0-100,"ambition":0-100,"power":0-100}}]}',
  '要求：cast 数组给出鼎新后完整在朝名单（2~4 人；未提及者原样保留，改令点名的照改令来）；',
  '立场必须仍存对立；人物必须贴合改令与原背景，不凭空硬造不相关人名；years 为推移年数（改令没提年代则 0）。',
].join('\n');

async function llmReformSpec(
  llm: LLMProvider,
  spec: ScenarioSpec,
  text: string,
): Promise<{ spec: ScenarioSpec; note: string; years: number; removed: string[]; added: string[] } | undefined> {
  if (!llm.isReal()) return undefined;
  try {
    const profile = spec.cast.map(({ name, role, stance, influence, description }) => (
      { name, role, stance, influence, description }));
    const raw = await llm.chat(
      [{
        role: 'user',
        content:
          REFORM_PROMPT +
          '\n\n当前剧本：' + JSON.stringify({ title: spec.title, scenario: spec.scenario, cast: profile }) +
          '\n\n主上改令：' + text,
      }],
      { maxTokens: 1400 },
    );
    const j = JSON.parse(raw) as {
      years?: number; note?: string;
      cast?: Partial<Persona>[];
    };
    const incoming = (j.cast ?? []).filter((c) => typeof c.name === 'string' && (c.name as string).length >= 2);
    if (incoming.length < 2) return undefined;
    const oldNames = new Set(spec.cast.map((p) => p.name));
    const nextCast: Persona[] = incoming.map((c, i) => ({
      id: 'q' + i,
      name: String(c.name),
      role: String(c.role ?? '朝臣'),
      stance: String(c.stance ?? '客观'),
      influence: Math.max(1, Math.min(100, Number(c.influence) || 50)),
      description: String(c.description ?? ''),
      prompt: String(c.prompt ?? `你是${c.name}（${c.role}），立场${c.stance}。发言符合身份与立场。`),
      traits: (c.traits && typeof c.traits === 'object'
        ? c.traits
        : { competence: 60, loyalty: 60, ambition: 50, power: 50 }),
    }));
    const years = Math.max(0, Number(j.years) || 0);
    return {
      spec: {
        ...spec,
        scenario: {
          ...spec.scenario,
          background: years >= 5
            ? spec.scenario.background + '\n（时序推移 ' + years + ' 年，朝中人物已然换代。）'
            : spec.scenario.background,
          participants: nextCast.map((p) => p.id),
        },
        cast: nextCast,
      },
      note: String(j.note ?? ''),
      years,
      removed: spec.cast.filter((p) => !nextCast.some((q) => q.name === p.name)).map((p) => p.name),
      added: nextCast.filter((p) => !oldNames.has(p.name)).map((p) => p.name),
    };
  } catch {
    return undefined; // JSON 不合规 → mock 解析兜底
  }
}

/** 玩家一段话鼎新改局：人物册 / 场景矛盾 / 年代皆可动（数值体系保持稳定）。 */
export async function reformGame(
  store: Store,
  llm: LLMProvider,
  spec: ScenarioSpec,
  specId: string,
  gameId: string,
  text: string,
): Promise<{ rt: SessionRuntime; spec: ScenarioSpec; added: ChatMessage[] }> {
  const rt = loadRt(store, spec, specId, gameId);
  if (rt.status === 'final') {
    throw new AppError(ERROR_CODES.INVALID_ACTION, '本局已定谳，朝局不可再改');
  }
  const clean = text.trim();
  if (!clean) {
    throw new AppError(ERROR_CODES.BAD_INPUT, '改令内容不可为空');
  }
  if (clean.length > 800) {
    throw new AppError(ERROR_CODES.BAD_INPUT, '改令一言尽意，请勿超过 800 字');
  }

  const playerMsg = makeMsg(rt, 'player', clean, { act: true });
  rt.chat.push(playerMsg);
  const added: ChatMessage[] = [playerMsg];

  const plan = parseReformPlan(clean, spec);
  let nextSpec: ScenarioSpec;
  let note = '';
  let removed: string[] = [];
  let addedNames: string[] = [];
  let years = plan.years;
  let shifted = false;

  const viaLlm = await llmReformSpec(llm, spec, clean);
  if (viaLlm) {
    nextSpec = viaLlm.spec;
    note = viaLlm.note;
    removed = viaLlm.removed;
    addedNames = viaLlm.added;
    years = viaLlm.years || plan.years;
    shifted = plan.polarity !== 0;
  } else {
    const viaMock = mockReformSpec(spec, plan);
    nextSpec = viaMock.spec;
    removed = viaMock.removed;
    addedNames = viaMock.added;
    years = viaMock.years;
    shifted = viaMock.shifted;
  }

  const check = validateSpec(nextSpec);
  if (!check.ok) {
    throw new AppError(ERROR_CODES.INVALID_ACTION, '改局未成（' + check.errors.join('；') + '），朝局维持原状');
  }

  // 保底机制之三：改令入全员记忆 —— 无论人物是否变动，下轮廷议人人都接得住这道改令
  rt.memory = { ...rt.memory };
  for (const p of nextSpec.cast) {
    const mem = rt.memory[p.id];
    if (!mem) {
      rt.memory[p.id] = {
        longTerm: p.prompt,
        currentTurn: [],
        history: ['主上颁改令：' + clean.slice(0, 80)],
      };
    } else {
      rt.memory[p.id] = {
        ...mem,
        history: [...(mem.history ?? []), '主上颁改令：' + clean.slice(0, 80)].slice(-MEM_HISTORY_CAP),
      };
    }
  }

  const parts: string[] = ['—— 鼎新改局 ——'];
  if (note) parts.push(note);
  if (years >= 1) parts.push('时序推移 ' + years + ' 年。');
  if (removed.length) parts.push(removed.join('、') + ' 谢幕离朝。');
  if (addedNames.length) parts.push(addedNames.join('、') + ' 入朝补位。');
  if (shifted) {
    parts.push(plan.polarity > 0 ? '朝议风向转进，进取者声势上扬。' : '朝议风向趋稳，持重者声势上扬。');
  }
  if (removed.length || addedNames.length || shifted) {
    parts.push('（诸臣已将改令记于心间。）');
  } else {
    parts.push('朝局矛盾因主上改令而更张。');
  }
  const ev = makeMsg(rt, 'event', parts.join('\n'), { name: '鼎新' });
  rt.chat.push(ev);
  added.push(ev);

  rt.spec = nextSpec;
  saveGameSpec(store, gameId, nextSpec);
  saveRt(store, rt);
  return { rt, spec: nextSpec, added };
}