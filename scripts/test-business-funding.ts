/**
 * 商业/融资类话题测试脚本
 * 测试：A轮融资AI创业公司对赌协议场景
 *
 * 检查项：
 *   1. 指标是否为商业相关（估值/现金流/市占率/团队规模），而非历史科目
 *   2. 数值是否在合理范围（现金流以月为单位，估值以亿为单位）
 *   3. 对话是否体现商业角色差异（CFO保守 vs 投资人激进）
 *   4. 对赌协议接受 vs 拒绝是否对现金流和估值产生相反方向影响
 *   5. 终局判定是否合理
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";
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

const H = "127.0.0.1";
let N = 0;
const F = (m: string) => { N++; console.error("  FAIL: " + m); };
const S = (m: string) => console.log("  OK:   " + m);
const sec = (m: string) => console.log("\n=== " + m + " ===");
function sl(ms: number) { return new Promise((r) => setTimeout(r, ms)); }
async function fj(u: string, o?: RequestInit) {
  try { const r = await fetch(u, o); const t = await r.text(); let b = {};
    if (t && r.headers.get("content-type")?.includes("json")) try { b = JSON.parse(t); } catch {}
    return { status: r.status, body: b };
  } catch (e) { return { status: 0, body: { err: String((e as Error)?.message ?? e) } }; }
}
function fp(cs: number[]) { return new Promise<number | null>((res) => {
  let i = 0;
  const nx = () => {
    if (i >= cs.length) return res(null);
    const p = cs[i++];
    const s = createServer();
    s.once("error", () => { s.close(); nx(); });
    s.listen(p, H, () => { const a = s.address(); s.close(() => res(typeof a === "object" && a ? a.port : null)); });
  };
  nx();
}); }

// 话题原文
const TK = "架空：一家A轮融资的AI创业公司，创始人面临对赌协议压力，该如何选择？";
// 话题 ID（与 topics.ts 一致：文本前 16 字 + txt: 前缀）
const TOPIC_ID = "txt:" + TK.slice(0, 16);

// 收集检查项结果
const checks: Array<{ label: string; pass: boolean; detail?: string }> = [];
const addCheck = (label: string, pass: boolean, detail?: string) => checks.push({ label, pass, detail });

// 记录关键指标原始值
let initialMetrics: Record<string, number> = {};
let acceptMetrics: Record<string, number> = {};
let rejectMetrics: Record<string, number> = {};
let finalMetrics: Record<string, number> = {};

async function main() {
  const db = join(tmpdir(), "biz-" + Date.now() + ".sqlite");
  const P = await fp([9900, 9901, 9902, 9903, 9904, 9905]);
  if (!P) { console.error("no port available"); process.exit(1); }
  console.log("port: " + P);

  let ch: ReturnType<typeof spawn> | null = null;
  let log = "";
  let spec = null;
  let gameId: string | null = null;
  let st0: Record<string, number> = {};

  try {
    // 启动服务进程
    ch = spawn(process.execPath, ["--experimental-strip-types", "packages/serve/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(P), DB_PATH: db },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    ch.stdout.on("data", (d) => (log += d));
    ch.stderr.on("data", (d) => (log += d));

    // 等待服务就绪
    sec("1. start server");
    let up = false;
    for (let i = 0; i < 30; i++) {
      const r = await fj("http://" + H + ":" + P + "/healthz").catch(() => ({ status: 0 }));
      if (r.status === 200) { up = true; break; }
      await sl(400);
    }
    if (!up) { F("server failed to start"); return; }
    S("server up port " + P);

    // ---- Step 1: 创建话题 ----
    sec("2. create topic");
    const ir = await fj("http://" + H + ":" + P + "/api/topics/ingest", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ kind: "text", text: TK }),
    });
    const tid = ir.body?.topicId as string | undefined;
    if (!tid || ir.status !== 202) { F("ingest: " + JSON.stringify(ir)); return; }
    S("topicId=" + tid);
    console.log("");

    // ---- Step 2: 等待构建完成 ----
    sec("3. build spec");
    await fj("http://" + H + ":" + P + "/api/topics/" + encodeURIComponent(tid) + "/build", { method: "POST" });
    for (let i = 0; i < 240; i++) { // 240 * 500ms = 120s max wait for real LLM spec build
      const r = await fj("http://" + H + ":" + P + "/api/topics/" + encodeURIComponent(tid) + "/spec");
      if (r.status === 200 && r.body?.spec) { spec = r.body.spec; break; }
      await sl(500);
    }
    if (!spec) { F("spec timeout"); return; }
    S("spec loaded: metrics=" + (spec.metrics?.length ?? 0) + " rules=" + (spec.rules?.length ?? 0) + " cast=" + (spec.cast?.length ?? 0));
    console.log("  title: " + (spec.title ?? "?"));
    console.log("  domain: " + spec.domain);
    console.log("  cast: " + (spec.cast?.map(p => p.id + "(" + p.name + ":" + p.role + "/" + p.stance + ")").join(" | ") ?? "none"));
    for (const m of spec.metrics ?? []) {
      console.log("  metric: " + m.key + " label=[" + m.label + "] unit=[" + (m.unit ?? "-") + "] range=[" + m.min + "," + m.max + "] start=" + m.start + " higher=" + m.higherIsBetter);
    }
    if (JSON.stringify(spec).includes('"formula"')) F("formula leak in spec"); else S("no formula leak");
    if (!Array.isArray(spec.formulaAudit)) F("missing formulaAudit"); else S("formulaAudit OK (" + spec.formulaAudit.length + " entries)");
    console.log("");

    // ---- Step 3: 建局 ----
    sec("4. create game");
    const gr = await fj("http://" + H + ":" + P + "/api/games", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ specId: tid, player: "founder" }),
    });
    gameId = gr.body?.gameId as string | undefined;
    if (gr.status === 201 && gameId) {
      S("gameId=" + gameId);
      st0 = gr.body?.state as Record<string, number> ?? {};
      Object.assign(initialMetrics, st0);
      console.log("  initial state: " + JSON.stringify(st0));
    } else {
      F("create game failed: " + gr.status + " " + JSON.stringify(gr.body));
      console.log("");
      return;
    }

    // ---- Step 4: 发问策消息（问CFO关于现金流） ----
    sec("5. consult CFO about cash flow");
    // 先找CFO角色id
    const cfo = spec.cast?.find(p => /cfo|财务| CFO/i.test(p.role + " " + p.name));
    const cfoId = cfo?.id ?? spec.cast?.[1]?.id; // 通常第二个角色是CFO
    console.log("  targeting CFO: " + (cfoId ?? "none"));
    const consult1 = await fj(
      "http://" + H + ":" + P + "/api/games/" + gameId + "/message",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "目前公司现金流还能撑几个月？请帮我做个测算", act: false, to: cfoId }),
      });
    if (consult1.status === 200) {
      S("consult1 (CFO cash flow) ok");
      const replies1 = (consult1.body?.messages ?? []) as Array<{ kind: string; text: string; name?: string; stance?: string }>;
      console.log("  replies: " + replies1.map(r => "[" + (r.name ?? r.kind) + "] " + r.text.slice(0, 80)).join(" | "));
    } else F("consult1: " + consult1.status);
    console.log("");

    // ---- Step 5: 发问策消息（问投资人关于估值） ----
    sec("6. consult investor about valuation");
    const investor = spec.cast?.find(p => /投资|investor|股东/i.test(p.role + " " + p.name + " " + (p.stance ?? "")));
    const investorId = investor?.id ?? spec.cast?.[0]?.id;
    console.log("  targeting investor: " + (investorId ?? "none"));
    const consult2 = await fj(
      "http://" + H + ":" + P + "/api/games/" + gameId + "/message",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "现在市场对我们估值的看法如何？下一轮大概什么水平", act: false, to: investorId }),
      });
    if (consult2.status === 200) {
      S("consult2 (investor valuation) ok");
      const replies2 = (consult2.body?.messages ?? []) as Array<{ kind: string; text: string; name?: string; stance?: string }>;
      console.log("  replies: " + replies2.map(r => "[" + (r.name ?? r.kind) + "] " + r.text.slice(0, 80)).join(" | "));
    } else F("consult2: " + consult2.status);
    console.log("");

    // ---- Step 6: 下诏（接受对赌协议） ----
    sec("7. decree: accept 对赌协议");
    const acceptDecree = await fj(
      "http://" + H + ":" + P + "/api/games/" + gameId + "/message",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "接受对赌协议，估值六亿，业绩增长百分之五十，三年后达标解锁额外股权", act: true }),
      });
    if (acceptDecree.status === 200) {
      S("accept decree ok, turn=" + acceptDecree.body?.turn);
      acceptMetrics = acceptDecree.body?.state ?? {};
      const reps = (acceptDecree.body?.messages ?? []) as Array<{ kind: string; text: string; name?: string; stance?: string; deltas?: Array<{ metric: string; by: number; why: string[] }> }>;
      console.log("  messages: " + reps.map(r => {
        const d = r.deltas?.map(d => d.metric + (d.by >= 0 ? "+" : "") + d.by).join(",") ?? "";
        return "[" + (r.name ?? r.kind) + "] " + r.text.slice(0, 60) + (d ? " deltas:" + d : "");
      }).join(" | "));
      console.log("  state after accept: " + JSON.stringify(acceptMetrics));
    } else F("accept decree: " + acceptDecree.status);
    console.log("");

    // ---- Step 7: 下诏（拒绝对赌，寻求其他融资） ----
    sec("8. decree: reject 对赌协议, seek other financing");
    // 注意：两个诏令在同局中顺序执行，第二次诏令的输入状态是第一次诏令后的状态
    // 为了对比"相反方向影响"，需要看两次诏令产生的 deltas 是否方向相反
    const rejectDecree = await fj(
      "http://" + H + ":" + P + "/api/games/" + gameId + "/message",
      { method: "POST", headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ text: "拒绝对赌协议，寻求战略投资或债务融资等其他方式", act: true }),
      });
    if (rejectDecree.status === 200) {
      S("reject decree ok, turn=" + rejectDecree.body?.turn);
      rejectMetrics = rejectDecree.body?.state ?? {};
      const reps = (rejectDecree.body?.messages ?? []) as Array<{ kind: string; text: string; name?: string; stance?: string; deltas?: Array<{ metric: string; by: number; why: string[] }> }>;
      console.log("  messages: " + reps.map(r => {
        const d = r.deltas?.map(d => d.metric + (d.by >= 0 ? "+" : "") + d.by).join(",") ?? "";
        return "[" + (r.name ?? r.kind) + "] " + r.text.slice(0, 60) + (d ? " deltas:" + d : "");
      }).join(" | "));
      console.log("  state after reject: " + JSON.stringify(rejectMetrics));
    } else F("reject decree: " + rejectDecree.status);
    console.log("");

    // ---- Step 8: 查看终局 ----
    sec("9. end session & view ending");
    const endR = await fj("http://" + H + ":" + P + "/api/games/" + gameId + "/end", { method: "POST" });
    if (endR.status === 200) {
      S("session ended");
      const en = endR.body?.ending as { verdict: string; narrative: string; metrics: Record<string, number> } | undefined;
      finalMetrics = en?.metrics ?? rejectMetrics;
      console.log("  verdict: " + en?.verdict);
      console.log("  narrative: " + String(en?.narrative ?? "").slice(0, 120));
      console.log("  final metrics: " + JSON.stringify(en?.metrics));
    } else F("end: " + endR.status + " " + JSON.stringify(endR.body));
    console.log("");

    // =============================================
    //  质量检查
    // =============================================
    sec("10. quality checks");

    // ---- Q1: 指标是否为商业相关 ----
    const allLabels = (spec.metrics ?? []).map(m => (m.label ?? m.key) + (m.unit ? " " + m.unit : "")).join(" | ");
    const bizKeywords = /估值|现金流|现金|跑道|融资|市占|营收|利润|团队|人才/i;
    const hasBiz = bizKeywords.test(allLabels);
    // 排除纯历史关键词
    const histKeywords = /民心|赋税|兵额|粮草|官职|爵位|田亩|户口/i;
    const hasHist = histKeywords.test(allLabels);
    if (hasBiz && !hasHist) {
      addCheck("指标为商业相关", true, allLabels);
    } else if (!hasBiz) {
      addCheck("指标为商业相关", false, "缺少商业关键词，当前指标: " + allLabels);
    } else {
      addCheck("指标为商业相关", false, "混入历史科目指标: " + allLabels);
    }
    console.log("  [Q1] 指标是否为商业相关: " + (hasBiz && !hasHist ? "✅" : "❌") + "  " + allLabels);

    // ---- Q2: 数值是否在合理范围 ----
    // 现金流 runway 应以月为单位（一般 6-24 个月）
    // 估值应以亿为单位（一般 1-20 亿）
    const runwayKey = (spec.metrics ?? []).find(m => /runway|现金流|现金|月/i.test(m.label ?? m.key))?.key;
    const valKey = (spec.metrics ?? []).find(m => /估值|valuation/i.test(m.label ?? m.key))?.key;
    if (runwayKey && initialMetrics[runwayKey] != null) {
      const rv = initialMetrics[runwayKey];
      const ok = rv >= 3 && rv <= 36; // 3-36个月合理
      addCheck("现金流合理范围(3-36月)", ok, runwayKey + ": " + rv);
      console.log("  [Q2] 现金流合理: " + (ok ? "✅" : "⚠️") + "  " + runwayKey + " = " + rv);
    }
    if (valKey && initialMetrics[valKey] != null) {
      const vv = initialMetrics[valKey];
      const ok = vv >= 0.5 && vv <= 100; // 0.5-100亿合理
      addCheck("估值合理范围(0.5-100亿)", ok, valKey + ": " + vv);
      console.log("  [Q2] 估值合理: " + (ok ? "✅" : "⚠️") + "  " + valKey + " = " + vv);
    }

    // ---- Q3: 对话是否体现角色差异 ----
    // 比较两次问策回复的语气：CFO应偏保守谨慎，投资人应偏激进乐观
    const consult1Text = (consult1.body?.messages ?? [])
      .filter((m: any) => m.kind === "agent" && m.from !== "player")
      .map((m: any) => (m.text ?? "").toLowerCase())
      .join(" ");
    const consult2Text = (consult2.body?.messages ?? [])
      .filter((m: any) => m.kind === "agent" && m.from !== "player")
      .map((m: any) => (m.text ?? "").toLowerCase())
      .join(" ");
    const conservativeWords = /谨慎|风险|小心|不足|困难|压力|担忧|挑战|保守/i;
    const aggressiveWords = /看好|乐观|增长|潜力|机会|进取|扩张|冲刺|激进/i;
    const c1Cons = conservativeWords.test(consult1Text);
    const c2Agg = aggressiveWords.test(consult2Text);
    addCheck("角色对话体现商业立场差异", c1Cons || c2Agg,
      "CFO回复含保守词:" + c1Cons + " | 投资人回复含激进词:" + c2Agg);
    console.log("  [Q3] 角色立场差异: " + (c1Cons || c2Agg ? "✅" : "⚠️") +
      "  CFO保守=" + c1Cons + " 投资人激进=" + c2Agg);

    // ---- Q4: 对赌协议接受 vs 拒绝 是否产生相反方向的影响 ----
    // 接受对赌：估值↑，但现金流可能↓（对赌压力下需加速花钱冲业绩）或↑（拿投资款）
    // 拒绝对赌：估值↓，现金流可能↑（避免高压投入）
    // 核心检验：acceptMetrics 与 rejectMetrics 在同一指标上是否有反向变化趋势
    const metricKeys = Object.keys(initialMetrics);
    let oppositePairs = 0;
    let totalPairs = 0;
    for (const k of metricKeys) {
      const av = acceptMetrics[k] ?? 0;
      const rv = rejectMetrics[k] ?? 0;
      const iv = initialMetrics[k] ?? 0;
      const deltaAccept = av - iv;
      const deltaReject = rv - iv;
      if (deltaAccept !== 0 && deltaReject !== 0) {
        totalPairs++;
        // 相反方向：一个正一个负
        if ((deltaAccept > 0 && deltaReject < 0) || (deltaAccept < 0 && deltaReject > 0)) {
          oppositePairs++;
        }
      }
    }
    const oppositeRatio = totalPairs > 0 ? oppositePairs / totalPairs : 0;
    const hasOpposite = oppositePairs >= 1;
    addCheck("对赌接受vs拒绝产生反向影响", hasOpposite,
      "反向比例: " + oppositePairs + "/" + totalPairs + " (" + Math.round(oppositeRatio * 100) + "%)");
    console.log("  [Q4] 反向影响: " + (hasOpposite ? "✅" : "❌") +
      "  accept deltas vs reject deltas: 反向" + oppositePairs + "/" + totalPairs);
    for (const k of metricKeys) {
      const dv = (acceptMetrics[k] ?? 0) - (initialMetrics[k] ?? 0);
      const dr = (rejectMetrics[k] ?? 0) - (initialMetrics[k] ?? 0);
      console.log("    " + k + ": accept=" + (dv >= 0 ? "+" : "") + dv + "  reject=" + (dr >= 0 ? "+" : "") + dr);
    }

    // ---- Q5: 终局判定是否合理 ----
    if (endR.status === 200) {
      const verdict = endR.body?.ending?.verdict as string | undefined;
      const valid = ["victory", "defeat", "open"].includes(verdict ?? "");
      addCheck("终局判定合理", valid, "verdict=" + verdict);
      console.log("  [Q5] 终局判定: " + (valid ? "✅" : "❌") + "  verdict=" + verdict);
      // 进一步：看终局叙事是否提到了商业关键词
      const narrative = String(endR.body?.ending?.narrative ?? "");
      const narrativeBiz = /估值|现金流|融资|对赌|股权|业绩/i.test(narrative);
      if (narrativeBiz) {
        addCheck("终局叙事含商业关键词", true, narrative.slice(0, 80));
      } else {
        addCheck("终局叙事含商业关键词", false, narrative.slice(0, 80));
      }
      console.log("  [Q5] 终局叙事商业相关: " + (narrativeBiz ? "✅" : "⚠️"));
    }

    // ---- 汇总 ----
    sec("11. summary");
    const passCount = checks.filter(c => c.pass).length;
    const failCount = checks.filter(c => !c.pass).length;
    console.log("  通过: " + passCount + "  失败: " + failCount);
    for (const c of checks) {
      console.log("    " + (c.pass ? "✅" : "❌") + " " + c.label + (c.detail ? "  [" + c.detail + "]" : ""));
    }

    console.log("\n" + "=".repeat(60));
    // 计算综合评分（每项2分，共10分）
    const score = Math.round(passCount / checks.length * 10);
    console.log("整体评分: " + score + "/10");
    if (N === 0 && failCount === 0) {
      console.log("ALL PASSED (全链通过)");
    } else {
      console.error(N + " critical failure(s), " + failCount + " quality check(s) failed");
      process.exit(1);
    }

  } finally {
    if (ch && ch.exitCode === null) { ch.kill(); await new Promise((r) => ch?.once("exit", r)); }
    for (const sf of ["", "-wal", "-shm"]) {
      try { rmSync(db + sf, { force: true }); } catch {}
    }
  }
}

await main();
