import type { Persona, TalkTask, LLMProvider, LLMMessage } from './types.ts';
import type { AgentMemory } from './memory.ts';

// 可选工具：真实 LLM 模式下可被 agent 调用（ReAct 式）。mock 模式不使用。
export interface Tool {
  name: string;
  description: string;
  run: (args: Record<string, unknown>) => Promise<string>;
}

export interface AgentLoopOpts {
  maxRounds?: number;  // 对齐原版 maxRounds = 30
  tools?: Tool[];
  stateBlock?: string; // 当前数值快照（反馈给角色，让它依据局势发言）
  maxTokens?: number;  // 单轮回复 token 上限（透传 LLM.chat）
}

function buildSystem(p: Persona, task: TalkTask, tools: Tool[], stateBlock?: string): string {
  const toolDesc = tools.length
    ? `\n可用工具：\n${tools.map((t) => `- ${t.name}：${t.description}`).join('\n')}\n如需调用，只回复 JSON：{"tool":"name","args":{...}}。`
    : '';
  const stateDesc = stateBlock
    ? `\n【当前局势数值】（你应参考这些数字来表态，注意它们会随推演变化）\n${stateBlock}\n`
    : '';
  return (
    `${p.prompt}\n\n你正在参与一场多智能体推演。\n` +
    `当前议题：${task.topic}\n${task.context}\n` +
    `${stateDesc}` +
    `请以你的立场发言，必要时提出主张或反驳。${toolDesc}`
  );
}

function tryParseTool(
  raw: string,
  tools: Tool[],
): { tool: Tool; args: Record<string, unknown> } | null {
  const m = raw.match(/\{[^{}]*"tool"\s*:\s*"([^"]+)"[^{}]*\}/);
  if (!m) return null;
  const name = m[1];
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  try {
    const start = m.index!;
    const snippet = raw.slice(start, start + m[0].length);
    const obj = JSON.parse(snippet);
    return { tool, args: obj.args ?? {} };
  } catch {
    return null;
  }
}

// ReAct 式 agent loop：可多轮调用工具，直到不再请求工具为止（最多 maxRounds 轮）。
// 真实 LLM 走此路径；mock 模式不走（见 debate.ts）。
export async function runAgentLoop(
  persona: Persona,
  task: TalkTask,
  memory: AgentMemory,
  llm: LLMProvider,
  opts: AgentLoopOpts = {},
): Promise<string> {
  const maxRounds = opts.maxRounds ?? 30;
  const tools = opts.tools ?? [];
  const sys = buildSystem(persona, task, tools, opts.stateBlock);
  const messages: LLMMessage[] = [{ role: 'system', content: sys }];
  if (memory.history.length) {
    messages.push({ role: 'user', content: '此前局势摘要：\n' + memory.history.join('\n') });
  }
  let finalText = '';
  for (let r = 0; r < maxRounds; r++) {
    messages.push({
      role: 'user',
      content: r === 0 ? '请就当前议题发表你的立场与主张。' : '继续推进讨论，或给出结论。',
    });
    const raw = await llm.chat(messages, { temperature: 0.85, ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}) });
    const toolReq = tryParseTool(raw, tools);
    if (toolReq) {
      const result = await toolReq.tool.run(toolReq.args);
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'tool', content: result });
      continue;
    }
    finalText = raw;
    break;
  }
  return finalText;
}
