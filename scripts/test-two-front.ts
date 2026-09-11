/**
 * 两线作战可行性警示端到端测试
 * 流程：
 *   1. POST /api/topics/ingest
 *   2. POST /api/topics/{id}/build
 *   3. GET /api/topics/{id}/status（轮询 ready/failed）
 *   4. GET /api/topics/{id}/spec
 *   5. POST /api/games（使用 topicId 作 specId）
 *   6. POST /api/games/{gameId}/message（下诏，act=true）
 *   7. 检查是否包含 name:'史官' 且含 '可行性' 的消息
 * 运行方式：node --experimental-strip-types scripts/test-two-front.ts
 */
import { createServer } from 'node:net';
import { readFileSync, existsSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { buildServer } from '../packages/serve/src/server.ts';
import { createProviders } from '../packages/llm/src/index.ts';

const ROOT = resolve(import.meta.dirname, '..');

// 加载 .env（AGNES_API_KEY 等凭证），确保 LLM 为真实模式
{
  const dotEnvPath = resolve(process.cwd(), '.env');
  if (existsSync(dotEnvPath)) {
    for (const line of readFileSync(dotEnvPath, 'utf8').split(String.fromCharCode(10))) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eq = trimmed.indexOf('=');
      if (eq > 0) {
        const key = trimmed.slice(0, eq).trim();
        const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, '');
        if (!(key in process.env)) process.env[key] = val;
      }
    }
  }
}

const HOST = '127.0.0.1';
const TOPIC = '架空：蜀国同时攻打魏国和吴国，诸葛亮会怎么选择？';
const DECREE = '朕意已决：命魏延出子午谷直取长安，诸葛亮亲率大军北伐，同时派马岱袭取东吴荆州，两路并进，务必一举拿下！';

let failures = 0;
const fail = (msg) => { failures += 1; console.error('  ✗ ' + msg); };
const step = (msg) => console.log('  ✓ ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function main() {
  console.log('═'.repeat(60));
  console.log('两线作战可行性警示 · 端到端测试');
  console.log('═'.repeat(60));

  // 加载环境变量并创建真实 LLM providers
  const providers = createProviders();
  console.log('LLM provider:', providers.real ? 'real (AGNES)' : 'mock');

  const { app, store } = buildServer({ providers });

  // ① ingest
  const ing = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: TOPIC },
  });
  console.log('');
  console.log('── ① POST /api/topics/ingest ──');
  console.log('  入参：kind=text, text="' + TOPIC + '"');
  console.log('  状态：' + ing.statusCode);
  console.log('  响应：' + JSON.stringify(ing.json()).slice(0, 300));
  if (ing.statusCode !== 202 || !ing.json().topicId) {
    fail('ingest 失败（' + ing.statusCode + '）');
    return;
  }
  const topicId = ing.json().topicId;
  step('ingest → topicId=' + topicId);

  // ② build
  const bld = await app.inject({
    method: 'POST',
    url: '/api/topics/' + encodeURIComponent(topicId) + '/build',
  });
  console.log('');
  console.log('── ② POST /api/topics/{id}/build ──');
  console.log('  状态：' + bld.statusCode);
  console.log('  响应：' + JSON.stringify(bld.json()).slice(0, 200));
  if (bld.statusCode !== 202 && bld.statusCode !== 409) {
    fail('build 非 202/409（' + bld.statusCode + '）');
    return;
  }
  step('build 接受（' + (bld.statusCode === 202 ? '202' : '409') + '）');

  // ③ 轮询 status
  let statusState = 'idle';
  console.log('');
  console.log('── ③ GET /api/topics/{id}/status（轮询）──');
  for (let i = 0; i < 120; i++) {
    const s = await app.inject({
      method: 'GET',
      url: '/api/topics/' + encodeURIComponent(topicId) + '/status',
    });
    statusState = s.json().state;
    if (i % 10 === 9) console.log('  [' + (i+1) + '] state=' + statusState);
    if (statusState === 'ready' || statusState === 'failed') break;
    await sleep(500);
  }
  if (statusState !== 'ready') {
    fail('话题构建未完成（state=' + statusState + '）');
    return;
  }
  step('话题构建完成（state=ready）');

  // ④ spec
  const sp = await app.inject({
    method: 'GET',
    url: '/api/topics/' + encodeURIComponent(topicId) + '/spec',
  });
  console.log('');
  console.log('── ④ GET /api/topics/{id}/spec ──');
  console.log('  状态：' + sp.statusCode);
  const specBody = sp.json();
  console.log('  响应摘要：' + JSON.stringify(specBody).slice(0, 500));
  if (sp.statusCode !== 200) {
    fail('spec 拉取失败（' + sp.statusCode + '）');
    return;
  }
  const spec = specBody.spec;
  const metrics = spec.metrics || [];
  const cast = spec.cast || [];
  step('spec 出库（metrics=' + metrics.length + ' cast=' + cast.length + '）');

  // ⑤ 建局
  const g = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: topicId, player: '测试玩家' },
  });
  console.log('');
  console.log('── ⑤ POST /api/games ──');
  console.log('  入参：specId="' + topicId + '", player="测试玩家"');
  console.log('  状态：' + g.statusCode);
  const gameBody = g.json();
  console.log('  响应摘要：' + JSON.stringify(gameBody).slice(0, 400));
  if (g.statusCode !== 201) {
    fail('建局失败（' + g.statusCode + '）');
    return;
  }
  const gameId = gameBody.gameId;
  step('建局成功 → gameId=' + gameId);

  // ⑥ 下诏（两线作战指令）
  const msg = await app.inject({
    method: 'POST',
    url: '/api/games/' + encodeURIComponent(gameId) + '/message',
    payload: { text: DECREE, act: true },
  });
  console.log('');
  console.log('── ⑥ POST /api/games/{id}/message（下诏·两线作战）──');
  console.log('  入参：text="' + DECREE.slice(0, 40) + '…", act=true');
  console.log('  状态：' + msg.statusCode);
  const resp = msg.json();
  console.log('  turn=' + (resp.turn || '?') + '  status=' + (resp.status || '?'));
  const messages = resp.messages || [];
  console.log('  新增消息数：' + messages.length);
  for (const m of messages) {
    const preview = m.text.replace(/\n/g, ' ').slice(0, 80);
    console.log('    [' + m.kind + '] name=' + (m.name || '-') + '  ' + preview + (m.text.length > 80 ? '...' : ''));
  }
  if (msg.statusCode !== 200) {
    fail('下诏失败（' + msg.statusCode + '）');
    return;
  }
  step('下诏成功（turn=' + resp.turn + '）');

  // ⑦ 检查可行性警示
  console.log('');
  console.log('── ⑦ 检查可行性警示 ──');
  const stakeMsg = messages.find(
    (m) => m.name === '史官' && m.text && m.text.includes('可行性'),
  );
  if (stakeMsg) {
    console.log('  ✔ 找到史官可行性警示：');
    console.log('    ' + stakeMsg.text);
    step('可行性警示验证通过');
  } else {
    console.log('  ⚠ 未找到「史官」+「可行性」字样的消息');
    fail('可行性警示未出现');
  }

  await app.close();

  console.log('');
  console.log('═'.repeat(60));
  if (failures === 0) {
    console.log('测试全链通过（话题 → spec → 建局 → 下诏 → 警示检查）');
  } else {
    console.error('测试未通过（' + failures + ' 项失败）');
  }
  process.exit(failures > 0 ? 1 : 0);
}

await main();
