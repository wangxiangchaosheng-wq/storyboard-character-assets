/**
 * 检索（docs/07 §5）：词形归一（中文按字切分 + 英文小写）→ BM25 打分；
 * 可选向量相似度（余弦）与 BM25 按权重混合。
 * 过滤：confidence ≥ minConfidence（默认 0.6）——估算项也要达到置信门槛才出示。
 */
import type { Fact } from '@sim/contracts';
import type { FactStore } from './db.ts';
import { allFacts } from './db.ts';

export interface SearchHit {
  fact: Fact;
  score: number;
}

export const K1 = 1.5;
export const B = 0.75;

/** 最小相关性门：归一化 BM25 分低于此值的命中视为纯词频噪音
 *  （如「爆发」二字把不相干的二战文档带到一战话题），直接丢弃。
 *  0.03 仅拦「几乎零分」的擦边命中；真实弱关联（同主题二次文档）仍可保留。 */
export const MIN_SCORE = 0.03;

/** 中英混排分词：连续 ASCII 词保留（小写）；CJK 段拆 unigram + bigram。 */
export function tokenize(text: string): string[] {
  const out: string[] = [];
  const ascii = text.match(/[a-zA-Z0-9_]+/g) ?? [];
  for (const w of ascii) out.push(w.toLowerCase());
  const cjk = text.match(/[\u4e00-\u9fff\u3400-\u4dbf]+/g) ?? [];
  for (const run of cjk) {
    for (const ch of run) out.push(ch);
    for (let i = 0; i < run.length - 1; i++) out.push(run.slice(i, i + 2));
  }
  return out;
}

/** 归一化 BM25 打分（idf 平滑，防罕见词过拟合）。 */
export function bm25Score(
  query: string[],
  docTokens: string[],
  df: Map<string, number>,
  total: number,
  avgDl: number,
): number {
  const k1 = K1;
  const b = B;
  const tf = new Map<string, number>();
  for (const t of docTokens) tf.set(t, (tf.get(t) ?? 0) + 1);
  const dl = docTokens.length;
  let score = 0;
  for (const q of query) {
    const n = df.get(q) ?? 0;
    if (n === 0) continue;
    const idf = Math.log(1 + (total - n + 0.5) / (n + 0.5));
    const t = tf.get(q) ?? 0;
    score += idf * ((t * (k1 + 1)) / (t + k1 * (1 - b + (b * dl) / avgDl)));
  }
  return score;
}

/** 余弦相似度。 */
export function cosine(a: number[], bb: number[]): number {
  if (a.length === 0 || a.length !== bb.length) return 0;
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * bb[i];
    na += a[i] * a[i];
    nb += bb[i] * bb[i];
  }
  if (na === 0 || nb === 0) return 0;
  return dot / (Math.sqrt(na) * Math.sqrt(nb));
}

/** 从库中读取某条 fact 的已存向量。 */
function getEmbedded(db: FactStore, id: string): number[] | undefined {
  const row = db
    .prepare('SELECT embedded FROM facts WHERE id = ?')
    .get(id) as { embedded?: string } | undefined;
  if (!row?.embedded) return undefined;
  try {
    const v = JSON.parse(row.embedded) as number[];
    return Array.isArray(v) ? v : undefined;
  } catch {
    return undefined;
  }
}

/**
 * 混合检索主入口：
 * - 稀疏：BM25（文档 = entity + claim + tags）
 * - 稠密（可选）：facts.embedded × queryVector 余弦
 * - 按权重加权（默认 0.7 / 0.3），max 归一后降序，confidence ≥ minConfidence。
 */
export function searchFacts(
  db: FactStore,
  query: string,
  opts: {
    limit?: number;
    minConfidence?: number;
    weightSparse?: number;
    weightDense?: number;
    queryVector?: number[];
  } = {},
): SearchHit[] {
  const limit = opts.limit ?? 8;
  const minConfidence = opts.minConfidence ?? 0.6;
  const wSparse = opts.weightSparse ?? 0.7;
  const wDense = opts.weightDense ?? 0.3;

  const facts = allFacts(db).filter((f) => f.confidence >= minConfidence);
  if (facts.length === 0) return [];

  const qTokens = tokenize(query.toLowerCase()).filter(
    // 中文单字丢弃（「战」「欧」这类泛字会把跨题材文档都带进来）；
    // 数字/英文 token 保留（1944、b2b 等有实体性）
    (t) => /[a-z0-9_]/.test(t) || t.length >= 2,
  );
  const docs = facts.map((f) => tokenize(`${f.entity} ${f.claim} ${(f.tags ?? []).join(' ')}`));
  const total = facts.length;
  const df = new Map<string, number>();
  const seen = new Set<string>();
  for (const d of docs) {
    seen.clear();
    for (const t of d) {
      if (!seen.has(t)) {
        seen.add(t);
        df.set(t, (df.get(t) ?? 0) + 1);
      }
    }
  }
  const avgDl = docs.reduce((s, d) => s + d.length, 0) / Math.max(1, total);

  const raw = facts.map((f, i) => {
    const sparse = bm25Score(qTokens, docs[i], df, total, avgDl);
    let dense = 0;
    if (opts.queryVector && opts.queryVector.length > 0) {
      const vec = getEmbedded(db, f.id);
      if (vec) dense = cosine(opts.queryVector, vec);
    }
    return { fact: f, sparse, dense };
  });

  const sMax = Math.max(...raw.map((x) => x.sparse), 1e-6);
  const dMax = Math.max(...raw.map((x) => x.dense), 1e-6);
  return raw
    .map((x) => ({ fact: x.fact, score: wSparse * (x.sparse / sMax) + wDense * (x.dense / dMax) }))
    .filter((x) => x.score >= MIN_SCORE)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit);
}