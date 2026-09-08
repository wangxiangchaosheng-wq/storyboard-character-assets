/**
 * Provider 抽象（docs/06 §2）—— 业务只依赖这四个接口。
 * 换模型 = 改 .env，不碰业务代码。全部出站请求走 safeFetch（本包）。
 */
import { AppError } from '@sim/contracts';
import { safeFetch } from './safeFetch.ts';

export interface ChatMessage {
  role: 'system' | 'user' | 'assistant' | 'tool';
  content: string;
}

export interface CompletionOpts {
  temperature?: number;
  maxTokens?: number;
  /** 强制输出 JSON（外层解析失败会重试 1 次再降级） */
  jsonMode?: boolean;
}

export interface StreamChunk {
  delta: string; // token 增量
  finished?: boolean;
}

export interface ChatProvider {
  readonly name: string;
  isReal(): boolean;
  /** 非流式补全（校验/小批量场景） */
  generate(messages: ChatMessage[], opts?: CompletionOpts): Promise<string>;
  /** 流式透传到服务端 SSE（服务层将 chunk.delta 原样转发） */
  stream(messages: ChatMessage[], opts?: CompletionOpts): AsyncIterable<StreamChunk>;
}

export interface EmbedProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface ImageGenReq {
  prompt: string;
  style?: string; // '立绘' | '水墨' | '卷轴' 等，端上 stable
  size?: string; // '512x512' | '768x1024'
}

export interface ImageGenResult {
  kind: 'url' | 'b64';
  data: string;
  mime?: string;
}

export interface ImageProvider {
  /** 是否真实模型（false = 占位/演示素材，端上可据此打水印） */
  isReal(): boolean;
  gen(req: ImageGenReq): Promise<ImageGenResult>;
}

/** cpk-agnes 生图（docs/06）：按 OpenAI 兼容 /images/generations 契约实现，key/基址从 env 注入 */
export class AgnesImageProvider implements ImageProvider {
  readonly name = 'agnes-image';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private constructor(apiKey: string, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  static fromEnv(env: NodeJS.ProcessEnv = process.env): ImageProvider {
    const key = env.AGNES_API_KEY;
    if (key && env.AGNES_BASE_URL) {
      return new AgnesImageProvider(key, env.AGNES_BASE_URL, env.AGNES_IMAGE_MODEL ?? '');
    }
    throw new AppError('4001', '未配置 AGNES_BASE_URL / AGNES_API_KEY，无法创建真实生图 provider');
  }

  isReal(): boolean {
    return true;
  }

  async gen(req: ImageGenReq): Promise<ImageGenResult> {
    const base = this.baseUrl.replace(/\/$/, '');
    const res = await safeFetch(`${base}/images/generations`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model || undefined,
        prompt: req.style ? `${req.prompt}，${req.style}风格` : req.prompt,
        size: req.size ?? '768x1024', // 竖版立绘默认
      }),
      timeoutMs: 60_000,
    });
    if (!res.ok) {
      throw new AppError(res.status === 429 ? '4003' : '4005', `生图失败 ${res.status}`);
    }
    const data = (await res.json()) as { data?: { url?: string; b64_json?: string }[] };
    const item = data.data?.[0];
    if (!item) throw new AppError('4005', '生图返回为空');
    if (item.url) return { kind: 'url', data: item.url };
    if (item.b64_json) return { kind: 'b64', data: item.b64_json, mime: 'image/png' };
    throw new AppError('4005', '生图返回缺少 url / b64_json');
  }
}

/** OpenAI 兼容聊天（cpk-agnes / DeepSeek 等统一走此实现，baseUrl/model 从 .env 注入） */
export class OpenAICompatibleChat implements ChatProvider {
  readonly name = 'openai-compatible';
  private readonly apiKey: string;
  private readonly baseUrl: string;
  private readonly model: string;
  private constructor(apiKey: string, baseUrl: string, model: string) {
    this.apiKey = apiKey;
    this.baseUrl = baseUrl;
    this.model = model;
  }

  static from(cfg: { apiKey: string; baseUrl: string; model?: string }): ChatProvider {
    return new OpenAICompatibleChat(
      cfg.apiKey,
      cfg.baseUrl,
      cfg.model ?? 'gpt-4o-mini',
    );
  }

  static fromEnv(
    env: NodeJS.ProcessEnv = process.env,
  ): ChatProvider {
    const key = env.OPENAI_API_KEY;
    if (key) {
      return OpenAICompatibleChat.from({
        apiKey: key,
        baseUrl: env.OPENAI_BASE_URL ?? 'https://api.openai.com/v1',
        model: env.OPENAI_MODEL,
      });
    }
    throw new AppError('4001', '未配置 OPENAI_API_KEY，无法创建真实 provider');
  }

  isReal(): boolean {
    return true;
  }

  async generate(messages: ChatMessage[], opts: CompletionOpts = {}): Promise<string> {
    const res = await safeFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 900,
        response_format: opts.jsonMode ? { type: 'json_object' } : undefined,
      }),
      timeoutMs: 30_000,
    });
    if (!res.ok) {
      if (res.status === 429) throw new AppError('4003', `LLM 限流 ${res.status}`);
      if (res.status >= 500) throw new AppError('4003', `LLM 服务端错误 ${res.status}`);
      throw new AppError('4004', `LLM 拒绝请求 ${res.status}`);
    }
    const data = (await res.json()) as {
      choices?: { message?: { content?: string } }[];
    };
    return data.choices?.[0]?.message?.content ?? '';
  }

  async *stream(messages: ChatMessage[], opts: CompletionOpts = {}) {
    const res = await safeFetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({
        model: this.model,
        messages,
        stream: true,
        temperature: opts.temperature ?? 0.8,
        max_tokens: opts.maxTokens ?? 900,
      }),
      timeoutMs: 60_000,
    });
    if (!res.ok || !res.body) {
      throw new AppError('4004', `LLM 流式请求失败 ${res.status}`);
    }
    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buf = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buf += decoder.decode(value, { stream: true });
        const lines = buf.split('\n');
        buf = lines.pop() ?? '';
        for (const line of lines) {
          const t = line.trim();
          if (!t.startsWith('data:')) continue;
          const payload = t.slice(5).trim();
          if (payload === '[DONE]') continue;
          try {
            const j = JSON.parse(payload) as { choices?: { delta?: { content?: string } }[] };
            const delta = j.choices?.[0]?.delta?.content ?? '';
            if (delta) yield { delta, finished: false };
          } catch {
            /* 半包忽略，下轮继续 */
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
  }
}