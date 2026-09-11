/** @sim/llm —— LLM/生图/出站网关（docs/06 §2、docs/11 §2）。 */
export { safeFetch, assertSafeTarget, isForbidden } from './safeFetch.ts';
export type { SafeFetchOptions, SafeTarget } from './safeFetch.ts';

export {
  OpenAICompatibleChat,
  AgnesImageProvider,
} from './providers.ts';
export type {
  ChatMessage,
  CompletionOpts,
  StreamChunk,
  ChatProvider,
  EmbedProvider,
  ImageGenReq,
  ImageGenResult,
  ImageProvider,
} from './providers.ts';

export { MockChatProvider, MockEmbedProvider, MockImageProvider } from './mock.ts';
export { EmptySearchProvider, MockSearchProvider, WebSearchProvider } from './webSearch.ts';
export type { SearchProvider } from './webSearch.ts';

export { createProviders } from './registry.ts';
export type { ProviderSet } from './registry.ts';

import { AppError } from '@sim/contracts';
export { AppError };
// （re-export 仅为文档签名一致；业务错误统一走 @sim/contracts）