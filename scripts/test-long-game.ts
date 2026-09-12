#!/usr/bin/env node
/**
 * 长时间对局稳定性 & 对话质量测试
 *
 * 流程：
 *   1. Ingest topic + build spec
 *   2. 建局 + grab initial state
 *   3. 5 轮对话（每轮：问策 → 下诏）
 *      - 记录每个角色发言内容（含全文）
 *      - 记录 deltas / state
 *      - 检查工具 JSON 是否泄露
 *      - 检查同一角色是否重复台词（n-gram overlap）
 *   4. 第 3、5 轮与第 1 轮台词多样性比对
 *   5. 退朝终局 → 记录 verdict + 最终数值
 *
 * 重点关注：
 *   - 同一角色不同轮次说不同话
 *   - 数值合理波动（非单调）
 *   - 无工具 JSON 泄露
 *   - 对话长度合理（>50 chars）
 *   - 终局叙事有意义（>100 chars）
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";
import { tmpdir } from "node:os";

const ROOT = resolve(join(dirname(fileURLToPath(import.meta.url)), ".."));
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
const TOPIC_TEXT =
  "架空：崇祯年间穿越成为户部尚书，面对国库空虚与农民起义，该如何抉择？";
const DB_PATH = join(tmpdir(), `long-game-${Date.now()}-${process.pid}.sqlite`);

// ─── helpers ───────────────────────────────────────────────────────
function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

async function fetchJson(url, opts) {
  try {
    const r = await fetch(url, opts);
    let body = {};
    const ct = r.headers.get("content-type") ?? "";
    if (r.body) {
      const text = await r.text();
      if (text) body = ct.includes("json") ? JSON.parse(text) : text;
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: { error: String(e?.message ?? e) } };
  }
}

function freePort(cands) {
  return new Promise((res) => {
    let i = 0;
    const tryNext = () => {
      if (i >= cands.length) return res(null);
      const port = cands[i++];
      const srv = createServer();
      srv.once("error", () => {
        srv.close();
        tryNext();
      });
      srv.listen(port, HOST, () => {
        const a = srv.address();
        srv.close(() => res(typeof a === "object" && a ? a.port : null));
      });
    };
    tryNext();
  });
}

// ─── test data structures ──────────────────────────────────────────
const results = {
  turns: [],        // per-turn snapshot
  issues: [],       // bug list
  notes: [],        // warnings
  checks: [],       // pass/fail checklist
};

function check(label, pass, note = "") {
  results.checks.push({ label, pass, note });
  console.log(`  ${pass ? "✅" : "❌"} ${label}${note ? ` — ${note}` : ""}`);
}
function issue(label, note = "") {
  results.issues.push({ label, note });
  console.error(`  ❌ BUG: ${label}${note ? ` — ${note}` : ""}`);
}
function note(label, note = "") {
  results.notes.push({ label, note });
  console.warn(`  ⚠️  ${label}${note ? ` — ${note}` : ""}`);
}

// JSON-escape string for concise logging
function js(v) {
  try {
    return JSON.stringify(v);
  } catch {
    return String(v);
  }
}

// ─── Main ──────────────────────────────────────────────────────────
async function main() {
  const PORT = await freePort([8801, 8802, 8803, 8804, 8805]);
  if (!PORT) {
    console.error("no free port");
    process.exit(1);
  }

  let child = null;
  try {
    child = spawn(process.execPath, [
      "--experimental-strip-types",
      "packages/serve/src/index.ts",
    ], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT), DB_PATH },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });

    let bootLog = "";
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    // wait for server
    let up = false;
    for (let i = 0; i < 30; i++) {
      const r = await fetchJson(`http://${HOST}:${PORT}/healthz`).catch(() => ({
        status: 0,
      }));
      if (r.status === 200) {
        up = true;
        break;
      }
      await sleep(400);
    }
    if (!up) {
      console.error("server not ready in 15s");
      console.log(bootLog.slice(0, 500));
      process.exit(1);
    }

    console.log(`\n${"=".repeat(70)}`);
    console.log("  长时间对局稳定性 & 对话质量测试  ·  port=${PORT}");
    console.log(`${"=".repeat(70)}\n`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 1 – Ingest + Build
    // ═══════════════════════════════════════════════════════════════
    console.log("【步骤 1】Ingest topic");
    const ing = await fetchJson(`http://${HOST}:${PORT}/api/topics/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "text", text: TOPIC_TEXT }),
    });
    const topicId = ing.body?.topicId;
    check("Topic ingest", ing.status === 202, `status=${ing.status} topicId=${topicId ?? "?"}`);
    if (!topicId) {
      console.error("Cannot continue without topicId");
      process.exit(1);
    }

    console.log("\n【步骤 2】Build spec");
    const bld = await fetchJson(
      `http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/build`,
      { method: "POST" },
    );
    check("Build submitted", bld.status === 202 || bld.status === 409, `status=${bld.status}`);

    let spec = null;
    for (let i = 0; i < 180; i++) {
      const st = await fetchJson(
        `http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/status`,
      );
      if (st.body?.state === "ready" || st.body?.state === "failed") break;
      await sleep(500);
    }
    const specRes = await fetchJson(
      `http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/spec`,
    );
    check("Spec retrieved", specRes.status === 200, `status=${specRes.status}`);
    spec = specRes.body?.spec;
    if (!spec) {
      console.error("No spec returned");
      process.exit(1);
    }

    // spec-level checks
    const metrics = spec.metrics ?? [];
    const rules = spec.rules ?? [];
    const cast = spec.cast ?? [];
    check("Metrics present", metrics.length >= 3, `${metrics.length} metrics`);
    check("Cast present (≥3)", cast.length >= 3, `${cast.length} personas`);
    const specStrFull = JSON.stringify(spec);
    const formulaLeak = specStrFull.includes('"formula"');
    check("No formula leak in spec", !formulaLeak, formulaLeak ? "FOUND 'formula' key" : "");
    if (formulaLeak) issue("Spec leaks formula field", specStrFull.match(/"formula".{0,80}/g)?.join(", "));

    const audit = spec.formulaAudit ?? [];
    check("Formula audit present", Array.isArray(audit) && audit.length > 0, `${audit.length} audits`);

    console.log(`  Title:   ${spec.scenario?.title ?? "?"}`);
    console.log(`  Metrics: ${metrics.map((m) => `${m.label}[${m.key}]`).join(", ")}`);
    console.log(`  Cast:    ${cast.map((p) => `${p.name}(${p.role})[${p.stance}]`).join(", ")}`);
    console.log(`  Rules:   ${rules.length} (${rules.filter((r) => r.kind === "drift").length} drift, ${rules.filter((r) => r.kind === "reaction").length} reaction)`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 3 – Create game
    // ═══════════════════════════════════════════════════════════════
    console.log("\n【步骤 3】Create game");
    const gResp = await fetchJson(`http://${HOST}:${PORT}/api/games`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specId: topicId, player: "穿越者" }),
    });
    check("Game created", gResp.status === 201, `status=${gResp.status}`);
    const gameId = gResp.body?.gameId;
    const initChat = gResp.body?.chat ?? [];
    const initState0 = { ...gResp.body?.state };
    check("Initial state non-empty", Object.keys(initState0).length > 0, `${Object.keys(initState0).length} keys`);

    // Identify agents
    const agents = initChat.filter((m) => m.kind === "agent");
    console.log(`  GameId:   ${gameId}`);
    console.log(`  Opening chat: ${initChat.length} msgs, ${agents.length} agents`);

    // pick a finance / treasury agent as the primary interlocutor
    const financeAgent =
      agents.find((m) => /户|财|钱|粮|税|户部|财政/.test(m.name ?? "")) ??
      agents.find((m) => /尚书/.test(m.role ?? "")) ??
      agents.find((m) => /财/.test(m.stance ?? "")) ??
      agents[0];
    const militaryAgent =
      agents.find((m) => /兵|军|将|边|辽/.test(m.name ?? "") || /兵|军/.test(m.role ?? "")) ??
      agents.find((m) => /军/.test(m.stance ?? "")) ??
      agents[1] ?? agents[0];
    const rulerAgent =
      agents.find((m) => /皇帝|天子|陛下|崇祯|皇/.test(m.name ?? "")) ??
      agents.find((m) => /皇家|宫廷/.test(m.stance ?? "")) ??
      agents[agents.length - 1] ?? agents[0];

    const finId = financeAgent?.from ?? agents[0]?.from;
    const milId = militaryAgent?.from ?? agents[1]?.from;
    const rulId = rulerAgent?.from ?? agents[agents.length - 1]?.from;

    console.log(`  Finance: ${financeAgent?.name ?? "?"}(${finId}) [${financeAgent?.stance ?? ""}]`);
    console.log(`  Military:${militaryAgent?.name ?? "?"}(${milId}) [${militaryAgent?.stance ?? ""}]`);
    console.log(`  Ruler:   ${rulerAgent?.name ?? "?"}(${rulId}) [${rulerAgent?.stance ?? ""}]`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 4 – 5 rounds (问策 → 下诏)
    // ═══════════════════════════════════════════════════════════════
    const rounds = [
      {
        num: 1,
        consultText: "户部大人，国库日衰民变四起，你当如何筹款平乱？",
        consultTo: finId,
        decreeText: "着户部加征商税，以充军饷，凡江南富庶之地皆不得免。",
      },
      {
        num: 2,
        consultText: "兵部大人，流寇犯境，边军欠饷，如何 bolster 军心？",
        consultTo: milId,
        decreeText: "着兵部开仓支银，先赈陕西灾民，再图进剿，不准骚扰百姓。",
      },
      {
        num: 3,
        consultText: "内帑尚有积储几何？皇上欲移用内帑赈济灾民，可否？",
        consultTo: rulId,
        decreeText: "下旨：停止一切宫室营建，节省内帑以充军需与赈济。",
      },
      {
        num: 4,
        consultText: "户部大人，加税之后民怨更甚，当暂缓加派还是继续？",
        consultTo: finId,
        decreeText: "准户部奏议，暂缓加派一年，以安民心为急。",
      },
      {
        num: 5,
        consultText: "兵部大人，流寇势大，是否当求和谈判？",
        consultTo: milId,
        decreeText: "着户部拨银五十万两，遣使招安流寇，允其归田。",
      },
    ];

    // per-round recording
    const previousAgentContents = {}; // agentId → array of contents seen so far
    const valueTrajectory = [];       // { turn, state }
    valueTrajectory.push({ turn: 0, state: { ...initState0 } });

    for (const round of rounds) {
      console.log(`\n${"─".repeat(60)}`);
      console.log(`【轮次 ${round.num}】`);

      // ── 4a. 问策 ──
      const qUrl = `http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`;
      const qResp = await fetchJson(qUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: round.consultText,
          to: round.consultTo,
          act: false,
        }),
      });

      check(
        `R${round.num} 问策 HTTP`,
        qResp.status === 200,
        `status=${qResp.status}`,
      );
      const qTurn = qResp.body?.turn;
      const qState = qResp.body?.state ?? {};
      const qMessages = qResp.body?.messages ?? [];
      const qAgents = qMessages.filter((m) => m.kind === "agent");
      const qResults = qMessages.filter((m) => m.kind === "result");

      check(
        `R${round.num} 问策 turn=${qTurn ?? "?"}`,
        qTurn === 0 || qTurn === undefined || qTurn === round.num * 2 - 2,
        `expected consult turn`,
      );
      check(
        `R${round.num} 问策不改数值`,
        JSON.stringify(qState) === JSON.stringify(valueTrajectory[valueTrajectory.length - 1].state),
        "state unchanged",
      );

      // record agent messages
      for (const msg of qAgents) {
        const aid = msg.from ?? msg.speaker ?? "?";
        const content = msg.content ?? msg.text ?? "";
        if (!previousAgentContents[aid]) previousAgentContents[aid] = [];
        previousAgentContents[aid].push(content);

        // length check
        if (content.length < 50) {
          issue(
            `R${round.num} 问策 对话过短 [${msg.name ?? aid}]`,
            `content length=${content.length}`,
          );
        }
        // tool JSON leak check
        if (/```|JSON\.parse|fetch\(|axios|tool_use|tool_result/i.test(content)) {
          issue(
            `R${round.num} 问策 疑似工具JSON泄露 [${msg.name ?? aid}]`,
            content.slice(0, 120),
          );
        }
        // repetition check
        const prev = previousAgentContents[aid].slice(0, -1);
        for (const prevContent of prev) {
          if (prevContent.length > 80 && content.length > 80) {
            const common = findLongestCommonSubstring(prevContent, content);
            if (common.length > Math.min(prevContent.length, content.length) * 0.6) {
              issue(
                `R${round.num} 问策 角色[${msg.name ?? aid}]可能复读`,
                `overlap=${common.length} chars`,
              );
            }
          }
        }
      }

      console.log(
        `  问策: turn=${qTurn ?? "-"}, agents=${qAgents.length}, ` +
        qAgents.map((m) => `[${m.name ?? "?"}] ${String(m.content ?? m.text ?? "").slice(0, 80)}...`).join("; "),
      );

      // ── 4b. 下诏 ──
      const dResp = await fetchJson(qUrl, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          text: round.decreeText,
          act: true,
        }),
      });

      check(
        `R${round.num} 下诏 HTTP`,
        dResp.status === 200,
        `status=${dResp.status}`,
      );
      const dTurn = dResp.body?.turn;
      const dState = dResp.body?.state ?? {};
      const dMessages = dResp.body?.messages ?? [];
      const dAgents = dMessages.filter((m) => m.kind === "agent");
      const dResults = dMessages.filter((m) => m.kind === "result");

      check(
        `R${round.num} 下诏 turn递增`,
        dTurn > (qTurn ?? -1),
        `qTurn=${qTurn} dTurn=${dTurn}`,
      );
      check(
        `R${round.num} 下诏有结果消息`,
        dResults.length > 0,
        `${dResults.length} result(s)`,
      );

      // record agent messages
      for (const msg of dAgents) {
        const aid = msg.from ?? msg.speaker ?? "?";
        const content = msg.content ?? msg.text ?? "";
        if (!previousAgentContents[aid]) previousAgentContents[aid] = [];
        previousAgentContents[aid].push(content);

        if (content.length < 50) {
          issue(
            `R${round.num} 下诏 对话过短 [${msg.name ?? aid}]`,
            `content length=${content.length}`,
          );
        }
        if (/```|JSON\.parse|fetch\(|axios|tool_use|tool_result/i.test(content)) {
          issue(
            `R${round.num} 下诏 疑似工具JSON泄露 [${msg.name ?? aid}]`,
            content.slice(0, 120),
          );
        }
        const prev = previousAgentContents[aid].slice(0, -1);
        for (const prevContent of prev) {
          if (prevContent.length > 80 && content.length > 80) {
            const common = findLongestCommonSubstring(prevContent, content);
            if (common.length > Math.min(prevContent.length, content.length) * 0.6) {
              issue(
                `R${round.num} 下诏 角色[${msg.name ?? aid}]可能复读`,
                `overlap=${common.length} chars`,
              );
            }
          }
        }
      }

      // record deltas
      for (const res of dResults) {
        const deltas = res.deltas ?? [];
        for (const d of deltas) {
          console.log(
            `  下诏 delta: ${d.key} ${d.by > 0 ? "+" : ""}${d.by} (${d.reason ?? ""}) [${d.source}]`,
          );
        }
        if (deltas.length === 0) {
          note(`R${round.num} 下诏 无数值变动`, `result text=${String(res.text ?? res.narrative ?? "").slice(0, 80)}`);
        }
      }

      console.log(
        `  下诏: turn=${dTurn ?? "-"}, agents=${dAgents.length}, results=${dResults.length}`,
      );

      // update trajectory
      valueTrajectory.push({ turn: dTurn ?? round.num * 2 - 1, state: { ...dState } });

      // dump full state for traceability
      console.log(
        `  状态: ${JSON.stringify(dState).slice(0, 200)}`,
      );

      // value monotony check
      if (valueTrajectory.length >= 3) {
        const keys = Object.keys(dState).filter((k) => typeof dState[k] === "number");
        for (const k of keys) {
          const vals = valueTrajectory
            .map((v) => v.state[k])
            .filter((v) => typeof v === "number");
          if (vals.length >= 3) {
            const inc = vals.every((v, i) => i === 0 || v >= vals[i - 1]);
            const dec = vals.every((v, i) => i === 0 || v <= vals[i - 1]);
            if (inc || dec) {
              note(
                `R${round.num} 数值单调${inc ? "递增" : "递减"} [${k}]`,
                `values=${vals.join("→")}`,
              );
            }
          }
        }
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 5 – Diversity check (round 3 vs round 1, round 5 vs round 1)
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n${"─".repeat(60)}`);
    console.log("【多样性检查】");

    const round1Consult =
      (initChat.filter((m) => m.kind === "agent") ?? [])
        .map((m) => ({ from: m.from ?? m.speaker, name: m.name, content: m.content ?? m.text ?? "" }))
        .filter((m) => m.content.length > 20);
    const r1Contents = round1Consult.map((m) => m.content);

    // Collect all agent messages per round from previousAgentContents
    // We need per-round agent content. Let's restructure: store per-round snapshots.
    // We'll approximate by looking at the stored contents per agent.
    // A simpler approach: re-fetch the game chat after round 1, 3, 5.
    // Actually, let's query the game state at that point for comparison.
    // For now, check per-agent variety across all messages.

    for (const [aid, contents] of Object.entries(previousAgentContents)) {
      if (contents.length < 2) continue;
      const distinct = new Set(contents.map((c) => c.trim()));
      const uniqueRatio = distinct.size / contents.length;
      check(
        `角色[${aid}] 台词多样性`,
        uniqueRatio >= 0.5,
        `${distinct.size}/${contents.length} unique (ratio=${uniqueRatio.toFixed(2)})`,
      );
      if (uniqueRatio < 0.5) {
        issue(`角色[${aid}] 台词重复率高`, `unique=${distinct.size}/total=${contents.length}`);
      }
    }

    // Re-fetch full chat to compare round-1 vs round-3 vs round-5 agent content
    const fullState = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/state`);
    const fullChat = fullState.body?.chat ?? [];
    const allAgents = fullChat.filter((m) => m.kind === "agent");

    // Map messages to rough rounds by index
    // Round 1 consult messages are indices 0..n1, round 1 decree n1..n2, etc.
    // Simpler: count total agents per round by looking at turn numbers
    const agentsByTurn = {};
    for (const m of allAgents) {
      const t = m.turn ?? "?";
      if (!agentsByTurn[t]) agentsByTurn[t] = [];
      agentsByTurn[t].push({ name: m.name, content: m.content ?? m.text ?? "" });
    }

    // For each agent, check content similarity between first appearance and later
    const agentFirstContent = {};
    const agentLaterContents = {};
    for (const m of allAgents) {
      const aid = m.from ?? m.speaker ?? m.name ?? "?";
      const content = m.content ?? m.text ?? "";
      if (!agentFirstContent[aid]) {
        agentFirstContent[aid] = content;
      } else {
        if (!agentLaterContents[aid]) agentLaterContents[aid] = [];
        agentLaterContents[aid].push(content);
      }
    }

    for (const [aid, first] of Object.entries(agentFirstContent)) {
      const later = agentLaterContents[aid] ?? [];
      if (later.length === 0) continue;
      const diverse = later.some(
        (c) => c.trim() !== first.trim() && c.length > 30 && first.length > 30,
      );
      check(
        `角色[${aid}] 首次 vs 后续不重复`,
        diverse,
        `first=${first.slice(0, 60)}..., later count=${later.length}`,
      );
      if (!diverse) {
        issue(`角色[${aid}] 始终说相同话`, `content=${first.slice(0, 100)}`);
      }
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 6 – End game
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n${"─".repeat(60)}`);
    console.log("【退朝·终局】");

    const endResp = await fetchJson(
      `http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/end`,
      { method: "POST" },
    );
    check("退朝 HTTP", endResp.status === 200, `status=${endResp.status}`);

    const ending = endResp.body?.ending ?? {};
    const endingMetrics = ending.metrics ?? endResp.body?.view?.state ?? {};
    const finalState = endResp.body?.view?.state ?? {};

    console.log(`  Verdict:   ${ending.verdict ?? "?"}`);
    console.log(`  Title:     ${ending.title ?? "?"}`);
    console.log(
      `  Narrative: ${(ending.narrative ?? "").slice(0, 200)}...`,
    );
    console.log(`  Metrics:   ${JSON.stringify(endingMetrics).slice(0, 300)}`);

    check("Verdict 合法", ["victory", "defeat", "open"].includes(ending.verdict ?? ""), `got: ${ending.verdict}`);
    check("终局叙事长度>100", (ending.narrative ?? "").length > 100, `${(ending.narrative ?? "").length} chars`);

    // value bounds check
    for (const m of metrics) {
      const v = endingMetrics[m.key] ?? finalState[m.key];
      if (typeof v !== "number") {
        issue(`终局指标越界/缺失 [${m.label}]`, `key=${m.key} value=${v}`);
      } else if (v < m.min || v > m.max) {
        issue(`终局指标越界 [${m.label}]`, `value=${v} range=[${m.min},${m.max}]`);
      }
    }

    // post-end cannot send message
    const postEnd = await fetchJson(
      `http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "再议", act: true }),
      },
    );
    check("终局后发消息 409", postEnd.status === 409, `got ${postEnd.status}`);

    // post-end GET /ending should work
    const getEnd = await fetchJson(
      `http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/ending`,
    );
    check("终局后 GET /ending", getEnd.status === 200, `got ${getEnd.status}`);

    // ═══════════════════════════════════════════════════════════════
    // STEP 7 – Value trajectory table
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n${"─".repeat(60)}`);
    console.log("【数值轨迹表】");
    const allKeys = new Set();
    for (const snap of valueTrajectory) {
      for (const k of Object.keys(snap.state)) allKeys.add(k);
    }
    const sortedKeys = [...allKeys].sort();
    const header = ["turn"].concat(sortedKeys.map((k) => k.padEnd(16))).join(" | ");
    console.log("  " + header);
    for (const snap of valueTrajectory) {
      const row = [String(snap.turn).padStart(4)];
      for (const k of sortedKeys) {
        const v = snap.state[k];
        row.push((typeof v === "number" ? v.toFixed(1).padStart(15) : String(v ?? "-").padStart(16)));
      }
      console.log("  " + row.join(" | "));
    }

    // ═══════════════════════════════════════════════════════════════
    // STEP 8 – Summary & score
    // ═══════════════════════════════════════════════════════════════
    console.log(`\n${"=".repeat(70)}`);
    const passCount = results.checks.filter((c) => c.pass).length;
    const failCount = results.checks.filter((c) => !c.pass).length;
    const issueCount = results.issues.length;
    const noteCount = results.notes.length;

    console.log(`  通过: ${passCount}  失败: ${failCount}  Bug: ${issueCount}  警告: ${noteCount}`);

    const score = Math.max(
      1,
      Math.round((passCount / Math.max(passCount + failCount + issueCount, 1)) * 10),
    );
    console.log(`  整体评分: ${score}/10`);

    if (results.issues.length > 0) {
      console.log(`\n  【Bug 列表】`);
      for (const iss of results.issues) {
        console.log(`    ❌ ${iss.label}${iss.note ? ` — ${iss.note}` : ""}`);
      }
    }
    if (results.notes.length > 0) {
      console.log(`\n  【警告】`);
      for (const nt of results.notes) {
        console.log(`    ⚠️  ${nt.label}${nt.note ? ` — ${nt.note}` : ""}`);
      }
    }

    // ── Save detailed report ──
    const reportPath = join(
      dirname(DB_PATH),
      `long-game-report-${Date.now()}.json`,
    );
    writeFileSync(
      reportPath,
      JSON.stringify(
        {
          topicId,
          gameId,
          spec: {
            title: spec.scenario?.title,
            metrics: metrics.map((m) => ({
              key: m.key,
              label: m.label,
              min: m.min,
              max: m.max,
              start: m.start,
              unit: m.unit,
            })),
            cast: cast.map((p) => ({
              id: p.id,
              name: p.name,
              role: p.role,
              stance: p.stance,
            })),
          },
          valueTrajectory,
          checks: results.checks,
          issues: results.issues,
          notes: results.notes,
          ending: {
            verdict: ending.verdict,
            title: ending.title,
            narrativeLength: (ending.narrative ?? "").length,
            metrics: endingMetrics,
          },
          agentContentSummary: Object.fromEntries(
            Object.entries(previousAgentContents).map(([k, v]) => [
              k,
              { count: v.length, samples: v.map((s) => s.slice(0, 100)) },
            ]),
          ),
        },
        null,
        2,
      ),
      "utf8",
    );
    console.log(`\n  Report saved: ${reportPath}`);

    // ══ Final console output ══
    console.log(`\n\n${"=".repeat(70)}`);
    console.log(`  FINAL SCORE: ${score}/10`);
    console.log(`  Verdict: ${ending.verdict ?? "N/A"} | Narrative: ${(ending.narrative ?? "").slice(0, 100)}...`);
    console.log(`  Issues: ${issueCount} | Checks passed: ${passCount}/${passCount + failCount}`);
    console.log(`${"=".repeat(70)}\n`);
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child?.once("exit", r));
    }
    for (const suf of ["", "-wal", "-shm"]) {
      try {
        rmSync(DB_PATH + suf, { force: true });
      } catch {
        /* ignore */
      }
    }
  }
}

// ─── utility: longest common substring ──────────────────────────────
function findLongestCommonSubstring(a, b) {
  if (!a || !b || a.length === 0 || b.length === 0) return "";
  const m = a.length,
    n = b.length;
  let best = "";
  // O(m*n) DP is fine for short strings (<500 chars)
  const dp = Array.from({ length: m + 1 }, () => new Uint16Array(n + 1));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      if (a[i - 1] === b[j - 1]) {
        dp[i][j] = dp[i - 1][j - 1] + 1;
        if (dp[i][j] > best.length) {
          best = a.substring(i - dp[i][j], i);
        }
      }
    }
  }
  return best;
}

main().catch((e) => {
  console.error("uncaught:", e);
  process.exit(1);
});
