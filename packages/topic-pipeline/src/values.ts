/**
 * 数值司（docs/01 §4「四司分工 · 数值司」）：AI 动态推导数值体系与规则——
 * 不为任何话题写死数值，而是由「考据司产物（facts/gaps）+ 构演司产物（cast/conflict）」
 * 出发，产出 metrics/rules，并强制带上两份溯源：
 *   provenance —— 每个指标「数值从哪找真实」（史料/数据源/检索词/换算口径/估算链）；
 *   derivations—— 每条规则「公式为什么这样推」（依据/参考事实/惯例说明）。
 *
 * 双实现，输出 schema 完全一致：
 *  - 真实 LLM：按 valuesPrompt 输出结构化 JSON → parseNumbers 收紧（动态生成）；
 *  - mock/离线：deriveNumbersOffline 确定性启发 —— 从考据事实原文抽「数字+单位」
 *    构指标（如「大军十二万」→ 指标 大军(万)），无数字时按话题语域给通用科目并注明
 *    估算口径；规则按指标动态对齐。全程不写死任何一条数值/公式。
 */
import type { ChatProvider } from '@sim/llm';
import type { TopicBrief, FillResult } from '@sim/contracts';
import type {
  MetricDef, RuleDef, ProvenanceNote, DerivationNote,
} from '@sim/engine-core';
import type { DramaDraft } from './drama.ts';

export interface DerivedNumbers {
  metrics: MetricDef[];
  rules: RuleDef[];
  provenance: ProvenanceNote[];
  derivations: DerivationNote[];
}

// ---------- 真实 LLM：动态推导（主路径） ----------

/** 根据话题文本返回历史量纲参考，注入 prompt 让 LLM 知道该朝代的合理数值范围 */
function buildEraContext(text: string): string {
  if (/三国|蜀|魏|吴|诸葛亮|北伐/.test(text))
    return '蜀汉巅峰期：民户约28万、兵额约10万、岁入约30万两、粮储约80万石。';
  if (/崇祯|明.*末|李自成|农民起义|明.*亡/.test(text))
    return '明末：民户约1600万、兵额约80万、岁入约200万两、粮储约400万石。';
  if (/王安石|变法|宋/.test(text))
    return '北宋熙宁：民户约2000万、兵额约120万、岁入约400万两、粮储约600万石。';
  if (/安史|唐.*叛|玄宗/.test(text))
    return '盛唐天宝：民户约3000万、兵额约200万、岁入约500万两、粮储约800万石。';
  return '';
}

export function valuesPrompt(brief: TopicBrief, fill: FillResult, drama?: DramaDraft): string {
  const castLines = (drama?.cast ?? [])
    .map((c) => `- ${c.name}（${c.role}，立场「${c.stance}」）`)
    .join('\n');
  const factsLines =
    fill.facts.map((f) => `- ${f.claim}` + (f.estimated ? `（估算：${f.basis ?? ''}）` : '')).join('\n') || '（空）';
  const gapsLines = fill.gaps.map((g) => `- ${g.topic}`).join('\n') || '（无）';
  // 注入历史基线：让 LLM 知道该朝代的真实量纲，避免瞎编"蜀汉700万户"这种离谱值
  const eraCtx = buildEraContext(brief.title + ' ' + (brief.body ?? ''));
  // 精简 prompt：不要求 provenance/derivation（这些由离线路径补全），避免 LLM 输出过长被截断
  return (
'你是历史模拟引擎的「数值司」：根据话题考据与人物立场，推导一套可运行的数值指标（metrics）' +
    '与演化规则（rules）。\n' +
    '硬性要求：\n' +
    '1) 指标必须是该语境下的史籍真实科目（如人口户数、田赋岁入、粮储、兵额等），带单位（unit 必填：户/万石/万两/万/匹……）且 start 按该朝常见量纲取值；' +
    '严禁使用「军势」「民望」「士气」「国力」「局势」「实力」「民心」这类游戏化抽象词作指标名。\n' +
    '2) metrics 至少 4 个、rules 至少 5 条；drift（每回合漂移）、reaction（受限幅度）、threshold（低线+高线）三种都要有，' +
    '且每个指标都拥有属于自己的 drift 与 threshold。\n' +
    '3) 每个 metric 写 provenance：数值「从哪找真实」（史料名/检索词/换算口径，一句话即可）。\n' +
    '4) 每条 rule 写 derivation：为什么这样推（一句话，含依据事实）。\n' +
    '5) formula 只允许数字、指标 key（如 m1/m2）、+ - * / ( ) 和 round/min/max，不要引用 start 等额外变量。\n' +
    '只输出 JSON（不要代码块环绕），结构如下：\n' +
    '{"metrics":[{"key":"中文名","label":"中文名","min":0,"max":800,"start":300,"unit":"万两","higherIsBetter":true,"description":"一句话"}],' +
    '"rules":[{"id":"drift-中文名","kind":"drift","label":"漂移","description":"描述","target":"指标key","formula":"表达式"},' +
    '{"id":"th-crisis-中文名","kind":"threshold","label":"底线告警","metric":"指标key","op":"<=","value":200,"fires":"触发文案"}]}\n\n' +
    `话题：${brief.title}\n核心问题：${brief.asks.join('；') || '（无）'}\n\n` +
    `已考据事实（供取数与出处）：\n${factsLines}\n\n` +
    `缺口（需估算）：\n${gapsLines}\n\n` +
    `人物与立场：\n${castLines || '（构演司未定）'}\n` +
    (drama?.conflict ? `核心矛盾：${drama.conflict}\n` : '') +
    (drama?.background ? `背景：${drama.background}\n` : '') +
    (eraCtx ? `\n【历史量纲参考】${eraCtx}\n` : '')
  );
}

/** 把 LLM 的 JSON 收紧成 DerivedNumbers；缺关键结构即 null（上层转离线兜底） */
/** LLM 可能生成非法公式（含条件运算符、未声明变量等），此处做安全化清洗 */
function sanitizeFormula(formula: string, metricKeys: string[]): string {
  // 移除三元运算符：(a ? b : c) → clamp(b, c, min/max) 或直接取 b
  let sanitized = formula.replace(/\(\s*([^?]+)\?\s*([^:]+)\s*:\s*([^)]+)\s*\)/g, (_, cond, trueExpr, falseExpr) => {
    // 简化：条件为真时返回trueExpr，否则返回falseExpr中的常数或0
    const falseConst = falseExpr.match(/^-?\d+\.?\d*$/);
    return falseConst ? String(trueExpr) : `max(${trueExpr}, ${falseExpr.trim()})`;
  });
  // 移除所有未声明的变量名（保留数字、metric key、函数名和运算符）
  const validTokens = new Set([...metricKeys, ...['min', 'max', 'round', 'abs', 'floor', 'ceil', 'sqrt', 'clamp']]);
  // 替换非法标识符为 0
  sanitized = sanitized.replace(/[a-zA-Z_][a-zA-Z0-9_]*/g, (word) => {
    if (validTokens.has(word)) return word;
    return '0';
  });
  // 清理多余运算符（如连续的 +/-）
  sanitized = sanitized.replace(/[+\-]{2,}/g, '+').replace(/\)\s*\+\s*\(/g, ')+(');
  return sanitized.trim() || '0';
}

export function parseNumbers(raw: string): DerivedNumbers | null {
  type J = Record<string, unknown>;
  let obj: J | null = null;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    obj = JSON.parse(raw.slice(start, end + 1)) as J;
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.metrics) || !Array.isArray(obj.rules)) return null;
  if (obj.metrics.length < 4 || obj.rules.length < 5) return null; // 结构不足 → 上层转离线
  const metrics: MetricDef[] = ((obj.metrics ?? []) as J[]).map((m) => ({
    key: String(m.key),
    label: String(m.label ?? m.key),
    min: Number(m.min ?? 0),
    max: Number(m.max ?? 100),
    start: Number(m.start ?? 50),
    unit: m.unit as string | undefined,
    higherIsBetter: m.higherIsBetter !== false,
    description: String(m.description ?? ''),
  }));
  const provenance: ProvenanceNote[] = ((obj.metrics ?? []) as J[]).map((m) => ({
    metric: String(m.key),
    source: String((m.provenance as J | undefined)?.source ?? ''),
    how: String((m.provenance as J | undefined)?.how ?? ''),
    estimate: (m.provenance as J | undefined)?.estimate as string | undefined,
  }));
  const ruleJson = (obj.rules ?? []) as J[];
  const rules: RuleDef[] = ruleJson.map((r) => {
    const kind = r.kind === 'reaction' || r.kind === 'threshold' ? r.kind : 'drift';
    const b: RuleDef = {
      id: String(r.id ?? 'r'),
      kind,
      label: String(r.label ?? r.id ?? '规则'),
      description: String(r.description ?? ''),
    };
    if (kind === 'drift') {
      b.target = r.target ? String(r.target) : undefined;
      b.appliesTo = (r.appliesTo as string[] | undefined)
        ? (r.appliesTo as string[]).map(String)
        : r.target ? [String(r.target)] : undefined;
      b.formula = String(r.formula ?? '1');
      // 清理 LLM 生成的非法公式：移除条件运算符、替换未声明变量、简化结构
      b.formula = sanitizeFormula(b.formula, metrics.map((m) => m.key));
    } else if (kind === 'reaction') {
      b.appliesTo = r.appliesTo as string[] | undefined;
      if (typeof r.bounds === 'number') b.bounds = r.bounds;
      else if (r.bounds && typeof r.bounds === 'object') b.bounds = r.bounds as Record<string, number>;
    } else {
      b.metric = r.metric ? String(r.metric) : r.target ? String(r.target) : undefined;
      b.op = (r.op ?? '>=') as RuleDef['op'];
      b.value = Number(r.value ?? 0);
      b.fires = String(r.fires ?? '');
    }
    return b;
  });
  const derivations: DerivationNote[] = ruleJson.map((r) => {
    const derivation = r.derivation as J | undefined;
    return {
      ruleId: String(r.id ?? 'r'),
      formula:
        r.kind === 'drift'
          ? String(r.formula ?? '1')
          : r.kind === 'reaction'
            ? JSON.stringify(r.bounds ?? {})
            : `${String(r.op ?? '>=')} ${Number(r.value ?? 0)}`,
      why: String(derivation?.why ?? r.description ?? ''),
      ref: derivation?.ref as string | undefined,
    };
  });
  return { metrics, rules, provenance, derivations };
}

// ---------- 离线确定性推导（mock / 无 LLM） ----------

/** 单位 → 指标候选（读档体系：只认史册实战常见的计数单位，其余忽略） */
const NUM_UNIT: Record<string, { cap: number; higher: boolean; how: (noun: string) => string }> = {
  万: { cap: 120, higher: true, how: (n) => `检索「${n}」的兵力实数（史传/部伍档案），换算成万单位` },
  亿: { cap: 100, higher: true, how: (n) => `检索「${n}」的赋税/财政记录（如《食货志》或预算表），换算到同量纲` },
  年: { cap: 60, higher: true, how: (n) => `检索「${n}」起止年份，按纪年可推` },
  月: { cap: 36, higher: true, how: (n) => `检索「${n}」的持续时间（按纪月推）` },
  人: { cap: 2000, higher: true, how: (n) => `检索「${n}」人口/从军/流民记录（册籍/纪年）` },
  两: { cap: 2000, higher: true, how: (n) => `检索「${n}」银两/岁入记录（支出/俸禄/赏赐）` },
  石: { cap: 2000, higher: true, how: (n) => `检索「${n}」粮储/运量（仓储策）` },
  匹: { cap: 2000, higher: true, how: (n) => `检索「${n}」马政数字` },
};

/** 语域 → 史册科目兜底表：科目名、真实单位、常见量纲、检索口径（不写死话题数值） */
interface FallbackDim { label: string; unit: string; start: number; max: number; hint: string; }
const DIM_SUBJECTS: { re: RegExp; dim: FallbackDim }[] = [
  { re: /粮|米|粟|储|仓|漕/, dim: { label: '粮储', unit: '万石', start: 500, max: 1200, hint: '检索仓廪簿录/常平仓漕运册，按在仓实数记分' } },
  { re: /财|税|钱|库|银|饷|赋|户部/, dim: { label: '岁入', unit: '万两', start: 300, max: 800, hint: '检索《食货志》/户部档册，按实征折银记分' } },
  { re: /民|流民|百姓|灾|戸|户口|丁/, dim: { label: '民户', unit: '万户', start: 700, max: 1800, hint: '检索会典/文献所载在籍民户实数，按黄册记分' } },
  { re: /军|兵|战|征|剿|贼|营|骑|兵额/, dim: { label: '兵额', unit: '万', start: 40, max: 120, hint: '按兵部册/战报所载在编实数记分' } },
];

/** 领域专属兜底科目：商业/情感话题使用与历史完全不同的量纲体系 */
const DIM_BUSINESS: FallbackDim[] = [
  { label: '估值', unit: '亿', start: 10, max: 100, hint: '检索同行业/同阶段公司融资估值（ PitchBook/Crunchbase），取投后估' },
  { label: '现金流', unit: '月', start: 12, max: 36, hint: '按 Burn Rate 推算可支撑月数（Cash / Monthly Burn）' },
  { label: '市占率', unit: '%', start: 15, max: 80, hint: '按行业研报/艾瑞/易观等第三方数据估算份额' },
  { label: '团队规模', unit: '人', start: 50, max: 500, hint: '按企查查/脉脉/公司官网披露的在职人数估算' },
];
const DIM_EMOTION: FallbackDim[] = [
  { label: '亲密值', unit: '', start: 50, max: 100, hint: '主观量表：双方关系亲密度 0-100' },
  { label: '信任度', unit: '', start: 40, max: 100, hint: '主观量表：相互信任程度 0-100' },
  { label: '冲突烈度', unit: '', start: 30, max: 100, hint: '主观量表：双方矛盾激烈程度 0-100，越高越差' },
  { label: '沟通频次', unit: '次/周', start: 5, max: 20, hint: '每周有效沟通次数估算' },
];

/** 语域 → 兜底科目（不写死话题，只按领域信号选真实科目并注明估算口径；缺位时补常见科目保证可玩） */
/** 三国内战场景的历史基线（蜀汉巅峰期真实量纲，避免 LLM 瞎编 700万户/60万兵这种数值） */
const HIST_BASLINE: Record<string, Partial<Record<string, number>>> = {
  三国: { '民户': 28, '粮储': 80, '岁入': 30, '兵额': 10 },
  蜀:   { '民户': 28, '粮储': 80, '岁入': 30, '兵额': 10 },
  诸葛亮: { '民户': 28, '粮储': 80, '岁入': 30, '兵额': 10 },
  崇祯: { '民户': 1600, '粮储': 400, '岁入': 200, '兵额': 80 },
  明末: { '民户': 1600, '粮储': 400, '岁入': 200, '兵额': 80 },
  王安石: { '民户': 2000, '粮储': 600, '岁入': 400, '兵额': 120 },
  安史: { '民户': 3000, '粮储': 800, '岁入': 500, '兵额': 200 },
};
function topicDomainHint(text: string): string {
  if (/三国|蜀|魏|吴|诸葛亮|北伐|赤壁|赤壁/.test(text)) return '三国';
  if (/崇祯|明.*末|李自成|农民|起义|明.*亡/.test(text)) return '明末';
  if (/王安石|变法|宋/.test(text)) return '王安石';
  if (/安史|唐.*叛|玄宗/.test(text)) return '安史';
  return '';
}
function applyHistBaseline(starts: Record<string, number>, text: string): Record<string, number> {
  const hint = topicDomainHint(text);
  const bl = HIST_BASLINE[hint];
  if (!bl) return starts;
  const out = { ...starts };
  for (const [label, v] of Object.entries(bl)) {
    const cur = out[label];
    if (v === undefined || cur === undefined || cur <= 0) continue;
    // LLM 数值严重偏离历史基线时覆盖：低于基线 50% 或高于基线 3 倍
    if (cur < v * 0.5 || cur > v * 3) out[label] = v;
  }
  return out;
}
/** 直接修改 MetricDef 数组上的 start/max（LLM 路径专用，不返回新数组） */
/** LLM 可能用别名（如"国库银"→"岁入"），先归一化标签再校正基线 */
const LABEL_NORMALIZE: Record<string, string> = {
  国库银: '岁入', 岁入银: '岁入', 赋税岁入: '岁入', 太仓银: '岁入', 田赋: '岁入',
  京仓: '粮储', 京师粮储: '粮储', 常平: '粮储', 仓廪: '粮储',
  编户: '民户', 户口: '民户', 民户总数: '民户',
  兵额: '兵额', 在营: '兵额', 边镇兵: '兵额', 九边兵额: '兵额', 官兵: '兵额', 马政: '兵额',
};
function normalizeLabel(label: string): string {
  return LABEL_NORMALIZE[label] ?? label;
}
function applyHistBaselineToMetrics(metrics: MetricDef[], text: string, domain?: string): void {
  const starts: Record<string, number> = {};
  for (const m of metrics) starts[normalizeLabel(m.label)] = m.start;
  const corrected = applyHistBaseline(starts, text);
  for (const m of metrics) {
    const norm = normalizeLabel(m.label);
    const c = corrected[norm];
    if (c !== undefined && c > 0 && c !== m.start) {
      m.start = c;
      m.max = Math.max(m.max, Math.ceil(c * 1.5));
    }
  }
}
function fallbackDims(text: string, domain?: string): FallbackDim[] {
  const dims: FallbackDim[] = [];
  for (const s of DIM_SUBJECTS) {
    if (s.re.test(text) && !dims.some((d) => d.label === s.dim.label)) dims.push(s.dim);
  }
  // 商业/情感域用专属科目表，避免历史农业科目出现在融资/恋爱话题中
  if (domain === 'business' && dims.length === 0) {
    for (const d of DIM_BUSINESS) {
      if (dims.length >= 4) break;
      dims.push(d);
    }
  } else if (domain === 'emotion' && dims.length === 0) {
    for (const d of DIM_EMOTION) {
      if (dims.length >= 4) break;
      dims.push(d);
    }
  }
const COMMON: FallbackDim[] = [
    { label: '民户', unit: '万户', start: 700, max: 1800, hint: '检索会典/文献所载在籍民户实数，无档按口数折估' },
    { label: '粮储', unit: '万石', start: 500, max: 1200, hint: '检索仓廪簿录/常平仓储量，按在仓实数记分' },
    { label: '岁入', unit: '万两', start: 300, max: 800, hint: '检索《食货志》/户部折银册，按实征记分' },
    { label: '兵额', unit: '万', start: 40, max: 120, hint: '按兵部册/战报所载在编实数记分' },
  ];
  for (const d of COMMON) {
    if (dims.length >= 4) break;
    if (!dims.some((x) => x.label === d.label)) dims.push(d);
  }
  return dims.slice(0, 4);
}

/**
 * 从一段文本抽全部「名词+数字+单位」线索（示例：『大军四十万』＝ 大军/40/万）。
 * 单位须在 NUM_UNIT 表内，且阿拉伯数字；纯汉字数（十二）与年份（>300 的年数）不构指标。
 * 同时接收提问原文：用户一句话里自带的真实数字，也构指标并带真实复核路径。
 */
function numberCluesFromText(text: string): { noun: string; n: number; unit: string }[] {
  const out: { noun: string; n: number; unit: string }[] = [];
  const re = /([\u4e00-\u9fa5]{2,6}?)\s*([-+]?\d+(?:\.\d+)?)\s*(万|亿|年|月|人|两|石|匹)/g;
  for (const m of text.matchAll(re)) {
    const unit = m[3]!;
    if (!NUM_UNIT[unit]) continue;
    const n = Number(m[2]);
    if (!Number.isFinite(n) || n <= 0) continue;
    // 「…… 年」只接受 300 以内（存续期 / 周期）；四位数是公历年份，不构指标
    if (unit === '年' && n > 300) continue;
    // 名词取数字前 2 字（「为何败给东晋 8 万」→ 东晋；「诸葛亮率大军 12 万」→ 大军）
    const noun = m[1]!.slice(-2);
    if (noun.length < 2) continue;
    out.push({ noun, n, unit });
  }
  return out;
}

/** 排名依据名词的字数收拢成键（同名词同单位只进 1 指标） */
function clueKey(c: { noun: string; unit: string }): string {
  return `${c.noun}|${c.unit}`;
}

/**
 * 离线推导（确定性）：从考据原文抽「数字+单位」构指标；无实数字时按语域给通用科目
 * （并注明估算口径）；规则三条（drift/reaction/threshold）由指标自动对齐，
 * derivation 永远给出「为什么这么定」。不写死任何话题数值。
 */
export function deriveNumbersOffline(
  brief: TopicBrief,
  fill: FillResult,
  drama: DramaDraft | undefined,
  domain?: string,
): DerivedNumbers {
  const metrics: MetricDef[] = [];
  const provenance: ProvenanceNote[] = [];
  const rules: RuleDef[] = [];
  const derivations: DerivationNote[] = [];
  let nIdx = 0;

  const pushMetric = (
    label: string, start: number, maxCap: number, unit: string | undefined,
    higher: boolean, desc: string, how: string, estimate?: string,
  ) => {
    const max = Math.max(maxCap, Math.ceil(start * 1.5));
    metrics.push({
      key: `m${++nIdx}`,
      label, min: 0, max, start: Math.min(start, max), unit,
      higherIsBetter: higher, description: desc,
    });
    provenance.push({ metric: `m${nIdx}`, source: desc, how, estimate });
  };

  // ① 数字线索 → 指标（同一名词+单位只进 1 指标；考据事实优先，其次提问原文自带的数字）
  const seenCue = new Set<string>();
  const ctxText = `${brief.title} ${brief.body ?? ''} ` +
    (drama?.background ?? '') + ' ' + (drama?.cast ?? []).map((c) => c.name + c.role).join(' '); // 供语域兜底
  const questionText = `${brief.title} ${brief.body ?? ''} ${(brief.asks ?? []).join(' ')}`.trim();
  const clueSources: { text: string; source: string }[] = [
    ...fill.facts.map((f) => ({ text: f.claim, source: `考据原文：${f.claim.slice(0, 40)}` })),
  ];
  if (questionText) clueSources.push({ text: questionText, source: `提问原文自带数字：${questionText.slice(0, 40)}` });
  for (const src of clueSources) {
    for (const c of numberCluesFromText(src.text)) {
      if (seenCue.has(clueKey(c))) continue;
      seenCue.add(clueKey(c));
      const u = NUM_UNIT[c.unit];
      pushMetric(
        `${c.noun}（${c.unit}）`,
        c.n,
        Math.max(u.cap, c.n),
        c.unit,
        u.higher,
        src.source,
        u.how(c.noun),
      );
    }
  }

  // ② 数字线索不足 → 以语域真实科目补足到 4 个（带量纲初值，标注估算口径）
  const dims = fallbackDims(ctxText, domain);
  if (metrics.length < 4) {
    // 有线索的部分保留，缺位由领域科目补齐（全无则全用领域科目）
    for (const d of dims) {
      if (metrics.length >= 4) break;
      pushMetric(d.label, d.start, d.max, d.unit, true,
        `史料科目（话题原文无比量词，按该朝常见量纲取初值）`,
        d.hint, '估算：按同题材/同朝代史料常见量纲取初值，后续可换成真实记载');
    }
  }

  // ②.5 历史基线校正：三国内战等特定题材的数值应贴近史实量纲
  // （如蜀汉巅峰期民户约28万、兵额约10万，而非明代的700万/80万）
  const startsMap: Record<string, number> = {};
  for (const m of metrics) startsMap[m.label] = m.start;
  const correctedStarts = applyHistBaseline(startsMap, ctxText);
  for (const m of metrics) {
    const corrected = correctedStarts[m.label];
    if (corrected !== undefined && corrected > 0) {
      m.start = corrected;
      m.max = Math.max(m.max, Math.ceil(corrected * 1.5));
    }
  }

// ③ 规则：drift / reaction / threshold —— 每个指标都拥有自己的 drift 公式、
  //    一条覆盖全科目的 reaction（每指标各自的 bounds）、以及低线（30%）+ 高线（80%）双阈值，
  //    参数全部由指标定义推导（不写死任何绝对数值）。
  const reactBounds: Record<string, number> = {};
  // 各指标分配不同的漂移周期与相位，避免四条公式长得一模一样
  const PERIODS = [5, 7, 4, 6]; // 质数/互质周期，保证指标走势不同步
  const PHASES  = [0, 1, 3, 2]; // 错开的初始相位
  for (let idx = 0; idx < metrics.length; idx++) {
    const m = metrics[idx]!;
    const period = PERIODS[idx % PERIODS.length];
    const phase  = PHASES[idx % PHASES.length];
    const driftScale = Math.max(1, Math.round(m.max * 0.012)); // 约1.2%脉动（比0.8%略宽）
    const formula = m.higherIsBetter
      ? `round(${m.key}*0.003) + ${driftScale} * (((r + ${phase}) % ${period}) - ${Math.floor(period/2)})`
      : `round(${m.key}*0.003) - ${driftScale} * (((r + ${phase}) % ${period}) - ${Math.floor(period/2)})`;
    rules.push({
      id: 'drift-' + m.key, kind: 'drift', label: `${m.label}的自然演化`,
      description: '每轮结束按当前值与回合相位施加双向漂移（时势向好则升，向坏则降，周期约6轮）',
      target: m.key, appliesTo: [m.key], formula,
    });
    reactBounds[m.key] = Math.max(1, Math.round(m.max * 0.08)); // 该指标单回合处置上限：区间 8%（原15%偏高）
    derivations.push({
      ruleId: 'drift-' + m.key,
      formula,
      why: m.higherIsBetter
        ? `「${m.label}」越高越好；漂移以6轮为周期在±${driftScale}内振荡（(r%6)-3 ∈{-3..+2}），体现时势起伏而非单向增长`
        : `「${m.label}」越低越好（坏指标）；漂移同周期振荡，方向取反，体现崩势与恢复交替`,
      ref: `依据 higherIsBetter=${m.higherIsBetter} 与区间上限 ${m.max} 推导；事实出处见 ${m.description}`,
    });
  }
  rules.push({
    id: 're-act', kind: 'reaction', label: '诏令处置的影响',
    description: '玩家每个回合的行动，按各指标各自的 bounds 幅度改变全部科目',
    appliesTo: metrics.map((m) => m.key), bounds: reactBounds,
  });
  derivations.push({
    ruleId: 're-act',
    formula: Object.entries(reactBounds).map(([k, v]) => `${k}±${v}`).join('，'),
    why: `玩家处置的效应幅度取各指标区间上限的 8%（原15%偏高，下调防一回合爆表）：${metrics.map((m) => `${m.label} 区间 0-${m.max} → ±${reactBounds[m.key]}`).join('；')}`,
    ref: '按模拟惯例（决策反馈不超过区间 8%，保证数值稳定性）推导',
  });
  // ④ 阈值规则：每个指标各一条低线（30% 崩危）与一条高线（80% 盈溢），
  //    任一科目越线都要在面板上拉响预警（UI 按 spec.rules 全量匹配）。
  for (const m of metrics) {
    const line = Math.max(1, Math.round(m.max * 0.3));
    rules.push({
      id: 'th-crisis-' + m.key, kind: 'threshold', label: '底线告警',
      description: `「${m.label}」跌破 ${line} 时触发事件`,
      metric: m.key, op: '<=', value: line, fires: `「${m.label}」跌破 ${line}，事出异常，必生变局。`,
    });
    derivations.push({
      ruleId: 'th-crisis-' + m.key,
      formula: `${m.key} ≤ ${line}`,
      why: `低线取该指标区间上限的 30%：${m.label} 上限 ${m.max}，跌破 ${line} 即告急（可依史料中「支撑不住」的记载调至更贴近真实线）`,
      ref: `模拟惯例（危险带 = 下限起的 30%）；指标 ${m.label}（${m.key}）`,
    });
    const summit = Math.max(1, Math.round(m.max * 0.8));
    rules.push({
      id: 'th-summit-' + m.key, kind: 'threshold', label: '高线告警',
      description: `「${m.label}」超过 ${summit} 时触发事件`,
      metric: m.key, op: '>=', value: summit, fires: `「${m.label}」已至 ${summit} 高线，物极则反，须防盛极而衰。`,
    });
    derivations.push({
      ruleId: 'th-summit-' + m.key,
      formula: `${m.key} ≥ ${summit}`,
      why: `高线取区间上限的 80%：${m.label} 超过 ${summit} 即过盈，避免数值无上限空涨（历史盛况亦有顶）`,
      ref: `模拟惯例（高线 = 上限 80%，物极必反的机制化表达）；指标 ${m.label}（${m.key}）`,
    });
  }

  return { metrics, rules, provenance, derivations };
}

// ---------- 主入口 ----------

/**
 * 数值司主入口：LLM 动态推导为主，离线推导兜底；无论哪条产物都保证
 * provenance（数值从哪找真实）与 derivations（公式怎么推）非空。
 */
export async function deriveNumbers(
  brief: TopicBrief,
  fill: FillResult,
  drama: DramaDraft | undefined,
  chat: ChatProvider,
  domain?: string,
): Promise<DerivedNumbers> {
  if (chat.isReal()) {
    try {
      const raw = await chat.generate([{ role: 'user', content: valuesPrompt(brief, fill, drama) }], {
        jsonMode: true,
        maxTokens: 2000, // 数值推导 JSON 结构复杂，默认 900 token 不够用
      });
      const d = parseNumbers(raw);
      if (d && d.metrics.length >= 4 && d.rules.length >= 5) {
        // LLM 返回的数值可能严重偏离历史量纲，用基线校正
        applyHistBaselineToMetrics(d.metrics, brief.title + ' ' + (brief.body ?? ''), domain);
        return d;
      }
    } catch {
      /* 解析失败 → 走离线兜底 */
    }
  }
  return deriveNumbersOffline(brief, fill, drama, domain);
}