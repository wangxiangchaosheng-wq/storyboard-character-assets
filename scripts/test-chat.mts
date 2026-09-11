#!/usr/bin/env node
/** 历史架空游戏 - 基础对话流程测试 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
// 加载 .env 到当前进程，确保子进程继承 AGNES 等凭证
import { readFileSync } from "node:fs";
for (const line of readFileSync(join(ROOT, ".env"), "utf8").split("\n")) {
  const t = line.trim();
  if (!t || t.startsWith("#")) continue;
  const eq = t.indexOf("=");
  if (eq > 0) {
    const k = t.slice(0, eq).trim();
    const v = t.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
    if (!(k in process.env)) process.env[k] = v;
  }
}
const HOST = "127.0.0.1";
const DB_PATH = join(tmpdir(), `sim-chat-test-${Date.now()}-${process.pid}.sqlite`);
const TOPIC_TEXT = "架空：崇祯年间穿越成为户部尚书，面对国库空虚与农民起义，该如何抉择？";

function freePort(cands) {
  return new Promise((res) => {
    let i = 0;
    const tryNext = () => {
      if (i >= cands.length) return res(null);
      const port = cands[i++];
      const srv = createServer();
      srv.once("error", () => { srv.close(); tryNext(); });
      srv.listen(port, HOST, () => { const a = srv.address(); srv.close(() => res(typeof a === "object" && a ? a.port : null)); });
    };
    tryNext();
  });
}

async function fetchJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    let body = {};
    const ct = r.headers.get("content-type") ?? "";
    if (r.body) { const text = await r.text(); if (text) body = ct.includes("json") ? JSON.parse(text) : text; }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: { error: String(e?.message ?? e) } }; }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

async function main() {
  const PORT = await freePort([8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795]);
  if (!PORT) { console.error("no free port in 8788-8795"); process.exit(1); }
  let child = null;
  let failures = 0;
  const fail = (m) => { failures += 1; console.error(`\n  FAIL: ${m}`); };
  const step = (m) => console.log(`  OK:   ${m}`);
  const section = (m) => console.log(`\n=== ${m} ===`);

  try {
    child = spawn(process.execPath, ["--experimental-strip-types", "packages/serve/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DB_PATH },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    let bootLog = "";
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    let up = false;
    for (let i = 0; i < 30; i++) {
      const r = await fetchJson(`http://${HOST}:${PORT}/healthz`).catch(() => ({ status: 0 }));
      if (r.status === 200) { up = true; break; }
      await sleep(400);
    }
    if (!up) { fail(`serve not ready in 15s on port ${PORT}`); console.log(bootLog.slice(0, 400)); return; }
    step(`serve up on port ${PORT}`);

    // 1) ingest
    section("1. Topic Ingest");
    const ing = await fetchJson(`http://${HOST}:${PORT}/api/topics/ingest`, {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "text", text: TOPIC_TEXT }),
    });
    if (ing.status !== 202 || !ing.body?.topicId) {
      fail(`ingest failed: ${ing.status} ${JSON.stringify(ing.body).slice(0, 200)}`);
    } else {
      const topicId = ing.body.topicId;
      step(`topicId=${topicId}`);

      // 2) build + wait
      section("2. Build & Spec");
      const bld = await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/build`, { method: "POST" });
      step(`build submitted: status=${bld.status}`);
      for (let i = 0; i < 80; i++) {
        const st = await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/status`);
        if (st.body?.state === "ready" || st.body?.state === "failed") break;
        await sleep(500);
      }
      const specRes = await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/spec`);
      if (specRes.status !== 200) fail(`spec fetch failed: ${specRes.status}`);
      else {
        const spec = specRes.body.spec;
        const metrics = spec?.metrics ?? [];
        const rules = spec?.rules ?? [];
        step(`spec: metrics=${metrics.length} rules=${rules.length} cast=${(spec?.cast ?? []).length}`);
        step(`title="${spec?.scenario?.title ?? "?"}" bg="${String(spec?.scenario?.background ?? "").slice(0, 60)}..."`);
        if (metrics.length < 2) fail(`metrics too few (${metrics.length})`);
        if (JSON.stringify(spec).includes('"formula"')) fail("spec leaks formula");
        if (!Array.isArray(spec?.formulaAudit) || spec.formulaAudit.length < (rules?.length ?? 0)) fail("missing formulaAudit");
      }

      // 3) 建局
      section("3. Create Game");
      if (!specRes.body?.spec) fail("no spec available");
      else {
        const g = await fetchJson(`http://${HOST}:${PORT}/api/games`, {
          method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ specId: topicId, player: "穿越者" }),
        });
        if (g.status !== 201) {
          fail(`create game failed: ${g.status} ${JSON.stringify(g.body).slice(0, 200)}`);
        } else {
          const game = g.body;
          const gameId = game.gameId;
          step(`gameId=${gameId} turn=${game.turn} status=${game.status}`);
          step(`chat count=${game.chat?.length ?? 0} firstKind=${game.chat?.[0]?.kind} firstName=${game.chat?.[0]?.name ?? "?"}`);
          step(`metrics=${JSON.stringify(game.metrics?.map((m) => ({ key: m.key, label: m.label })))}`);
          step(`directives=${game.directives?.length ?? 0}`);

          const initState = { ...game.state };
          step(`initial state: ${JSON.stringify(initState)}`);

          const agents = (game.chat ?? []).filter((m) => m.kind === "agent");
          const militaryAgent = agents.find((m) => /兵|军|将/.test(m.name ?? "")) ?? agents[0];
          const financeAgent = agents.find((m) => /户|财|钱|粮/.test(m.name ?? "")) ?? agents[agents.length - 1] ?? agents[0];
          const milId = militaryAgent?.from;
          const finId = financeAgent?.from;
          step(`targeted: military=${militaryAgent?.name ?? "?"}(${milId ?? "?"}) finance=${financeAgent?.name ?? "?"}(${finId ?? "?"})`);

          // 4a 问兵部（军费）
          section("4a. Consult Military (军费)");
          const q1 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "兵部大人，辽东军费浩繁，边军欠饷三月，如何筹措？", to: milId, act: false }),
          });
          if (q1.status !== 200) {
            fail(`q1 failed: ${q1.status} ${JSON.stringify(q1.body).slice(0, 200)}`);
          } else {
            const r1 = q1.body;
            if (r1.turn !== 0) fail(`q1 turn should be 0, got ${r1.turn}`);
            if (JSON.stringify(r1.state) !== JSON.stringify(initState)) fail("q1 state changed when act=false");
            const ag = r1.messages?.filter((m) => m.kind === "agent") ?? [];
            step(`q1 turn=${r1.turn} agentReplies=${ag.length} first=${ag[0]?.name ?? "?"}`);
          }

          // 4b 问户部（财政）
          section("4b. Consult Finance (财政)");
          const q2 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "户部大人，国库空虚民怨沸腾，有何良策？", to: finId, act: false }),
          });
          if (q2.status !== 200) {
            fail(`q2 failed: ${q2.status}`);
          } else {
            const r2 = q2.body;
            if (r2.turn !== 0) fail(`q2 turn should be 0, got ${r2.turn}`);
            const ag = r2.messages?.filter((m) => m.kind === "agent") ?? [];
            step(`q2 turn=${r2.turn} agentReplies=${ag.length} first=${ag[0]?.name ?? "?"}`);
          }

          // 4c 下诏（实际行动）
          section("4c. Issue Decree (赈济流民)");
          const decree = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
            method: "POST", headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ text: "着户部即刻开仓放粮，赈济流民，所费从内帑支取，不得加派。", act: true }),
          });
          if (decree.status !== 200) {
            fail(`decree failed: ${decree.status}`);
          } else {
            const rd = decree.body;
            if (rd.turn !== 1) fail(`decree turn should be 1, got ${rd.turn}`);
            const resultMsg = rd.messages?.find((m) => m.kind === "result");
            const deltas = resultMsg?.deltas ?? [];
            if (deltas.length < 1) fail("decree result has no deltas");
            step(`decree turn=${rd.turn} deltas=${JSON.stringify(deltas)}`);
            step(`state after: ${JSON.stringify(rd.state)}`);
            if (JSON.stringify(rd.state) === JSON.stringify(initState)) fail("state unchanged after decree");
            else step("state changed after decree (数值结算正常)");
          }

          // 5) 状态核查
          section("5. State & Metadata Checks");
          const st = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/state`);
          if (st.status !== 200) fail(`/state: ${st.status}`);
          else {
            const s = st.body;
            step(`/state turn=${s.turn} status=${s.status} chatLen=${s.chat?.length}`);
            if (JSON.stringify(s.spec ?? {}).includes('"formula"')) fail("state spec leaks formula");
            else step("state spec OK (no formula leak)");
          }

          const hist = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/history`);
          if (hist.status !== 200) fail(`/history: ${hist.status}`);
          else step(`/history turn=${hist.body.turn} events=${hist.body.events?.length} metricSeries=${hist.body.metrics?.length}`);

          const mp = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/map`);
          if (mp.status !== 200) fail(`/map: ${mp.status}`);
          else step(`/map factions=${mp.body.factions?.length}`);

          const sb = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/storyboard`);
          if (sb.status !== 200) fail(`/storyboard: ${sb.status}`);
          else step(`/storyboard beats=${sb.body.beats?.length}`);

          // 6) 退朝终局
          section("6. End Session (退朝)");
          const end = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/end`, { method: "POST" });
          if (end.status !== 200) {
            fail(`end failed: ${end.status} ${JSON.stringify(end.body).slice(0, 200)}`);
          } else {
            const ej = end.body;
            step(`verdict=${ej.ending?.verdict} narrative="${String(ej.ending?.narrative ?? "").slice(0, 50)}..."`);
            step(`view status=${ej.view?.status} turn=${ej.view?.turn}`);
            if (!["victory", "defeat", "open"].includes(ej.ending?.verdict ?? "")) fail(`bad verdict: ${ej.ending?.verdict}`);
            if ((ej.ending?.narrative ?? "").length < 10) fail("narrative too short");
            else step("narrative length OK");

            const pst = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/state`);
            if (pst.body?.status !== "final") fail(`post-end state status=${pst.body?.status}, expected final`);
            else step("post-end /state status=final");

            const pmsg = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
              method: "POST", headers: { "Content-Type": "application/json" },
              body: JSON.stringify({ text: "再议", act: true }),
            });
            if (pmsg.status !== 409) fail(`post-end message should 409, got ${pmsg.status}`);
            else step("post-end message -> 409");

            const pend = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/ending`);
            if (pend.status !== 200) fail(`post-end GET /ending: ${pend.status}`);
            else step("post-end GET /ending -> 200");
          }
        }
      }
    }

    console.log("\n" + "=".repeat(50));
    if (failures === 0) console.log("ALL PASSED (全链通过)");
    else { console.error(`${failures} failure(s)\n`); process.exit(1); }
  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((r) => child?.once("exit", r)); }
    for (const suf of ["", "-wal", "-shm"]) { try { rmSync(DB_PATH + suf, { force: true }); } catch {} }
  }
}

main().catch((e) => { console.error("uncaught:", e); process.exit(1); });
