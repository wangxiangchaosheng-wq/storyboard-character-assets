/**
 * @sim/facts —— 历史数据与检索（docs/07）。
 * 聚合入口：SQLite 事实库（预设史料 + 可扩展条目）→ BM25 检索引擎（可选向量混合）→ 缺口估算器。
 * 降级链：无 key / 无 embed → 纯 BM25 + preset；LLM 不可用 → 估算返回空，不中断管线。
 */
import type { Fact } from '@sim/contracts';
import type { ChatProvider, EmbedProvider } from '@sim/llm';
import { openDb, seedPresets, upsertFact, countFacts, getFact, setEmbedding, clearEmbeddings } from './db.ts';
import type { FactStore } from './db.ts';
import { searchFacts } from './searcher.ts';
import type { EstimateGap } from './estimator.ts';
import { estimateGap } from './estimator.ts';

export type { FactStore } from './db.ts';
export { openDb, seedPresets, countFacts, getFact } from './db.ts';
export { tokenize, bm25Score, cosine, searchFacts } from './searcher.ts';
export type { SearchHit } from './searcher.ts';
export { estimateGap, parseEstimate, estimatePrompt } from './estimator.ts';
export type { EstimateGap } from './estimator.ts';
export { PRESET_FACTS } from './preset.ts';
export type { PresetFact } from './preset.ts';

export interface FactStoreOptions {
  /** 真实库路径；缺省 = 内存库（进程内，测试/演示用）。 */
  dbPath?: string;
  /** 向量器（可选）。有则启动时对全库补向量，检索引启用稠密混合。 */
  embed?: EmbedProvider;
  /** 检索过滤阈值（缺省 0.6）。 */
  minConfidence?: number;
}

export interface FactService {
  /** BM25（+可选向量）检索，返回按相关度降序的 Fact[]。 */
  search(query: string, opts?: { limit?: number }): Promise<Fact[]>;
  /** 缺口估算（LLM 不可用 / 不合格时返回 undefined，绝不编造）。 */
  estimate(llm: ChatProvider, gap: EstimateGap): Promise<Fact | undefined>;
  count(): number;
  get(id: string): Fact | undefined;
  /** 显式重建向量（embed 供应商变更后重灌）。 */
  reembed(): Promise<number>;
  /** 关闭底层 db。 */
  close(): void;
}

export async function createFactStore(opts: FactStoreOptions = {}): Promise<FactService> {
  const db: FactStore = openDb(opts.dbPath);
  seedPresets(db);

  const service: FactService = {
    async search(query, searchOpts = {}) {
      let queryVector: number[] | undefined;
      if (opts.embed) {
        try {
          const [v] = await opts.embed.embed([query]);
          queryVector = v;
        } catch {
          /* 向供应商故障 → 纯 BM25，不中断 */
        }
      }
      const hits = searchFacts(db, query, {
        limit: searchOpts.limit ?? 8,
        minConfidence: opts.minConfidence ?? 0.6,
        queryVector,
      });
      return hits.map((h) => h.fact);
    },

    async estimate(llm, gap) {
      const fact = await estimateGap(llm, gap, String(service.count() + 1).padStart(4, '0'));
      if (fact) upsertFact(db, fact);
      return fact;
    },

    count: () => countFacts(db),
    get: (id) => getFact(db, id),
    close: () => db.close(),
    async reembed() {
      if (!opts.embed) return 0;
      const facts = db
        .prepare('SELECT id, claim, entity FROM facts')
        .all() as { id: string; claim: string; entity: string }[];
      const vecs = await opts.embed.embed(facts.map((f) => `${f.entity} ${f.claim}`));
      facts.forEach((f, i) => {
        const v = vecs[i];
        if (v) setEmbedding(db, f.id, v);
      });
      return facts.length;
    },
  };

  // 启动时若有 embed → 预灌向量（reembed 幂等）
  if (opts.embed && countFacts(db) > 0) {
    clearEmbeddings(db);
    await service.reembed();
  }

  return service;
}