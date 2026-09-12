import type { Persona, TalkTask, Utterance, LLMProvider } from './types.ts';
import type { MemoryBank } from './memory.ts';
import { runAgentLoop, type AgentLoopOpts, type Tool } from './agentLoop.ts';
import { mockPersonaReply, mockPersonaRebutt } from './mock.ts';

export interface DebateOptions extends AgentLoopOpts {
  /** 每回合入局角色的发言数上限（防御） */
  maxRoundsPerDebate?: number;
  /**
   * 交锋轮数。1 = 每人各表一次态（原行为）；
   * 2 = 表态后再各自针对立场相左者的原话回应一轮（多角色真正有来有回）。
   */
  passes?: number;
  /**
   * 玩家促议的原始文本（问策/诏令）——掺进 mock 的 random seed 与开场白，
   * 使不同番次的廷议不复读同一套台词。
   */
  questionSeed?: string;
  /**
   * 按角色构建其专属工具运行时（arena_three_kingdoms 的 per-agent runtime 模式）：
   * 行动类工具（密折呈递/记忆检索）需绑定调用者身份。优先于静态 opts.tools。
   */
  toolsFactory?: (persona: Persona) => Tool[];
}

function toText(u: Utterance): string {
  return `${u.speakerName}（${u.stance ?? ''}）：${u.content}`;
}

/**
 * 驱动一轮辩论：先全员各表态一次，如需交锋（passes>1）再让每位
 * 针对上一轮对立立场者的原话回应。后发言者始终能看到先发言者的内容——
 * 真实 LLM 走 ReAct agent loop（前文写进 task.context）；mock 走规则响应器
 * （具体引用前文原话 + 独立人格句式）。
 */
export async function runDebateRound(
  cast: Persona[],
  task: TalkTask,
  llm: LLMProvider,
  memory: MemoryBank,
  opts: DebateOptions = {},
): Promise<Utterance[]> {
  const passes = opts.passes ?? 1;
  // 本回合开始：清掉上一回合的 currentTurn（只留本回合发言）
  for (const p of cast) memory[p.id].currentTurn = [];

  const utterances: Utterance[] = [];
  let historyText = '';

  // ---- 第 1 轮：全员表态 ----
  for (const p of cast) {
    let content: string;
    if (llm.isReal()) {
      const prior = utterances.map(toText).join('\n');
      const ctx = task.context + (prior ? `\n\n【本回合已有一位在前发言】\n${prior}` : '');
      // per-agent 工具运行时：行动类工具绑定调用者身份（toolsFactory 优先于静态 tools）
      const personaTools = opts.toolsFactory ? opts.toolsFactory(p) : opts.tools;
      content = await runAgentLoop(
        p,
        { ...task, context: ctx },
        memory[p.id],
        llm,
        { ...opts, tools: personaTools, maxTokens: opts.maxTokens ?? 500 },
      );
    } else {
      const last = utterances.at(-1);
      content = mockPersonaReply(
        p,
        task,
        historyText,
        opts.stateBlock,
        last ? { name: last.speakerName, stance: last.stance, content: last.content } : undefined,
        { seed: opts.questionSeed, round: task.round },
      );
    }
    const u: Utterance = { speaker: p.id, speakerName: p.name, content, stance: p.stance, round: task.round };
    utterances.push(u);
    historyText += toText(u) + '\n';
    memory[p.id].currentTurn.push(toText(u));
  }

  // ---- 第 2 轮起：必答（找立场与自己相左者交锋，无人相左则跳过） ----
  for (let pass = 2; pass <= passes; pass++) {
    const firstHalf = [...utterances];
    for (const p of cast) {
      const opponents = firstHalf
        .filter((u) => u.speaker !== p.id && u.stance !== undefined && u.stance !== p.stance)
        .map((u) => ({ name: u.speakerName, content: u.content }));
      if (!opponents.length) continue; // 无人立场相左，无需交锋
      let content: string;
      if (llm.isReal()) {
        const prior = firstHalf.map(toText).join('\n');
        const ctx =
          task.context +
          `\n\n【交锋时刻】上面是全员首轮表态。请针对与你立场相左的那位，逐条回应其原话（可用工具查看局势）。\n${prior}`;
        const personaTools = opts.toolsFactory ? opts.toolsFactory(p) : opts.tools;
        content = await runAgentLoop(
          p,
          { ...task, context: ctx },
          memory[p.id],
          llm,
          { ...opts, tools: personaTools, maxTokens: opts.maxTokens ?? 400 },
        );
      } else {
        content = mockPersonaRebutt(p, task, opponents, opts.stateBlock, { seed: opts.questionSeed, round: task.round });
      }
      const u: Utterance = { speaker: p.id, speakerName: p.name, content, stance: p.stance, round: task.round };
      utterances.push(u);
      historyText += `（第 ${pass} 轮交锋）${toText(u)}\n`;
      memory[p.id].currentTurn.push(`（第 ${pass} 轮交锋）${u.content}`);
    }
  }
  return utterances;
}