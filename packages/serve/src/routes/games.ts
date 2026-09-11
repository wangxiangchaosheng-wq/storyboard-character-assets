/**
 * 游戏路由（docs/05 §3「games」，聊天模型）：
 * 建局（史官开场 + 群臣陈情）→ GET state（全部对话 + 动态机制）→
 * POST message（问策 / 下诏）→ 会话推进 → POST end 主动定局。
 * SSE：/api/games/:id/events 读 Last-Event-ID，hub 回放历史后进实时流（断线续拉）。
 *
 * 对外投影一律经 @sim/contracts 的 GameView / MessageReply / EndingView 形状；
 * 全部逻辑（结算/终局/持久化）在 gamesflow.ts，路由只做 IO 与广播。
 */
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { randomBytes } from 'node:crypto';
import { AppError, ERROR_CODES } from '@sim/contracts';
import type { GameView, EndingView, HistoryEntry, MessageReq, MessageReply, GameDelta } from '@sim/contracts';
import type { ProviderSet } from '@sim/llm';
import type { ScenarioSpec } from '@sim/engine-core';
import type { Store } from '../store.ts';
import { getGame, kvGet, putGame, getTurns, listGames } from '../store.ts';
import type { SseHub } from '../sse.ts';
import {
  asLlm, loadSpec, startSession, handleMessage, endSession, toGameView, loadSession,
  reformGame, loadGameSpec, getTopicFill,
} from '../gamesflow.ts';
import { toPublicSpec } from '../publicSpec.ts';
import { MockSearchProvider, EmptySearchProvider } from '@sim/llm';
import type { SearchProvider } from '@sim/llm';

/** 从 topics.fill 提取的史实构建一个轻量 SearchProvider（离线可用）。 */
function buildSearchFromFill(fill: { claims: string[] }): SearchProvider {
  // 补充两线作战关键史实（pipeline BM25 对短查询命中率低，此处兜底）
  const extraFacts = [
    '诸葛亮北伐最多同时对付一个方向，从未敢两线开战，以国力悬殊为根本原因。',
    '两线作战需要兵力达到对手单线的1.5倍以上才可能成功。',
    '蜀汉人口不足魏国四分之一，军队后勤多依赖汉中屯田。',
  ];
  const allClaims = [...fill.claims, ...extraFacts];
  return {
    isReal: () => true,
    async search(_query: string) {
      return allClaims.map((c, i) => ({
        id: 'f' + i, claim: c, entity: '史实', source: 'search' as const,
        estimated: false, confidence: 0.9,
      }));
    },
  };
}

const ENDING_KEY = (id: string) => 'game:ending:' + id;

interface GamesDeps {
  providers: ProviderSet;
  hub: SseHub;
  store: Store;
}

function mustSpec(store: Store, specId: string): ScenarioSpec {
  const spec = loadSpec(store, specId);
  if (!spec) {
    throw new AppError(ERROR_CODES.TASK_NOT_FOUND, 'spec 不存在或未构建：' + specId);
  }
  return spec;
}

/** 对局生效 spec：鼎新覆盖版优先（人物册随改令变动），否则话题原版。 */
function mustGameSpec(store: Store, specId: string, gameId: string): ScenarioSpec {
  const spec = loadGameSpec(store, specId, gameId);
  if (!spec) {
    throw new AppError(ERROR_CODES.TASK_NOT_FOUND, 'spec 不存在或未构建：' + specId);
  }
  return spec;
}

function lastEventIdOf(req: FastifyRequest): number | undefined {
  const raw = req.headers['last-event-id'];
  const n = Array.isArray(raw) ? raw[0] : raw;
  if (!n) return undefined;
  const seq = Number(n);
  return Number.isFinite(seq) ? seq : undefined;
}

/** 从全量对话投出公开日志（player-view 兼容） */
function chatToHistory(chat: GameView['chat']): HistoryEntry[] {
  const out: HistoryEntry[] = [];
  for (const m of chat) {
    let kind: HistoryEntry['kind'] = 'debate';
    if (m.kind === 'result') kind = 'decision';
    else if (m.kind === 'event') kind = 'settle';
    const title = (m.kind === 'result' ? '诏令' : m.name ?? '朝局') +
      (m.stance ? '『' + m.stance + '』' : '');
    const item: HistoryEntry = { turn: 1, kind, title, text: m.text };
    if (m.deltas?.length) item.deltas = m.deltas;
    out.push(item);
  }
  return out;
}

/** storyboard：每道已结算诏令一个锚点 */
function toBeats(chat: GameView['chat']): { turn: number; title: string; summary: string }[] {
  const beats: { turn: number; title: string; summary: string }[] = [];
  let turn = 0;
  for (const m of chat) {
    if (m.kind !== 'result') continue;
    turn += 1;
    beats.push({ turn, title: (m.name ?? '诏令') + '（' + m.text.slice(0, 40) + '…）', summary: m.text });
  }
  return beats;
}

export function registerGameRoutes(app: FastifyInstance, deps: GamesDeps): void {
  const { providers, hub, store } = deps;
  const llm = asLlm(providers.chat);

  // ---------- 建局：spec → 史官开场 + 群臣陈言 ----------
  app.post('/api/games', async (req, reply) => {
    const body = (req.body ?? {}) as { specId?: string; player?: string };
    if (!body.specId || !body.player) {
      return reply
        .code(400)
        .send({ error: { code: ERROR_CODES.BAD_INPUT, message: '需要 specId 与 player' } });
    }
    const spec = mustSpec(store, body.specId);
    const gameId = 'g' + randomBytes(4).toString('hex');
    // 恢复考据司产出，注入可行性引擎
    const topicFill = getTopicFill(store, body.specId);
    const search = topicFill ? buildSearchFromFill(topicFill) : new MockSearchProvider();
    const rt = await startSession(store, llm, spec, body.specId, gameId, body.player, search);
    putGame(store, {
      id: gameId,
      spec_id: body.specId,
      title: spec.title,
      player: body.player,
      status: 'awaiting',
      turn: 0,
      total_rounds: 0,
      state: rt.state,
      metrics: spec.metrics,
    });
    hub.publish('game:' + gameId, 'games.state.update', { gameId, turn: 0, status: 'awaiting' });
    return reply.code(201).send(toGameView(rt, spec)); // 直接返回完整视图，省前端一轮 GET
  });

  // ---------- 历史对局列表（首页「续局」） ----------
  app.get('/api/games', async (_req, reply) => {
    const rows = listGames(store, 12);
    return reply.send({
      games: rows.map((r) => ({
        gameId: r.id,
        title: r.title,
        turn: r.turn,
        status: r.status === 'ended' ? 'final' : 'awaiting',
        specId: r.spec_id,
      })),
    });
  });

  // ---------- 推演历史：指标波形 + 诏令/事件时间线（复盘与走势图数据源） ----------
  app.get('/api/games/:id/history', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const rt = loadSession(store, spec, row.spec_id, id);
    const snaps = getTurns(store, id); // [{turn, payload:{state,narrative,deltas?,at?}}]
    if (!snaps.length) {
      // 旧版本留下的对局没有快照记录：以当前状态补一帧「恢复留档」，面板不至于空白
      snaps.push({
        turn: 0,
        payload: {
          state: rt.state,
          narrative: '恢复历史对局 · 按当前朝局状态留档',
          at: rt.endedAt ?? Date.now(),
        },
      });
    }

    const series: {
      key: string; label: string; unit?: string; min: number; max: number;
      points: { t: number; v: number }[];
    }[] = spec.metrics.map((m) => {
      const points: { t: number; v: number }[] = [];
      for (const s of snaps) {
        const p = s.payload as { state?: Record<string, number> };
        const v = p.state?.[m.key];
        if (typeof v === 'number') points.push({ t: s.turn, v });
      }
      return {
        key: m.key,
        label: m.label ?? m.key,
        unit: m.unit,
        min: m.min,
        max: m.max,
        points,
      };
    });

    const events = [];
    for (const s of snaps) {
      const p = s.payload as {
        state?: Record<string, number>; narrative?: string;
        deltas?: GameDelta[]; at?: number;
      };
      events.push({
        t: s.turn,
        at: p.at ?? 0,
        narrative: p.narrative ?? '',
        deltas: p.deltas ?? [],
      });
    }

    return reply.send({
      gameId: id,
      turn: rt.turn,
      status: rt.status === 'final' ? 'final' : 'awaiting',
      metrics: series,
      events,
    });
  });

  // ---------- 局级状态（对话 + 机制 + 数值） ----------
  app.get('/api/games/:id/state', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const rt = loadSession(store, spec, row.spec_id, id);
    // spec 走对外解密视图：公式只在引擎与审校司内部，不下发给客户端
    return reply.send({ ...toGameView(rt, spec), spec: toPublicSpec(spec) });
  });

  // ---------- 玩家一条消息：问策（conversation）或下诏（settle） ----------
  app.post('/api/games/:id/message', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    if (row.status === 'ended') {
      return reply.code(409).send({ error: { code: ERROR_CODES.INVALID_ACTION, message: '对局已终' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const body = (req.body ?? {}) as MessageReq;
    // 重新从 fill 构建 SearchProvider（与建局时一致）
    const topicFill = getTopicFill(store, row.spec_id);
    const msgSearch = topicFill ? buildSearchFromFill(topicFill) : undefined;
    const { rt, added } = await handleMessage(store, llm, spec, row.spec_id, id, body, msgSearch);
    putGame(store, {
      id,
      spec_id: row.spec_id,
      title: spec.title,
      player: rt.player,
      status: rt.status === 'final' ? 'ended' : 'awaiting',
      turn: rt.turn,
      total_rounds: 0,
      state: rt.state,
      metrics: spec.metrics,
    });
    const out: MessageReply = { gameId: id, turn: rt.turn, status: rt.status, messages: added, state: rt.state };
    if (rt.status === 'final') {
      const ending = kvGet(store, ENDING_KEY(id)) as EndingView | undefined;
      if (ending) out.ended = ending;
    }
    hub.publish('game:' + id, 'games.state.update', {
      gameId: id, turn: rt.turn, status: rt.status, kind: body.act ? 'decree' : 'consult',
    });
    hub.publish('game:' + id, 'games.ai.reply', { gameId: id, turn: rt.turn, count: added.length });
    return reply.send(out);
  });

  // ---------- 鼎新改局：一段话改写任意区域（年代 / 人物册 / 矛盾） ----------
  app.post('/api/games/:id/reform', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    if (row.status === 'ended') {
      return reply.code(409).send({ error: { code: ERROR_CODES.INVALID_ACTION, message: '对局已终，朝局不可再改' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const body = (req.body ?? {}) as { text?: string };
    const { rt, spec: nextSpec, added } = await reformGame(store, llm, spec, row.spec_id, id, String(body.text ?? ''));
    putGame(store, {
      id,
      spec_id: row.spec_id,
      title: nextSpec.title,
      player: rt.player,
      status: 'awaiting',
      turn: rt.turn,
      total_rounds: 0,
      state: rt.state,
      metrics: nextSpec.metrics,
    });
    hub.publish('game:' + id, 'games.reform', { gameId: id, turn: rt.turn, cast: nextSpec.cast.length });
    hub.publish('game:' + id, 'games.state.update', { gameId: id, turn: rt.turn, status: 'awaiting', kind: 'reform' });
    return reply.send({
      gameId: id,
      turn: rt.turn,
      status: rt.status,
      messages: added,
      state: rt.state,
      view: toGameView(rt, nextSpec),
      spec: toPublicSpec(nextSpec),
    });
  });

  // ---------- 主动退朝（终局） ----------
  app.post('/api/games/:id/end', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const { rt, ending } = await endSession(store, spec, row.spec_id, id);
    putGame(store, {
      id,
      spec_id: row.spec_id,
      title: spec.title,
      player: rt.player,
      status: 'ended',
      turn: rt.turn,
      total_rounds: 0,
      state: rt.state,
      metrics: spec.metrics,
    });
    hub.publish('game:' + id, 'games.ending', { gameId: id, verdict: ending.verdict });
    hub.publish('game:' + id, 'games.state.update', { gameId: id, turn: rt.turn, status: 'final' });
    return reply.send({ ending, view: toGameView(rt, spec) });
  });

  // ---------- 终局 --------------------------
  app.get('/api/games/:id/ending', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const saved = kvGet(store, ENDING_KEY(id)) as EndingView | undefined;
    if (!saved) {
      return reply.code(409).send({ error: { code: ERROR_CODES.INVALID_ACTION, message: '对局尚未终局' } });
    }
    return reply.send(saved);
  });

  // ---------- 玩家视角（公开对话回放）----------
  app.get('/api/games/:id/player-view', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const rt = loadSession(store, spec, row.spec_id, id);
    return reply.send({
      gameId: id,
      title: spec.title,
      turn: rt.turn,
      status: rt.status === 'final' ? 'final' : 'awaiting',
      log: chatToHistory(rt.chat),
    });
  });

  // ---------- storyboard（每道诏令 = 一个锚点） ----------
  app.get('/api/games/:id/storyboard', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    const rt = loadSession(store, spec, row.spec_id, id);
    return reply.send({ gameId: id, beats: toBeats(rt.chat) });
  });

  // ---------- SSE 事件流（Last-Event-ID 续拉） ----------
  app.get('/api/games/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const afterSeq = lastEventIdOf(req);
    const unsubscribe = hub.subscribe('game:' + id, reply, { afterSeq });
    req.raw.on('close', unsubscribe);
  });

  // ---------- 阵营图（静态势力投影） ----------
  app.get('/api/games/:id/map', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getGame(store, id);
    if (!row) {
      return reply.code(404).send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: '对局不存在' } });
    }
    const spec = mustGameSpec(store, row.spec_id, id);
    return reply.send({
      gameId: id,
      era: spec.scenario.background.slice(0, 40),
      factions: spec.cast.map((p) => ({
        id: p.id,
        name: p.name,
        role: p.role,
        stance: p.stance,
        influence: p.influence,
        traits: p.traits,
      })),
    });
  });
}