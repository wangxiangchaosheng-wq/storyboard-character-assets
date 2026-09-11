import { spawn } from "node:child_process";
import { createServer } from "node:net";
import { rmSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { tmpdir } from "node:os";;
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
const H = "127.0.0.1";
let N = 0; const F = (m) => { N++; console.error("  FAIL: " + m); };
const S = (m) => console.log("  OK:   " + m);
const sec = (m) => console.log("\n=== " + m + " ===");
function sl(ms) { return new Promise((r) => setTimeout(r, ms)); }
async function fj(u, o) {
  try { const r = await fetch(u, o); const t = await r.text(); let b = {}; if (t && r.headers.get("content-type")?.includes("json")) try { b = JSON.parse(t); } catch {} return { status: r.status, body: b }; }
  catch (e) { return { status: 0, body: { err: String(e?.message ?? e) } }; }
}
function fp(cs) { return new Promise((res) => { let i = 0; const nx = () => { if (i >= cs.length) return res(null); const p = cs[i++]; const s = createServer(); s.once("error", () => { s.close(); nx(); }); s.listen(p, H, () => { const a = s.address(); s.close(() => res(typeof a === "object" && a ? a.port : null)); }); }; nx(); }); }
const TK = "架空：一家A轮融资的AI创业公司，创始人面临对赌协议压力，该如何选择？";
async function main() {
  const db = join(tmpdir(), "biz-" + Date.now() + ".sqlite");
  const P = await fp([9900, 9901, 9902, 9903, 9904, 9905]);
  if (!P) { console.error("no port"); process.exit(1); }
  console.log("port: " + P);
  let ch = null, log = "", sp = null, gid = null;
  let st0 = {}, st2 = {};
  try {
    ch = spawn(process.execPath, ["--experimental-strip-types", "packages/serve/src/index.ts"], {
      cwd: ROOT, env: { ...process.env, PORT: String(P), DB_PATH: db },
      stdio: ["ignore", "pipe", "pipe"], windowsHide: true,
    });
    ch.stdout.on("data", (d) => (log += d));
    ch.stderr.on("data", (d) => (log += d));
    sec("1. start server");
    let up = false;
    for (let i = 0; i < 30; i++) { const r = await fj("http://" + H + ":" + P + "/healthz").catch(() => ({ status: 0 })); if (r.status === 200) { up = true; break; } await sl(400); }
    if (!up) { F("server failed"); return; }
    S("server up port " + P);
    sec("2. create topic");
    const ir = await fj("http://" + H + ":" + P + "/api/topics/ingest", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ kind: "text", text: TK }) });
    const tid = ir.body?.topicId;
    if (!tid || ir.status !== 202) F("ingest: " + ir.status); else { S("topicId=" + tid); console.log(""); }
    sec("3. build spec");
    if (tid) {
      await fj("http://" + H + ":" + P + "/api/topics/" + encodeURIComponent(tid) + "/build", { method: "POST" });
      for (let i = 0; i < 60; i++) { const r = await fj("http://" + H + ":" + P + "/api/topics/" + encodeURIComponent(tid) + "/spec"); if (r.status === 200 && r.body?.spec) { sp = r.body.spec; break; } await sl(500); }
      if (!sp) F("spec timeout");
      else {
        S("spec: metrics=" + (sp.metrics?.length ?? 0) + " rules=" + (sp.rules?.length ?? 0));
        console.log("title: " + (sp.title ?? "?") + " cast=" + (sp.cast?.map(p => p.id + "(" + p.name + ")").join(",")));
        for (const m of sp.metrics ?? []) console.log("  m:" + m.label + " [" + m.min + "-" + m.max + "]=" + m.start);
        if (JSON.stringify(sp).includes('"formula"')) F("formula leak"); else S("no formula leak");
        if (!Array.isArray(sp.formulaAudit)) F("missing audit"); else S("audit OK");
        console.log("");
      }
    }
    sec("4. create game");
    if (tid) {
      const gr = await fj("http://" + H + ":" + P + "/api/games", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ specId: tid, player: "founder" }) });
      gid = gr.body?.gameId;
      if (gr.status === 201 && gid) { S("gameId=" + gid); st0 = { ...gr.body.state }; }
      else F("create game: " + gr.status);
      console.log("initial: " + JSON.stringify(st0) + "\n");
    }
    const ml = sp?.metrics ?? [];
    if (!gid) { console.log("skip: no gameId\n"); }
    else {
      sec("5. messages");
      const c1 = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "对赌协议底线在哪里各位有何高见", act: false }) });
      if (c1.status === 200) S("consult1"); else F("c1: " + c1.status);
      const c2 = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "CFO测算若接受对赌runway能撑多久", act: false, to: "b" }) });
      if (c2.status === 200) S("consult2_cfo"); else F("c2: " + c2.status);
      const d1 = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "接受高估值对赌方案估值六亿业绩增长百分之五十对赌三年后达标解锁额外股权", act: true }) });
      console.log("d1: " + d1.status + " state=" + JSON.stringify(d1.body?.state ?? {}));
      if (d1.status === 200) S("d1 turn=" + d1.body?.turn); else F("d1: " + d1.status);
      const c3 = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "CEO对赌落地后团队士气如何市场有没有正向反馈", act: false, to: "a" }) });
      if (c3.status === 200) S("consult3_ceo"); else F("c3: " + c3.status);
      const d2 = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/message", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ text: "加大市场投入抢占份额不惜亏损也要冲到下一个里程碑", act: true }) });
      st2 = d2.body?.state ?? {};
      console.log("d2: " + d2.status + " state=" + JSON.stringify(st2));
      if (d2.status === 200) S("d2 turn=" + d2.body?.turn); else F("d2: " + d2.status);
      console.log("");
      sec("6. value checks");
      if (!ml.length) F("no metrics"); else S("metrics: " + ml.length);
      const hasDeltas = JSON.stringify(d1.body ?? {}) !== "{}" && (d1.body?.state ?? {}) !== JSON.stringify(st0); if (hasDeltas || JSON.stringify(st2) !== JSON.stringify(st0)) S("deltas ok"); else F("no deltas");
      let ok = true;
      for (const m of ml) { const v = st2[m.key]; if (v == null || v < m.min || v > m.max) { ok = false; console.log("  x " + m.label); } }
      if (ok) S("state in bounds"); else F("state out of bounds");
      const rk = ml.find(m => /runway|cash|跑道|现金/i.test(m.label || m.key))?.key;
      if (rk && st0[rk] != null && st2[rk] != null) console.log("  runway: " + st0[rk] + " -> " + st2[rk] + " (+" + (st2[rk] - st0[rk]) + ")");
      const vk = ml.find(m => /估值|valuation/i.test(m.label || m.key))?.key;
      if (vk && st0[vk] != null && st2[vk] != null) console.log("  valuation: " + st0[vk] + " -> " + st2[vk]);
      console.log("");
      sec("7. end session");
      const er = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/end", { method: "POST" });
      if (er.status === 200) {
        S("session_ended");
        const en = er.body?.ending;
        const v = en?.verdict ?? "?";
        console.log("verdict: " + v + " narrative=" + String(en?.narrative ?? "").slice(0, 80));
        for (const m of ml) { const x = en?.metrics?.[m.key] ?? "?"; const d = typeof x === "number" ? x - (st0[m.key] ?? 0) : 0; console.log("  " + m.label + ": " + x + " (+" + d + ")"); }
        if (["victory", "defeat", "open"].includes(v)) S("verdict valid"); else F("bad verdict: " + v);
      } else F("end: " + er.status);
      sec("8. history");
      const hr = await fj("http://" + H + ":" + P + "/api/games/" + gid + "/history");
      if (hr.status === 200) {
        S("history read");
        const h = hr.body;
        console.log("turns: " + h?.turn + " metricSeries: " + (h?.metrics ?? []).length);
      } else F("hist: " + hr.status);
    }
    console.log("\n" + "=".repeat(55));
    if (N === 0) console.log("ALL PASSED (全链通过)");
    else { console.error(N + " failure(s)"); process.exit(1); }
  } finally {
    if (ch && ch.exitCode === null) { ch.kill(); await new Promise((r) => ch?.once("exit", r)); }
    for (const sf of ["", "-wal", "-shm"]) try { rmSync(db + sf, { force: true }); } catch {}
  }
}
await main();
