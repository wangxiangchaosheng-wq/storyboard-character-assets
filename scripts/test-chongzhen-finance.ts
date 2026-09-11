#!/usr/bin/env node
/**
 * 崇祯户部尚书 - 完整对局测试（v2）
 * 关注：角色历史准确性、数值量纲合理性、立场对话差异、诏令效果、公式周期
 */
import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

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
const TOPIC_TEXT = "架空：崇祯年间穿越成为户部尚书，面对国库空虚与农民起义，该如何抉择？";
const DB_PATH = join("/tmp", `cz-test-${Date.now()}-${process.pid}.sqlite`);

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
    if (r.body) {
      const text = await r.text();
      if (text) body = ct.includes("json") ? JSON.parse(text) : text;
    }
    return { status: r.status, body };
  } catch (e) {
    return { status: 0, body: { error: String(e?.message ?? e) } };
  }
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)); }

// ─── 测试结果记录 ───────────────────────────────────────────────
const CHECKS = [];
function check(label, result, note = "") {
  const mark = result === true ? "✅" : result === false ? "❌" : "⚠️";
  CHECKS.push({ label, result, note });
  console.log(`  ${mark} ${label}${note ? " — " + note : ""}`);
}
function warn(label, note = "") {
  CHECKS.push({ label, result: null, note });
  console.log(`  ⚠️  ${label} — ${note}`);
}

async function main() {
  const PORT = await freePort([8788, 8789, 8790, 8791, 8792, 8793, 8794, 8795]);
  if (!PORT) { console.error("no free port"); process.exit(1); }
  let child = null;

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
    if (!up) {
      console.error("server not ready");
      console.log(bootLog.slice(0, 400));
      process.exit(1);
    }
    console.log(`\n=== 崇祯户部尚书 - 完整对局测试 ===`);
    console.log(`端口: ${PORT}\n`);

    // ── 1. 创建话题 ──
    console.log("【步骤 1】创建话题");
    const ing = await fetchJson(`http://${HOST}:${PORT}/api/topics/ingest`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "text", text: TOPIC_TEXT }),
    });
    const topicId = ing.body?.topicId;
    check("话题创建", ing.status === 202, `topicId=${topicId ?? "?"}`);

    // ── 2. 等待构建完成 ──
    console.log("\n【步骤 2】构建 Spec");
    await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/build`, { method: "POST" });
    let spec = null;
    for (let i = 0; i < 180; i++) {
      const st = await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/status`);
      if (st.body?.state === "ready" || st.body?.state === "failed") break;
      await sleep(500);
    }
    const specRes = await fetchJson(`http://${HOST}:${PORT}/api/topics/${encodeURIComponent(topicId)}/spec`);
    check("Spec 构建成功", specRes.status === 200, `状态=${specRes.body?.state ?? "?"}`);
    if (specRes.status !== 200) {
      console.error("spec 获取失败:", JSON.stringify(specRes.body).slice(0, 300));
      process.exit(1);
    }
    spec = specRes.body.spec;
    console.log(`  标题: ${spec?.title}`);
    console.log(`  背景: ${(spec?.scenario?.background ?? "").slice(0, 100)}...`);
    console.log(`  矛盾: ${(spec?.scenario?.conflict ?? "").slice(0, 100)}...`);
    console.log(`  角色: ${spec?.cast?.map(p => `${p.name}(${p.role})[${p.stance}]`).join(", ") ?? []}`);
    console.log(`  指标: ${spec?.metrics?.map(m => `${m.label}[${m.key}](${m.unit})`).join(", ") ?? []}`);

    // ── 3. 建局 ──
    console.log("\n【步骤 3】建局");
    const g = await fetchJson(`http://${HOST}:${PORT}/api/games`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specId: topicId, player: "穿越者" }),
    });
    check("建局成功", g.status === 201, `gameId=${g.body?.gameId ?? "?"}`);
    const gameId = g.body?.gameId;
    const initChat = g.body?.chat ?? [];
    const agents = initChat.filter((m) => m.kind === "agent");
    console.log(`  开场消息数: ${initChat.length}, 角色发言: ${agents.length}`);

    // 查找目标角色
    const financeAgent = agents.find((m) => /户|财|钱|粮|税|户部/.test(m.name ?? "")) ?? agents.find((m) => /尚书/.test(m.role ?? "")) ?? agents[0];
    const militaryAgent = agents.find((m) => /兵|军|将|辽东|边/.test(m.name ?? "") || /兵|军/.test(m.role ?? "")) ?? (agents.length > 1 ? agents[1] : agents[0]);
    const innerAgent = agents.find((m) => /内|司|宦|太/.test(m.name ?? "") || /太监|内务/.test(m.role ?? "")) ?? (agents.length > 2 ? agents[2] : agents[agents.length - 1]);
    const finId = financeAgent?.from;
    const milId = militaryAgent?.from;
    const innerId = innerAgent?.from;
    console.log(`  户部角色: ${financeAgent?.name ?? "?"}(${finId}) [${financeAgent?.stance}]`);
    console.log(`  兵部角色: ${militaryAgent?.name ?? "?"}(${milId}) [${militaryAgent?.stance}]`);
    console.log(`  内务角色: ${innerAgent?.name ?? "?"}(${innerId}) [${innerAgent?.stance}]`);

    const initState = g.body?.state ?? {};
    console.log(`  初始数值: ${JSON.stringify(initState)}`);

    // ── 4. 三条问策消息 ──
    console.log("\n【步骤 4】问策 ×3");

    // 4a. 问户部
    console.log("\n  --- 问户部 ---");
    const q1 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "户部大人，国库空虚民怨沸腾，有何良策？", to: finId, act: false }),
    });
    console.log(`  状态码: ${q1.status}, turn: ${q1.body?.turn}`);
    const q1Agents = q1.body?.messages?.filter((m) => m.kind === "agent") ?? [];
    console.log(`  角色回复: ${q1Agents.length} 条`);
    if (q1Agents.length > 0) {
      const content = q1Agents[0].content ?? "(无内容)";
      console.log(`  首条: [${q1Agents[0].name}] ${String(content).slice(0, 120)}...`);
    }
    check("问户部", q1.status === 200 && q1Agents.length > 0);
    check("问户部 turn=0", q1.body?.turn === 0, `got ${q1.body?.turn}`);
    check("问策不改数值", JSON.stringify(q1.body?.state ?? {}) === JSON.stringify(initState), "state 不变");

    // 4b. 问兵部
    console.log("\n  --- 问兵部 ---");
    const q2 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "兵部大人，辽东军费浩繁，边军欠饷数月，如何筹措？", to: milId, act: false }),
    });
    console.log(`  状态码: ${q2.status}, turn: ${q2.body?.turn}`);
    const q2Agents = q2.body?.messages?.filter((m) => m.kind === "agent") ?? [];
    console.log(`  角色回复: ${q2Agents.length} 条`);
    if (q2Agents.length > 0) {
      const content = q2Agents[0].content ?? "(无内容)";
      console.log(`  首条: [${q2Agents[0].name}] ${String(content).slice(0, 120)}...`);
    }
    check("问兵部", q2.status === 200 && q2Agents.length > 0);

    // 4c. 问内务
    console.log("\n  --- 问内务 ---");
    const q3 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "内务府大人，皇上欲移用内帑赈济灾民，可否？", to: innerId, act: false }),
    });
    console.log(`  状态码: ${q3.status}, turn: ${q3.body?.turn}`);
    const q3Agents = q3.body?.messages?.filter((m) => m.kind === "agent") ?? [];
    console.log(`  角色回复: ${q3Agents.length} 条`);
    if (q3Agents.length > 0) {
      const content = q3Agents[0].content ?? "(无内容)";
      console.log(`  首条: [${q3Agents[0].name}] ${String(content).slice(0, 120)}...`);
    }
    check("问内务", q3.status === 200 && q3Agents.length > 0);

    // ── 5. 两道下诏 ──
    console.log("\n【步骤 5】下诏 ×2");

    // 5a. 加税诏令
    console.log("\n  --- 下诏加税 ---");
    const dec1 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "着户部加派辽饷，于江南富庶之地加征商税，以充军饷。", act: true }),
    });
    console.log(`  状态码: ${dec1.status}, turn: ${dec1.body?.turn}`);
    const d1Result = dec1.body?.messages?.find((m) => m.kind === "result") ?? null;
    const d1Deltas = d1Result?.deltas ?? [];
    console.log(`  结算叙事: ${(d1Result?.text ?? "(无)").slice(0, 150)}...`);
    console.log(`  数值变动: ${JSON.stringify(d1Deltas)}`);
    const stateAfterDec1 = dec1.body?.state ?? {};
    console.log(`  变化后数值: ${JSON.stringify(stateAfterDec1)}`);
    check("加税诏令执行", dec1.status === 200);
    check("加税 turn=1", dec1.body?.turn === 1, `got ${dec1.body?.turn}`);
    check("加税有数值变动", d1Deltas.length > 0, `${d1Deltas.length} deltas`);

    // 5b. 赈灾诏令
    console.log("\n  --- 下诏赈灾 ---");
    const dec2 = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "着户部开仓放粮，赈济陕西、河南灾民，所费从内帑支取，不得加派。", act: true }),
    });
    console.log(`  状态码: ${dec2.status}, turn: ${dec2.body?.turn}`);
    const d2Result = dec2.body?.messages?.find((m) => m.kind === "result") ?? null;
    const d2Deltas = d2Result?.deltas ?? [];
    console.log(`  结算叙事: ${(d2Result?.text ?? "(无)").slice(0, 150)}...`);
    console.log(`  数值变动: ${JSON.stringify(d2Deltas)}`);
    const stateAfterDec2 = dec2.body?.state ?? {};
    console.log(`  变化后数值: ${JSON.stringify(stateAfterDec2)}`);
    check("赈灾诏令执行", dec2.status === 200);
    check("赈灾 turn=2", dec2.body?.turn === 2, `got ${dec2.body?.turn}`);
    check("赈灾有数值变动", d2Deltas.length > 0, `${d2Deltas.length} deltas`);

    // ── 6. 终局 ──
    console.log("\n【步骤 6】查看终局");
    const end = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/end`, { method: "POST" });
    console.log(`  状态码: ${end.status}`);
    check("终局接口", end.status === 200);
    const ending = end.body?.ending ?? {};
    console.log(`  结局: ${ending.verdict} (${ending.title})`);
    console.log(`  叙事: ${(ending.narrative ?? "").slice(0, 200)}...`);
    console.log(`  终局数值: ${JSON.stringify(ending.metrics ?? {})}`);
    check("结局 verdict 合法", ["victory", "defeat", "open"].includes(ending.verdict ?? ""), `got: ${ending.verdict}`);
    check("终局叙事长度", (ending.narrative ?? "").length > 50, `${(ending.narrative ?? "").length} chars`);

    // ── 7. 深度检查 ──
    console.log("\n【深度检查】");

    // 7a. 角色历史准确性
    const charNames = spec.cast.map((p) => p.name);
    const charRoles = spec.cast.map((p) => p.role);
    console.log(`  角色名: ${charNames.join(", ")}`);
    console.log(`  角色职: ${charRoles.join(", ")}`);

    const hasChongzhen = charNames.some((n) => /崇祯|皇帝|天子|陛下/.test(n)) ||
                          charRoles.some((r) => /皇帝|天子/.test(r));
    const hasLiZicheng = charNames.some((n) => /李自成|闯王/.test(n));
    const hasMinistryFinance = charNames.some((n) => /户部|财政|钱粮|税|户部尚书/.test(n)) ||
                                 charRoles.some((r) => /户部|财政|尚书/.test(r));
    const hasMingEra = charNames.some((n) => /崇祯|明|李自成|袁崇焕/.test(n)) ||
                       charRoles.some((r) => /明|崇祯/.test(r));
    const hasWrongEra = charNames.some((n) => /诸葛亮|费祎|杨仪|魏延|姜维|三国/.test(n));
    check("包含崇祯帝/皇帝", hasChongzhen, "");
    check("包含户部相关角色", hasMinistryFinance, "");
    check("包含明末/崇祯相关人物", hasMingEra, "");
    check("不含错误时代角色(三国等)", !hasWrongEra,
      hasWrongEra ? "检测到三国人物" : "未检测到");

    // 7b. 数值量纲（明末：岁入约200-300万两，民户约1600万）
    const metrics = spec.metrics ?? [];
    const treasury = metrics.find((m) => /岁入|国库|银两|财政/.test(m.label || m.key));
    const people = metrics.find((m) => /民户|户口|百姓|人口/.test(m.label || m.key));
    const soldiers = metrics.find((m) => /兵额|军队|将士/.test(m.label || m.key));
    const grain = metrics.find((m) => /粮储|粮仓|存粮/.test(m.label || m.key));

    console.log(`  指标详情:`);
    for (const m of metrics) {
      const startV = initState[m.key] ?? m.start;
      const curV = stateAfterDec2[m.key] ?? "-";
      console.log(`    ${m.label} key=${m.key} 初始=${startV} 终局=${curV} 范围=[${m.min}-${m.max}] unit=${m.unit ?? "?"}`);
    }

    if (treasury) {
      const startV = initState[treasury.key] ?? treasury.start;
      check("岁入量纲合理（200-300万两）",
        treasury.unit === "万两" && startV >= 100 && startV <= 500,
        `${treasury.label}: 初始=${startV}${treasury.unit ?? ""}, unit=${treasury.unit}`);
    } else {
      warn("岁入指标缺失", "未在 metrics 中找到含'岁入/国库/银'的指标");
    }

    if (people) {
      const startV = initState[people.key] ?? people.start;
      check("民户量纲合理（约1600万户）",
        people.unit === "万户" && startV >= 500 && startV <= 3000,
        `${people.label}: 初始=${startV}${people.unit ?? ""}, unit=${people.unit}`);
    } else {
      warn("民户指标缺失", "未在 metrics 中找到含'民户/户口'的指标");
    }

    if (soldiers) {
      const startV = initState[soldiers.key] ?? soldiers.start;
      check("兵额量纲合理（约80万）",
        startV >= 30 && startV <= 200,
        `${soldiers.label}: 初始=${startV}`);
    }

    if (grain) {
      const startV = initState[grain.key] ?? grain.start;
      check("粮储量纲合理（约400万石）",
        grain.unit === "万石" && startV >= 100 && startV <= 1000,
        `${grain.label}: 初始=${startV}${grain.unit ?? ""}`);
    }

    // 7c. 角色对话立场差异
    const allMessages = end.body?.view?.chat ?? [];
    const agentMsgs = allMessages.filter((m) => m.kind === "agent");
    const stanceSet = new Set(agentMsgs.map((m) => m.stance));
    console.log(`  立场集合: ${[...stanceSet].join(", ")}`);
    check("立场多样（≥2种）", stanceSet.size >= 2, `${stanceSet.size} 种`);

    // 7d. 加税对民户的负面影响
    const peopleDelta1 = d1Deltas.find((d) => /民户|户口|民心|百姓/.test(d.metric));
    const treasuryDelta1 = d1Deltas.find((d) => /岁入|国库|银|财政/.test(d.metric));
    if (peopleDelta1) {
      check("加税对民户产生负面影响", peopleDelta1.by < 0,
        `${peopleDelta1.metric}: ${peopleDelta1.by > 0 ? "+" : ""}${peopleDelta1.by}`);
    } else {
      warn("加税未明确检测民户变动", `所有deltas: ${JSON.stringify(d1Deltas)}`);
    }
    if (treasuryDelta1) {
      check("加税对岁入产生正面影响", treasuryDelta1.by > 0,
        `${treasuryDelta1.metric}: ${treasuryDelta1.by > 0 ? "+" : ""}${treasuryDelta1.by}`);
    } else {
      warn("加税未明确检测岁入变动", "");
    }

    // 7e. 赈灾对财政的压力
    const treasuryDelta2 = d2Deltas.find((d) => /岁入|国库|银|财政/.test(d.metric));
    const grainDelta2 = d2Deltas.find((d) => /粮储|粮仓/.test(d.metric));
    if (treasuryDelta2) {
      check("赈灾对财政产生压力", treasuryDelta2.by < 0,
        `${treasuryDelta2.metric}: ${treasuryDelta2.by > 0 ? "+" : ""}${treasuryDelta2.by}`);
    } else if (grainDelta2) {
      check("赈灾对粮储产生消耗", grainDelta2.by < 0,
        `${grainDelta2.metric}: ${grainDelta2.by > 0 ? "+" : ""}${grainDelta2.by}`);
    } else {
      warn("赈灾未见明显财政/粮储变动", `所有deltas: ${JSON.stringify(d2Deltas)}`);
    }

    // 7f. 公式漂移周期检查
    const rules = spec.rules ?? [];
    const driftRules = rules.filter((r) => r.kind === "drift");
    console.log(`  漂移规则数: ${driftRules.length}`);
    for (const r of driftRules) {
      const rAny = r as any;
      console.log(`    ${r.id}: ${r.label} target=${rAny.target} formula=${rAny.formula ?? "(effect)"}`);
    }
    check("存在漂移规则", driftRules.length > 0, `${driftRules.length} 条`);
    // 检查是否有不同指标使用不同漂移周期
    const formulas = driftRules.map((r) => (r as any).formula ?? "");
    const uniquePeriods = new Set(formulas.map((f) => {
      const m = f.match(/% (\d+)/);
      return m ? m[1] : "?";
    }));
    console.log(`  漂移周期分布: ${[...uniquePeriods].join(", ")}`);
    check("不同指标有不同漂移周期", uniquePeriods.size > 1 || driftRules.length <= 1,
      `周期种类=${uniquePeriods.size}`);

    // 7g. 终局数值均在合法区间
    let allInBounds = true;
    for (const m of metrics) {
      const v = stateAfterDec2[m.key];
      if (v == null || v < m.min || v > m.max) {
        console.log(`  ❌ 越界: ${m.label}=${v} [${m.min},${m.max}]`);
        allInBounds = false;
      }
    }
    check("终局数值均在合法区间", allInBounds);

    // 7h. 公式未泄露到对外接口
    const specStr = JSON.stringify(spec);
    check("spec 无 formula 泄露", !specStr.includes('"formula"'), "");

    // 7i. 终局后不能再发消息
    const postEnd = await fetchJson(`http://${HOST}:${PORT}/api/games/${encodeURIComponent(gameId)}/message`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ text: "再议", act: true }),
    });
    check("终局后发消息返回409", postEnd.status === 409, `got ${postEnd.status}`);

    // 7j. 初始数值一致性（state 的 key 与 spec.metrics[].key 对应）
    const metricKeys = new Set(metrics.map((m) => m.key));
    const stateKeys = new Set(Object.keys(initState));
    const keyMismatch = [...stateKeys].filter((k) => !metricKeys.has(k));
    if (keyMismatch.length > 0) {
      warn("初始 state key 与 spec metric key 不匹配", `extra keys: ${keyMismatch.join(", ")}`);
    } else {
      check("初始 state key 与 spec metric key 一致", true);
    }

    // 7k. 对话文本包含立场词检测
    const allAgentContent = agentMsgs.map((m) => (m.content ?? "")).join(" ");
    const hasImperialImpatience = /急|速|何故|为何|岂能|决不能|立刻|即刻|火速/.test(allAgentContent);
    const hasFinanceCaution = /缓|切勿|慎|斟酌|量入|度出|省费|节用|不可/.test(allAgentContent);
    check("对话体现急躁/稳健立场差异", hasImperialImpatience || hasFinanceCaution,
      `急躁检出=${hasImperialImpatience}, 谨慎检出=${hasFinanceCaution}`);

    // ── 汇总 ──
    console.log("\n" + "=".repeat(60));
    const passCount = CHECKS.filter((c) => c.result === true).length;
    const failCount = CHECKS.filter((c) => c.result === false).length;
    const warnCount = CHECKS.filter((c) => c.result === null).length;
    console.log(`通过: ${passCount}  失败: ${failCount}  警告: ${warnCount}  总计: ${CHECKS.length}`);

    const score = Math.round((passCount / Math.max(passCount + failCount, 1)) * 10);
    console.log(`整体评分: ${score}/10`);

    console.log("\n详细结果:");
    for (const c of CHECKS) {
      const mark = c.result === true ? "✅" : c.result === false ? "❌" : "⚠️";
      console.log(`  ${mark} ${c.label}${c.note ? " — " + c.note : ""}`);
    }
  } finally {
    if (child && child.exitCode === null) {
      child.kill();
      await new Promise((r) => child?.once("exit", r));
    }
    for (const suf of ["", "-wal", "-shm"]) {
      try { rmSync(DB_PATH + suf, { force: true }); } catch { /* ignore */ }
    }
  }
}

main().catch((e) => { console.error("uncaught:", e); process.exit(1); });
