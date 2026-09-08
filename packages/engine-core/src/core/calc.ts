// 数值结算：把「反应规则」交给大模型按规则计算变动（规则→大模型→反馈的核心），
// 并与「执行衰减叙事」合并成一份 Settlement。无 LLM 时回退到启发式 mock。
//
// 设计要点（回应需求 1：规则与反馈）：
//  - 规则以自然语言 description + 幅度上限 bounds 交给大模型；大模型只输出结构化的
//    {key, amount, reason}，引擎负责校验 bounds、夹紧到 [min,max]，保证可控可复现。
//  - 计算得到的数值会写回 State，并在下一轮辩论前以 stateBlock 的形式反馈给所有角色大模型，
//    所以每个角色「看到的局势数字」是随推演真实变化的。

import type {
  State, RuleDef, MetricDef, Persona, Decision, Scenario, Settlement, Delta,
  ThresholdEvent, LLMProvider, LLMMessage, Traits,
} from './types.ts';
import { applyDecay } from './decision.ts';
import { describeRules, checkThresholds, resolveBound } from './rules.ts';
import { formatState, applyDeltas } from './metrics.ts';

function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

// 给大模型的结算提示词：明确列出规则、当前数值、剧情与决策，要求只输出 JSON 变动。
function buildSettlementPrompt(
  metrics: MetricDef[],
  rules: RuleDef[],
  state: State,
  scenario: Scenario,
  cast: Persona[],
  decision: Decision,
  debateSummary: string,
  deviation: number,
): LLMMessage[] {
  const metricText = metrics
    .map((m) => `- ${m.label}（${m.key}）：范围 ${m.min}~${m.max}，越大越${m.higherIsBetter ? '好' : '坏'}。${m.description ?? ''}`)
    .join('\n');
  const sys =
    '你是本推演的「数值结算官」。你必须严格遵循下方[规则]来计算每个指标在本决策后的变化。\n' +
    '每条反应规则给出了它影响的指标、以及每回合变动幅度上限(bounds)。\n' +
    '请结合[当前数值][剧情与决策][在场角色][执行偏差]，为每个相关指标给出变动 amount（可正可负）与简短 reason。\n' +
    'amount 绝对值不得超过对应规则的 bounds；不要编造规则未涉及的指标。\n' +
    '只输出一个 JSON，格式：{"deltas":[{"key":"指标key","amount":数字,"reason":"简短理由"}]}。不要输出多余文字。';
  const user =
    `【指标定义】\n${metricText}\n\n` +
    `【规则】\n${describeRules(rules)}\n\n` +
    `【当前数值】\n${formatState(state, metrics)}\n\n` +
    `【剧情与决策】\n议题：${scenario.title}\n矛盾：${scenario.conflict}\n` +
    `玩家裁决意图：${decision.intent}\n执行偏差估计：${(deviation * 100).toFixed(0)}%（偏差越大，正向意图越可能被损耗）\n\n` +
    `【在场角色】\n${cast.map((p) => `- ${p.name}（${p.role}，${p.stance}）：忠诚${p.traits.loyalty}/野心${p.traits.ambition}/势力${p.traits.power}`).join('\n')}\n\n` +
    `【本轮辩论摘要】\n${debateSummary}`;
  return [
    { role: 'system', content: sys },
    { role: 'user', content: user },
  ];
}

// 把大模型（或任何来源）的 JSON 解析成受约束的 Delta 列表。
function parseDeltas(raw: string, rules: RuleDef[], metrics: MetricDef[]): Delta[] {
  const byKey = new Map(metrics.map((m) => [m.key, m]));
  const ruleByKey = new Map<string, RuleDef>();
  for (const r of rules) if (r.kind === 'reaction') for (const k of r.appliesTo ?? []) ruleByKey.set(k, r);

  let obj: any = null;
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    obj = JSON.parse(raw.slice(start, end + 1));
  } catch {
    return [];
  }
  const list: { key: string; amount: number; reason?: string }[] = [];
  if (Array.isArray(obj?.deltas)) {
    for (const d of obj.deltas) if (d && typeof d.key === 'string') list.push(d);
  } else if (obj && typeof obj === 'object') {
    for (const [k, v] of Object.entries(obj)) {
      if (k === 'deltas') continue;
      if (typeof v === 'number') list.push({ key: k, amount: v });
      else if (v && typeof (v as any).amount === 'number')
        list.push({ key: k, amount: (v as any).amount, reason: (v as any).reason });
    }
  }

  const out: Delta[] = [];
  for (const d of list) {
    const m = byKey.get(d.key);
    if (!m) continue; // 忽略规则未涉及的指标
    const rule = ruleByKey.get(d.key);
    const bound = resolveBound(rule, d.key) ?? Math.max(1, Math.round((m.max - m.min) / 4));
    let amount = Number(d.amount);
    if (!Number.isFinite(amount)) continue;
    amount = Math.max(-bound, Math.min(bound, amount));
    out.push({ key: d.key, amount, reason: d.reason ?? rule?.label ?? '反应', source: rule?.id ?? 'reaction' });
  }
  return out;
}

// 无 LLM 时的启发式：基于 hash 产生有界随机变动，并以执行偏差衰减「正向」变动。
function mockReaction(
  state: State,
  rules: RuleDef[],
  metrics: MetricDef[],
  cast: Persona[],
  decision: Decision,
  deviation: number,
): Delta[] {
  const out: Delta[] = [];
  for (const r of rules) {
    if (r.kind !== 'reaction') continue;
    for (const key of r.appliesTo ?? []) {
      const m = metrics.find((x) => x.key === key);
      if (!m) continue;
      const bound = resolveBound(r, key) ?? 5;
      const h = hash(key + '|' + decision.intent + '|' + cast.length);
      let amount = Math.round(((h % 1000) / 1000 - 0.5) * 2 * bound);
      // 偏差削弱「好方向」的变动：higherIsBetter 的正向、lowerIsBetter 的负向都算好方向。
      const goodDir = m.higherIsBetter ? amount > 0 : amount < 0;
      if (goodDir) amount = Math.round(amount * (1 - deviation * 0.6));
      out.push({ key, amount, reason: r.label + '（启发式）', source: r.id });
    }
  }
  return out;
}

// 主结算：叙事（执行衰减）+ 数值变动（反应规则）+ 阈值事件。
export async function computeSettlement(
  llm: LLMProvider,
  metrics: MetricDef[],
  rules: RuleDef[],
  state: State,
  scenario: Scenario,
  cast: Persona[],
  decision: Decision,
  debateSummary: string,
): Promise<{ settlement: Settlement; stateAfter: State }> {
  // 1) 执行衰减叙事 + 偏差因子（沿用原版思路）
  const decay = await applyDecay(decision, cast, undefined as any, llm);

  // 2) 反应规则 → 数值变动
  let deltas: Delta[] = [];
  const reactionRules = rules.filter((r) => r.kind === 'reaction');
  if (llm.isReal() && reactionRules.length) {
    const json = await llm.chat(buildSettlementPrompt(
      metrics, rules, state, scenario, cast, decision, debateSummary, decay.deviation,
    ));
    deltas = parseDeltas(json, rules, metrics);
  } else if (reactionRules.length) {
    deltas = mockReaction(state, rules, metrics, cast, decision, decay.deviation);
  }

  // 3) 落盘数值 + 阈值检测
  const stateAfter = applyDeltas(state, deltas, metrics);
  const thresholds: ThresholdEvent[] = checkThresholds(stateAfter, rules, metrics);

  const settlement: Settlement = {
    narrative: decay.actual,
    factors: decay.factors,
    deviation: decay.deviation,
    deltas,
    thresholds,
  };
  return { settlement, stateAfter };
}
