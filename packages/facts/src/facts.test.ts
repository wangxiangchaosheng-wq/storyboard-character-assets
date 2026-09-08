/**
 * @sim/facts 验收（docs/07）：预置史料可检索（崇祯/王安石/安史三关键词 ≥3 条可溯源）、
 * BM25/余弦正确性、估算器校验路径、seed 幂等、embed 混合降级。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MockChatProvider, MockEmbedProvider } from '@sim/llm';
import { openDb, seedPresets, countFacts, getFact, upsertFact } from './db.ts';
import { tokenize, cosine, searchFacts } from './searcher.ts';
import { parseEstimate, estimateGap, estimatePrompt } from './estimator.ts';
import { createFactStore } from './index.ts';

test('tokenize：中英混排 → unigram+bigram+ascii', () => {
  const t = tokenize('北伐 228 AB');
  assert.ok(t.includes('北'));
  assert.ok(t.includes('北伐'));
  assert.ok(t.includes('228'));
  assert.ok(t.includes('ab'));
});

test('cosine：正交 0、共线 1、长度不匹配 0', () => {
  assert.equal(cosine([1, 0], [0, 1]), 0);
  assert.ok(Math.abs(cosine([1, 2], [2, 4]) - 1) < 1e-9);
  assert.equal(cosine([1], [1, 2]), 0);
});

test('seedPresets 幂等：二次 seed 总数不变，id 有序 rag-0001', () => {
  const db = openDb();
  const n1 = seedPresets(db);
  const n2 = seedPresets(db);
  assert.equal(n1, n2);
  assert.ok(n1 >= 26, `预置史料应 ≥26（实为 ${n1}）`);
  const first = getFact(db, 'rag-0001');
  assert.ok(first, 'rag-0001 存在');
  assert.equal(first.source, 'rag');
});

test('检索：崇祯 → 命中崇祯帝/煤山', () => {
  const db = openDb();
  seedPresets(db);
  const hits = searchFacts(db, '崇祯');
  assert.ok(hits.length >= 3, `崇祯应 ≥3 条（实为 ${hits.length}）`);
  assert.ok(hits[0].fact.claim.includes('崇祯'), `top1 应含崇祯: ${hits[0].fact.claim}`);
  assert.ok(
    hits.some((h) => h.fact.claim.includes('煤山') || h.fact.claim.includes('景山')),
    '应命中煤山/景山条目',
  );
});

test('检索：王安石：命中青苗法；安史：命中安禄山', () => {
  const db = openDb();
  seedPresets(db);
  const w = searchFacts(db, '王安石 青苗法');
  assert.ok(w.some((h) => h.fact.claim.includes('青苗')), `王安石组应有青苗条目: ${JSON.stringify(w.map((x) => x.fact.claim))}`);
  const a = searchFacts(db, '安史之乱');
  assert.ok(a.length >= 3, `安史应 ≥3 条（实为 ${a.length}）`);
  assert.ok(a.some((h) => h.fact.claim.includes('安禄山')));
});

test('检索：minConfidence 过滤与 limit', () => {
  const db = openDb();
  seedPresets(db);
  upsertFact(db, {
    id: 'low-conf',
    claim: '崇祯年号传闻考',
    entity: '崇祯',
    source: 'ai_estimate',
    estimated: true,
    confidence: 0.3,
    basis: '测试低置信条目',
  });
  const strict = searchFacts(db, '崇祯', { minConfidence: 0.6 });
  assert.ok(!strict.some((h) => h.fact.id === 'low-conf'), '低置信应被过滤');
  const loose = searchFacts(db, '崇祯', { minConfidence: 0.2 });
  assert.ok(loose.some((h) => h.fact.id === 'low-conf'), '放宽门槛应放行');
  const limited = searchFacts(db, '崇祯', { limit: 2 });
  assert.ok(limited.length <= 2);
});

test('检索：无关键词也能翻出（实体兜底）', () => {
  const db = openDb();
  seedPresets(db);
  const hits = searchFacts(db, '诸葛亮');
  assert.ok(hits.length >= 3, `诸葛亮组应 ≥3 条（实为 ${hits.length}）`);
});

test('估算：非法 JSON → null；区间错乱 → null；规范 → draft', () => {
  assert.equal(parseEstimate('not json'), undefined);
  assert.equal(parseEstimate(JSON.stringify({ value: 5, min: 9, max: 10, basis: 'x' })), undefined);
  assert.equal(parseEstimate(JSON.stringify({ value: 5, min: 4, max: 6, basis: '' })), undefined);
  const ok = parseEstimate(JSON.stringify({ value: 42, min: 30, max: 50, basis: '由XX推', confidence: 0.6 }));
  assert.ok(ok);
  assert.equal(ok.value, 42);
});

test('estimateGap：LLM 不可解析 → undefined（不编造）；可解析 → estimated=true + basis', async () => {
  const bad = new MockChatProvider({});
  const g = { topic: '汉中之战蜀军兵力', whyMissing: '影响战役推演规模' };
  const none = await estimateGap(bad, g, '0001');
  assert.equal(none, undefined, 'mock 无剧本应返回 undefined');

  const script = new MockChatProvider({
    [estimatePrompt(g)]: JSON.stringify({ value: 10, min: 8, max: 12, unit: '万', basis: '据《三国志》零星记载推断', confidence: 0.55 }),
  });
  const fact = await estimateGap(script, g, '0001');
  assert.ok(fact, '有剧本应返回估算');
  assert.equal(fact.source, 'ai_estimate');
  assert.equal(fact.estimated, true);
  assert.ok(fact.basis?.includes('推断'));
  assert.equal(fact.id, 'est-0001');
});

test('FactService：seed 预置 → search 可查 → 内存库 → estimate 入库自增', async () => {
  const svc = await createFactStore({ embed: new MockEmbedProvider() });
  assert.ok(svc.count() >= 20);
  const hits = await svc.search('崇祯');
  assert.ok(hits.length >= 3);
  const g = { topic: '子午谷行军天数', whyMissing: '决定奇袭窗口' };
  const est = await svc.estimate(new MockChatProvider({}), g);
  assert.equal(est, undefined, 'mock 无剧本 → 估算降级');
  const n = svc.count();
  await svc.reembed();
  assert.equal(svc.count(), n, 'reembed 不改条目数');
  svc.close();
});

test('FactService：dbPath 落盘 + 重启后 seed 不重复', () => {
  const dir = mkdtempSync(join(tmpdir(), 'facts-'));
  const p = join(dir, 'fg.db');
  try {
    const a = openDb(p);
    seedPresets(a);
    const n = countFacts(a);
    a.close();
    const b = openDb(p);
    seedPresets(b);
    assert.equal(countFacts(b), n, '二次 seed 不重复');
    b.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('无 embed 供应商 → 纯 BM25，检索不报错（向量段跳过）', async () => {
  const svc = await createFactStore({});
  const hits = await svc.search('安史之乱');
  assert.ok(hits.length >= 3, `无 embed 也应返回 BM25 命中（实为 ${hits.length}）`);
  svc.close();
});