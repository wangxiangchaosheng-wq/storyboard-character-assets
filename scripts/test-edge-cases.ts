/**
 * 边界情况与异常输入测试（历史架空游戏）
 *
 * 覆盖：
 *   1. 空话题
 *   2. 超长话题 (>1000字)
 *   3. 特殊字符（HTML / emoji / 非法 Unicode）
 *   4. 重复建局（同一 topicId 两次 build）
 *   5. 已终局后继续问策/下诏
 *   6. 不存在的 gameId
 *   7. 非法指标（metric key 为数字/含特殊字符）
 *   8. 缺失字段（LLM 返回缺 rules / metrics 的 spec）
 *   9. 格式错误的 formula（含中文变量如 round(岁入*0.01)）
 *  10. 并发请求（同一 topicId 同时 build）
 *  11. URL 注入绕过 safeFetch
 *  12. 消息体缺少 text 字段
 *
 * 输出要求：每项标记 ✅/❌/⚠️/🛡️，描述实际错误行为，不 panic/crash 即合格。
 */
process.env.LOG_LEVEL = 'silent';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { Store } from '../packages/serve/src/store.ts';
import { buildServer } from '../packages/serve/src/server.ts';

type Mark = '✅' | '❌' | '⚠️' | '🛡️';

function section(title: string) {
  console.log(`\n=== ${title} ===`);
}
function mark(status: Mark, desc: string) {
  console.log(`  ${status} ${desc}`);
}
function ok(desc: string) { mark('✅', desc); }
function warn(desc: string) { mark('⚠️', desc); }
function fail(desc: string) { mark('❌', desc); }
function guard(desc: string) { mark('🛡️', desc); }

const PIPELINE_TIMEOUT_MS = 45_000; // mock 模式下管线完成约 35s，留余量

/** 把一份 ScenarioSpec 直接写入 topics 表，绕过管线（用于注入异常 spec） */
function injectSpec(store: Store, topicId: string, spec: unknown): void {
  const now = Date.now();
  store.prepare(
    'INSERT OR REPLACE INTO topics (id, status, input, brief, fill, spec, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  ).run(topicId, 'ready', JSON.stringify({ kind: 'text', text: 'injected' }), null, null, JSON.stringify(spec), now, now);
}

/** 轮询管线直到 ready/failed，或超时 */
async function waitForPipeline(
  app: ReturnType<typeof buildServer>['app'],
  topicId: string,
  timeoutMs = PIPELINE_TIMEOUT_MS,
): Promise<{ state: string; elapsed: number }> {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const s = await app.inject({ method: 'GET', url: `/api/topics/${encodeURIComponent(topicId)}/status` });
    const j = s.json() as { state: string };
    if (j.state === 'ready' || j.state === 'failed') return { state: j.state, elapsed: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, 500));
  }
  return { state: 'timeout', elapsed: Date.now() - t0 };
}

// ============================================================================
// 1. 空话题
// ============================================================================
test('边界：空话题', async () => {
  section('1. 空话题');
  const { app } = buildServer();
  try {
    const res = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'text', text: '' },
    });
    if (res.statusCode === 400 && res.json().error?.code === '1001') {
      guard('空话题被 Zod min(1) 拦截，返回 400 BAD_INPUT');
    } else {
      fail(`未拦截空话题，状态=${res.statusCode} body=${JSON.stringify(res.json()).slice(0, 120)}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 2. 超长话题（>1000字，上限 50000）
// ============================================================================
test('边界：超长话题 (>1000字)', async () => {
  section('2. 超长话题');
  const { app } = buildServer();
  try {
    const short = 'x'.repeat(1001);
    const r1 = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'text', text: short },
    });
    if (r1.statusCode === 202) ok('1001字话题 ingest 通过 (202)');
    else fail(`1001字话题 ingest 异常: status=${r1.statusCode}`);

    const long = 'x'.repeat(50_001);
    const r2 = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'text', text: long },
    });
    if (r2.statusCode === 400 && r2.json().error?.code === '1001') {
      guard('50001字话题被 Zod max(50_000) 拦截，返回 400');
    } else {
      fail(`50001字话题未被拦截: status=${r2.statusCode}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 3. 特殊字符（HTML / emoji / 混合 Unicode）
// ============================================================================
test('边界：特殊字符', async () => {
  section('3. 特殊字符');
  const { app } = buildServer();
  try {
    const html = '<script>alert(1)</script> 刘备<span>借荆州</span>';
    const emoji = '诸葛亮🤔🎯：北伐🏔️·粮草⚠️·民心❤️‍🔥';
    const weirdUnicode = '\uE000\uF8FF \uD800\uDC00 𝄞 𝅘𝅥𝅮';
    const all = html + ' | ' + emoji + ' | ' + weirdUnicode;

    const res = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'text', text: all },
    });
    if (res.statusCode === 202) {
      ok('含 HTML/emoji/特殊 Unicode 的话题 ingest 通过 (202)，未 crash');
    } else {
      fail(`特殊字符话题 ingest 异常: status=${res.statusCode}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 4. 重复建局（同一 topicId 连续 build）
// ============================================================================
test('边界：重复建局', async () => {
  section('4. 重复建局');
  const { app } = buildServer();
  try {
    const ing = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'text', text: '重复建局测试' },
    });
    const topicId = ing.json().topicId;

    const b1 = await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
    if (b1.statusCode !== 202) fail(`首次 build 异常: status=${b1.statusCode}`);
    else guard('首次 build 返回 202 accepted');

    // 立即再发一次
    const b2 = await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
    if (b2.statusCode === 409 && b2.json().error?.code === '3002') {
      guard('第二次 build 被 runTask Set 锁住，返回 409 TASK_RUNNING');
    } else {
      fail(`第二次 build 未按预期返回 409: status=${b2.statusCode}`);
    }
    // 等待后台管线结束，防止 app.close() 后仍有写入
    await waitForPipeline(app, topicId);
  } finally { await app.close(); }
});

// ============================================================================
// 5. 已终局操作（终局后继续问策/下诏/reform/end）
// 注意：mock 模式下管线约需 ~35s，故使用 injectSpec 绕过管线
// ============================================================================
test('边界：已终局操作', async () => {
  section('5. 已终局操作');
  const { app, store } = buildServer();
  try {
    // 直接注入一个可用的 spec，跳过管线等待
    const goodSpec = {
      domain: 'history' as const,
      title: '终局测试',
      scenario: {
        title: '终局测试',
        background: '测试终局后操作语义'.repeat(5),
        conflict: '终局操作',
        participants: ['p1', 'p2'],
        rounds: 3,
        decisionPoint: '如何处置',
        successCriteria: '终局',
      },
      cast: [
        { id: 'p1', name: '张三', role: '户部', stance: '进取', influence: 70, description: '进取派',
          prompt: '你是张三。', traits: { competence: 60, loyalty: 70, ambition: 50, power: 60 } },
        { id: 'p2', name: '李四', role: '兵部', stance: '稳守', influence: 65, description: '稳守派',
          prompt: '你是李四。', traits: { competence: 55, loyalty: 80, ambition: 30, power: 70 } },
      ],
      metrics: [
        { key: 'gold', label: '国库', min: 0, max: 100, start: 50, higherIsBetter: true },
        { key: '民心', label: '民心', min: 0, max: 100, start: 50, higherIsBetter: true },
      ],
      rules: [{ id: 'r1', kind: 'drift', label: '银两', description: '稳定', target: 'gold', appliesTo: ['gold'], formula: '1' }],
    };
    injectSpec(store, 'spec:endtest', goodSpec);

    const g = await app.inject({
      method: 'POST', url: '/api/games',
      payload: { specId: 'spec:endtest', player: '主上' },
    });
    if (g.statusCode !== 201) { fail(`建局失败: status=${g.statusCode}`); return; }
    const gameId = g.json().gameId;

    // 终局
    const endRes = await app.inject({ method: 'POST', url: `/api/games/${encodeURIComponent(gameId)}/end` });
    if (endRes.statusCode !== 200) { fail(`终局失败: status=${endRes.statusCode}`); return; }
    ok('终局成功');

    // 终局后再问策
    const msgQ = await app.inject({
      method: 'POST', url: `/api/games/${encodeURIComponent(gameId)}/message`,
      payload: { text: '再议一会' },
    });
    if (msgQ.statusCode === 409 && msgQ.json().error?.code === '2003') guard('终局后问策返回 409 INVALID_ACTION');
    else fail(`终局后问策未按预期拦截: status=${msgQ.statusCode}`);

    // 终局后再下诏
    const msgD = await app.inject({
      method: 'POST', url: `/api/games/${encodeURIComponent(gameId)}/message`,
      payload: { text: '再下一诏', act: true },
    });
    if (msgD.statusCode === 409 && msgD.json().error?.code === '2003') guard('终局后下诏返回 409 INVALID_ACTION');
    else fail(`终局后下诏未按预期拦截: status=${msgD.statusCode}`);

    // 终局后再退朝（重复 end）
    const end2 = await app.inject({ method: 'POST', url: `/api/games/${encodeURIComponent(gameId)}/end` });
    if (end2.statusCode === 409) guard('终局后重复退朝返回 409');
    else fail(`重复退朝未按预期拦截: status=${end2.statusCode}`);

    // 终局后 reform
    const rf = await app.inject({
      method: 'POST', url: `/api/games/${encodeURIComponent(gameId)}/reform`,
      payload: { text: '十年后' },
    });
    if (rf.statusCode === 409) guard('终局后改局返回 409 INVALID_ACTION');
    else fail(`终局后改局未按预期拦截: status=${rf.statusCode}`);

    // 终局后 GET /state 应显示 final
    const st = await app.inject({ method: 'GET', url: `/api/games/${encodeURIComponent(gameId)}/state` });
    if (st.json().status === 'final') guard('终局后 GET /state 返回 status=final');
    else fail(`终局后 /state 状态异常: status=${st.json().status}`);
  } finally { await app.close(); }
});

// ============================================================================
// 6. 不存在的 gameId
// ============================================================================
test('边界：不存在的 gameId', async () => {
  section('6. 不存在的 gameId');
  const { app } = buildServer();
  try {
    const missId = 'g' + '0'.repeat(8);
    const st = await app.inject({ method: 'GET', url: `/api/games/${missId}/state` });
    if (st.statusCode === 404 && st.json().error?.code === '3001') guard('GET /state 不存在 gameId → 404');
    else fail(`GET state 未返回 404: status=${st.statusCode}`);

    const msg = await app.inject({
      method: 'POST', url: `/api/games/${missId}/message`,
      payload: { text: 'test' },
    });
    if (msg.statusCode === 404) guard('POST message 不存在 gameId → 404');
    else fail(`POST message 未返回 404: status=${msg.statusCode}`);

    const end = await app.inject({ method: 'POST', url: `/api/games/${missId}/end` });
    if (end.statusCode === 404) guard('POST end 不存在 gameId → 404');
    else fail(`POST end 未返回 404: status=${end.statusCode}`);

    const hist = await app.inject({ method: 'GET', url: `/api/games/${missId}/history` });
    if (hist.statusCode === 404) guard('GET history 不存在 gameId → 404');
    else fail(`GET history 未返回 404: status=${hist.statusCode}`);
  } finally { await app.close(); }
});

// ============================================================================
// 7. 非法指标（metric key 为数字 / 含特殊字符）
// ============================================================================
test('边界：非法指标', async () => {
  section('7. 非法指标');
  const { app, store } = buildServer();
  try {
    const badSpec = {
      domain: 'history' as const,
      title: '非法指标测试',
      scenario: {
        title: '非法指标测试',
        background: '模拟引擎对非法指标 key 的处理能力测试边界情况'.repeat(3),
        conflict: '指标命名不规范，含数字 key 和特殊字符',
        participants: ['p1', 'p2'],
        rounds: 3,
        decisionPoint: '如何处置',
        successCriteria: '系统不崩溃',
      },
      cast: [
        { id: 'p1', name: '张三', role: '户部', stance: '进取', influence: 70, description: '进取派',
          prompt: '你是张三。', traits: { competence: 60, loyalty: 70, ambition: 50, power: 60 } },
        { id: 'p2', name: '李四', role: '兵部', stance: '稳守', influence: 65, description: '稳守派',
          prompt: '你是李四。', traits: { competence: 55, loyalty: 80, ambition: 30, power: 70 } },
      ],
      metrics: [
        { key: '123', label: '国库', min: 0, max: 100, start: 50, higherIsBetter: true, description: '数字 key' },
        { key: 'state-!@#', label: '民心', min: 0, max: 100, start: 50, higherIsBetter: true, description: '特殊字符 key' },
        { key: 'gold', label: '银两', min: 0, max: 100, start: 50, higherIsBetter: true },
      ],
      rules: [],
    };
    injectSpec(store, 'spec:badmetrics', badSpec);

    const g = await app.inject({
      method: 'POST', url: '/api/games',
      payload: { specId: 'spec:badmetrics', player: '主上' },
    });
    if (g.statusCode === 201) {
      ok('含非法 metric key 的 spec 建局成功 (201)，引擎未崩溃');
      const gameId = g.json().gameId;
      const d = await app.inject({
        method: 'POST', url: `/api/games/${gameId}/message`,
        payload: { text: '加派赋税', act: true },
      });
      if (d.statusCode === 200) ok('含非法 metric key 的对局下诏结算正常');
      else fail(`含非法 metric key 的对局下诏失败: status=${d.statusCode} body=${JSON.stringify(d.json()).slice(0, 200)}`);
    } else {
      fail(`含非法指标的 spec 建局失败: status=${g.statusCode} body=${JSON.stringify(g.json()).slice(0, 200)}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 8. 缺失字段（LLM 返回无 rules / metrics 的 spec）
// ============================================================================
test('边界：缺失字段', async () => {
  section('8. 缺失字段');
  const { app, store } = buildServer();
  try {
    // spec 缺少 metrics（engine createState 需要 spec.metrics）
    const minimalSpec = {
      domain: 'history' as const,
      title: '缺字段测试',
      scenario: {
        title: '缺字段测试',
        background: '测试缺失必要字段时引擎的容错能力'.repeat(4),
        conflict: '无指标无规则',
        participants: ['p1', 'p2'],
        rounds: 2,
        decisionPoint: '怎么办',
        successCriteria: '不崩溃',
      },
      cast: [
        { id: 'p1', name: '王五', role: '丞相', stance: '进取', influence: 80, description: '相',
          prompt: '你是王五。', traits: { competence: 70, loyalty: 70, ambition: 50, power: 80 } },
        { id: 'p2', name: '赵六', role: '御史', stance: '稳守', influence: 60, description: '御史',
          prompt: '你是赵六。', traits: { competence: 60, loyalty: 90, ambition: 20, power: 50 } },
      ],
      // metrics: 缺失！
      // rules: 缺失！
    };
    injectSpec(store, 'spec:missing-fields', minimalSpec);

    const g = await app.inject({
      method: 'POST', url: '/api/games',
      payload: { specId: 'spec:missing-fields', player: '主上' },
    });
    if (g.statusCode === 201) {
      warn('缺失 metrics/rules 的 spec 仍建局成功 (201)，说明 createState(undefined) 有容错但行为未定义');
    } else if (g.statusCode === 400 || g.statusCode === 500) {
      guard(`缺失关键字段的 spec 在建局时被拦截: status=${g.statusCode}`);
    } else {
      fail(`缺失字段 spec 建局状态不明: status=${g.statusCode} body=${JSON.stringify(g.json()).slice(0, 200)}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 9. 格式错误的 formula（含中文变量如 round(岁入*0.01)）
// ============================================================================
test('边界：格式错误的 formula', async () => {
  section('9. 格式错误的 formula');
  const { app, store } = buildServer();
  try {
    const badFormulaSpec = {
      domain: 'history' as const,
      title: '公式测试',
      scenario: {
        title: '公式测试',
        background: '测试含中文变量的公式处理'.repeat(5),
        conflict: '公式中的中文名变量',
        participants: ['p1', 'p2'],
        rounds: 3,
        decisionPoint: '财政如何',
        successCriteria: '公式不崩',
      },
      cast: [
        { id: 'p1', name: '管仲', role: '财政', stance: '进取', influence: 80, description: '财政大臣',
          prompt: '你是管仲。', traits: { competence: 90, loyalty: 80, ambition: 60, power: 90 } },
        { id: 'p2', name: '晏婴', role: '民吏', stance: '稳守', influence: 70, description: '民吏',
          prompt: '你是晏婴。', traits: { competence: 80, loyalty: 90, ambition: 30, power: 70 } },
      ],
      metrics: [
        { key: 'gold', label: '国库', min: 0, max: 100, start: 60, higherIsBetter: true, description: '银两' },
        { key: '米价', label: '米价', min: 0, max: 100, start: 50, higherIsBetter: false, description: '粮价' },
      ],
      rules: [
        // 合法公式
        { id: 'r1', kind: 'drift', label: '正常', description: '每回合增 2', target: 'gold', appliesTo: ['gold'], formula: '2' },
        // 含中文变量的公式（岁入不在 metric keys 中，审校司会报 issue，引擎执行时按 0 处理）
        { id: 'r2', kind: 'drift', label: '中文变量', description: '岁入税', target: 'gold', appliesTo: ['gold'], formula: 'round(岁入*0.01)' },
      ],
    };
    injectSpec(store, 'spec:badformula', badFormulaSpec);

    const g = await app.inject({
      method: 'POST', url: '/api/games',
      payload: { specId: 'spec:badformula', player: '主上' },
    });
    if (g.statusCode === 201) {
      ok('含非法 formula（中文变量）的 spec 建局成功（审校司识别岁入为野引用，引擎按 0 处理）');
      const gameId = g.json().gameId;
      const d = await app.inject({
        method: 'POST', url: `/api/games/${gameId}/message`,
        payload: { text: '加税', act: true },
      });
      if (d.statusCode === 200) ok('含非法 formula 的对局下诏结算正常，未崩');
      else fail(`含非法 formula 的对局下诏失败: status=${d.statusCode} body=${JSON.stringify(d.json()).slice(0, 200)}`);
    } else {
      fail(`含非法 formula 的 spec 建局失败: status=${g.statusCode} body=${JSON.stringify(g.json()).slice(0, 200)}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 10. 并发请求（同时发起两个 build）
// ============================================================================
test('边界：并发请求', async () => {
  section('10. 并发请求');
  const { app } = buildServer();
  try {
    const ing = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'text', text: '并发测试' },
    });
    const topicId = ing.json().topicId;

    // 同时发起两个 build
    const p1 = app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
    const p2 = app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
    const [r1, r2] = await Promise.all([p1, p2]);

    const s1 = r1.statusCode;
    const s2 = r2.statusCode;
    if ((s1 === 202 && s2 === 409) || (s1 === 409 && s2 === 202)) {
      guard('并发 build 只允许一个通过 (202)，另一个被 runTask Set 锁住 (409 TASK_RUNNING)');
    } else if (s1 === 202 && s2 === 202) {
      fail('并发 build 两个都返回 202，任务锁失效（管线可能被执行两次）');
    } else {
      fail(`并发 build 状态异常: r1=${s1} r2=${s2}`);
    }
    // 等待后台管线结束，防止 app.close() 后仍有写入
    await waitForPipeline(app, topicId);
  } finally { await app.close(); }
});

// ============================================================================
// 11. URL 注入：file:// / localhost 绕过 safeFetch 门禁
// ============================================================================
test('边界：URL 注入绕过安全门禁', async () => {
  section('11. URL 注入安全');
  const { app } = buildServer();
  try {
    // file:// 协议：Zod schema 只校验 .url()，不拒绝 file://
    const r1 = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'url', url: 'file:///etc/passwd' },
    });
    if (r1.statusCode === 202) {
      warn('file:// URL 绕过 Zod .url() 校验被 ingest 接受 (202)；safeFetch 门禁在 build 阶段才触发，但 topicId 已泄露为 file:///etc/passwd');
    } else {
      guard(`file:// URL 被拦截: status=${r1.statusCode}`);
    }

    // localhost 域名：Zod 接受，safeFetch 解析 IP 后应拒绝
    const r2 = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'url', url: 'https://localhost/test' },
    });
    if (r2.statusCode === 202) {
      warn('https://localhost 绕过 Zod .url() 校验被 ingest 接受 (202)；topicId 泄露为该 URL');
    } else {
      guard(`localhost URL 被拦截: status=${r2.statusCode}`);
    }

    // 内网 IP（10.x / 192.168.x）：同样会被 Zod .url() 接受
    const r3 = await app.inject({
      method: 'POST', url: '/api/topics/ingest',
      payload: { kind: 'url', url: 'http://192.168.1.1/admin' },
    });
    if (r3.statusCode === 202) {
      warn('内网 IP URL 被 ingest 接受 (202)；SSRF 风险——safeFetch 在 build 阶段才会拦截，但 topicId 已泄露');
    } else {
      guard(`内网 IP URL 被拦截: status=${r3.statusCode}`);
    }
  } finally { await app.close(); }
});

// ============================================================================
// 12. 消息体缺失 text 字段 / text=null
// ============================================================================
test('边界：消息体缺失 text', async () => {
  section('12. 消息体缺失 text');
  const { app, store } = buildServer();
  try {
    const goodSpec = {
      domain: 'history' as const,
      title: '消息测试',
      scenario: {
        title: '消息测试',
        background: '测试消息体缺失 text 字段'.repeat(5),
        conflict: '消息体缺失',
        participants: ['p1', 'p2'],
        rounds: 3,
        decisionPoint: '如何处置',
        successCriteria: '不崩',
      },
      cast: [
        { id: 'p1', name: '张三', role: '户部', stance: '进取', influence: 70, description: '进取派',
          prompt: '你是张三。', traits: { competence: 60, loyalty: 70, ambition: 50, power: 60 } },
        { id: 'p2', name: '李四', role: '兵部', stance: '稳守', influence: 65, description: '稳守派',
          prompt: '你是李四。', traits: { competence: 55, loyalty: 80, ambition: 30, power: 70 } },
      ],
      metrics: [
        { key: 'gold', label: '国库', min: 0, max: 100, start: 50, higherIsBetter: true },
      ],
      rules: [],
    };
    injectSpec(store, 'spec:msgtest', goodSpec);

    const g = await app.inject({
      method: 'POST', url: '/api/games',
      payload: { specId: 'spec:msgtest', player: '主上' },
    });
    if (g.statusCode !== 201) { fail(`建局失败: status=${g.statusCode}`); return; }
    const gameId = g.json().gameId;

    // 完全缺少 text 字段
    const m1 = await app.inject({
      method: 'POST', url: `/api/games/${gameId}/message`,
      payload: { act: true },
    });
    if (m1.statusCode === 400 && m1.json().error?.code === '1001') guard('缺少 text 字段返回 400 BAD_INPUT，trim(undefined) 产生空字符串被拦截');
    else warn(`缺少 text 字段状态: status=${m1.statusCode} body=${JSON.stringify(m1.json()).slice(0, 120)}`);

    // text = null
    const m2 = await app.inject({
      method: 'POST', url: `/api/games/${gameId}/message`,
      payload: { text: null },
    });
    if (m2.statusCode === 400 && m2.json().error?.code === '1001') guard('text=null 返回 400 BAD_INPUT');
    else warn(`text=null 状态: status=${m2.statusCode} body=${JSON.stringify(m2.json()).slice(0, 120)}`);
  } finally { await app.close(); }
});

console.log('\n========== 测试完成 ==========');
