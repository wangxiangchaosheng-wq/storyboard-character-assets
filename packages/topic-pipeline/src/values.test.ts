/**
 * 数值司（values.ts）测试：
 * - 数字线索 → 指标实化（带单位），provenance 指明「去哪找真实数字」；
 * - 无数字 → 语域科目（估算口径标注）；
 * - 规则三件套 + 每条带 derivation（公式为什么这么推）；
 * - 多话题差异：不同话题 → 不同指标体系与推导；
 * - parseNumbers 容错：合法 JSON 可并入，垃圾输入返回 null；
 * - deriveNumbers 入口：mock 不可用 → 转离线，产物 shape 完整可执行。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { TopicBrief, Fact, FillResult } from '@sim/contracts';
import { MockChatProvider } from '@sim/llm';
import {
  deriveNumbers, deriveNumbersOffline, parseNumbers, valuesPrompt,
} from './values.ts';

function brief(title: string, body = ''): TopicBrief {
  return {
    id: 't',
    title,
    body: body || `关于「${title}」的讨论`,
    sections: [],
    asks: [],
    entities: [],
    takenAt: new Date().toISOString(),
  };
}

function fact(id: string, claim: string): Fact {
  return { id, claim, entity: 'x', source: 'rag' as const, estimated: false, confidence: 0.9 };
}

function fillWith(claims: string[]): FillResult {
  return { facts: claims.map((c, i) => fact(`f${i}`, c)), gaps: [] };
}

/** 给个稳定的 LLM JSON 样例（等价于真正模型可能吐出的 shape） */
const SAMPLE_LLM_JSON = JSON.stringify({
  metrics: [
    {
      key: 'troops', label: '兵力', min: 0, max: 100, start: 40, unit: '万',
      higherIsBetter: true, description: '可用兵力',
      provenance: { source: '史传兵册', how: '检索《晋书》本传', estimate: undefined },
    },
    {
      key: 'moral', label: '士气', min: 0, max: 100, start: 60,
      higherIsBetter: true, description: '战意',
      provenance: { source: '军志', how: '按战后士气记录估', estimate: '史料未载，按战况估计' },
    },
    {
      key: 'granary', label: '粮储', min: 0, max: 600, start: 260, unit: '万石',
      higherIsBetter: true, description: '仓廪所储',
      provenance: { source: '仓场簿录', how: '检索仓储册', estimate: undefined },
    },
    {
      key: 'popul', label: '民户', min: 0, max: 1200, start: 640, unit: '万户',
      higherIsBetter: true, description: '在籍民户',
      provenance: { source: '会典户册', how: '按黄册检索', estimate: undefined },
    },
  ],
  rules: [
    {
      id: 'r-drift', kind: 'drift', label: '消耗', description: '每轮兵力缓慢减少',
      target: 'troops', formula: '-0.5', appliesTo: ['troops'],
      derivation: { why: '长期消耗，处于进攻态势', ref: '军志·消耗表' },
    },
    {
      id: 'r-react', kind: 'reaction', label: '策略反馈', description: '决策影响各项',
      appliesTo: ['troops', 'moral', 'granary', 'popul'], bounds: 8,
      derivation: { why: '行动反馈幅度定 8 点', ref: '惯例' },
    },
    {
      id: 'r-thr', kind: 'threshold', label: '崩盘预警', description: '士气低于 25 触发',
      metric: 'moral', op: '<=', value: 25, fires: '士卒哗溃',
      derivation: { why: '低谷失衡门槛', ref: '惯例' },
    },
    {
      id: 'r-thr-gra', kind: 'threshold', label: '粮储告急', description: '粮储低于 180 触发',
      metric: 'granary', op: '<=', value: 180, fires: '仓廪见底',
      derivation: { why: '按三月之粮估定', ref: '仓储惯例' },
    },
    {
      id: 'r-drift-gra', kind: 'drift', label: '粮储消耗', description: '每轮粮储缓减',
      target: 'granary', formula: '-2', appliesTo: ['granary'],
      derivation: { why: '日常耗用', ref: '支给表' },
    },
    {
      id: 'r-thr-gra-hi', kind: 'threshold', label: '粮储高线', description: '粮储超 540 触发',
      metric: 'granary', op: '>=', value: 540, fires: '仓庾俱满',
      derivation: { why: '上限 90% 作溢出线', ref: '惯例' },
    },
  ],
});

test('离线：数字线索 → 指标实化，provenance 指明去哪找真实', () => {
  const nums = deriveNumbersOffline(
    brief('北伐'),
    fillWith(['诸葛亮率大军 12 万屯田汉中', '曹魏总兵力二十余万']),
    undefined,
  );
  assert.ok(nums.metrics.length >= 1, '有线索应产出指标');
  const wan = nums.metrics.find((m) => m.unit === '万');
  assert.ok(wan, '单位『万』的线索应构出指标');
  assert.equal(wan!.start, 12);
  const prov = nums.provenance.find((p) => p.metric === wan!.key);
  assert.ok(prov, '每个指标都要有 provenance');
  assert.ok((prov!.how ?? '').length > 0, 'provenance 应写检索/换算路径');
});

test('离线：无数字 → 语域科目（估算口径标注，真实史料科目）', () => {
  const nums = deriveNumbersOffline(
    brief('创业公司现金流紧张'),
    fillWith(['刚融完一轮但烧钱快', '团队观望']),
    undefined,
  );
  assert.ok(nums.metrics.length >= 2, '语域科目兜底');
  for (const m of nums.metrics) {
    const p = nums.provenance.find((x) => x.metric === m.key);
    assert.ok(p, '每个指标都要有 provenance');
  }
  // 兜底科目应标注估算
  assert.ok(
    nums.provenance.some((p) => p.estimate && p.estimate.length > 0),
    '无直接数字时 provenance 应给估算链',
  );
});

test('指标永不使用游戏化抽象词（军势/民望/士气/国力/局势/实力）', () => {
  const banned = ['军势', '民望', '士气', '国力', '局势', '实力', '民心'];
  for (const text of ['乏军粮，流民塞道', '税赋无着，府库空虚', '完全没有任何信号的短话题']) {
    const nums = deriveNumbersOffline(brief(text), fillWith([]), undefined);
    assert.ok(nums.metrics.length >= 2, `${text} 应产出兜底科目`);
    for (const m of nums.metrics) {
      for (const w of banned) {
        assert.ok(!m.label.includes(w), `指标名「${m.label}」不得含违规词「${w}」`);
      }
      assert.ok(m.unit && m.unit.length > 0, `指标「${m.label}」必须带真实单位`);
      assert.ok(m.start > 0, `指标「${m.label}」初值按史料量纲，大于 0`);
    }
  }
});

test('无数字无信号话题 → 兜底为真实科目（民户/粮储/岁入/兵额）且带量纲', () => {
  const nums = deriveNumbersOffline(brief('治理地方'), fillWith(['无从查证']), undefined);
  const labels = nums.metrics.map((m) => `${m.label}:${m.unit}`).join('|');
  assert.ok(labels.includes('民户'), labels);
  assert.ok(labels.includes('粮储'), labels);
  assert.ok(labels.includes('岁入'), labels);
  assert.ok(labels.includes('兵额'), labels);
  assert.ok(nums.metrics.length >= 4, '兜底科目至少 4 项');
  for (const m of nums.metrics) {
    assert.ok(m.start > 0, `「${m.label}」初值按常见量纲（start=${m.start}）`);
  }
});

test('离线：规则三件套 + 每条规则有 derivation，且覆盖全部指标', () => {
  const nums = deriveNumbersOffline(
    brief('常备话题'),
    fillWith(['大军三十万南下']),
    undefined,
  );
  const kinds = new Set(nums.rules.map((r) => r.kind));
  assert.ok(kinds.has('drift') && kinds.has('reaction') && kinds.has('threshold'), 'drift/reaction/threshold 齐');
  assert.equal(nums.rules.length, nums.derivations.length, '规则与推导一一对应');
  for (const d of nums.derivations) {
    assert.ok(d.formula && d.formula.length > 0, 'derivation 要带落地公式');
    assert.ok(d.why.length >= 6, 'derivation 要有理由');
  }
  const provKeys = nums.provenance.map((p) => p.metric).sort();
  const metricKeys = nums.metrics.map((m) => m.key).sort();
  assert.deepEqual(provKeys, metricKeys, 'provenance 覆盖全部指标');
});

test('多话题差异：两个话题 → 不同指标（不共享常量）', () => {
  const a = deriveNumbersOffline(brief('一年为期'), fillWith(['军饷200万两']), undefined);
  const b = deriveNumbersOffline(brief('足球队冲超'), fillWith(['三年内打进前八']), undefined);
  const labelsA = a.metrics.map((m) => m.label).join('|');
  const labelsB = b.metrics.map((m) => m.label).join('|');
  assert.notEqual(labelsA, labelsB, '两个话题的指标构成不应相同');
});

test('一句话提问自带的数字也构指标（考据为空时）', () => {
  const nums = deriveNumbersOffline(
    brief('淝水之战：前秦 80 万大军为何败给东晋 8 万北府兵？'),
    fillWith([]),
    undefined,
  );
  const m1 = nums.metrics.find((m) => m.label.startsWith('前秦') && m.start === 80);
  const m2 = nums.metrics.find((m) => m.label.startsWith('东晋') && m.start === 8);
  assert.ok(m1, '前秦 80 万 → 指标（起值 80）');
  assert.ok(m2, '东晋 8 万 → 指标（起值 8）');
  const q = nums.provenance.find((p) => p.source.includes('提问原文'));
  assert.ok(q, '来源标注为「提问原文自带数字」');
  assert.ok(q!.how.includes('检索'), '提问原文数字同样给真实复核路径');
});

test('parseNumbers：合法 LLM 输出 → 完整并入', () => {
  const r = parseNumbers(SAMPLE_LLM_JSON);
  assert.ok(r, '合法输出应解析成功');
  assert.equal(r!.metrics.length, 4);
  assert.equal(r!.rules.length, 6);
  assert.equal(r!.provenance.length, 4);
  assert.equal(r!.derivations.length, 6);
  assert.equal(r!.rules[0]!.kind, 'drift');
  assert.ok(r!.provenance[1]!.estimate, '估算链透传');
});

test('parseNumbers：垃圾输入 / 缺结构 → null（走离线兜底）', () => {
  assert.equal(parseNumbers('{not json'), null);
  assert.equal(parseNumbers('{"metrics":[]}'), null);
  assert.equal(parseNumbers('{"metrics":[{}],"rules":[]}'), null);
});

test('valuesPrompt：必带话题、事实、缺口与两重追溯要求', () => {
  const prompt = valuesPrompt(brief('诺曼底登录'), fillWith(['艾森豪威尔调动大军']), undefined);
  assert.ok(prompt.includes('诺曼底'), 'prompt 含话题');
  assert.ok(prompt.includes('考据'), 'prompt 呈现事实');
  assert.ok(prompt.includes('provenance'), 'prompt 要求出处');
  assert.ok(prompt.includes('derivation'), 'prompt 要求推导理由');
});

test('deriveNumbers 入口（mock）→ 离线产物，shape 完整可执行', async () => {
  const nums = await deriveNumbers(
    brief('增税三饷'),
    fillWith(['朝廷加征三饷']),
    undefined,
    new MockChatProvider(),
  );
  assert.ok(nums.metrics.length >= 2);
  assert.ok(nums.rules.length >= 3);
  assert.equal(nums.provenance.length, nums.metrics.length, '来源链覆盖');
  assert.equal(nums.derivations.length, nums.rules.length, '推导链覆盖');
});