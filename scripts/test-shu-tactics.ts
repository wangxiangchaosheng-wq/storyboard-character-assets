/**
 * 蜀国两线作战端到端测试（spawn server 模式，与 test-chat.mts 风格一致）
 * 流程：
 *   1. 启动 serve 进程
 *   2. POST /api/topics/ingest   — 创建话题
 *   3. POST /api/topics/{id}/build + 轮询 → 等待 spec 就绪
 *   4. GET  /api/topics/{id}/spec — 取出 cast
 *   5. POST /api/games            — 建局
 *   6. POST /message (act=false, to=诸葛亮) — 问策
 *   7. POST /message (act=false, to=蒋琬/费祎) — 问策
 *   8. POST /message (act=true)   — 下诏（两线作战指令）
 *   9. POST /api/games/{id}/end   — 终局
 *   10. 检查汇总
 */

import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { existsSync, readFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");

// ── 工具函数 ────────────────────────────────────────────────────────────────────
const HOST = "127.0.0.1";
let failures = 0;
const fail = (msg: string) => { failures += 1; console.error("  ✗ " + msg); };
const step = (msg: string) => console.log("  ✓ " + msg);
const section = (msg: string) => console.log("\n" + "═".repeat(50) + "\n" + msg + "\n" + "═".repeat(50));
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function fj(u: string, opts: { method?: string; body?: unknown } = {}) {
  try {
    const r = await fetch(u, {
      method: opts.method ?? "GET",
      headers: { "Content-Type": "application/json" },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
    let body: unknown = {};
    const text = await r.text();
    if (text && r.headers.get("content-type")?.includes("json")) { try { body = JSON.parse(text); } catch { body = text; } }
    return { status: r.status, body };
  } catch (e) { return { status: 0, body: { err: String(e?.message ?? e) } }; }
}

function freePort(cands: number[]): Promise<number | null> {
  return new Promise((res) => {
    let i = 0;
    const tryNext = () => {
      if (i >= cands.length) return res(null);
      const port = cands[i++];
      const srv = createServer();
      srv.once("error", () => { srv.close(); tryNext(); });
      srv.listen(port, HOST, () => {
        const a = srv.address();
        srv.close(() => res(typeof a === "object" && a ? a.port : null));
      });
    };
    tryNext();
  });
}

// ── 加载 .env ────────────────────────────────────────────────────────────────────
if (existsSync(resolve(process.cwd(), ".env"))) {
  for (const line of readFileSync(resolve(process.cwd(), ".env"), "utf8").split("\n")) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith("#")) continue;
    const eq = trimmed.indexOf("=");
    if (eq > 0) {
      const key = trimmed.slice(0, eq).trim();
      const val = trimmed.slice(eq + 1).trim().replace(/^['"]|['"]$/g, "");
      if (!(key in process.env)) process.env[key] = val;
    }
  }
}
console.log("AGNES_API_KEY set: " + !!process.env.AGNES_API_KEY);

// ── 主流程 ──────────────────────────────────────────────────────────────────────
async function main() {
  console.log("═".repeat(60));
  console.log("蜀国两线作战 · 端到端测试");
  console.log("═".repeat(60));

  const TOPIC_TEXT = "架空：蜀国同时攻打魏国和吴国，诸葛亮会怎么选择？";
  const DECREE_TEXT = "朕意已决：命魏延出子午谷直取长安，亮亲率大军北伐，同时派马岱袭取东吴荆州，两路并进，务必一举拿下！";

  // ── 启动 serve 进程 ──────────────────────────────────────────────────────────
  const PORT = await freePort([8800, 8801, 8802, 8803, 8804]);
  if (!PORT) { console.error("no free port"); process.exit(1); }
  console.log("server port: " + PORT);

  let child = null;
  let bootLog = "";
  try {
    child = spawn(process.execPath, ["--experimental-strip-types", "packages/serve/src/index.ts"], {
      cwd: ROOT,
      env: { ...process.env, PORT: String(PORT) },
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    child.stdout.on("data", (d) => (bootLog += d));
    child.stderr.on("data", (d) => (bootLog += d));

    // 等待健康检查
    let up = false;
    for (let i = 0; i < 30; i++) {
      const r = await fj("http://" + HOST + ":" + PORT + "/healthz").catch(() => ({ status: 0 }));
      if (r.status === 200) { up = true; break; }
      await sleep(400);
    }
    if (!up) { fail("serve not ready in 15s\n" + bootLog.slice(0, 400)); return; }
    step("serve up on port " + PORT);

    const BASE = "http://" + HOST + ":" + PORT;

    // ── ① 建话题 ──────────────────────────────────────────────────────────────
    section("① 创建话题");
    const ing = await fj(BASE + "/api/topics/ingest", {
      method: "POST",
      body: { kind: "text", text: TOPIC_TEXT },
    });
    if (ing.status !== 202 || !ing.body?.topicId) {
      fail("ingest 失败: " + ing.status + " " + JSON.stringify(ing.body).slice(0, 200));
      return;
    }
    const topicId = ing.body.topicId as string;
    step("topicId=" + topicId);

    // ── ② 构建 spec ──────────────────────────────────────────────────────────────
    section("② 构建话题 spec");
    const bld = await fj(BASE + "/api/topics/" + encodeURIComponent(topicId) + "/build", { method: "POST", body: {} });
    console.log("  build 状态: " + bld.status + " " + JSON.stringify(bld.body).slice(0, 200));
    if (bld.status !== 202 && bld.status !== 409) {
      fail("build 非 202/409: " + bld.status);
      return;
    }
    step("build 提交成功");

    // 轮询直到 ready/failed
    let state = "idle";
    for (let i = 0; i < 300; i++) {
      const st = await fj(BASE + "/api/topics/" + encodeURIComponent(topicId) + "/status");
      state = String((st.body as any)?.state ?? "idle");
      if (i % 20 === 19) console.log("  [" + (i + 1) + "] state=" + state);
      if (state === "ready" || state === "failed") break;
      await sleep(500);
    }
    console.log("  最终 state=" + state);
    if (state !== "ready") {
      fail("话题构建未就绪（state=" + state + "）");
      return;
    }
    step("话题构建完成");

    // ── ③ 获取 spec（含 cast） ───────────────────────────────────────────────────
    section("③ 获取 spec");
    const spRes = await fj(BASE + "/api/topics/" + encodeURIComponent(topicId) + "/spec");
    if (spRes.status !== 200) {
      fail("spec 拉取失败: " + spRes.status + " " + JSON.stringify(spRes.body).slice(0, 300));
      return;
    }
    const spec = (spRes.body as any).spec;
    const metrics = spec?.metrics ?? [];
    const cast = spec?.cast ?? [];
    const scenario = spec?.scenario ?? {};

    step("metrics=" + metrics.length + " cast=" + cast.length + " domain=" + spec?.domain);
    console.log("  title: " + (spec?.title ?? "?"));
    console.log("  background: " + String(scenario?.background ?? "").slice(0, 100));
    console.log("  conflict: " + String(scenario?.conflict ?? "").slice(0, 100));
    console.log("  decisionPoint: " + String(scenario?.decisionPoint ?? ""));
    console.log("  cast:");
    for (const p of cast) {
      console.log("    id=" + p.id + " name=[" + p.name + "] role=[" + p.role + "] stance=" + p.stance + " influence=" + p.influence);
    }
    console.log("  metrics:");
    for (const m of metrics) {
      console.log("    key=" + m.key + " label=" + m.label + " start=" + m.start + " min=" + m.min + " max=" + m.max);
    }

    // ── ④ 建局 ────────────────────────────────────────────────────────────────────
    section("④ 建局");
    const gRes = await fj(BASE + "/api/games", {
      method: "POST",
      body: { specId: topicId, player: "先主遗诏托孤者" },
    });
    if (gRes.status !== 201) {
      fail("建局失败: " + gRes.status + " " + JSON.stringify(gRes.body).slice(0, 300));
      return;
    }
    const gameId = gRes.body.gameId;
    step("gameId=" + gameId + " turn=" + gRes.body.turn + " status=" + gRes.body.status);
    console.log("  initial state: " + JSON.stringify(gRes.body.state));
    console.log("  chat count: " + (gRes.body.chat?.length ?? 0));
    const initState = gRes.body.state;

    // ── ⑤ 找诸葛亮、蒋琬/费祎的 id ──────────────────────────────────────────────
    const zhugeId = cast.find((p: any) => /诸葛亮|孔明/.test(p.name))?.id;
    const jiangwanId = cast.find((p: any) => /蒋琬/.test(p.name))?.id;
    const feiyiId = cast.find((p: any) => /费祎/.test(p.name))?.id;
    console.log("  zhugeId=" + zhugeId + " jiangwanId=" + jiangwanId + " feiyiId=" + feiyiId);

    // ── ⑥ 问策：诸葛亮 ────────────────────────────────────────────────────────────
    section("⑥ 问策·诸葛亮");
    const consult1 = await fj(
      BASE + "/api/games/" + encodeURIComponent(gameId) + "/message",
      {
        method: "POST",
        body: {
          text: "相父，今两线并进，魏吴夹击，亮意欲何如？",
          to: zhugeId,
          act: false,
        },
      },
    );
    if (consult1.status !== 200) {
      fail("问诸葛亮失败: " + consult1.status + " " + JSON.stringify(consult1.body).slice(0, 300));
    } else {
      step("turn=" + consult1.body.turn);
      const msgs = consult1.body.messages ?? [];
      console.log("  新增消息数: " + msgs.length);
      for (const m of msgs) {
        const preview = String(m.text).replace(/\n/g, " ").slice(0, 120);
        console.log("    [" + m.kind + "] name=[" + (m.name ?? "-") + "] stance=[" + (m.stance ?? "-") + "]  " + preview);
      }
    }

    // ── ⑦ 问策：蒋琬/费祎 ─────────────────────────────────────────────────────────
    section("⑦ 问策·蒋琬/费祎");
    const targetId = jiangwanId ?? feiyiId;
    const consult2 = await fj(
      BASE + "/api/games/" + encodeURIComponent(gameId) + "/message",
      {
        method: "POST",
        body: {
          text: "如今两线开战，粮草军需恐难支撑，公以为如何？",
          to: targetId,
          act: false,
        },
      },
    );
    if (consult2.status !== 200) {
      fail("问蒋琬/费祎失败: " + consult2.status + " " + JSON.stringify(consult2.body).slice(0, 300));
    } else {
      step("turn=" + consult2.body.turn);
      const msgs = consult2.body.messages ?? [];
      console.log("  新增消息数: " + msgs.length);
      for (const m of msgs) {
        const preview = String(m.text).replace(/\n/g, " ").slice(0, 120);
        console.log("    [" + m.kind + "] name=[" + (m.name ?? "-") + "] stance=[" + (m.stance ?? "-") + "]  " + preview);
      }
    }

    // ── ⑧ 下诏：两线作战 ──────────────────────────────────────────────────────────
    section("⑧ 下诏·两线作战");
    const decree = await fj(
      BASE + "/api/games/" + encodeURIComponent(gameId) + "/message",
      {
        method: "POST",
        body: { text: DECREE_TEXT, act: true },
      },
    );
    if (decree.status !== 200) {
      fail("下诏失败: " + decree.status + " " + JSON.stringify(decree.body).slice(0, 300));
    } else {
      step("turn=" + decree.body.turn);
      const msgs = decree.body.messages ?? [];
      console.log("  新增消息数: " + msgs.length);
      console.log("  state after decree: " + JSON.stringify(decree.body.state));
      for (const m of msgs) {
        const preview = String(m.text).replace(/\n/g, " ").slice(0, 120);
        console.log("    [" + m.kind + "] name=[" + (m.name ?? "-") + "] stance=[" + (m.stance ?? "-") + "]  " + preview);
        if ((m as any).deltas?.length) {
          console.log("      deltas: " + JSON.stringify((m as any).deltas));
        }
      }
    }

    // ── ⑨ 终局 ────────────────────────────────────────────────────────────────────
    section("⑨ 终局");
    const end = await fj(
      BASE + "/api/games/" + encodeURIComponent(gameId) + "/end",
      { method: "POST", body: {} },
    );
    if (end.status !== 200) {
      fail("终局失败: " + end.status + " " + JSON.stringify(end.body).slice(0, 300));
    } else {
      const ending = end.body.ending as any;
      step("verdict=" + ending?.verdict);
      console.log("  narrative: " + String(ending?.narrative ?? "").slice(0, 300));
      console.log("  final metrics: " + JSON.stringify(ending?.metrics ?? {}));
    }

    // ── ⑩ 最终状态核查 ────────────────────────────────────────────────────────────
    section("⑩ 最终状态");
    const finalState = await fj(BASE + "/api/games/" + encodeURIComponent(gameId) + "/state");
    if (finalState.status === 200) {
      const s = finalState.body as any;
      step("status=" + s.status + " turn=" + s.turn);
      console.log("  metrics 检查:");
      for (const m of s.metrics ?? []) {
        const v = s.state?.[m.key];
        const inRange = typeof v === "number" && v >= m.min && v <= m.max;
        console.log("    " + m.label + "=" + v + " range=[" + m.min + "-" + m.max + "]" + (inRange ? "" : " 超出范围!"));
      }
    }

    // ── 全链检查 ──────────────────────────────────────────────────────────────────
    section("⑪ 全链检查汇总");
    const zhugeMsg = decree.body.messages?.find((m: any) => m.kind === "event" && m.name === "史官" && m.text?.includes("可行性"));
    if (zhugeMsg) {
      step("可行性警示出现: " + String(zhugeMsg.text).slice(0, 80));
    } else {
      // 可能在前面的消息里
      const allMsgs = (decree.body.messages ?? []);
      const anyFeas = allMsgs.find((m: any) => m.kind === "event" && m.name === "史官" && m.text?.includes("可行性"));
      if (anyFeas) step("可行性警示出现在下诏响应中: " + String(anyFeas.text).slice(0, 80));
      else fail("下诏响应中未发现「可行性警示」");
    }

    const verdict = (end.body.ending as any)?.verdict;
    if (["victory", "defeat", "open"].includes(verdict ?? "")) step("verdict 合法: " + verdict);
    else fail("verdict 非法: " + verdict);

    // 检查角色 role 字段
    let roleOk = true;
    for (const p of cast) {
      const r = String(p.role ?? "");
      if (r.length < 2 || /[,，。！？]/.test(r)) {
        console.log("  ⚠ role 字段可能不合理: name=" + p.name + " role=[" + r + "]");
        roleOk = false;
      }
    }
    if (roleOk) step("所有角色 role 字段格式正常");

    // 检查数值量纲（蜀汉兵额应在 10 万级别，即 10-30 范围内）
    const milKey = metrics.find((m: any) => /兵额|兵力|军队/.test(m.label))?.key;
    if (milKey) {
      const milStart = initState[milKey] ?? 0;
      const milFinal = finalState.body?.state?.[milKey] ?? milStart;
      if (milStart < 5 || milStart > 50) {
        console.log("  ⚠ 初始兵额 " + milStart + " 偏离历史合理范围（预期 10-30 万）");
      } else {
        step("兵额初始值 " + milStart + " 在合理范围内");
      }
    }

  } finally {
    if (child && child.exitCode === null) { child.kill(); await new Promise((r) => child?.once("exit", r)); }
  }

  console.log("\n" + "═".repeat(60));
  console.log("测试完成，failures=" + failures);
  if (failures > 0) process.exit(1);
}

main().catch((e) => { console.error("uncaught:", e); process.exit(1); });
