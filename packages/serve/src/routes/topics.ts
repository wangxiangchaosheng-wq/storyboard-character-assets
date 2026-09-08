/**
 * 话题路由（docs/05 §3「topics」）：
 * ingest 登记 topics 行（幂等）→ build 跑管线（异步，阶段状态写 DB + SSE 推送）
 * → status / spec 从库里读（断线后仍可查）。
 * 真实管线：mock provider 时全链路离线可跑（URL 分支仍受 safeFetch 门禁）。
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { runPipeline } from '@sim/topic-pipeline';
import { ERROR_CODES } from '@sim/contracts';
import type { ProviderSet } from '@sim/llm';
import type { FactService } from '@sim/facts';
import type { Store } from '../store.ts';
import { saveTopic, getTopic } from '../store.ts';
import type { SseHub } from '../sse.ts';
import { toPublicSpec } from '../publicSpec.ts';

const ingestSchema = z.union([
  z.object({ kind: z.literal('text'), text: z.string().min(1).max(50_000) }),
  z.object({ kind: z.literal('url'), url: z.string().url() }),
]);

export function registerTopicRoutes(
  app: FastifyInstance,
  deps: { providers: ProviderSet; hub: SseHub; store: Store; facts: Promise<FactService> },
): void {
  const { providers, hub, store, facts } = deps;
  const runTask = new Set<string>();

  app.post('/api/topics/ingest', async (req, reply) => {
    const parsed = ingestSchema.safeParse(req.body);
    if (!parsed.success) {
      return reply.code(400).send({
        error: { code: ERROR_CODES.BAD_INPUT, message: parsed.error.issues[0].message },
      });
    }
    const input = parsed.data;
    // 轻量指纹做 topicId：URL 用原文，文本用内容前 16 字（同输入可复用/幂等）
    const topicId = input.kind === 'url' ? input.url : 'txt:' + input.text.slice(0, 16);
    saveTopic(store, topicId, { status: 'idle', input: JSON.parse(JSON.stringify(input)) });
    return reply.code(202).send({ topicId, state: 'idle' });
  });

  app.post('/api/topics/:id/build', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    if (runTask.has(id)) {
      return reply
        .code(409)
        .send({ error: { code: ERROR_CODES.TASK_RUNNING, message: '任务已运行' } });
    }
    runTask.add(id);
    saveTopic(store, id, { status: 'running' });
    reply.code(202).send({ accepted: true });

    // 后台执行：阶段状态写库（status 各节点经 saveTopic），进度事件经 SSE 推送
    const input = id.startsWith('http')
      ? ({ kind: 'url', url: id } as const)
      : ({ kind: 'text', text: id.slice(4) } as const);
    void (async () => {
      const factService = await facts; // 考据司检索库（PRESET 预置史实快照）
      await runPipeline(input, {
        providers,
        onStatus: (s) => {
          saveTopic(store, id, { status: s.state === 'ready' ? 'ready' : 'running' });
          hub.publish(id, 'topics.build.progress', s);
        },
        facts: {
          // 关键词直查 + 缺口补缺；估算只在真实 LLM 下才有意义（mock 自动返回 undefined）
          search: { find: (q: string) => factService.search(q, { limit: 3 }) },
          estimate: (gap) => factService.estimate(providers.chat, gap),
        },
      })
        .then((res) => {
        if (res.status.state === 'ready') {
          saveTopic(store, id, {
            status: 'ready',
            brief: res.brief,
            fill: res.fill,
            spec: { id, ...res.spec },
          });
          hub.publish(id, 'topics.spec.ready', {
            topicId: id,
            specId: res.status.specId,
            estimatedRate: res.status.estimatedRate,
          });
        } else {
          saveTopic(store, id, { status: 'failed' });
          hub.publish(id, 'topics.spec.failed', res.status);
        }
      })
      .finally(() => runTask.delete(id));
    })();
  });

  app.get('/api/topics/:id/status', async (req) => {
    const id = (req.params as { id: string }).id;
    const row = getTopic(store, id);
    return { topicId: id, state: row?.status ?? 'idle' };
  });

  app.get('/api/topics/:id/spec', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const row = getTopic(store, id);
    if (!row || !row.spec) {
      return reply
        .code(404)
        .send({ error: { code: ERROR_CODES.TASK_NOT_FOUND, message: 'spec 尚未生成' } });
    }
    // spec 走对外脱敏视图：公式原文不出库（formulaAudit 结论仍在）
    return reply.send({ topicId: id, spec: toPublicSpec(JSON.parse(row.spec)) });
  });

  app.post('/api/topics/:id/abort', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    runTask.delete(id);
    saveTopic(store, id, { status: 'idle' });
    reply.code(204).send();
  });

  // SSE 事件流（与 build 推送同一频道；支持 Last-Event-ID 续拉）
  app.get('/api/topics/:id/events', async (req, reply) => {
    const id = (req.params as { id: string }).id;
    const afterSeq = parseLastEventId(req);
    const unsubscribe = hub.subscribe(id, reply, { afterSeq });
    req.raw.on('close', unsubscribe);
  });
}

function parseLastEventId(req: { headers: Record<string, string | string[] | undefined> }): number | undefined {
  const raw = req.headers['last-event-id'];
  const n = Array.isArray(raw) ? raw[0] : raw;
  if (!n) return undefined;
  const seq = Number(n);
  return Number.isFinite(seq) ? seq : undefined;
}