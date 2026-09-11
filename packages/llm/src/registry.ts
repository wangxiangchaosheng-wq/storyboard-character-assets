/**
 * Provider 装配（docs/06 §3）—— 唯一读环境变量的入口。
 * 未配 key 一律回退 mock（离线可跑）。
 */
import type { ChatProvider, EmbedProvider, ImageProvider } from './providers.ts';
import { OpenAICompatibleChat, AgnesImageProvider } from './providers.ts';
import { MockChatProvider, MockEmbedProvider, MockImageProvider } from './mock.ts';

export interface ProviderSet {
  chat: ChatProvider;
  embed: EmbedProvider;
  image: ImageProvider;
  real: boolean; // 任意一路为真实模型则 true（服务端用于标记演示模式）
}

export function createProviders(env: NodeJS.ProcessEnv = process.env): ProviderSet {
  let chat: ChatProvider;
  if (env.OPENAI_API_KEY) {
    chat = OpenAICompatibleChat.fromEnv(env);
  } else if (env.AGNES_API_KEY && env.AGNES_BASE_URL && env.AGNES_CHAT_MODEL) {
    // AGNES 通道：同 OpenAI 兼容协议，基址/模型取 AGNES_*
    chat = OpenAICompatibleChat.from({
      apiKey: env.AGNES_API_KEY,
      baseUrl: env.AGNES_BASE_URL,
      model: env.AGNES_CHAT_MODEL,
    });
  } else {
    chat = new MockChatProvider();
  }

  let real = chat.isReal();
  let image: ImageProvider;
  try {
    if (env.AGNES_API_KEY && env.AGNES_BASE_URL) {
      image = AgnesImageProvider.fromEnv(env);
      real = true;
    } else {
      image = new MockImageProvider();
    }
  } catch {
    image = new MockImageProvider();
  }

  return { chat, image, embed: new MockEmbedProvider(), real };
}