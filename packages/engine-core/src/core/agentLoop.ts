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
  /** 最多允许的纯工具轮数：超过后强制要求自然语言表态（防工具死循环+空发言） */
  maxToolRounds?: number;
}

function buildSystem(p: Persona, task: TalkTask, tools: Tool[], stateBlock?: string): string {
  const toolDesc = tools.length
    ? `\n可用工具（最多调用 2 次）：\n${tools.map((t) => `- ${t.name}：${t.description}`).join('\n')}\n如需调用工具，请在自然语言发言之后，另起一行加上工具调用JSON，例如：{"tool":"view_state","args":{}}。工具结果将补充在你的发言中。`
    : '';
  const stateDesc = stateBlock
    ? `\n【当前局势数值】（你应参考这些数字来表态，注意它们会随推演变化）\n${stateBlock}\n`
    : '';
  return (
    `${p.prompt}\n\n你正在参与一场多智能体推演。\n` +
    `【身份锚定】你自始至终是「${p.name}」（${p.role}）。发言中的自称必须与该身份一致（皇帝用朕/孤，太后用老身，臣子用臣/老臣/奴才），绝不冒用他人姓名或称谓。\n` +
    `当前议题：${task.topic}\n${task.context}\n` +
    `${stateDesc}` +
    `请以你的立场发言，必要时提出主张或反驳。\n` +
    `【重要】你必须始终以角色身份用自然语言发言。需要查数时直接调用工具（无需声明），拿到结果后立刻给出立场陈述。\n` +
    `【输出纪律】最终发言只包含角色台词本身，禁止出现：工具调用JSON、工具结果回显、思考标签、` +
    `任何元话语（如"容我先查看""欲观朝局实况""先定措辞"）、其他角色的发言复述。\n${toolDesc}`
  );
}

/** 从文本中移除平衡的工具调用 JSON（从含 "tool" 键的 { 起到配对 } 止） */
function stripToolJson(text: string): string {
  let out = text;
  for (let pass = 0; pass < 6; pass++) {
    const m = out.match(/"tool"\s*:\s*"/);
    if (!m || m.index === undefined) break;
    // 从 key 前最近的 { 起
    let start = out.lastIndexOf('{', m.index);
    if (start === -1) break;
    // 向后扫描配对 }
    let depth = 0;
    let end = -1;
    let inStr = false;
    let esc = false;
    for (let i = start; i < out.length; i++) {
      const ch = out[i];
      if (esc) { esc = false; continue; }
      if (ch === '\\') { esc = true; continue; }
      if (ch === '"') inStr = !inStr;
      if (inStr) continue;
      if (ch === '{') depth++;
      else if (ch === '}') {
        depth--;
        if (depth === 0) { end = i + 1; break; }
      }
    }
    if (end === -1) break;
    out = (out.slice(0, start) + out.slice(end)).trim();
  }
  return out;
}

/** 清理推理标签与元话语残片 */
function stripReasoning(text: string): string {
  return text
    .replace(/<think>[\s\S]*?<\/think>/gi, '')
    .replace(/<\/?think>/gi, '')
    .replace(/<tool_calls>[\s\S]*?<\/tool_calls>/g, '')
    .trim();
}

/** 防御性清理：模型复读的工具结果块 / 数据 dict 回显 */
function stripEchoedToolResult(text: string): string {
  return text
    .replace(/=+\s*工具调用结果\s*=+[\s\S]*?(?=\n\n|\n[^=\n]|\*$|$)/g, '')
    .replace(/【调用局势】[\s\S]*?(?=\n\n|$)/g, '')
    .replace(/-{2,}\s*【朝局态势】[\s\S]*?(?=\n\n|\n-{2,}|$)/g, '')
    .trim();
}

function tryParseTool(
  raw: string,
  tools: Tool[],
): { tool: Tool; args: Record<string, unknown> } | null {
  // 简单匹配 "tool":"xxx" 即可（兼容嵌套括号如 {"tool":"x","args":{}}）
  const m = raw.match(/"tool"\s*:\s*"([^"]+)"/);
  if (!m) return null;
  const name = m[1];
  const tool = tools.find((t) => t.name === name);
  if (!tool) return null;
  // 提取工具调用所在的 JSON 对象（从最近的 { 到匹配的 }）
  const idx = m.index!;
  let braceCount = 0;
  let endIdx = idx;
  // 向前找 {
  let startIdx = idx;
  for (let i = idx; i >= 0; i--) {
    if (raw[i] === '}') braceCount++;
    else if (raw[i] === '{') {
      braceCount--;
      if (braceCount < 0) { startIdx = i + 1; break; }
      startIdx = i;
      break;
    }
  }
  // 向后找匹配的 }
  braceCount = 0;
  for (let i = startIdx; i < raw.length; i++) {
    if (raw[i] === '{') braceCount++;
    else if (raw[i] === '}') {
      braceCount--;
      if (braceCount === 0) { endIdx = i + 1; break; }
    }
  }
  const snippet = raw.slice(startIdx, endIdx);
  try {
    const obj = JSON.parse(snippet);
    return { tool, args: obj.args ?? {} };
  } catch {
    return null;
  }
}

function looksLikeRawToolJson(text: string): boolean {
  const stripped = text.replace(/```[a-z]*\n?/gi, '').trim();
  return /^\{[\s\S]*"tool"[\s\S]*\}$/.test(stripped) && stripped.replace(/\s/g, '').length < 300;
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
  const maxRounds = opts.maxRounds ?? 6;
  const maxToolRounds = opts.maxToolRounds ?? 2;
  const tools = opts.tools ?? [];
  const sys = buildSystem(persona, task, tools, opts.stateBlock);
  const messages: LLMMessage[] = [{ role: 'system', content: sys }];
  if (memory.history.length) {
    messages.push({ role: 'user', content: '此前局势摘要：\n' + memory.history.join('\n') });
  }
  let finalText = '';
  let toolRounds = 0;
  for (let r = 0; r < maxRounds; r++) {
    const forceProse = toolRounds >= maxToolRounds;
    messages.push({
      role: 'user',
      content: forceProse
        ? '工具调用次数已用完。请立即以你的角色身份给出完整的立场陈述（禁止任何工具调用JSON）。'
        : r === 0
          ? '请就当前议题发表你的立场与主张。'
          : '继续推进讨论，或给出结论。',
    });
    const raw = await llm.chat(messages, { temperature: 0.85, ...(opts.maxTokens !== undefined ? { maxTokens: opts.maxTokens } : {}) });
    let cleaned = stripReasoning(raw);
    const toolReq = tryParseTool(cleaned, tools);
    if (toolReq && !forceProse) {
      toolRounds++;
      const result = await toolReq.tool.run(toolReq.args);
      messages.push({ role: 'assistant', content: raw });
      messages.push({ role: 'tool', content: result });
      continue;
    }
    // 正常回复：移除工具 JSON 残片与复读的回显
    cleaned = stripToolJson(cleaned);
    cleaned = stripEchoedToolResult(cleaned);
    // 纯工具JSON / 过短：本轮作废，继续要正文（不再回退到原始文本）
    if (looksLikeRawToolJson(cleaned) || cleaned.replace(/\s/g, '').length < 6) {
      finalText = '';
      continue;
    }
    finalText = cleaned;
    break;
  }
  // 兜底：绝不返回空串或 JSON——给一条符合身份的最小说话
  if (!finalText || looksLikeRawToolJson(finalText)) {
    const stance = persona.stance ?? '协商';
    finalText = `臣${persona.name}以为，此事关乎大局，臣持${stance}之见：当以社稷为重，徐图良策。`;
  }
  return finalText.trim();
}
