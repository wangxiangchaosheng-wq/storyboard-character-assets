import type { Persona, Utterance, LLMProvider } from './types.ts';

// 记忆分层（解决长局上下文爆炸，对应原版 long_term / current_turn / memory-compression）
export interface AgentMemory {
  longTerm: string;       // 长期人设 / 背景
  currentTurn: string[];  // 本回合发言
  history: string[];      // 已压缩的历史摘要
}

export type MemoryBank = Record<string, AgentMemory>;

export function initMemory(cast: Persona[]): MemoryBank {
  const bank: MemoryBank = {};
  for (const p of cast) {
    bank[p.id] = {
      longTerm: p.prompt,
      currentTurn: [],
      history: [],
    };
  }
  return bank;
}

// 把一轮辩论压缩成摘要，固化进长期历史。
export async function compressRound(
  utterances: Utterance[],
  llm: LLMProvider,
  round: number,
): Promise<string> {
  if (llm.isReal()) {
    const text = utterances.map((u) => `${u.speakerName}：${u.content}`).join('\n');
    const summary = await llm.chat([
      {
        role: 'system',
        content: '你是记录员，请用 2-3 句话客观概括下面这段多角色讨论的核心分歧与结论。',
      },
      { role: 'user', content: text },
    ]);
    return `第${round}轮：${summary}`;
  }
  // 规则版：截取每人首句，形成可复现的简短摘要。
  const parts = utterances.map((u) => `${u.speakerName}：${u.content.slice(0, 40)}…`);
  return `第${round}轮：${parts.join('；')}`;
}
