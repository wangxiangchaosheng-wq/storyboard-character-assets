/**
 * 服务端 SQLite 存储（docs/05 §5）：topics/specs/games/turns/kv/events 六表 + 封装。
 * - node:sqlite DatabaseSync（WAL），单进程同步语义，配 buildServer 单例使用。
 * - events 表带全局自增 seq —— SSE 断线续拉的持久化源（Last-Event-ID）。
 * - 全部 SQL 静态常量 + 参数占位符，无拼接。
 */
import { DatabaseSync } from 'node:sqlite';

export type Store = DatabaseSync;

const EVENTS_CAP = 5000; // 事件环形保留上限（防无限增长）

const DDL_TABLES = [
  'CREATE TABLE IF NOT EXISTS topics (',
  '  id TEXT PRIMARY KEY,',
  '  status TEXT NOT NULL,',
  '  input TEXT NOT NULL,',
  '  brief TEXT,',
  '  fill TEXT,',
  '  spec TEXT,',
  '  created_at INTEGER NOT NULL,',
  '  updated_at INTEGER NOT NULL',
  ')',
].join(' ');
const DDL_GAMES = [
  'CREATE TABLE IF NOT EXISTS games (',
  '  id TEXT PRIMARY KEY,',
  '  spec_id TEXT NOT NULL,',
  '  title TEXT NOT NULL,',
  '  player TEXT NOT NULL,',
  '  status TEXT NOT NULL,',
  '  turn INTEGER NOT NULL DEFAULT 0,',
  '  total_rounds INTEGER NOT NULL DEFAULT 1,',
  '  state TEXT NOT NULL,',
  '  metrics TEXT NOT NULL,',
  '  ended_at INTEGER',
  ')',
].join(' ');
const DDL_TURNS = [
  'CREATE TABLE IF NOT EXISTS turns (',
  '  game_id TEXT NOT NULL,',
  '  turn INTEGER NOT NULL,',
  '  payload TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL,',
  '  PRIMARY KEY (game_id, turn)',
  ')',
].join(' ');
const DDL_KV = [
  'CREATE TABLE IF NOT EXISTS kv (',
  '  key TEXT PRIMARY KEY,',
  '  value TEXT NOT NULL,',
  '  updated_at INTEGER NOT NULL',
  ')',
].join(' ');
const DDL_EVENTS = [
  'CREATE TABLE IF NOT EXISTS events (',
  '  seq INTEGER PRIMARY KEY AUTOINCREMENT,',
  '  channel TEXT NOT NULL,',
  '  event TEXT NOT NULL,',
  '  data TEXT NOT NULL,',
  '  created_at INTEGER NOT NULL',
  ')',
].join(' ');
const DDL_IDX_EVENTS = 'CREATE INDEX IF NOT EXISTS idx_events_channel ON events(channel, seq)';

export interface TopicRow {
  id: string;
  status: string;
  input: string;
  brief: string | null;
  fill: string | null;
  spec: string | null;
  created_at: number;
  updated_at: number;
}

export interface GameRow {
  id: string;
  spec_id: string;
  title: string;
  player: string;
  status: string;
  turn: number;
  total_rounds: number;
  state: string;
  metrics: string;
  ended_at: number | null;
}

export interface StoredEvent {
  seq: number;
  channel: string;
  event: string;
  data: string;
  created_at: number;
}

export function openStore(dbPath?: string): Store {
  const store: Store = new DatabaseSync(dbPath ?? ':memory:');
  for (const ddl of [DDL_TABLES, DDL_GAMES, DDL_TURNS, DDL_KV, DDL_EVENTS, DDL_IDX_EVENTS]) {
    store.prepare(ddl).run();
  }
  return store;
}

// ---------- topics ----------

export function saveTopic(
  store: Store,
  id: string,
  patch: { status?: string; input?: unknown; brief?: unknown; fill?: unknown; spec?: unknown },
): TopicRow {
  const now = Date.now();
  const existing = getTopic(store, id);
  const status = patch.status ?? existing?.status ?? 'idle';
  const input = JSON.stringify(patch.input ?? (existing ? JSON.parse(existing.input) : null) ?? null);
  const brief = patch.brief !== undefined
    ? JSON.stringify(patch.brief)
    : (existing?.brief ?? null);
  const fill = patch.fill !== undefined ? JSON.stringify(patch.fill) : (existing?.fill ?? null);
  // 'spec' in patch 且值为 null => 清除既有产物；未传则保留
  const spec = 'spec' in patch
    ? (patch.spec == null ? null : JSON.stringify(patch.spec))
    : (existing?.spec ?? null);
  store
    .prepare(
      [
        'INSERT INTO topics (id, status, input, brief, fill, spec, created_at, updated_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
        'ON CONFLICT(id) DO UPDATE SET',
        '  status = excluded.status, input = excluded.input, brief = excluded.brief,',
        '  fill = excluded.fill, spec = excluded.spec, updated_at = excluded.updated_at',
      ].join(' '),
    )
    .run(id, status, input, brief, fill, spec, existing?.created_at ?? now, now);
  return getTopic(store, id) as TopicRow;
}

export function getTopic(store: Store, id: string): TopicRow | undefined {
  return store
    .prepare('SELECT * FROM topics WHERE id = ?')
    .get(id) as unknown as TopicRow | undefined;
}

export function listTopics(store: Store, limit = 20): TopicRow[] {
  return store.prepare('SELECT * FROM topics ORDER BY updated_at DESC LIMIT ?').all(limit) as unknown as TopicRow[];
}

// ---------- games ----------

export function putGame(
  store: Store,
  g: {
    id: string;
    spec_id: string;
    title: string;
    player: string;
    status: string;
    turn: number;
    total_rounds: number;
    state: unknown;
    metrics: unknown;
  },
): GameRow {
  const now = Date.now();
  const existing = getGame(store, g.id);
  store
    .prepare(
      [
        'INSERT INTO games (id, spec_id, title, player, status, turn, total_rounds, state, metrics, ended_at)',
        'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
        'ON CONFLICT(id) DO UPDATE SET',
        '  title = excluded.title, player = excluded.player, status = excluded.status,',
        '  turn = excluded.turn, total_rounds = excluded.total_rounds,',
        '  state = excluded.state, metrics = excluded.metrics',
      ].join(' '),
    )
    .run(
      g.id,
      g.spec_id,
      g.title,
      g.player,
      g.status,
      g.turn,
      g.total_rounds,
      JSON.stringify(g.state),
      JSON.stringify(g.metrics),
      existing?.ended_at ?? (g.status === 'ended' ? now : null),
    );
  return getGame(store, g.id) as GameRow;
}

export function getGame(store: Store, id: string): GameRow | undefined {
  return store.prepare('SELECT * FROM games WHERE id = ?').get(id) as unknown as GameRow | undefined;
}

export function listGames(store: Store, limit = 50): GameRow[] {
  return store.prepare('SELECT * FROM games ORDER BY turn DESC LIMIT ?').all(limit) as unknown as GameRow[];
}

// ---------- turns ----------

export function appendTurn(store: Store, gameId: string, turn: number, payload: unknown): void {
  store
    .prepare(
      [
        'INSERT INTO turns (game_id, turn, payload, created_at) VALUES (?, ?, ?, ?)',
        'ON CONFLICT(game_id, turn) DO UPDATE SET payload = excluded.payload',
      ].join(' '),
    )
    .run(gameId, turn, JSON.stringify(payload), Date.now());
}

export function getTurns(store: Store, gameId: string): { turn: number; payload: unknown }[] {
  const rows = store
    .prepare('SELECT turn, payload FROM turns WHERE game_id = ? ORDER BY turn')
    .all(gameId) as unknown as { turn: number; payload: string }[];
  return rows.map((r) => ({ turn: r.turn, payload: JSON.parse(r.payload) }));
}

export function getTurn(store: Store, gameId: string, turn: number): unknown | undefined {
  const row = store.prepare('SELECT payload FROM turns WHERE game_id = ? AND turn = ?').get(gameId, turn) as
    | { payload: string }
    | undefined;
  return row ? JSON.parse(row.payload) : undefined;
}

// ---------- kv ----------

export function kvSet(store: Store, key: string, value: unknown): void {
  store
    .prepare(
      [
        'INSERT INTO kv (key, value, updated_at) VALUES (?, ?, ?)',
        'ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at',
      ].join(' '),
    )
    .run(key, JSON.stringify(value), Date.now());
}

export function kvGet(store: Store, key: string): unknown | undefined {
  const row = store.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? JSON.parse(row.value) : undefined;
}

// ---------- events（SSE 持久化 + Last-Event-ID 续拉） ----------

export function appendEvent(store: Store, channel: string, event: string, data: unknown): number {
  const now = Date.now();
  const res = store
    .prepare('INSERT INTO events (channel, event, data, created_at) VALUES (?, ?, ?, ?)')
    .run(channel, event, JSON.stringify(data), now);
  // 超上限时清最旧 10%（保证断线续拉窗口不无限膨胀）
  const total = store.prepare('SELECT COUNT(*) AS n FROM events').get() as unknown as { n: number };
  if (total.n > EVENTS_CAP) {
    store
      .prepare('DELETE FROM events WHERE seq <= (SELECT seq FROM events ORDER BY seq LIMIT 1 OFFSET ?)')
      .run(Math.floor(EVENTS_CAP * 0.9));
  }
  return typeof res.lastInsertRowid === 'number' ? res.lastInsertRowid : Number(res.lastInsertRowid);
}

export interface EventFilter {
  afterSeq?: number; // Last-Event-ID 续拉：seq > afterSeq
  channel?: string | string[]; // 按频道过滤；不传 = 全量
  limit?: number;
}

export function listEvents(store: Store, opts: EventFilter = {}): StoredEvent[] {
  const q: string[] = ['SELECT seq, channel, event, data, created_at FROM events'];
  const args: (number | string)[] = [];
  if (opts.channel !== undefined) {
    const chans = Array.isArray(opts.channel) ? opts.channel : [opts.channel];
    q.push('WHERE channel IN (' + chans.map(() => '?').join(', ') + ')');
    args.push(...chans);
  }
  if (opts.afterSeq !== undefined) {
    q.push(opts.channel !== undefined ? 'AND seq > ?' : 'WHERE seq > ?');
    args.push(opts.afterSeq);
  }
  q.push('ORDER BY seq ASC');
  if (opts.limit !== undefined) {
    q.push('LIMIT ?');
    args.push(opts.limit);
  }
  const rows = store.prepare(q.join(' ')).all(...args) as unknown as StoredEvent[];
  return rows;
}