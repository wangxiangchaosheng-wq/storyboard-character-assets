// 构思管线：把「大模型如何构思一个好剧本 / 如何模拟历史」流程化、规范化约束起来。
// 回应需求 3：不再任由大模型自由发挥，而是强制它按固定 schema 产出
//   metrics（数值体系）+ rules（数值机制）+ cast（人物与对立立场）+ scenario（剧本），
// 产出的就是一份可直接运行的 ScenarioSpec。最后用 validateSpec 做流程化校验。

import type {
  ScenarioSpec, Scenario, Persona, MetricDef, RuleDef, Domain, LLMProvider, LLMMessage,
} from '../core/types.ts';
import { validateMetrics } from '../core/metrics.ts';
import { evalFormula } from '../core/rules.ts';

// 强制大模型输出的 JSON 结构（规范契约）。
const SCHEMA_HINT = `你必须输出一个 JSON 对象，包含以下字段：
{
  "title": "推演标题",
  "scenario": { "background":"背景","conflict":"核心矛盾","participants":["角色id",...],"rounds":3,"decisionPoint":"玩家最终裁决","successCriteria":"成功标准" },
  "cast": [ { "id","name","role","stance":"立场/动机","influence":0-100,"description","prompt":"人设system提示","traits":{"competence","loyalty","ambition","power":0-100} } ],
  "metrics": [ { "key":"英文或拼音键","label":"中文名","min":0,"max":100,"start":50,"unit":"可选","higherIsBetter":true/false,"description":"含义" } ],
  "rules": [
    { "id","kind":"drift|reaction|threshold","label","description","appliesTo":["指标key"],
      "target":"指标key","formula":"安全表达式，可引用其他指标key，如 'minxin*-0.02+1'",
      "bounds": 数字 或 {"指标key":数字},
      "metric":"指标key","op":">=|<="等,"value":数字,"fires":"触发文案" }
  ]
}
要求：
- cast 至少 2 人，且立场必须对立（形成冲突）。
- metrics 至少 2 个；每个指标都要在 rules 里被某条规则引用。
- drift 规则用 formula（可引用其他指标做条件/系数）；reaction 规则必须给 bounds 约束大模型每回合变动上限；threshold 规则给出触发条件与 fires 文案。
- 所有 rule 引用的指标 key 必须出现在 metrics 中。只输出 JSON，不要多余文字。`;

export function conceiveSpecPrompt(brief: string, domain?: Domain): LLMMessage[] {
  const sys =
    '你是一位资深的「多智能体推演 / 剧本杀」架构师，擅长把任意主题（历史、公司、情感、抽象议题）' +
    '拆解成可计算、可推演的结构。' + SCHEMA_HINT;
  const user =
    `请基于以下主题构思一份完整推演定义：\n「${brief}」\n` +
    (domain ? `（建议领域偏向：${domain}）\n` : '') +
    `先想清楚：这个故事/议题里有哪些可被量化的数值？它们如何随事件变化？有哪些立场对立的角色？` +
    `然后用上面的 JSON 结构输出。`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

// 把大模型（或任何来源）的 JSON 解析并映射成 ScenarioSpec。
export function specFromJson(raw: string, domain: Domain): ScenarioSpec | null {
  type J = Record<string, unknown>;
  let obj: J | null = null;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    obj = JSON.parse(raw.slice(start, end + 1)) as J;
  } catch {
    return null;
  }
  if (!obj || !obj.scenario || !Array.isArray(obj.metrics) || !Array.isArray(obj.cast)) return null;
  const scenario: Scenario = {
    title: (obj.scenario as J)?.title as string ?? obj.title as string ?? '未命名推演',
    background: (obj.scenario as J)?.background as string ?? '',
    conflict: (obj.scenario as J)?.conflict as string ?? '',
    participants: (obj.scenario as J)?.participants as string[] ?? (obj.cast as J[]).map((c) => String(c.id)),
    rounds: Number((obj.scenario as J)?.rounds ?? 3),
    decisionPoint: (obj.scenario as J)?.decisionPoint as string ?? '你做出怎样的决断？',
    successCriteria: (obj.scenario as J)?.successCriteria as string ?? '',
  };
  const metrics: MetricDef[] = (obj.metrics as J[]).map((m) => ({
    key: String(m.key),
    label: String(m.label ?? m.key),
    min: Number(m.min ?? 0),
    max: Number(m.max ?? 100),
    start: Number(m.start ?? 50),
    unit: m.unit as string | undefined,
    higherIsBetter: m.higherIsBetter !== false,
    description: m.description as string | undefined,
  }));
  const rules: RuleDef[] = ((obj.rules ?? []) as J[]).map((r) => ({
    id: String(r.id ?? r.label ?? 'rule'),
    kind: r.kind as RuleDef['kind'],
    label: String(r.label ?? r.id ?? '规则'),
    description: String(r.description ?? ''),
    appliesTo: r.appliesTo as string[] | undefined,
    target: r.target as string | undefined,
    formula: r.formula as string | undefined,
    bounds: r.bounds as number | Record<string, number> | undefined,
    metric: r.metric as string | undefined,
    op: r.op as RuleDef['op'] | undefined,
    value: Number(r.value ?? 0),
    fires: r.fires as string | undefined,
  }));
  const cast: Persona[] = (obj.cast as J[]).map((c) => ({
    id: String(c.id),
    name: String(c.name ?? c.id),
    role: String(c.role ?? ''),
    stance: String(c.stance ?? ''),
    influence: Number(c.influence ?? 50),
    description: String(c.description ?? ''),
    prompt: String(c.prompt ?? `你是${String(c.name ?? c.id)}，立场${String(c.stance ?? '')}。`),
    traits: {
      competence: Number((c.traits as J)?.competence ?? 60),
      loyalty: Number((c.traits as J)?.loyalty ?? 60),
      ambition: Number((c.traits as J)?.ambition ?? 50),
      power: Number((c.traits as J)?.power ?? 50),
    },
  }));
  return { domain, title: String((obj as J)?.title ?? scenario.title), scenario, cast, metrics, rules, rounds: scenario.rounds };
}

export interface SpecCheck {
  ok: boolean;
  errors: string[];
  warnings: string[];
}

// 流程化校验：确保 spec 自洽、可被引擎安全运行。
export function validateSpec(spec: ScenarioSpec): SpecCheck {
  const errors: string[] = [];
  const warnings: string[] = [];
  errors.push(...validateMetrics(spec.metrics));

  const keys = new Set(spec.metrics.map((m) => m.key));
  const ids = new Set(spec.cast.map((c) => c.id));
  const referenced = new Set<string>();

  for (const r of spec.rules) {
    for (const k of r.appliesTo ?? []) { referenced.add(k); if (!keys.has(k)) errors.push(`规则 ${r.id} 引用了未定义指标 ${k}`); }
    if (r.target) { referenced.add(r.target); if (!keys.has(r.target)) errors.push(`规则 ${r.id} 的 target 未定义：${r.target}`); }
    if (r.metric) { if (!keys.has(r.metric)) errors.push(`规则 ${r.id} 的 threshold.metric 未定义：${r.metric}`); }
    if (r.kind === 'drift' && r.formula) {
      const state0: Record<string, number> = {};
      for (const m of spec.metrics) state0[m.key] = m.start;
      try { evalFormula(r.formula, state0); } catch (e) { warnings.push(`规则 ${r.id} 的 formula 无法求值：${(e as Error).message}`); }
    }
    if (r.kind === 'reaction' && r.bounds == null) warnings.push(`反应规则 ${r.id} 未设 bounds，大模型变动可能失控`);
  }
  for (const k of keys) if (!referenced.has(k)) warnings.push(`指标 ${k} 未被任何规则引用（可能永不变化）`);

  const stances = new Set(spec.cast.map((c) => c.stance));
  if (spec.cast.length < 2) errors.push('cast 至少需要 2 个角色');
  if (stances.size < 2) errors.push('角色立场必须至少 2 种（需形成对立冲突）');
  for (const pid of spec.scenario.participants) if (!ids.has(pid)) errors.push(`scenario.participants 引用了未定义角色 ${pid}`);

  return { ok: errors.length === 0, errors, warnings };
}

// 主入口：自然语言 brief → 完整可运行 spec（经 LLM 构思 + 校验）。
export async function conceiveScript(
  brief: string,
  llm: LLMProvider,
  opts: { domain?: Domain } = {},
): Promise<ScenarioSpec> {
  if (llm.isReal()) {
    const raw = await llm.chat(conceiveSpecPrompt(brief, opts.domain), { temperature: 0.7, maxTokens: 2000 });
    const spec = specFromJson(raw, opts.domain ?? 'custom');
    if (!spec) throw new Error('构思失败：无法解析大模型返回的结构');
    const check = validateSpec(spec);
    if (!check.ok) throw new Error('构思失败：\n' + check.errors.join('\n'));
    if (check.warnings.length) console.warn('[构思] 警告：\n' + check.warnings.join('\n'));
    return spec;
  }
  // 无 LLM：返回一份以 brief 为主题的通用脚手架（保证流程可演示）。
  return scaffoldFromBrief(brief, opts.domain ?? 'custom');
}

// 离线脚手架：演示"一份合法 spec 长什么样"，可被开发者直接改写。
function scaffoldFromBrief(brief: string, domain: Domain): ScenarioSpec {
  return {
    domain,
    title: `推演：${brief}`,
    scenario: {
      title: `推演：${brief}`,
      background: `${brief}。一个需要权衡与裁决的局面。`,
      conflict: `${brief}：不同立场就如何处置产生分歧。`,
      participants: ['a', 'b'],
      rounds: 3,
      decisionPoint: '你最终做出怎样的决断？',
      successCriteria: '在冲突中取得可持续的平衡。',
    },
    cast: [
      { id: 'a', name: '主张者', role: '推动方', stance: '变革', influence: 60, description: '主张采取行动。', prompt: '你是主张者，立场变革，积极推动。', traits: { competence: 70, loyalty: 60, ambition: 60, power: 55 } },
      { id: 'b', name: '反对者', role: '制衡方', stance: '保守', influence: 60, description: '主张谨慎。', prompt: '你是反对者，立场保守，强调风险与稳定。', traits: { competence: 70, loyalty: 60, ambition: 40, power: 55 } },
    ],
    metrics: [
      { key: 'progress', label: '推进度', min: 0, max: 100, start: 50, higherIsBetter: true, description: '事项推进程度' },
      { key: 'risk', label: '风险', min: 0, max: 100, start: 30, higherIsBetter: false, description: '局势失控程度' },
      { key: 'satisfaction', label: '满意度', min: 0, max: 100, start: 60, higherIsBetter: true, description: '相关方满意程度' },
    ],
    rules: [
      { id: 's-drift-risk', kind: 'drift', label: '风险自然累积', description: '无干预时风险缓慢上升', target: 'risk', formula: '1' },
      { id: 's-react', kind: 'reaction', label: '决策对局势的影响', description: '玩家裁决改变推进度/风险/满意度', appliesTo: ['progress', 'risk', 'satisfaction'], bounds: { progress: 12, risk: 10, satisfaction: 10 } },
      { id: 's-thr-risk', kind: 'threshold', label: '危机爆发', description: '风险过高', metric: 'risk', op: '>=', value: 85, fires: '风险失控，局面破裂。' },
    ],
    rounds: 3,
  };
}
