/**
 * 前端 API 层（docs/08）：对 @sim/serve 的真实 HTTP + SSE 客户端。
 * 统一错误形状：服务端 { error: { code, message } } → 抛 ApiError(code, message)。
 */
import type { GameOption, TurnView, EndingView, StoryView } from '@sim/contracts';

export class ApiError extends Error {
  readonly code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'ApiError';
    this.code = code;
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(path, {
    headers: { 'content-type': 'application/json' },
    ...init,
  });
  let body: unknown = null;
  try {
    body = await res.json();
  } catch {
    /* 非 JSON 响应 */
  }
  if (!res.ok) {
    const err = body as { error?: { code?: string; message?: string } } | null;
    throw new ApiError(err?.error?.code ?? String(res.status), err?.error?.message ?? res.statusText);
  }
  return body as T;
}

// ---------- 话题管线 ----------

export interface IngestOk {
  topicId: string;
  state: string;
}

export function ingestTopic(input: { kind: 'text'; text: string } | { kind: 'url'; url: string }) {
  return request<IngestOk>('/api/topics/ingest', { method: 'POST', body: JSON.stringify(input) });
}

export function buildTopic(topicId: string) {
  return request<{ accepted: boolean }>(`/api/topics/${encodeURIComponent(topicId)}/build`, {
    method: 'POST',
    body: '{}',
  });
}

export type TopicState = 'idle' | 'running' | 'ready' | 'failed';

export interface TopicStatus {
  topicId: string;
  state: TopicState;
}

export function topicStatus(topicId: string) {
  return request<TopicStatus>(`/api/topics/${encodeURIComponent(topicId)}/status`);
}

export interface SpecPayload {
  topicId: string;
  spec: {
    domain: string;
    title: string;
    scenario: { background: string; conflict: string };
    metrics: { key: string; label?: string; min: number; max: number; start: number }[];
    rounds: number;
    cast: { id: string; name: string; role: string; stance: string; influence: number }[];
  };
}

export function fetchSpec(topicId: string) {
  return request<SpecPayload>(`/api/topics/${encodeURIComponent(topicId)}/spec`);
}

// ---------- 游戏 ----------

export interface CreateGameOk {
  gameId: string;
  status: 'awaiting';
  turn: number;
  view: TurnView;
  options: GameOption[];
}

export function createGame(specId: string, player: string) {
  return request<CreateGameOk>('/api/games', {
    method: 'POST',
    body: JSON.stringify({ specId, player }),
  });
}

export interface GameStateOk {
  gameId: string;
  title: string;
  status: 'awaiting' | 'final';
  turn: number;
  totalRounds: number;
  state: Record<string, number>;
  metrics: { key: string; label?: string; min: number; max: number }[];
  latest?: TurnView;
}

export function gameState(gameId: string) {
  return request<GameStateOk>(`/api/games/${gameId}/state`);
}

export interface OptionsOk {
  gameId: string;
  turn: number;
  options: GameOption[];
}

export function gameOptions(gameId: string) {
  return request<OptionsOk>(`/api/games/${gameId}/options`);
}

export interface DecideOk {
  settled: TurnView;
  next?: { view: TurnView; options: GameOption[] };
  ending?: EndingView;
}

export function decide(gameId: string, payload: { option: string; text?: string }) {
  return request<DecideOk>(`/api/games/${gameId}/decide`, {
    method: 'POST',
    body: JSON.stringify(payload),
  });
}

export function fetchEnding(gameId: string) {
  return request<EndingView>(`/api/games/${gameId}/ending`);
}

export function fetchStoryboard(gameId: string) {
  return request<StoryView>(`/api/games/${gameId}/storyboard`);
}

// ---------- SSE ----------

export interface SseIncoming {
  event: string;
  data: unknown;
}

/** 长连接订阅：onEvent 逐事件回调；内部自动携带 Last-Event-ID，断线即重建续拉。 */
export function subscribeSse(path: string, onEvent: (ev: SseIncoming) => void): () => void {
  let closed = false;
  let lastId: string | undefined;

  const connect = () => {
    if (closed) return;
    fetch(path, {
      headers: lastId ? { 'last-event-id': lastId } : undefined,
    })
      .then((res) => res.body ? pump(res.body.getReader()) : undefined)
      .catch(() => scheduleReconnect());
  };

  let timer: ReturnType<typeof setTimeout> | undefined;
  const scheduleReconnect = () => {
    if (closed) return;
    timer = setTimeout(connect, 1500);
  };

  const pump = async (reader: ReadableStreamDefaultReader<Uint8Array>) => {
    const dec = new TextDecoder();
    let buffer = '';
    try {
      for (;;) {
        const { value, done } = await reader.read();
        if (done || closed) break;
        buffer += dec.decode(value, { stream: true });
        const frames = buffer.split('\n\n');
        buffer = frames.pop() ?? '';
        for (const frame of frames) {
          if (!frame.trim()) continue;
          let event = ''; let data = '';
          for (const line of frame.split('\n')) {
            if (line.startsWith('id: ')) lastId = line.slice(4).trim();
            else if (line.startsWith('event: ')) event = line.slice(7).trim();
            else if (line.startsWith('data: ')) data = line.slice(6).trim();
          }
          if (event) onEvent({ event, data });
        }
      }
    } catch {
      /* 流中断 */
    } finally {
      scheduleReconnect();
    }
  };

  connect();
  return () => {
    closed = true;
    if (timer) clearTimeout(timer);
  };
}