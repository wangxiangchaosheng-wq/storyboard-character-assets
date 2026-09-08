/**
 * 服务端装配（docs/05）：Fastify + CORS + SQLite store + SSE hub + 路由。
 * buildServer 不监听端口 —— 可被测试 inject 复用；监听交给 index.ts。
 */
import Fastify from 'fastify';
import cors from '@fastify/cors';
import { createProviders } from '@sim/llm';
import { ERROR_CODES } from '@sim/contracts';
import { createFactStore } from '@sim/facts';
import type { FactService } from '@sim/facts';
import type { Store } from './store.ts';
import { openStore } from './store.ts';
import { SseHub } from './sse.ts';
import { registerTopicRoutes } from './routes/topics.ts';
import { registerGameRoutes } from './routes/games.ts';
import { registerWebRoutes } from './web.ts';

export interface AppBuildOptions {
  providers?: ReturnType<typeof createProviders>;
  /** SQLite 文件路径；缺省 = 内存库（测试用） */
  dbPath?: string;
  /** 考据司检索库（预置史实快照）——不传也可以，但话题会失去史实差异化 */
  facts?: FactService;
}

export function buildServer(opts: AppBuildOptions = {}) {
  const app = Fastify({ logger: { level: process.env.LOG_LEVEL ?? 'info' } });
  const providers = opts.providers ?? createProviders();
  const store: Store = openStore(opts.dbPath);
  const hub = new SseHub(store);
  const factStore: Promise<FactService> = Promise.resolve(opts.facts ?? createFactStore());

  void app.register(cors, { origin: true });

  app.addHook('onClose', async () => {
    hub.dispose();
    store.close();
    const svc = await factStore;
    if (typeof svc.close === 'function') svc.close();
  });

  app.get('/healthz', async () => ({ ok: true, provider: providers.real ? 'real' : 'mock' }));

  registerTopicRoutes(app, { providers, hub, store, facts: factStore });
  registerGameRoutes(app, { providers, hub, store });
  registerWebRoutes(app);

  // 统一错误形状：AppError → { error: { code, message } }（5000 兜底）
  const statusByCode: Record<string, number> = {
    [ERROR_CODES.BAD_INPUT]: 400,
    [ERROR_CODES.INVALID_URL_PROTOCOL]: 400,
    [ERROR_CODES.UNSAFE_URL_HOST]: 400,
    [ERROR_CODES.BAD_SCENARIO_SPEC]: 400,
    [ERROR_CODES.TASK_NOT_FOUND]: 404,
    [ERROR_CODES.TASK_RUNNING]: 409,
    [ERROR_CODES.INVALID_ACTION]: 409,
  };
  app.setErrorHandler((err, _req, reply) => {
    const code = 'code' in err && typeof err.code === 'string' ? err.code : '5000';
    const status = err.statusCode ?? statusByCode[code] ?? 500;
    reply.code(status).send({ error: { code, message: err.message } });
  });

  return { app, providers, hub, store };
}