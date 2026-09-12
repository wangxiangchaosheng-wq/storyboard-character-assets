/**
 * 对话层（聊天式推演）：玩家「点名某角色问策 / 向全体发话」→ 角色回应。
 * 无固定回合数 —— 对话流就是推演本身；数值只在玩家「下诏执行」时结算。
 *
 * 机制（directives）也在这里派生：不同对局因 spec 的 cast/role/stance 不同，
 * 会得到不同的「廷议机制」清单 —— 不写死话题，机制由本局人设自动长出来。
 */
import type { Persona, TalkTask, LLMProvider, RuleDef, MetricDef, ScenarioSpec } from './types.ts';
import type { MemoryBank } from './memory.ts';
import { runAgentLoop, type Tool } from './agentLoop.ts';
import { runDebateRound } from './debate.ts';
import { mockPersonaChat } from './mock.ts';

export interface DialogOptions {
  maxTokens?: number;
  /** 角色可调用的工具（如看数值/看最近笔录）；真实 LLM 才真正执行 */
  tools?: Tool[];
  /** 按角色构建其专属工具运行时（行动类工具需绑定调用者身份）。优先于静态 tools。 */
  toolsFactory?: (persona: Persona) => Tool[];
  /** 全场廷议时的交锋轮数（见 debate.ts 的 passes） */
  passes?: number;
}

/** 一条角色回应（与 Utterance 形状一致，便于复用现有渲染）。 */
export interface PersonaReply {
  speaker: string;
  speakerName: string;
  stance?: string;
  content: string;
}

/**
 * 廷议议题：围绕本局核心矛盾推进。
 * 议题不是拍死的六句——每番把上一轮辩论纪要也带进来，让议题随朝局演化。
 */
export function talkTaskFor(spec: ScenarioSpec, turn: number, lastSummary?: string): TalkTask {
  // 焦点用「矛盾」本身（conflict 每局不同），不用通用的 decisionPoint
  // （"作为统筹者，你最终下达怎样的决断？"）——否则多番议题听起来像同一条官话。
  const focus = spec.scenario.conflict || spec.scenario.decisionPoint;
  const withLast = lastSummary && lastSummary.trim()
    ? `\n上轮廷议纪要：${lastSummary.trim().slice(0, 160)}`
    : '';
  return {
    round: Math.max(1, turn),
    topic:
      turn > 1
        ? `合议「${focus.slice(0, 30)}」——第 ${turn} 番，局势新变，重新权衡立场。`
        : `合议「${focus.slice(0, 40)}」——各执己见者，先亮明立场与底牌。`,
    context: `${spec.scenario.conflict}\n背景：${spec.scenario.background}${withLast}`,
  };
}

/** 点名一位角色回应对策；真实 LLM 走 agent loop，mock 走规则对话器。 */
export async function askPersona(
  cast: Persona[],
  toId: string | undefined,
  task: TalkTask,
  llm: LLMProvider,
  memory: MemoryBank,
  playerText: string,
  stateBlock: string,
  opts: DialogOptions = {},
): Promise<PersonaReply[]> {
  const target = toId ? cast.find((p) => p.id === toId) : undefined;
  if (target) {
    const content = llm.isReal()
      ? await runAgentLoop(
          target,
          {
            round: task.round,
            topic: task.topic,
            context: task.context + `\n玩家（主上）刚才问：${playerText}`,
          },
          memory[target.id],
          llm,
          {
            stateBlock,
            maxTokens: opts.maxTokens ?? 600,
            tools: opts.toolsFactory ? opts.toolsFactory(target) : opts.tools,
          },
        )
      : mockPersonaChat(target, playerText, stateBlock);
    return [{ speaker: target.id, speakerName: target.name, stance: target.stance, content }];
  }
  // 未点名 → 全场廷议一圈：后发言者能听到先发言者（真实 LLM 上下文里带上），
  // 不再是"两个固定角色背稿"。
  const utterances = await runDebateRound(
    cast,
    { ...task, context: task.context + `\n玩家（主上）刚才说话：${playerText}` },
    llm,
    memory,
    {
      stateBlock,
      maxTokens: opts.maxTokens ?? 500,
      tools: opts.tools,
      toolsFactory: opts.toolsFactory,
      passes: opts.passes,
      questionSeed: playerText,
    },
  );
  return utterances.map((u) => ({
    speaker: u.speaker,
    speakerName: u.speakerName,
    stance: u.stance,
    content: u.content,
  }));
}

// ---------- 机制（Directives）：由本局的人设与规则自动派生 ----------

export interface DirectivePlan {
  key: string;
  kind: 'consult' | 'decree' | 'countersign';
  label: string;
  hint: string;
  personaId?: string;
}

/** 依 cast 生成「问计于谁」—— 每名角色一个带有其身份色彩的机制。 */
export function deriveDirectives(cast: Persona[], rules: RuleDef[], metrics: MetricDef[]): DirectivePlan[] {
  const out: DirectivePlan[] = [];
  // ① 问策化身：每位角色可「单独问计」
  for (const p of cast) {
    out.push({
      key: 'ask:' + p.id,
      kind: 'consult',
      label: '问计于' + p.name,
      hint: '单独召见 · ' + p.role + ' · 立场「' + p.stance + '」',
      personaId: p.id,
    });
  }
  // ② 依职降旨：给身份最高者一道"督办"（按 role 而非硬编码人名）
  const leader = [...cast].sort((a, b) => (b.influence ?? 0) - (a.influence ?? 0))[0];
  if (leader) {
    out.push({
      key: 'charge:' + leader.id,
      kind: 'decree',
      label: '下旨' + leader.role,
      hint: '以「' + leader.stance + '」为纲，责令' + leader.name + '推进',
      personaId: leader.id,
    });
  }
  // ③ 稳压：若 leader 与某角色立场相反，则给出「平衡」机制
  const opp = cast.find((p) => p.stance !== leader?.stance);
  if (leader && opp) {
    out.push({
      key: 'balance:' + opp.id,
      kind: 'countersign',
      label: '安抚' + opp.name,
      hint: '安抚' + opp.role + ' · 避免其掣肘',
      personaId: opp.id,
    });
  }
  // ④ 数值仪表式的机制：针对当前可改善的指标给出"择措"(从最高影响指标拉伸)
  const influenceMetric = [...metrics].sort((a, b) => (b.start ?? 0) - (a.start ?? 0))[0];
  if (influenceMetric) {
    out.push({
      key: 'push:' + influenceMetric.key,
      kind: 'decree',
      label: '着力' + (influenceMetric.label ?? influenceMetric.key),
      hint: '集中资源推动「' + (influenceMetric.label ?? influenceMetric.key) + '」',
    });
  }
  return out.slice(0, 8);
}