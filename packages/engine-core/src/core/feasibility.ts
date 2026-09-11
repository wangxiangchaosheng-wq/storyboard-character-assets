import type { Decision, Persona, LLMProvider, State, MetricDef, RuleDef, Scenario } from './types.ts';
import type { SearchProvider } from '@sim/llm';

export interface FeasibilityResult {
  feasible: boolean;
  rejectionReason?: string;
  level: 'full' | 'partial' | 'impossible';
  reasoning: string;
  suggestion?: string;
  confidence: number;
}

/**
 * 可行性引擎：基于搜索事实 + 角色特质，判断玩家决策是否可行。
 * - full   ：完全可行，无重大障碍
 * - partial：部分可行，需调整或付出额外代价
 * - impossible：不可行，必须告知玩家并建议替代方案
 */
export class FeasibilityEngine {
  private search: SearchProvider;
  private llm: LLMProvider;
  constructor(search: SearchProvider, llm: LLMProvider) {
    this.search = search;
    this.llm = llm;
  }

  async assess(
    decision: Decision,
    cast: Persona[],
    state: State,
    metrics: MetricDef[],
    scenario: Scenario,
    rules: RuleDef[],
    _previousRoundsSummary: string,
    topicText?: string,
  ): Promise<FeasibilityResult> {
    // 把话题原文、冲突描述和决策文本合并成搜索查询，获取更多相关史实
    const searchContext = `${topicText ?? ''} ${scenario.conflict} ${decision.intent} ${scenario.background.slice(0, 100)}`.trim();
    const searchQueries = this.buildSearchQueries(searchContext);
    const allFacts: string[] = [];
    for (const q of searchQueries) {
      try {
        const hits = await this.search.search(q);
        for (const f of hits) {
          if (!allFacts.includes(f.claim)) allFacts.push(f.claim);
        }
      } catch { /* 单一搜索词失败不致命 */ }
    }

    if (allFacts.length > 0 && (this.llm.isReal() || this.search.isReal())) {
      // LLM 模式下优先用 mock 规则判定（快、确定性）；仅在规则不足时回退 LLM
      const mockResult = this.mockAssess(decision, cast, state, metrics, scenario, allFacts);
      // 硬编码两线作战检测：两线意图 + 史实约束 = 强制 impossible/partial
      const mil = state['m4'] ?? state['兵额'] ?? 0;
      const twoFront = /两线|同时.*攻|东西.*夹|南北.*并进/.test(decision.intent);
      const hasTwoFrontFact = allFacts.some(f => /两线.*作战|从未敢两线开战/.test(f));
      if (twoFront && hasTwoFrontFact) {
        const reason = mil > 0 ? '两线作战风险极高：兵力' + mil + '不足以分兵，且史实明确禁止两线开战' : '两线作战：史实明确禁止蜀汉两线开战';
        return { feasible: false, level: 'impossible', reasoning: reason, rejectionReason: reason, suggestion: '建议先集中力量对付一个方向，再图其他', confidence: 0.9 };
      }
      if (mockResult.level !== 'full' && mockResult.level !== 'impossible') {
        // partial 结果：再调用 LLM 补充推理
        try {
          return await this.llmAssess(decision, cast, state, metrics, scenario, allFacts);
        } catch {
          // LLM 超时或失败时回落 mock 结果
        }
      }
      return mockResult;
    }
    // mock 模式或无搜索事实时，把史实融入 mockAssess 的推理上下文
    return this.mockAssess(decision, cast, state, metrics, scenario, allFacts);
  }

  // ── LLM 推理模式 ──
  private async llmAssess(
    decision: Decision,
    cast: Persona[],
    state: State,
    metrics: MetricDef[],
    scenario: Scenario,
    facts: string[],
  ): Promise<FeasibilityResult> {
    const stateStr = metrics.map((m) => `${m.label}=${state[m.key] ?? '?'}`).join('、');
    const castText = cast.map((p) =>
      `- ${p.name}（${p.stance}·${p.role}）：能力${p.traits.competence} 忠诚${p.traits.loyalty} 野心${p.traits.ambition}`,
    ).join('\n');
    const factsText = facts.length > 0 ? facts.slice(0, 5).map((f, i) => `${i+1}. ${f}`).join('\n') : '（暂无额外信息）';
    const prompt =
      `你是战略分析师，严格依据史实约束评估决策可行性。

【铁律】两线/多线同时作战在冷兵器时代几乎必然失败：兵力分散、后勤崩溃、战线过长。若史实中有「从未两线开战」「最多对付一个方向」「国力不足」等约束，必须判定 partial 或 impossible。
level=impossible：兵力低于对手任一方向、史实明确禁止两线作战、后勤无法支撑。
level=partial：有一定可能但代价极高、需极度谨慎。
level=full：史实未显示明显障碍、兵力充足。。\n\n` +
      `决策意图：${decision.intent}\n` +
      `当前数值：${stateStr}\n` +
      `在场角色：\n${castText}\n` +
      `背景：${scenario.background.slice(0, 150)}\n` +
      `相关史实：\n${factsText}\n\n` +
      `请输出 JSON（不要代码块）：{"level":"full|partial|impossible","reasoning":"推理(100字内)","rejectionReason":"","suggestion":"","confidence":0.8}`;
    try {
      const raw = await this.llm.chat([{ role: 'user', content: prompt }]);
      const start = raw.indexOf('{');
      const end = raw.lastIndexOf('}');
      if (start >= 0 && end > start) {
        const obj = JSON.parse(raw.slice(start, end + 1)) as Partial<FeasibilityResult>;
        return {
          feasible: obj.level !== 'impossible',
          level: obj.level ?? 'full',
          reasoning: obj.reasoning ?? '',
          rejectionReason: obj.rejectionReason,
          suggestion: obj.suggestion,
          confidence: obj.confidence ?? 0.7,
        };
      }
    } catch { /* 降级 */ }
    return this.mockAssess(decision, cast, state, metrics, scenario, []);
  }

  // ── Mock 规则引擎 ──
  private mockAssess(
    decision: Decision,
    cast: Persona[],
    state: State,
    metrics: MetricDef[],
    _scenario: Scenario,
    searchFacts: string[] = [],
  ): FeasibilityResult {
    const intent = decision.intent.toLowerCase();
    // 动态查找指标 key：按 label 匹配（指标顺序由 LLM 决定，不可硬编码 m1/m2/m3/m4）
    const milKey = metrics.find(m => /兵额|兵力|军队|马匹/.test(m.label))?.key ?? '';
    const treasKey = metrics.find(m => /岁入|财政|国库|银钱|赋税/.test(m.label))?.key ?? '';
    const foodKey = metrics.find(m => /粮储|军粮|粮草|屯田/.test(m.label))?.key ?? '';
    const mil = milKey ? (state[milKey] ?? 0) : 0;
    const treas = treasKey ? (state[treasKey] ?? 0) : 0;
    const food = foodKey ? (state[foodKey] ?? 0) : 0;

    let blockScore = 0;
    const reasons: string[] = [];

    // 兵力检查
    if (/进攻|攻打|征伐|北伐|南征|出兵|伐|战/.test(intent) && mil < 20) {
      reasons.push(`兵力不足（${mil}万），难以支撑进攻行动`);
      blockScore += 30;
    }
    if (/两线|同时.*攻|东西.*夹|南北.*并进/.test(intent) && mil < 40) {
      reasons.push(`两线作战风险极高：兵力${mil}万不足以分兵`);
      blockScore += 40;
    }
    if (/全面|全线|全部.*攻/.test(intent) && mil < 30) {
      reasons.push(`全面进攻需充足兵力储备，当前${mil}万偏少`);
      blockScore += 20;
    }

    // 财政检查
    if (/加税|增赋|加派|Heavy.*税/.test(intent) && treas < 150) {
      reasons.push(`国库空虚（岁入${treas}万两），加税恐引发民变`);
      blockScore += 25;
    }
    if (/大规模.*建设|大兴土木/.test(intent) && treas < 200) {
      reasons.push(`财政紧张，难以支撑大规模建设`);
      blockScore += 15;
    }

    // 粮食检查
    if (/养兵|扩军|征兵/.test(intent) && food < 200) {
      reasons.push(`粮储不足（${food}万石），无法支撑扩军`);
      blockScore += 25;
    }

    // 角色配合度检查
    for (const p of cast) {
      if (p.traits.loyalty < 40) {
        reasons.push(`${p.name}忠诚偏低（${p.traits.loyalty}），执行可能打折扣`);
        blockScore += 10;
      }
      if (p.traits.ambition > 75 && /进攻|征伐|扩张/.test(intent) && p.stance === '稳守') {
        reasons.push(`${p.name}（${p.stance}）与进攻决策立场冲突`);
        blockScore += 15;
      }
      if (p.traits.power > 75 && /增收|改革|集权|削减/.test(intent)) {
        reasons.push(`${p.name}势力过大（影响力${p.influence}），可能阻挠改革`);
        blockScore += 20;
      }
    }

    // 如果有搜索到史实，把史实中的关键限制条件也加入 blockScore
    // 只要搜索到有"两线/多线作战"相关事实，且意图涉及任何军事行动，就扣分
    const hasMilitaryIntent = /进攻|攻打|征伐|出兵|战|伐|攻|战|讨|破|平|征|北伐|南征|东征|西征|全面|全线|推进|出击|征讨|克复|收复|击破|荡平/.test(intent);
    for (const fact of searchFacts) {
      const f = fact.toLowerCase();
      if (/两线.*作战|同时.*攻|多线.*战|南北.*夹|东西.*夹|两路.*出兵/.test(f)) {
        if (hasMilitaryIntent) {
          reasons.push(`史实提醒：${fact}`);
          blockScore += 30;
        }
      }
      if (/国力最弱|兵力有限|难以支撑|极为困难|从未敢|不可能/.test(f) && hasMilitaryIntent) {
        reasons.push(`史实提醒：${fact}`);
        blockScore += 15;
      }
      if (/财政.*拖垮|入不敷出|常年.*空虚/.test(f) && /进攻|战争|征伐|出兵/.test(intent)) {
        reasons.push(`史实提醒：${fact}`);
        blockScore += 20;
      }
    }

    // 判定
    let level: 'full' | 'partial' | 'impossible';
    if (blockScore >= 50) level = 'impossible';
    else if (blockScore >= 20) level = 'partial';
    else level = 'full';

    const suggestion = this.buildSuggestion(intent, state, mil, treas, food);
    const factContext = searchFacts.length > 0
      ? `【史实】${searchFacts.slice(0, 2).join('；')}。`
      : '';

    return {
      feasible: level !== 'impossible',
      level,
      reasoning: reasons.length > 0
        ? `${factContext}基于以下因素评估：${reasons.join('；')}`
        : `${factContext}未发现明显可行性障碍`,
      rejectionReason: level === 'impossible' ? reasons.join('；') : undefined,
      suggestion: level !== 'full' ? suggestion : undefined,
      confidence: Math.max(0.3, 1 - blockScore / 100),
    };
  }

  private buildSearchQueries(context: string): string[] {
    const tokens = context.match(/[\u4e00-\u9fa5]{2,4}/g) ?? [];
    const seen = new Set<string>();
    const queries: string[] = [];
    for (const t of tokens) {
      if (t.length < 2 || seen.has(t)) continue;
      seen.add(t);
      queries.push(t);
      if (queries.length >= 3) break;
    }
    return queries;
  }

  private buildSuggestion(intent: string, _state: State, mil: number, treas: number, food: number): string {
    const parts: string[] = [];
    if (/进攻|攻打|征伐/.test(intent) && mil < 30) {
      parts.push(`先积蓄兵力至 ${Math.ceil(mil * 1.5)} 万以上再考虑进攻`);
    }
    if (/加税|增赋/.test(intent) && treas < 200) {
      parts.push('先恢复经济、增加岁入后再考虑加税');
    }
    if (/两线|同时.*攻/.test(intent)) {
      parts.push('建议先集中力量对付一个方向，再图其他');
    }
    if (/扩军|养兵/.test(intent) && food < 200) {
      parts.push('先充实粮储再考虑扩军');
    }
    if (parts.length === 0) parts.push('建议重新评估决策目标或等待更好时机');
    return parts.join('；');
  }
}
