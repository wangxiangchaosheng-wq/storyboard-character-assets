import type { Decision, Persona, LLMProvider, Traits } from './types.ts';
import type { MemoryBank } from './memory.ts';

// 执行衰减结果（叙事 + 偏差来源）。数值变动在 calc.ts 的 Settlement 中处理。
export interface DecayResult {
  intended: string;
  actual: string;
  deviation: number;
  deviations: string[];
  factors: { trait: keyof Traits; value: number; effect: string }[];
}

// 执行衰减（对应原版「官僚执行衰减」）：裁决不是结果，
// 意志经在场角色层层传达，受忠诚 / 野心 / 势力扰动 → 实际效果打折、甚至被曲解。
export async function applyDecay(
  decision: Decision,
  cast: Persona[],
  _memory: MemoryBank,
  llm: LLMProvider,
): Promise<DecayResult> {
  const factors: DecayResult['factors'] = [];
  let resist = 0;
  for (const p of cast) {
    const t: Traits = p.traits;
    if (t.loyalty < 50) {
      resist += (50 - t.loyalty) * 0.2;
      factors.push({ trait: 'loyalty', value: t.loyalty, effect: `${p.name}忠诚偏低，可能阳奉阴违` });
    }
    if (t.ambition > 70) {
      resist += (t.ambition - 70) * 0.2;
      factors.push({ trait: 'ambition', value: t.ambition, effect: `${p.name}野心过大，可能借机谋私` });
    }
    if (t.power > 70) {
      resist += (t.power - 70) * 0.1;
      factors.push({ trait: 'power', value: t.power, effect: `${p.name}势力过大，可能架空决策` });
    }
  }
  const deviation = Math.min(1, resist / 100);

  let actual: string;
  if (llm.isReal()) {
    actual = await llm.chat([
      {
        role: 'system',
        content:
          '你负责推演「决策落地」时各方如何反应。请基于下列在场角色的特质，' +
          '描写决策真实执行后发生了什么偏差，语言要具体、有戏剧性。',
      },
      {
        role: 'user',
        content:
          `决策意图：${decision.intent}\n` +
          `在场角色及特质：\n` +
          cast
            .map(
              (p) =>
                `- ${p.name}（${p.role}，${p.stance}）：忠诚${p.traits.loyalty}/野心${p.traits.ambition}/势力${p.traits.power}`,
            )
            .join('\n') +
          `\n偏差程度估计：${(deviation * 100).toFixed(0)}%`,
      },
    ]);
  } else {
    const blockers = factors.map((f) => f.effect);
    actual =
      `你的裁决意图是：「${decision.intent}」。\n` +
      (blockers.length
        ? `但执行中受到干扰：${blockers.join('；')}。实际落地出现了约 ${Math.round(deviation * 100)}% 的损耗，并出现了意料之外的转向。`
        : `在场角色配合度较高，决策基本按意图落地，仅有轻微损耗。`);
  }

  return {
    intended: decision.intent,
    actual,
    deviation,
    deviations: factors.map((f) => f.effect),
    factors,
  };
}
