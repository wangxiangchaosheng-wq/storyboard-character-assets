/**
 * Mock / 装配单测：离线可跑、可复现、无任何网络调用。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { MockChatProvider, MockEmbedProvider, MockImageProvider } from './mock.ts';
import { createProviders } from './registry.ts';

test('MockChatProvider：默认返回确定性模版，jsonMode 输出合法 JSON', async () => {
  const m = new MockChatProvider();
  const a = await m.generate([{ role: 'user', content: '论北伐' }]);
  const b = await m.generate([{ role: 'user', content: '论北伐' }]);
  assert.equal(a, b); // 同输入同输出
  const j = await m.generate([{ role: 'user', content: '输出 JSON' }], { jsonMode: true });
  assert.doesNotThrow(() => JSON.parse(j));
});

test('MockChatProvider：剧本 override 优先', async () => {
  const m = new MockChatProvider({ '问母舅': '回：不可' });
  assert.equal(await m.generate([{ role: 'user', content: '问母舅' }]), '回：不可');
});

test('MockChatProvider：模拟流式打点', async () => {
  const m = new MockChatProvider();
  const parts: string[] = [];
  for await (const c of m.stream([{ role: 'user', content: 'x' }])) parts.push(c.delta);
  assert.ok(parts.length >= 2);
  assert.equal(parts.join(''), '（模拟流式）');
});

test('MockEmbedProvider：同文本同向量、单位模长', async () => {
  const m = new MockEmbedProvider();
  const [u, u2, v] = await m.embed(['汉中', '汉中', '长安']);
  assert.deepEqual(u, u2);
  assert.notDeepEqual(u, v);
  for (const vec of [u ?? [], v ?? []]) {
    const norm = Math.sqrt(vec.reduce((s, x) => s + x * x, 0));
    assert.ok(Math.abs(norm - 1) < 1e-9, '应为单位向量');
  }
});

test('MockImageProvider：data URI 占位图，同 prompt 可复现', async () => {
  const m = new MockImageProvider();
  const r1 = await m.gen({ prompt: '诸葛亮立绘' });
  const r2 = await m.gen({ prompt: '诸葛亮立绘' });
  assert.equal(r1.kind, 'b64');
  assert.equal(r1.data, r2.data);
});

test('createProviders：无 key 全 mock（离线默认）', () => {
  const p = createProviders({} as NodeJS.ProcessEnv);
  assert.equal(p.chat.isReal(), false);
  assert.equal(p.image.isReal(), false);
  assert.equal(p.real, false);
});

test('createProviders：OPENAI key → 真实 chat；缺 AGNES → 图片仍 mock', () => {
  const p = createProviders({
    OPENAI_API_KEY: 'sk-test',
    OPENAI_BASE_URL: 'https://example.com/v1',
  } as NodeJS.ProcessEnv);
  assert.equal(p.chat.isReal(), true);
  assert.equal(p.image.isReal(), false);
  assert.equal(p.real, true);
});

test('createProviders：AGNES 仅画像时 chat 回退 mock、图片真实', () => {
  const p = createProviders({
    AGNES_API_KEY: 'k',
    AGNES_BASE_URL: 'https://img.example.com',
    AGNES_IMAGE_MODEL: 'm1',
  } as NodeJS.ProcessEnv);
  assert.equal(p.chat.isReal(), false);
  assert.equal(p.image.isReal(), true);
  assert.equal(p.real, true);
});