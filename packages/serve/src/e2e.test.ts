/**
 * serve e2e（docs/05 · 聊天模型）：完整用户旅程，mock provider 全程离线可跑 ——
 * ingest → build → 轮询 ready → spec 出库 → 建局（史官开场 + 群臣陈情）→
 * 问策（点名/全场）→ 下诏（结算数值）→ 多道诏令不限轮数 → 退朝终局 →
 * 终局语义（409 只读 / 终局落笔）。
 */
process.env.LOG_LEVEL = 'silent';
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildServer } from './server.ts';

const TOPIC = '创业公司 B 轮融资推演';

async function waitReady(app: ReturnType<typeof buildServer>['app'], id: string): Promise<string> {
  let state = 'idle';
  for (let i = 0; i < 100; i++) {
    const res = await app.inject({ method: 'GET', url: `/api/topics/${encodeURIComponent(id)}/status` });
    state = res.json().state;
    if (state === 'ready' || state === 'failed') break;
    await new Promise((r) => setTimeout(r, 60));
  }
  return state;
}

test('e2e：话题 → spec → 建局 → 问策 / 连下诏令 → 退朝终局', async () => {
  const { app } = buildServer();

  // 1) ingest（确定性 topicId：txt: 前缀 + 前 16 字）
  const ingest = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: TOPIC },
  });
  assert.equal(ingest.statusCode, 202);
  const topicId = ingest.json().topicId;
  assert.equal(topicId, 'txt:' + TOPIC.slice(0, 16));

  // 2) build → 轮询到 ready（mock 管线全离线）
  assert.equal(
    (await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` })).statusCode,
    202,
  );
  const state = await waitReady(app, topicId);
  assert.equal(state, 'ready');

  // 3) spec 出库（不再 501）
  const specRes = await app.inject({ method: 'GET', url: `/api/topics/${encodeURIComponent(topicId)}/spec` });
  assert.equal(specRes.statusCode, 200);
  const { spec } = specRes.json();
  assert.ok(spec.scenario?.title, 'spec 应有 scenario');
  assert.ok(spec.cast?.length >= 3, 'spec 应有 cast');
  assert.ok(spec.metrics?.length >= 2, 'spec 应有 metrics');
  // 公式保密边界：对外 spec 不下发任何公式原文，但复核结论（formulaAudit）在位
  assert.equal(JSON.stringify(spec).includes('"formula"'), false, '对外 spec 不得含 formula 键（公式只在引擎内部）');
  assert.ok(Array.isArray(spec.formulaAudit) && spec.formulaAudit.length >= spec.rules.length, '公式复核结论应随 spec 落库');
  for (const a of spec.formulaAudit) {
    assert.equal(typeof a.ruleId, 'string');
    assert.equal(typeof a.ok, 'boolean');
    assert.equal(a.source, 'rule', 'mock 链路的复核为确定性校验');
  }

  // 4) 建局 → 史官开场 + 群臣陈情已落 chat，执行机制已派生
  const g = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: topicId, player: '主上·小明' },
  });
  assert.equal(g.statusCode, 201);
  const game = g.json();
  assert.match(game.gameId, /^g[0-9a-f]{8}$/);
  assert.equal(game.status, 'awaiting');
  assert.equal(game.turn, 0, '初始无诏');
  assert.ok(Array.isArray(game.chat) && game.chat.length >= spec.cast.length + 1, 'chat 已有史官+群臣');
  assert.equal(game.chat[0].kind, 'system', '首条为史官开场');
  for (const m of game.chat.slice(1)) assert.equal(m.kind, 'agent', '群臣各自陈情');
  assert.ok(game.directives.length >= 3, '机制由 spec 派生（问策/诏/均衡/推力）');
  assert.ok(game.metrics.length >= 2, '数值量程可绘');
  const gameId = game.gameId;

  // 4.5) /state 同样不下发公式原文（前台只读得到复核结论）
  const st = await app.inject({ method: 'GET', url: `/api/games/${gameId}/state` });
  assert.equal(st.statusCode, 200);
  const stSpec = st.json().spec;
  assert.ok(stSpec, '/state 应携带对外 spec 视图');
  assert.equal(JSON.stringify(stSpec).includes('"formula"'), false, '/state 的 spec 不得含公式原文');
  assert.ok(Array.isArray(stSpec.formulaAudit) && stSpec.formulaAudit.length >= stSpec.rules.length, '/state 的复核结论在位');

  // 5) 问策：全场（act=false → 不改数值不改轮数）
  const q = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '先生们，眼下最要紧的是什么？' },
  });
  assert.equal(q.statusCode, 200);
  assert.equal(q.json().turn, 0, '问策不动轮次');
  assert.deepEqual(q.json().state, game.state, '问策不改数值');
  const qkinds = q.json().messages.map((m: { kind: string }) => m.kind);
  assert.equal(qkinds[0], 'player', '回显自己的话');
  assert.ok(qkinds.filter((k: string) => k === 'agent').length >= 2, '群臣各抒己见');

  // 6) 点名问策：只同该角色
  const target = game.chat[1].from;
  const q1 = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '你打算怎么处置？', to: target },
  });
  assert.equal(q1.statusCode, 200);
  const agentMsgs = q1.json().messages.filter((m: { kind: string }) => m.kind === 'agent');
  assert.equal(agentMsgs.length, 1, '点名后只有一人回禀');
  assert.equal(agentMsgs[0].name, game.chat.find((m: { kind: string }) => m.kind === 'agent')!.name);

  // 7) 下诏：结算漂移+反应，轮次 +1
  const d1 = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '下诏：先保住现金流，砍掉非核心业务。', act: true },
  });
  assert.equal(d1.statusCode, 200);
  assert.equal(d1.json().turn, 1, '每道诏令 +1 轮');
  const dkinds = d1.json().messages.map((m: { kind: string }) => m.kind);
  assert.equal(dkinds[0], 'player', '先回显原话');
  assert.ok(dkinds.includes('result'), '有政令颁行结果');
  const result = d1.json().messages.find((m: { kind: string }) => m.kind === 'result');
  assert.ok(result.deltas.length >= 1, '结果自带数值变动');
  assert.notDeepEqual(d1.json().state, game.state, '数值已按规则重算');
  const after1 = d1.json().state;

  // 8) 无限对话：超过旧固定轮数（3）连续再下诏，永不到头
  let turn = 2;
  for (; turn <= 6; turn++) {
    const d = await app.inject({
      method: 'POST',
      url: `/api/games/${gameId}/message`,
      payload: { text: `第 ${turn} 诏：维持战略定力，见机行事。`, act: true },
    });
    assert.equal(d.statusCode, 200, `第${turn}诏`);
    assert.equal(d.json().turn, turn);
  }
  assert.ok(turn > 3, '超过老版 3 回合仍可继续（无固定总轮数）');

  // 9) 中途状态持久化：GET state 还原续玩
  const mid = await app.inject({ method: 'GET', url: `/api/games/${gameId}/state` });
  assert.equal(mid.statusCode, 200);
  assert.equal(mid.json().turn, 6);
  assert.equal(mid.json().status, 'awaiting', '仍在廷议');
  assert.ok(mid.json().chat.length > 0, '聊天记录可恢复');

  // 10) 退朝定局
  const endRes = await app.inject({ method: 'POST', url: `/api/games/${gameId}/end` });
  assert.equal(endRes.statusCode, 200);
  const { ending, view } = endRes.json();
  assert.equal(view.status, 'final');
  assert.equal(ending.gameId, gameId);
  assert.ok(['victory', 'defeat', 'open'].includes(ending.verdict));
  assert.ok(ending.narrative.length > 0, '终局叙事（史官落笔）非空');
  assert.deepEqual(ending.metrics, view.state, '终局数值与最终状态一致');

  // 11) 终局语义：state final / ending 可取 / 再说话与再退朝都 409
  const st2 = await app.inject({ method: 'GET', url: `/api/games/${gameId}/state` });
  assert.equal(st2.json().status, 'final');
  const end2 = await app.inject({ method: 'GET', url: `/api/games/${gameId}/ending` });
  assert.equal(end2.statusCode, 200);
  assert.equal(end2.json().verdict, ending.verdict);
  const pv = await app.inject({ method: 'GET', url: `/api/games/${gameId}/player-view` });
  assert.equal(pv.json().status, 'final');
  assert.ok(pv.json().log.length >= 8, '公开回放包含全部对话');
  const sb = await app.inject({ method: 'GET', url: `/api/games/${gameId}/storyboard` });
  assert.equal(sb.json().beats.length, 6, '六道诏令六个锚点');
  const map = await app.inject({ method: 'GET', url: `/api/games/${gameId}/map` });
  assert.ok(map.json().factions.length >= 3, '阵营图应有 cast 势力');

  const againMsg = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '再议一会', act: true },
  });
  assert.equal(againMsg.statusCode, 409);
  assert.equal(againMsg.json().error.code, '2003');
  const againEnd = await app.inject({ method: 'POST', url: `/api/games/${gameId}/end` });
  assert.equal(againEnd.statusCode, 409);

  await app.close();
});

test('e2e：消息校验（未知局 / 空话 / 无此人 / 终局取结）', async () => {
  const { app, store } = buildServer();

  // 未知局 → 404
  const missing = await app.inject({
    method: 'POST',
    url: '/api/games/nope/message',
    payload: { text: 'hi' },
  });
  assert.equal(missing.statusCode, 404);

  // 直注入 financing spec（确保确定性），跳过管线提速
  const { financingSpec } = await import('@sim/engine-core');
  store.prepare(
    'INSERT INTO topics (id, status, input, created_at, updated_at) VALUES (?, ?, ?, ?, ?)',
  ).run('spec:e2e2', 'ready', JSON.stringify({ kind: 'text', text: 'x' }), Date.now(), Date.now());
  store.prepare('UPDATE topics SET spec = ? WHERE id = ?').run(JSON.stringify(financingSpec), 'spec:e2e2');

  const g = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: 'spec:e2e2', player: 'p' },
  });
  assert.equal(g.statusCode, 201);
  const gameId = g.json().gameId;

  // 空话 / 超长 / 虚构人物 → 400
  const blank = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '   ' },
  });
  assert.equal(blank.statusCode, 400);
  const long = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '长'.repeat(801) },
  });
  assert.equal(long.statusCode, 400);
  const noOne = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '出来', to: 'per-son:a' },
  });
  assert.equal(noOne.statusCode, 400);

  // 未终局 GET ending → 409
  const earlyEnding = await app.inject({ method: 'GET', url: `/api/games/${gameId}/ending` });
  assert.equal(earlyEnding.statusCode, 409);

  // 再补一诏，确保快路径也能结算
  const decree = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '遇事不决，先清金库。', act: true },
  });
  assert.equal(decree.statusCode, 200);
  assert.equal(decree.json().turn, 1);

  await app.close();
});

test('e2e：历史端点 —— 开局/诏令/终局快照 + 对局列表', async () => {
  const { app } = buildServer();

  // 建局（复用最短链路：ingest → build → ready → 建局）
  const ingest = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: '历史端点测试局' },
  });
  assert.equal(ingest.statusCode, 202);
  const topicId = ingest.json().topicId;
  await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
  await waitReady(app, topicId);
  const g = await app.inject({ method: 'POST', url: '/api/games', payload: { specId: topicId, player: 'p' } });
  assert.equal(g.statusCode, 201);
  const gameId = g.json().gameId;

  // 建局即有第 0 帧（开局快照）
  const h0 = await app.inject({ method: 'GET', url: `/api/games/${gameId}/history` });
  assert.equal(h0.statusCode, 200);
  const hist = h0.json();
  assert.equal(hist.turn, 0);
  assert.equal(hist.status, 'awaiting');
  assert.ok(hist.metrics.length >= 2);
  for (const s of hist.metrics) {
    assert.equal(s.points.length, 1, '开局只应有 1 个锚点');
    assert.equal(s.points[0].t, 0);
    assert.equal(typeof s.points[0].v, 'number');
  }
  assert.equal(hist.events.length, 1);
  assert.match(hist.events[0].narrative, /开局/);

  // 列表包含本局（尚未终局）
  const list = await app.inject({ method: 'GET', url: '/api/games' });
  assert.equal(list.statusCode, 200);
  const found = list.json().games.find((x: { gameId: string }) => x.gameId === gameId);
  assert.ok(found, '新建的对局应出现在列表中');
  assert.equal(found.status, 'awaiting');
  assert.equal(found.turn, 0);

  // 一诏落定 → 快照 +1，曲线多一个点
  const d = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '下诏：整顿吏治，先清金库。', act: true },
  });
  assert.equal(d.statusCode, 200);
  assert.equal(d.json().turn, 1);
  const h1 = await app.inject({ method: 'GET', url: `/api/games/${gameId}/history` });
  const hist1 = h1.json();
  assert.equal(hist1.turn, 1);
  assert.equal(hist1.events.length, 2);
  assert.equal(hist1.events[1].t, 1);
  assert.ok(hist1.events[1].deltas.length >= 1, '诏令帧应带 deltas');

  // 退朝终局 → 终局帧 + 列表状态翻转
  await app.inject({ method: 'POST', url: `/api/games/${gameId}/end` });
  const h2 = await app.inject({ method: 'GET', url: `/api/games/${gameId}/history` });
  const hist2 = h2.json();
  assert.equal(hist2.status, 'final');
  const last = hist2.events[hist2.events.length - 1];
  assert.equal(last.t, 2, '终局帧在诏令帧之后');
  assert.match(last.narrative, /终局/);
  const list2 = await app.inject({ method: 'GET', url: '/api/games' });
  const found2 = list2.json().games.find((x: { gameId: string }) => x.gameId === gameId);
  assert.equal(found2.status, 'final');

  // 不存在的局 → 404
  const miss = await app.inject({ method: 'GET', url: '/api/games/nope/history' });
  assert.equal(miss.statusCode, 404);

  await app.close();
});

test('e2e：鼎新改局 —— 一段话推年代 / 换人物，覆盖按局绑定不串局', async () => {
  const { app } = buildServer();

  // 建话题 + 建局
  const ingest = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: TOPIC },
  });
  const topicId = ingest.json().topicId;
  await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
  assert.equal(await waitReady(app, topicId), 'ready');

  const g1 = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: topicId, player: '主上' },
  });
  assert.equal(g1.statusCode, 201);
  const gameId = g1.json().gameId;
  const before = g1.json().chat
    .filter((m: { kind: string }) => m.kind === 'agent')
    .map((m: { name?: string }) => m.name ?? '');

  // 鼎新：推三十年 + 点名起用新人（mock 全程确定性）
  const rf = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '三十年后，老臣凋零，起用李校尉为将，锐意主战' },
  });
  assert.equal(rf.statusCode, 200);
  const rj = rf.json();
  assert.ok(rj.spec, '响应带覆盖 spec');
  const afterNames = rj.spec.cast.map((p: { name: string }) => p.name);
  assert.ok(afterNames.includes('李校尉'), '改令点名的「李校尉」入朝');
  assert.ok(
    afterNames.length !== before.length || afterNames.some((n: string) => !before.includes(n)),
    '人物册已变动',
  );
  assert.ok(
    rj.messages.some((m: { kind: string; name?: string }) => m.kind === 'event' && m.name === '鼎新'),
    '鼎新叙事落 chat',
  );
  assert.match(rj.messages[rj.messages.length - 1].text, /时序推移 30 年/);
  assert.ok(rj.spec.scenario.participants.length === rj.spec.cast.length, 'participants 与 cast 一致');

  // 覆盖按局绑定：同话题另开一局仍是原班底（不串局）
  const g2 = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: topicId, player: '主上' },
  });
  const g2names = g2.json().chat
    .filter((m: { kind: string }) => m.kind === 'agent')
    .map((m: { name?: string }) => m.name ?? '');
  assert.deepEqual(g2names, before, '第二局不受第一局鼎新影响');

  // 恢复链路：/state 返回覆盖 spec；新人可被点名问策
  const st = await app.inject({ method: 'GET', url: `/api/games/${gameId}/state` });
  assert.equal(st.statusCode, 200);
  assert.deepEqual(st.json().spec.cast.map((p: { name: string }) => p.name), afterNames);
  const newGuy = rj.spec.cast.find((p: { name: string }) => p.name === '李校尉');
  const q = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '新卿以为眼下该怎么走？', to: newGuy.id },
  });
  assert.equal(q.statusCode, 200, '鼎新后的新人可正常参与廷议');

  // 非法改令 → 400；终局后改局 → 409
  const bad = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '' },
  });
  assert.equal(bad.statusCode, 400);
  await app.inject({ method: 'POST', url: `/api/games/${gameId}/end` });
  const late = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '十年后' },
  });
  assert.equal(late.statusCode, 409);

  await app.close();
});

test('e2e：鼎新机制 —— 不靠动词表，任意说法都能被机制接住', async () => {
  const { app } = buildServer();
  const ingest = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: TOPIC },
  });
  const topicId = ingest.json().topicId;
  await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
  assert.equal(await waitReady(app, topicId), 'ready');
  const g = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: topicId, player: '主上' },
  });
  const gameId = g.json().gameId;

  // ① 旧动词清单外的说法：「换郭嘉主政」（无「起用/任命」字样）→ 机制照样认出新 agent 郭嘉
  const r1 = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '局面往激进方向推，换郭嘉主政' },
  });
  assert.equal(r1.statusCode, 200);
  const names1 = r1.json().spec.cast.map((p: { name: string }) => p.name);
  assert.ok(names1.includes('郭嘉'), 'n-元机制认出「郭嘉」，不依赖动词清单');
  assert.match(r1.json().messages.at(-1).text, /风向转进/, '极性打分生效（激进 → 风向转进）');

  // ② 无名无年的改令（「把重心转向江南水师」）→ 不硬造人名，但矛盾必重书 + 全员记忆必注入
  const castBefore = names1.length;
  const r2 = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '把重心转向江南水师' },
  });
  assert.equal(r2.statusCode, 200);
  const rj2 = r2.json();
  assert.equal(rj2.spec.cast.length, castBefore, '四字术语不被人名先验误收');
  assert.ok(rj2.spec.cast.every((p: { name: string }) => !p.name.includes('江南水师')), '「江南水师」不当人名');
  assert.ok(rj2.spec.scenario.conflict.includes('把重心转向江南水师'), '矛盾重书织入改令原话');
  assert.match(rj2.messages.at(-1).text, /更张|记于心间/, '事件叙事说明朝局已受改令影响');

  // ③ 改令进了全员记忆：下轮问策的笔录上下文里应能看到改令痕迹（记忆注入机制）
  const q = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/message`,
    payload: { text: '诸位对此改令有何话说？' },
  });
  assert.equal(q.statusCode, 200);
  assert.ok(q.json().messages.filter((m: { kind: string }) => m.kind === 'agent').length >= 2);

  await app.close();
});

test('e2e：鼎新推进词的改令 —— 事件词不被人名先验误收，时代跨度照常生效', async () => {
  const { app } = buildServer();
  const ingest = await app.inject({
    method: 'POST',
    url: '/api/topics/ingest',
    payload: { kind: 'text', text: TOPIC },
  });
  const topicId = ingest.json().topicId;
  await app.inject({ method: 'POST', url: `/api/topics/${encodeURIComponent(topicId)}/build` });
  assert.equal(await waitReady(app, topicId), 'ready');
  const g = await app.inject({
    method: 'POST',
    url: '/api/games',
    payload: { specId: topicId, player: '主上' },
  });
  const gameId = g.json().gameId;

  // ① 「三年后再次鼎新」→ “鼎新”是改局词，不能被切成“鼎新”当人名；年代推演照常
  const r1 = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '三年后再次鼎新，重定朝纲' },
  });
  assert.equal(r1.statusCode, 200);
  const names1 = r1.json().spec.cast.map((p: { name: string }) => p.name);
  assert.ok(names1.every((n: string) => !n.includes('鼎新')), '改局词「鼎新」不得被人名先验误收');
  assert.ok(
    r1.json().messages.at(-1).text.includes('3 年') || r1.json().messages.at(-1).text.includes('三年'),
    '年代跨度进入叙事',
  );

  // ② 「三十年后再次鼎新」→ 强制换代也拿走任选、新人入朝
  const r2 = await app.inject({
    method: 'POST',
    url: `/api/games/${gameId}/reform`,
    payload: { text: '三十年后再次鼎新，换田丰为相，锐意进取' },
  });
  assert.equal(r2.statusCode, 200);
  const rj2 = r2.json();
  assert.ok(rj2.spec.cast.some((p: { name: string }) => p.name.includes('田丰')), '点名「田丰」补位成功');
  assert.match(rj2.messages.at(-1).text, /入朝补位/, '新人入朝叙事落地');

  await app.close();
});