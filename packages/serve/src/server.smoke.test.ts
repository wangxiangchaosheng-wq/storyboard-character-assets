/**
 * serve 冒烟（docs/05）：buildServer 不起服务，全程 inject 打 HTTP。
 * 健康检查 / 话题 ingest-build-409-abort（hangChat 卡住管线）/ 游戏错误语义 / SSE 实时与断线续拉。
 * SSE 是长连接，用真实 listen + fetch 验证（inject 永不收尾）。
 */
process.env.LOG_LEVEL = 'silent';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { AddressInfo } from 'node:net';
import type { ChatProvider } from '@sim/llm';
import { createProviders } from '@sim/llm';
import { buildServer } from './server.ts';

const hangChat: ChatProvider = {
  name: 'hang',
  isReal: () => false,
  generate: () => new Promise<string>(() => {}),
  async *stream() {},
};

function hangApp() {
  return buildServer({ providers: { ...createProviders(), chat: hangChat } });
}

test('healthz：无 key → mock provider', async () => {
  const { app } = buildServer();
  const res = await app.inject({ method: 'GET', url: '/healthz' });
  assert.equal(res.statusCode, 200);
  assert.equal(res.json().ok, true);
  assert.equal(res.json().provider, 'mock');
  await app.close();
});

test('话题：ingest → build 202 → 重复 build 409 → abort 后 idle', async () => {
  const { app } = hangApp();
  const ingest = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: '诸葛亮五次北伐' },
  });
  assert.equal(ingest.statusCode, 202);
  const id = ingest.json().topicId;
  assert.equal(id, 'txt:诸葛亮五次北伐');

  const b1 = await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(id)}/build` });
  assert.equal(b1.statusCode, 202);
  assert.equal(b1.json().accepted, true);

  // 同一任务再触发 → 409 TASK_RUNNING（前端同名请求只能有一个管线）
  const b2 = await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(id)}/build` });
  assert.equal(b2.statusCode, 409);
  assert.equal(b2.json().error.code, '3002');

  const st = await app.inject({ method: 'GET', url: `/api/topics/${encodeURIComponent(id)}/status` });
  assert.equal(st.json().state, 'running');

  const ab = await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(id)}/abort` });
  assert.equal(ab.statusCode, 204);
  const st2 = await app.inject({ method: 'GET', url: `/api/topics/${encodeURIComponent(id)}/status` });
  assert.equal(st2.json().state, 'idle');
  await app.close();
});

test('输入校验：非法 body → 400 BAD_INPUT', async () => {
  const { app } = buildServer();
  const res = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: '' },
  });
  assert.equal(res.statusCode, 400);
  assert.equal(res.json().error.code, '1001');
  await app.close();
});

test('游戏：缺字段 400 → 无 spec 建局 404 (TASK_NOT_FOUND)', async () => {
  const { app } = buildServer();
  const bad = await app.inject({ method: 'POST', url: '/api/games', payload: {} });
  assert.equal(bad.statusCode, 400);
  assert.equal(bad.json().error.code, '1001');

  // spec 未构建时建局 → 404（不再允许对未知 spec 建局）
  const g = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: 's1', player: 'p1' },
  });
  assert.equal(g.statusCode, 404);
  assert.equal(g.json().error.code, '3001');
  await app.close();
});

test('SSE：订阅 → 推送 → 同帧收到；断线 Last-Event-ID → 回放历史（真实连接）', async () => {
  const { app, hub } = buildServer();
  await app.listen({ port: 0, host: '127.0.0.1' });
  const port = (app.server.address() as AddressInfo).port;
  const base = `http://127.0.0.1:${port}`;
  const channel = 'game:g00000000';

  // 先落两条历史（正式的发布路径：落库 + 广播）
  const seq1 = hub.publish(channel, 'games.state.update', { step: 1 });
  hub.publish(channel, 'games.ai.round.complete', { round: 1 });

  // 订阅1：实时推送
  const ev = await fetch(`${base}/api/games/g00000000/events`);
  assert.equal(ev.status, 200);
  assert.match(ev.headers.get('content-type') ?? '', /text\/event-stream/);
  const reader = ev.body!.getReader();

  hub.publish(channel, 'games.state.update', { step: 2 });
  const d = new TextDecoder();
  let text = '';
  for (let i = 0; i < 5 && !text.includes('"step":2'); i++) {
    const { value, done } = await reader.read();
    if (done) break;
    text += d.decode(value);
  }
  assert.ok(text.includes('event: games.state.update'), JSON.stringify(text));
  assert.ok(text.includes('"step":2'), JSON.stringify(text));
  await reader.cancel();

  // 订阅2：带 Last-Event-ID → 回放 seq1 之后的全部（含 step2 的历史落库）
  const replay = await fetch(`${base}/api/games/g00000000/events`, {
    headers: { 'last-event-id': String(seq1) },
  });
  assert.equal(replay.status, 200);
  const r2 = replay.body!.getReader();
  let rtext = '';
  for (let i = 0; i < 6; i++) {
    const { value, done } = await r2.read();
    if (done) break;
    rtext += d.decode(value);
    if (rtext.includes('"step":2')) break; // 目标事件回放回来就算成功
  }
  await r2.cancel();
  assert.ok(rtext.includes('event: games.state.update'), JSON.stringify(rtext));
  assert.ok(rtext.includes('"round":1'), JSON.stringify(rtext));
  await app.close();
});

test('话题 spec 出库：未构建 → 404（真实语义替代 501 占位）', async () => {
  const { app } = buildServer();
  const res = await app.inject({ method: 'GET', url: '/api/topics/x/spec' });
  assert.equal(res.statusCode, 404);
  assert.equal(res.json().error.code, '3001');
  await app.close();
});

test('静态界面：/ 给单页入口，/app/* 白名单文件 200，非法路径 404', async () => {
  const { app } = buildServer();
  const root = await app.inject({ method: 'GET', url: '/' });
  assert.equal(root.statusCode, 200);
  assert.match(root.headers['content-type'] ?? '', /text\/html/);
  assert.ok(root.body.includes('历史推演台'), root.body.slice(0, 80));
  // 页面引用的两个资源都在白名单内
  const js = await app.inject({ method: 'GET', url: '/app/app.js' });
  assert.equal(js.statusCode, 200);
  assert.match(js.headers['content-type'] ?? '', /javascript/);
  const css = await app.inject({ method: 'GET', url: '/app/app.css' });
  assert.equal(css.statusCode, 200);
  assert.match(css.headers['content-type'] ?? '', /text\/css/);
  // 白名单外一律 404（含伪装穿越）
  const evil = await app.inject({ method: 'GET', url: '/app/../src/server.ts' });
  assert.equal(evil.statusCode, 404);
  const other = await app.inject({ method: 'GET', url: '/app/server.ts' });
  assert.equal(other.statusCode, 404);
  await app.close();
});