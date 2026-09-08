/**
 * SQLite 事实库（docs/07 §3）：node:sqlite DatabaseSync（Node ≥22.5，同步、WAL）。
 * 表：facts(id, claim, entity, source, estimated, confidence, basis, url, tags, embedded)
 * seedPresets 幂等：同一 id 再次执行原地更新，不重复入库。
 * 全部 SQL 均为静态常量 + 参数占位符，无任何拼接、无 shell 执行。
 */
import { DatabaseSync } from 'node:sqlite';
import type { Fact } from '@sim/contracts';
import { PRESET_FACTS } from './preset.ts';

export type FactStore = DatabaseSync;

export type FactRow = {
  id: string;
  claim: string;
  entity: string;
  source: string;
  estimated: number; // 0|1
  confidence: number;
  basis: string | null;
  url: string | null;
  tags: string; // JSON array，或 ''
  embedded: string; // JSON array（向量），或 ''
};

const DDL_FACTS_TABLE = [
  'CREATE TABLE IF NOT EXISTS facts (',
  '  id         TEXT PRIMARY KEY,',
  '  claim      TEXT NOT NULL,',
  '  entity     TEXT NOT NULL,',
  '  source     TEXT NOT NULL,',
  '  estimated  INTEGER NOT NULL DEFAULT 0,',
  '  confidence REAL NOT NULL DEFAULT 0.5,',
  '  basis      TEXT,',
  '  url        TEXT,',
  '  tags       TEXT NOT NULL DEFAULT \'[]\',',
  '  embedded   TEXT NOT NULL DEFAULT \'\'',
  ')',
].join(' ');
const DDL_IDX_ENTITY = 'CREATE INDEX IF NOT EXISTS idx_facts_entity ON facts(entity)';
const DDL_IDX_SOURCE = 'CREATE INDEX IF NOT EXISTS idx_facts_source ON facts(source)';
const SQL_COUNT = 'SELECT COUNT(*) AS n FROM facts';
const SQL_ALL = 'SELECT * FROM facts ORDER BY id';
const SQL_GET = 'SELECT * FROM facts WHERE id = ?';
const SQL_UPSERT = [
  'INSERT INTO facts (id, claim, entity, source, estimated, confidence, basis, url, tags, embedded)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
  'ON CONFLICT(id) DO UPDATE SET',
  '  claim = excluded.claim, entity = excluded.entity, source = excluded.source,',
  '  estimated = excluded.estimated, confidence = excluded.confidence,',
  '  basis = excluded.basis, url = excluded.url, tags = excluded.tags,',
  '  embedded = CASE WHEN excluded.embedded = \'\' THEN facts.embedded ELSE excluded.embedded END',
].join(' ');
const SQL_SEED = [
  'INSERT INTO facts (id, claim, entity, source, estimated, confidence, basis, url, tags)',
  'VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
].join(' ');
const SQL_SET_EMBED = 'UPDATE facts SET embedded = ? WHERE id = ?';
const SQL_CLEAR_EMBED = [
  'UPDATE facts SET embedded = ?',
].join(' ');

export function openDb(path?: string): FactStore {
  const db = new DatabaseSync(path ?? ':memory:');
  // PRAGMA 与 DDL 均为静态单语句，prepare 后逐条执行（不把输入放进 SQL）。
  const wire = db.prepare('PRAGMA journal_mode = WAL');
  wire.get();
  db.prepare(DDL_FACTS_TABLE).run();
  db.prepare(DDL_IDX_ENTITY).run();
  db.prepare(DDL_IDX_SOURCE).run();
  return db;
}

export function dbToFact(row: FactRow): Fact {
  let tags: string[] = [];
  try {
    tags = row.tags ? (JSON.parse(row.tags) as string[]) : [];
  } catch {
    /* 脏数据按无标签处理 */
  }
  return {
    id: row.id,
    claim: row.claim,
    entity: row.entity,
    source: row.source as Fact['source'],
    estimated: row.estimated === 1,
    confidence: row.confidence,
    basis: row.basis ?? undefined,
    url: row.url ?? undefined,
    tags,
  };
}

/** 把 Fact 序列化进表（upsert）。embedded 显式传入才写，否则保留原值。 */
export function upsertFact(db: FactStore, fact: Fact, embedded?: number[]): void {
  const stmt = db.prepare(SQL_UPSERT);
  stmt.run(
    fact.id,
    fact.claim,
    fact.entity,
    fact.source,
    fact.estimated ? 1 : 0,
    fact.confidence,
    fact.basis ?? null,
    fact.url ?? null,
    JSON.stringify(fact.tags ?? []),
    embedded ? JSON.stringify(embedded) : '',
  );
}

/** 幂等种入预置史料（id = rag-0001…），返回总条数。 */
export function seedPresets(db: FactStore): number {
  const cur = db.prepare(SQL_COUNT).get() as { n: number };
  if (cur.n === 0) {
    const seed = db.prepare(SQL_SEED);
    PRESET_FACTS.forEach((f, i) => {
      seed.run(
        `rag-${String(i + 1).padStart(4, '0')}`,
        f.claim,
        f.entity,
        f.source,
        f.estimated ? 1 : 0,
        f.confidence,
        f.basis ?? null,
        f.url ?? null,
        JSON.stringify(f.tags ?? []),
      );
    });
  }
  return (db.prepare(SQL_COUNT).get() as { n: number }).n;
}

/** 全量（无分页，内部库规模小；检索过滤在内存做）。 */
export function allFacts(db: FactStore): Fact[] {
  const rows = db.prepare(SQL_ALL).all() as unknown as FactRow[];
  return rows.map(dbToFact);
}

export function countFacts(db: FactStore): number {
  return (db.prepare(SQL_COUNT).get() as { n: number }).n;
}

export function getFact(db: FactStore, id: string): Fact | undefined {
  const row = db.prepare(SQL_GET).get(id) as FactRow | undefined;
  return row ? dbToFact(row) : undefined;
}

/** 设置向量（供混合检索）。 */
export function setEmbedding(db: FactStore, id: string, vec: number[]): void {
  db.prepare(SQL_SET_EMBED).run(JSON.stringify(vec), id);
}

export function clearEmbeddings(db: FactStore): void {
  db.prepare(SQL_CLEAR_EMBED).run('');
}