/**
 * 进程级冒烟（review 工作流的冒烟步骤，也可 `pnpm smoke` 单跑）。
 *
 * 行为契约（防呆，任何自动化/模型可直接复用）：
 *  - 自选空闲端口（8899 起，向上落入 8890–8910 候选；均占用 → 退出 1 并说明）；
 *  - 真实拉起 serve（独立端口 + 临时 SQLite），全部通过后必杀子进程、清临时库；
 *  - 链式步骤：①healthz → ②ingest → ③build → ④spec 纪律断言 → ⑤建局 201；
 *  - 任一步失败即记 fail 并停止后续步骤（不再执行必然崩溃的调用），退出码 1；
 *  - 每步带明确输出（✔/✖），失败附原因与修复方向，方便低自动化照做。
 *
 * 退出码：0 = 全链通过；1 = 任一环节失败。
 */
import { spawn } from 'node:child_process';
import { createServer } from 'node:net';
import { rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const HOST = '127.0.0.1';
const BANNED = ['军势', '民望', '士气', '国力', '局势', '实力', '民心'];
const TOPIC =
  '崇祯十二年：三饷并催。军需浩繁，州县催科如虎；流民塞道，仓廪空虚，兵额在册而实伍半数逃亡。';

let failures = 0;
const fail = (msg) => {
  failures += 1;
  console.error('  ✗ ' + msg);
};
const step = (msg) => console.log('  ✓ ' + msg);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 探测某个端口是否空闲；返回可用端口号，全被占用返回 null。 */
function freePort(candidates) {
  return new Promise((resolvePort) => {
    let i = 0;
    const tryNext = () => {
      if (i >= candidates.length) return resolvePort(null);
      const port = candidates[i++];
      const srv = createServer();
      srv.once('error', () => {
        srv.close?.();
        tryNext();
      });
      srv.listen(port, HOST, () => {
        const addr = srv.address();
        srv.close(() => resolvePort(addr && typeof addr === 'object' ? addr.port : null));
      });
    };
    tryNext();
  });
}

async function fetchJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    const body = await r.json().catch(() => ({}));
    return { status: r.status, body };
  } catch (err) {
    return { status: 0, body: { error: String(err?.message ?? err) } };
  }
}

/** 轮询话题 spec 出库（构建为异步管线，最多等 40×500ms）。 */
async function waitSpecReady(port, topicId) {
  for (let i = 0; i < 40; i++) {
    const r = await fetch(`http://${HOST}:${port}/api/topics/${encodeURIComponent(topicId)}/spec`);
    if (r.status === 200) return await r.json();
    await sleep(500);
  }
  return null;
}

const dbPath = join(tmpdir(), `sims-review-${Date.now()}-${process.pid}.sqlite`);
const PORT = await freePort([8899, 8890, 8891, 8892, 8893, 8894, 8895, 8896, 8897, 8898, 8900]) ;
if (!PORT) {
  console.error('✗ 8890–8910 无空闲端口，无法自测');
  process.exit(1);
}

let child = null;
try {
  child = spawn(
    process.execPath,
    ['--experimental-strip-types', 'packages/serve/src/index.ts'],
    {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DB_PATH: dbPath },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    },
  );
  let bootLog = '';
  child.stdout.on('data', (d) => (bootLog += d));
  child.stderr.on('data', (d) => (bootLog += d));

  // ① healthz
  let up = false;
  for (let i = 0; i < 30; i++) {
    const r = await fetch(`http://${HOST}:${PORT}/healthz`).catch(() => null);
    if (r && r.status === 200) { up = true; break; }
    await sleep(400);
  }
  if (!up) {
    fail(`serve 未在 ${PORT} 就绪（15s 超时）。可能原因：端口被占、SQLite 锁、启动报错。日志片段：\n${bootLog.slice(0, 500)}`);
  } else {
    step(`serve 拉起（healthz 200，端口 ${PORT}）`);
  }

  // ② ingest → topicId
  let topicId = null;
  if (failures === 0) {
    const ing = await fetchJson(`http://${HOST}:${PORT}/api/topics/ingest`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ kind: 'text', text: TOPIC }),
    });
    if (ing.status !== 202 || !ing.body?.topicId) {
      fail(`ingest 未返回 202+topicId（${ing.status} ${JSON.stringify(ing.body).slice(0, 140)}）`);
    } else {
      topicId = ing.body.topicId;
      step(`ingest → ${topicId}`);
    }
  }

  // ③ build → spec 出库
  let spec = null;
  if (failures === 0 && topicId) {
    const bld = await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/build`, { method: 'POST' });
    if (bld.status !== 202 && bld.status !== 409) fail(`build 非 202/409（${bld.status}）`);
    spec = await waitSpecReady(PORT, topicId);
    if (!spec) fail('话题 spec 出溯超时（40×500ms）');
    else step(`spec 出数（metrics=${(spec.spec?.metrics ?? []).length} rules=${(spec.spec?.rules ?? []).length}）`);
  }

  // ④ spec 纪律断言
  if (failures === 0 && spec) {
    const ms = spec.spec?.metrics ?? [];
    const rules = spec.spec?.rules ?? [];
    if (!Array.isArray(ms) || ms.length < 2) fail(`metrics 不足 2（实际 ${ms.length}）`);
    for (const m of ms) {
      if (!m || !m.unit || !String(m.unit).length) fail(`指标「${m?.label ?? '?'}」缺真实单位`);
      for (const w of BANNED) {
        if (m?.label && String(m.label).includes(w)) fail(`指标名「${m.label}」含禁词「${w}」`);
      }
    }
    const raw = JSON.stringify(spec);
    if (raw.includes('"formula"')) fail('对外 spec 泄漏 formula 原文');
    if (!Array.isArray(spec.spec?.formulaAudit) || spec.spec.formulaAudit.length < (rules?.length ?? 0)) {
      fail('spec 缺 formulaAudit 复核结论（长度应 ≥ rules）');
    }
  }

  // ⑤ 建局
  if (failures === 0 && topicId) {
    const g = await fetchJson(`http://${HOST}:${PORT}/api/games`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ specId: topicId, player: 'smoke' }),
    });
    if (g.status !== 201) fail(`建局非 201（${g.status} ${JSON.stringify(g.body).slice(0, 120)}）`);
    else step(`建局 201 → ${g.body.gameId ?? ''}`);
  }

  if (failures === 0) console.log('\n冒烟全链通过：话题 → 出库 → 出对局（真实进程）');
} finally {
  if (child && child.exitCode === null) {
    child.kill();
    await new Promise((r) => child?.once('exit', r));
  }
  for (const suf of ['', '-wal', '-shm']) {
    try { rmSync(dbPath + suf, { force: true }); } catch { /* 忽略清理失败 */ }
  }
}

if (failures > 0) {
  console.error(`\n冒烟未通过（${failures} 项）。修复后重跑：pnpm smoke`);
  process.exit(1);
}