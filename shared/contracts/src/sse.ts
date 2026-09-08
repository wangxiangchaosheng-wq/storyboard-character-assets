/**
 * SSE 事件板 —— 单一清单（docs/05 §4）。新增事件类型必须登记于此，
 * 服务端发送与前端解析共用同一个字面量联合，保证双向一致。
 */
export const SSE_EVENTS = [
  // 话题管线（01）
  'topics.ingest.progress',
  'topics.build.progress',
  'topics.build.validated',
  'topics.spec.ready',
  'topics.spec.failed',
  // 游戏回合（02/03/04/05）
  'games.turn.report',
  'games.state.update',
  'games.map.update',
  'games.character.available',
  'games.ai.round.started',
  'games.ai.round.complete',
  'games.ai.reply',
  'games.reform',
  'games.storyboard',
  'games.ending',
  // 通用
  'heartbeat',
  'games.error',
] as const;
export type SseEventName = (typeof SSE_EVENTS)[number];

/** 每条 SSE 消息的统一外壳 */
export interface SseEnvelope<T = unknown> {
  event: SseEventName;
  data: T;
  ts: string; // ISO 时间
  seq?: number; // 全局自增序号，配合 Last-Event-ID 断线续拉
}

/** 竞技场演进别名：payload 的通用辅助类型 */
export type SseErrorPayload = { code: string; message: string; details?: unknown };