/**
 * 管线离线端到端（mock 提供器）：文本话题 → ready。
 * URL 分支不联网：用私网地址验证 SSRF 门禁（safeFetch 拒绝 → failed）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockChatProvider } from '@sim/llm';
import type { TopicBrief, Fact, FillResult } from '@sim/contracts';
import { runPipeline } from './pipeline.ts';
import { collectFacts, factPrompt } from './facts.ts';
import { composeDrama, isPersonName } from './drama.ts';

test('文本话题 × mock ⇒ 全链路至 ready，且带估算占比', async () => {
  const seen: string[] = [];
  const res = await runPipeline(
    { kind: 'text', text: '蜀汉北伐：子午谷奇谋是否有可行之法？' },
    { chat: new MockChatProvider(), onStatus: (s) => { seen.push(s.state); } },
  );

  assert.equal(res.status.state, 'ready');
  for (const st of ['ingesting', 'filling', 'generating', 'validating']) {
    assert.ok(seen.includes(st), `状态机应路过 ${st}`);
  }
  assert.ok(res.spec, '必须产出 spec');
  assert.ok(res.brief, '必须产出 brief');
  assert.equal(typeof res.status.estimatedRate, 'number');
});

test('URL 私网目标 ⇒ safeFetch 门禁 → failed（不发起真实请求）', async () => {
  const res = await runPipeline({ kind: 'url', url: 'https://127.0.0.1:1/x' });
  assert.equal(res.status.state, 'failed');
  assert.ok(res.status.lastRevision?.[0]?.includes('拒绝'), 'failed 应带失败原因');
});

test('isPersonName：人物通过；概念/兵种实体拒绝', () => {
  for (const ok of ['诸葛亮', '司马懿', '希特勒', '艾森豪威尔', '兴登堡', '崇祯帝', '王安石', '李自成']) {
    assert.ok(isPersonName(ok), `${ok} 应视为人物`);
  }
  for (const bad of ['青苗法', '北伐', '子午谷', '马嵬坡', '藩镇', '三饷', '己巳之变', '德军', '苏军', '安史之乱', 'a', '路易十四国王陛下']) {
    assert.ok(!isPersonName(bad), `${bad} 不应视为人物`);
  }
});

test('构演司：人物实体制 cast、概念实体不进；首对立场强制对立；史实入事件', async () => {
  const brief: TopicBrief = {
    id: 'ww2-t',
    title: '二战欧洲战场：1944年诺曼底登陆后，西线联军如何推进',
    body: '1944年6月6日盟军登陆诺曼底。',
    sections: [{ heading: '背景', text: '诺曼底登陆' }],
    asks: ['西线如何推进？'],
    entities: [{ name: '艾森豪威尔', kind: 'person' }],
    sourceUrl: 'https://example.com/ww2',
    takenAt: new Date().toISOString(),
  };
  const facts: Fact[] = [
    {
      id: 'f1', claim: '1944年6月6日，艾森豪威尔任盟军最高统帅，指挥诺曼底登陆，开辟第二战场。',
      entity: '艾森豪威尔', source: 'rag', estimated: false, confidence: 0.9,
    },
    {
      id: 'f2', claim: '1939年9月1日，希特勒下令德军闪击波兰，英法对德宣战。',
      entity: '希特勒', source: 'rag', estimated: false, confidence: 0.95,
    },
    {
      id: 'f3', claim: '1945年5月8日，德国无条件投降，欧洲战事结束。',
      entity: '德军', source: 'rag', estimated: false, confidence: 0.95,
    },
    {
      id: 'f4', claim: '青苗法由官府于春耕时贷款给农民，秋收加息归还。',
      entity: '青苗法', source: 'rag', estimated: false, confidence: 0.8,
    },
  ];
  const fill: FillResult = { facts, gaps: [] };
  const drama = await composeDrama(brief, fill, new MockChatProvider());
  assert.ok(drama, '有同名人物实体时应产出剧本');
  const names = drama!.cast.map((c) => c.name);
  for (const n of names) {
    assert.ok(!['德军', '青苗法'].includes(n), `概念实体 ${n} 不得进入 cast`);
  }
  assert.ok(names.includes('艾森豪威尔') && names.includes('希特勒'), '两人物应同时在 cast');
  assert.ok(drama!.cast.length >= 2 && drama!.cast[0]!.stance !== drama!.cast[1]!.stance, '须保证至少两类立场');
  assert.ok((drama!.seedEvents ?? []).some((e) => e.includes('诺曼底')) && (drama!.seedEvents ?? []).some((e) => e.includes('闪击波兰')));
});

test('构演司：无人物考据但史实存在 → 情境剧本仍可成局（背景/事件引自史实）', async () => {
  const brief: TopicBrief = {
    id: 'fb-t',
    title: '唐朝安史之乱后藩镇割据，中央为何无力节制河北三镇？',
    body: '唐朝安史之乱后藩镇割据，中央为何无力节制河北三镇？',
    sections: [],
    asks: ['中央为何无力节制河北三镇？'],
    entities: [{ name: '安禄山', kind: 'other' }],
    sourceUrl: '',
    takenAt: new Date().toISOString(),
  };
  const fill: FillResult = {
    facts: [
      {
        id: 'f1', claim: '天宝十四载（755），范阳（兼卢龙）节度使安禄山起兵叛唐，安史之乱爆发。',
        entity: '安史之乱', source: 'rag', estimated: false, confidence: 0.9,
      },
      {
        id: 'f2', claim: '安史乱后河北藩镇割据延续近二百年。',
        entity: '藩镇', source: 'rag', estimated: false, confidence: 0.9,
      },
    ],
    gaps: [],
  };
  const drama = await composeDrama(brief, fill, new MockChatProvider());
  assert.ok(drama, '有确认史实即应产出情境剧本');
  assert.ok((drama!.seedEvents ?? []).length >= 1, '开局事件应引自史实');
  assert.ok((drama!.background ?? '').includes('安史之乱'), '背景应含史实');
  assert.equal((drama!.cast ?? []).length, 0, '无人物考据时 cast 留空（上层用默认阵容）');
});

test('考据：语义亲和门 —— 跨题材实体的「爆发」词命中不进入收集结果', async () => {
  const brief: TopicBrief = {
    id: 'ww1-t',
    title: '一战：1914年萨拉热窝事件爆发，马恩河战役后西线堑壕僵持',
    body: '1914年6月28日，斐迪南大公在萨拉热窝遇刺。',
    sections: [{ heading: '背景', text: '马恩河' }],
    asks: ['西线为何僵持？'],
    entities: [{ name: '斐迪南大公', kind: 'person' }],
    sourceUrl: 'https://example.com/ww1',
    takenAt: new Date().toISOString(),
  };
  const chat = new MockChatProvider(); // mock 回显非结构化 → 走关键词直查
  const res = await collectFacts(brief, chat, {
    search: {
      find: async () => [
        {
          id: 'hit-ww2',
          claim: '1939年9月1日，希特勒下令德军闪击波兰，二战全面爆发。',
          entity: '希特勒',
          source: 'rag' as const,
          estimated: false,
          confidence: 0.95,
          tags: ['二战', '波兰'],
        },
        {
          id: 'hit-ww1',
          claim: '1914年6月28日，奥匈帝国皇储斐迪南大公在萨拉热窝遇刺。',
          entity: '斐迪南大公',
          source: 'rag' as const,
          estimated: false,
          confidence: 0.95,
          tags: ['一战', '萨拉热窝'],
        },
      ],
    },
  });
  const entities = res.facts.map((f) => f.entity);
  assert.ok(entities.includes('斐迪南大公'), '同话题的史实应被采纳');
  assert.ok(!entities.includes('希特勒'), '跨题材（二战）实体不应被「爆发」二字典型带入');
});

test('collectFacts：检索 find 注入 → rag 命中并入；估算兜底 → ai_estimate 并入', async () => {
  const brief = {
    id: 't-1',
    title: '崇祯朝的财政困局如何破？',
    body: '明朝末年，内忧外患，财政破产。',
    sections: [{ heading: '背景', text: '内忧外患' }],
    asks: ['如何破局？'],
    entities: [{ name: '崇祯', kind: 'person' as const }],
    sourceUrl: 'https://example.com/x',
    takenAt: new Date().toISOString(),
  };
  const prompt = factPrompt(brief);
  const chat = new MockChatProvider({
    [prompt]: JSON.stringify({
      facts: [{ claim: '明朝末年财政窘迫', entity: '崇祯', estimated: true, confidence: 0.8 }],
      gaps: [{ topic: '崇祯朝年财政收入', whyMissing: '影响财政推演模型' }],
    }),
  });
  const res = await collectFacts(brief, chat, {
    search: {
      find: async () => [
        {
          id: 'rag-0001',
          claim: '崇祯十七年（1644）三月，李自成破燕京。',
          entity: '崇祯帝',
          source: 'rag' as const,
          estimated: false,
          confidence: 0.95,
        },
      ],
    },
    estimate: async (g) => ({
      id: 'est-x',
      claim: g.topic + '约 300 万两',
      entity: g.topic,
      source: 'ai_estimate' as const,
      estimated: true,
      confidence: 0.5,
      basis: '通说估算',
    }),
  });
  assert.ok(res.facts.some((f) => f.source === 'rag'), 'rag 命中应并入 facts');
  assert.ok(res.facts.some((f) => f.source === 'ai_estimate'), '估算兜底应并入 facts');
  assert.ok(res.gaps.length >= 1, '缺口透传');
});