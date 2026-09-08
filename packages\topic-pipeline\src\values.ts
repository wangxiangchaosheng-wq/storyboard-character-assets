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

export function valuesPrompt(brief: TopicBrief, fill: FillResult, drama?: DramaDraft): string {
  const castLines = (drama?.cast ?? [])
    .map((c) => `- ${c.name}（${c.role}，立场「${c.stance}」）`)
    .join('\n');
  const factsLines =
    fill.facts.map((f) => `- ${f.claim}` + (f.estimated ? `（估算：${f.basis ?? ''}）` : '')).join('\n') || '（空）';
  const gapsLines = fill.gaps.map((g) => `- ${g.topic}`).join('\n') || '（无）';
  return (
'你是历史模拟引擎的「数值司」：根据话题考据与人物立场，推导一套可运行的数值指标（metrics）' +
    '与演化规则（rules）。\n' +
    '硬性要求：\n' +
    '1) 指标必须是该语境下的史籍真实科目（如人口户数、田赋岁入、粮储、兵额、马政、银钱、漕运、' +
    '盐引、丁役等），带单位（unit 必填：户/万石/万两/万/匹/引……）且 start 按该朝常见量纲取值；' +
    '严禁使用「军势」「民望」「士气」「国力」「局势」「实力」「民心」这类游戏化抽象词作指标名。\n' +
    '2) metrics 至少 4 个、rules 至少 5 条；drift（每回合漂移，可用 t+公式）、' +
    'reaction（受限幅度，bounds 可给每个指标单独上限）、threshold（op+value+fires，低线/高线都要有）' +
    '三种都要有，且每个指标都要有属于自己的 drift 与 threshold。\n' +
    '3) 每个 metric 都要写 provenance：这个数值「真实值从哪里找」——史料名/数据源/检索词/' +
    '换算口径；无直接依据的必须给 estimate（估算链）。\n' +
    '4) 每条 rule 都要写 derivation：公式/阈值为什么这样定（依据哪条事实或常识）。\n' +
    '5) formula 只允许数字、指标 key、+ - * / ( )，不要其他函数调用。\n' +
    '只输出 JSON（不要代码块环绕）：\n' +
    '{"metrics":[{"key":"k","label":"中文名","min":0,"max":100,"start":50,"unit":"必填真实单位",' +
    '"higherIsBetter":true,' +
    '"description":"含义","provenance":{"source":"数据来源描述","how":"检索/换算路径","estimate":"可选估算链"}}],\n' +
    ' "rules":[{"id":"r1","kind":"drift","label":"...","description":"...","target":"指标key","formula":"表达式",' +
    '"derivation":{"why":"为什么这样推","ref":"引用事实"}},' +
    '{"id":"r2","kind":"reaction","label":"...","description":"...","bounds":8,"appliesTo":["指标key"],' +
    '"derivation":{"why":"...","ref":"..."}},' +
    '{"id":"r3","kind":"threshold","label":"...","metric":"指标key","op":">=","value":85,"fires":"触发文案",' +
    '"derivation":{"why":"...","ref":"..."}}]}\n\n' +
    `话题：${brief.title}\n核心问题：${brief.asks.join('；') || '（无）'}\n\n` +
    `已考据事实（供取数与出处）：\n${factsLines}\n\n` +
    `缺口（需估算）：\n${gapsLines}\n\n` +
    `人物与立场：\n${castLines || '（构演司未定）'}\n` +
    (drama?.conflict ? `核心矛盾：${drama.conflict}\n` : '') +
    (drama?.background ? `背景：${drama.background}\n` : '')
  );
}

/** 把 LLM 的 JSON 收紧成 DerivedNumbers；缺关键结构即 null（上层转离线兜底） */
export function parseNumbers(raw: string): DerivedNumbers | null {
  let obj: any = null;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return null;
  }
  if (!obj || !Array.isArray(obj.metrics) || !Array.isArray(obj.rules)) return null;
  if (obj.metrics.length < 4 || obj.rules.length < 5) return null; // 结构不足 → 上层转离线
  const metrics: MetricDef[] = (obj.metrics as any[]).map((m) => ({
    key: String(m.key),
    label: String(m.label ?? m.key),
    min: Number(m.min ?? 0),
    max: Number(m.max ?? 100),
    start: Number(m.start ?? 50),
    unit: m.unit,
    higherIsBetter: m.higherIsBetter !== false,
    description: String(m.description ?? ''),
  }));
  const provenance: ProvenanceNote[] = (obj.metrics as any[]).map((m) => ({
    metric: String(m.key),
    source: String(m.provenance?.source ?? ''),
    how: String(m.provenance?.how ?? ''),
    estimate: m.provenance?.estimate ?? undefined,
  }));
  const ruleJson = (obj.rules as any[]) ?? [];
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
      b.appliesTo = r.appliesTo ? (r.appliesTo as any[]).map(String) : r.target ? [String(r.target)] : undefined;
      b.formula = String(r.formula ?? 1);
    } else if (kind === 'reaction') {
      b.appliesTo = r.appliesTo ? (r.appliesTo as any[]).map(String) : undefined;
      if (typeof r.bounds === 'number') b.bounds = r.bounds;
      else if (r.bounds && typeof r.bounds === 'object') b.bounds = r.bounds;
    } else {
      b.metric = r.metric ? String(r.metric) : r.target ? String(r.target) : undefined;
      b.op = r.op ?? '>=';
      b.value = Number(r.value ?? 0);
      b.fires = String(r.fires ?? '');
    }
    return b;
  });
  const derivations: DerivationNote[] = ruleJson.map((r) => ({
    ruleId: String(r.id ?? 'r'),
    formula:
      r.kind === 'drift'
        ? String(r.formula ?? 1)
        : r.kind === 'reaction'
          ? JSON.stringify(r.bounds ?? {})
          : `${String(r.op ?? '>=')} ${Number(r.value ?? 0)}`,
    why: String(r.derivation?.why ?? r.description ?? ''),
    ref: r.derivation?.ref ?? undefined,
  }));
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

/** 语域 → 兜底科目（不写死话题，只按领域信号选真实科目并注明估算口径；缺位时补常见科目保证可玩） */
function fallbackDims(text: string): FallbackDim[] {
  const dims: FallbackDim[] = [];
  for (const s of DIM_SUBJECTS) {
    if (s.re.test(text) && !dims.some((d) => d.label === s.dim.label)) dims.push(s.dim);
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
  const dims = fallbackDims(ctxText);
  if (metrics.length < 4) {
    // 有线索的部分保留，缺位由领域科目补齐（全无则全用领域科目）
    for (const d of dims) {
      if (metrics.length >= 4) break;
      pushMetric(d.label, d.start, d.max, d.unit, true,
        `史料科目（话题原文无比量词，按该朝常见量纲取初值）`,
        d.hint, '估算：按同题材/同朝代史料常见量纲取初值，后续可换成真实记载');
    }
  }

// ③ 规则：drift / reaction / threshold —— 每个指标都拥有自己的 drift 公式、
  //    一条覆盖全科目的 reaction（每指标各自的 bounds）、以及低线（30%）+ 高线（80%）双阈值，
  //    参数全部由指标定义推导（不写死任何绝对数值）。
  const reactBounds: Record<string, number> = {};
  for (const m of metrics) {
    const driftScale = Math.max(1, Math.round(m.max * 0.01)); // 每轮约区间 1% 的脉动
    const formula = m.higherIsBetter
      ? `max(${driftScale}, round(${m.key}*0.01))`
      : `-max(${driftScale}, round(${m.key}*0.01))`;
    rules.push({
      id: 'drift-' + m.key, kind: 'drift', label: `${m.label}的自然演化`,
      description: '每轮结束按当前值施加比例漂移（时势/传闻的自然脉搏，方向由指标定义给出）',
      target: m.key, appliesTo: [m.key], formula,
    });
    reactBounds[m.key] = Math.max(1, Math.round(m.max * 0.15)); // 该指标单回合处置上限：区间 15%
    derivations.push({
      ruleId: 'drift-' + m.key,
      formula,
      why: m.higherIsBetter
        ? `「${m.label}」越高越好，时势向好则自然缓升；漂移量按区间 1% 取 ${driftScale} 并随现值比例微调，避免一回合爆表`
        : `「${m.label}」越低越好（坏指标），若无干预按区间 1% 自然缓降（${driftScale}），体现崩势惯性`,
      ref: `依据定义 higherIsBetter=${m.higherIsBetter} 与区间上限 ${m.max} 推导；事实出处见 ${m.description}`,
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
    why: `玩家处置的效应幅度取各指标区间上限的 15%：${metrics.map((m) => `${m.label} 区间 0-${m.max} → ±${reactBounds[m.key]}`).join('；')}`,
    ref: '按模拟惯例（决策反馈不超过区间 15%，防止一回合爆表）推导',
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
): Promise<DerivedNumbers> {
  if (chat.isReal()) {
    try {
      const raw = await chat.generate([{ role: 'user', content: valuesPrompt(brief, fill, drama) }], {
        jsonMode: true,
      });
      const d = parseNumbers(raw);
      if (d && d.metrics.length >= 4 && d.rules.length >= 5) return d;
    } catch {
      /* 解析失败 → 走离线兜底 */
    }
  }
  return deriveNumbersOffline(brief, fill, drama);
}