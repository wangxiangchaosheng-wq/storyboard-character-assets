import type { LLMMessage, ChatOptions, LLMProvider } from './types.ts';
import { safeFetch } from '@sim/llm';
import { AppError } from '@sim/contracts';

// OpenAI / compatible /chat/completions 响应结构（窄类型，仅取 content 字段）
type ChatResponse = { choices?: Array<{ message?: { content?: string } }> };

// 规则 / mock 提供器：不联网，用确定性模板生成角色发言。
// 设计上始终可用，保证引擎离线可跑、可演示。
export class MockProvider implements LLMProvider {
  readonly name = 'mock';
  isReal(): boolean {
    return false;
  }
  // 通用 chat 不会被调用（引擎在 isReal()===false 时走专用 mock 响应器）。
  async chat(): Promise<string> {
    throw new Error('MockProvider.chat 不应被直接调用；请使用 mockPersonaReply。');
  }
}

// OpenAI 兼容提供器（BYOK）：OpenAI / DeepSeek / 通义 / 阶跃 等兼容 /chat/completions 的端点均可。
export class OpenAIProvider implements LLMProvider {
  readonly name = 'openai-compatible';
  private apiKey: string;
  private baseUrl: string;
  private model: string;
  constructor(apiKey: string, baseUrl = 'https://api.openai.com/v1', model = 'gpt-4o-mini') {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }
  isReal(): boolean {
    return true;
  }
  async chat(messages: LLMMessage[], opts?: ChatOptions): Promise<string> {
    // 出站唯一入口：safeFetch 校验（拒绝私网/环回）+ 超时（docs/11 §2）
    const res = await safeFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts?.temperature ?? 0.8,
        max_tokens: opts?.maxTokens ?? 900,
      }),
    });
    if (!res.ok) {
      const body = await res.text().catch(() => '');
      if (res.status === 429) throw new AppError('4003', `LLM 限流 ${res.status}`);
      throw new AppError('4004', `LLM 请求失败 ${res.status}: ${body}`);
    }
    const data = await res.json() as ChatResponse;
    return data.choices?.[0]?.message?.content ?? '';
  }
}

// 由环境变量或参数构造提供器；没有 key 时回退到 mock。
export function createProvider(opts?: {
  apiKey?: string;
  baseUrl?: string;
  model?: string;
}): LLMProvider {
  const key = opts?.apiKey ?? process.env.OPENAI_API_KEY;
  if (key) {
    return new OpenAIProvider(
      key,
      opts?.baseUrl ?? process.env.OPENAI_BASE_URL,
      opts?.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini',
    );
  }
  return new MockProvider();
}
