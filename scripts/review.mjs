/**
 * 一键审查工作流（根 `pnpm review`）—— 运行初始化 / 每次交付前的自动自检，
 * 结论与明细落盘 review/report.json，serve 启动时读取做「启动自检」。
 *
 * 防呆契约（低自动化也可以照跑）：
 *  - 步骤串行，任何一步失败都会继续跑完其余步骤（以便一次看到全部问题）；
 *  - 但对文件缺失/异常输入一律 try/catch，绝不崩溃栈；
 *  - 每步失败输出「修复指引」；汇总后 exit 1（有失败）或 exit 0（全过）。
 *  - `pnpm review --fast`：跳过真实进程冒烟（S4），用于快速迭代期。
 *
 * 步骤：
 *   S1 类型检查  pnpm -r run check（全仓 tsc --noEmit）
 *   S2 全量测试  pnpm -r test（含指标禁词断言、公式审计、serve e2e、SSE）
 *   S3 静态语义审计（本地扫描）：
 *      a. 源码不含游戏化指标词（军势/民望/士气/国力/局势/实力/民心，提示词声明行豁免）
 *      b. 前端指标卡真实单位（renderGauge unit span + CSS .g-num .unit）
 *      c. app.js 语法（node --check）
 *      d. 凭据字面量扫描（凭据只应来自环境/密钥；仓库内不得有可用凭据）
 *   S4 真实进程冒烟 scripts/smoke.mjs（起服务 → 建话题 → spec 纪律 → 建局）
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { join, relative, resolve } from 'node:path';

const ROOT = resolve(import.meta.dirname, '..');
const REPORT_DIR = join(ROOT, 'review');
const REPORT_FILE = join(REPORT_DIR, 'report.json');
const FAST = process.argv.includes('--fast');

const steps = []; // {id, name, ok, detail}

/** 输出步骤结果并记录；失败时附带指引。ok 可为 true/false/'skip'。 */
function step(id, name, ok, detail = '', fix = '') {
  steps.push({ id, name, ok, detail, fix });
  if (ok === 'skip') { console.log('  · ' + name + (detail ? `（${detail}）` : '')); return; }
  const prefix = ok ? '  ✓ ' : '  ✗ ';
  const fixTxt = ok || !fix ? '' : `　→ 修复：${fix}`;
  console.log(prefix + name + (detail ? `（${detail.slice(0, 160)}）` : '') + fixTxt);
}

/** 平台无关地运行命令；返回 {status, stdout, stderr, error}，绝不抛异常。 */
function sh(cmd, args) {
  const r = spawnSync(cmd, args, { cwd: ROOT, shell: true, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (r.error) return { status: null, stdout: '', stderr: `无法启动 ${cmd}：${r.error.message}`, error: r.error };
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

/** 递归收集文件（跳过 node_modules/.git/out），单目录不存在时安静返回空。 */
function walk(dir, exts, out = []) {
  const entries = existsSync(dir) ? readdirSync(dir) : [];
  for (const e of entries) {
    if (e === 'node_modules' || e === '.git' || e === 'out') continue;
    const p = join(dir, e);
    let st = null;
    try {
      st = statSync(p);
    } catch {
      continue; // 竞态删除等 → 跳过
    }
    if (st.isDirectory()) walk(p, exts, out);
    else if (exts.some((x) => p.endsWith(x))) out.push(p);
  }
  return out;
}

/** 安全读文件：不可读时返回 null（由调用方落 fail，不崩溃）。 */
function readText(p) {
  try {
    return existsSync(p) ? readFileSync(p, 'utf8') : null;
  } catch {
    return null;
  }
}

// ---------- S1 类型 ----------
const t1 = sh('pnpm', ['-r', 'run check']);
const s1 = t1.status === 0;
step('types', '类型检查 pnpm -r run check（全仓 tsc）', s1,
  s1 ? '' : (t1.stderr || t1.stdout).split('\n').filter(Boolean).slice(-6).join('；'),
  '打开报错包的输出（pnpm --filter <包> check），按 tsc 指出的文件:行修；常见：import 路径、空值判断。');

// ---------- S2 全量测试 ----------
const t2 = sh('pnpm', ['-r', 'test']);
const s2 = t2.status === 0;
step('tests', '全量测试 pnpm -r test', s2,
  s2 ? '' : (t2.stdout || '').split('\n').filter((l) => l.includes('✖')).slice(0, 8).join('；'),
  '跑一遍 n> 于失败包的测试：pnpm --filter <包> test，按 ✖ 断言逐条修该测试或业务代码。');

// ---------- S3 静态审计 ----------
const BANNED = ['军势', '民望', '士气', '国力', '局势', '实力', '民心'];
const bannedHits = [];
const srcFiles = [
  ...walk(join(ROOT, 'packages', 'serve', 'src'), ['.ts']),
  ...walk(join(ROOT, 'packages', 'serve', 'web'), ['.js', '.css']),
  ...walk(join(ROOT, 'packages', 'topic-pipeline', 'src'), ['.ts']).filter((p) => !p.includes('.test.ts')),
];
for (const f of srcFiles) {
  const txt = readText(f);
  if (txt === null) { bannedHits.push(`${relative(ROOT, f)}（不可读）`); continue; }
  txt.split('\n').forEach((ln, i) => {
    if (/严禁使用|游戏化抽象词/.test(ln)) return; // 提示词中列黑名单的正常声明行
    if (BANNED.some((w) => ln.includes(w))) bannedHits.push(`${relative(ROOT, f)}:${i + 1}`);
  });
}
const s3a = bannedHits.length === 0;
step('no-gamewords', '静态审计 · 游戏化指标词', s3a,
  s3a ? '' : bannedHits.slice(0, 10).join('；'),
  '把这些词换成史册真实科目/文言表述（如「局面的」→「仓廪」「朝局」），改完重跑。');

const appJs = join(ROOT, 'packages', 'serve', 'web', 'app.js');
const appCss = join(ROOT, 'packages', 'serve', 'web', 'app.css');
const jsTxt = readText(appJs);
const cssTxt = readText(appCss);
const unitOk = jsTxt !== null && cssTxt !== null && jsTxt.includes('class="unit"') && cssTxt.includes('.g-num .unit');
step('units_front', '前端指标卡露出真实单位（unit span + CSS）', unitOk,
  unitOk ? '' : 'app.js/app.css 缺单位呈现',
  '检查 renderGauge() 中 const unit = (def?.unit) ? span… 与 app.css 的 .g-num .unit。');

const t3c = sh('node', ['--check', 'packages/serve/web/app.js']);
step('syntax', '前端脚本语法（node --check app.js）', t3c.status === 0, '', '对照报错行号修复 app.js 括号/引号配对。');

const secretRe = /(sk-|ghp_|github_pat_|api[_-]?key|apikey|token|secret|password|passwd)\s*[:=]\s*["'][A-Za-z0-9_\-+/=]{16,}["']/i;
const secretHits = [];
for (const f of [
  ...walk(join(ROOT, 'packages'), ['.ts', '.mjs', '.js']),
  ...walk(join(ROOT, 'scripts'), ['.mjs', '.js']),
]) {
  if (f.includes('.test.ts') || f.includes(REPORT_DIR)) continue;
  const txt = readText(f);
  if (txt === null) continue;
  const m = txt.match(secretRe);
  if (m) secretHits.push(`${relative(ROOT, f)}：${m[0].slice(0, 40)}`);
}
const s3d = secretHits.length === 0;
step('secrets', '凭据字面量扫描（只认可能可用的长敏感串）', s3d,
  s3d ? '' : secretHits.join('；'),
  '把上列字面量改成从 process.env/密钥服务读取，删除示例中的真实可排凭据。');

// ---------- S4 冒烟（可 --fast 跳过） ----------
let s4 = true;
if (FAST) {
  step('smoke', '真实进程冒烟', 'skip', '--fast 跳过');
} else {
  const t4 = sh('node', ['scripts/smoke.mjs']);
  s4 = t4.status === 0;
  step('smoke', '真实进程冒烟（起服务→建话题→spec 纪律→建局）', s4,
    s4 ? '' : (t4.stdout || t4.stderr).split('\n').filter((l) => l.includes('✗')).slice(0, 6).join('；'),
    '按冒烟输出的 ✗ 项修（端口冲突找服务、日志看启动报错），修完重跑 pnpm smoke。');
}

// ---------- 汇总 ----------
const failed = steps.filter((s) => !s.ok);
const skipped = steps.filter((s) => s.ok === 'skip');
const conclusion = failed.length === 0 ? 'pass' : 'fail';
const report = {
  conclusion,
  finishedAt: new Date().toISOString(),
  mode: FAST ? 'fast' : 'full',
  steps: steps.map(({ id, name, ok, detail, fix }) => ({ id, name, ok: ok === true, skipped: ok === 'skip', detail, fix })),
  okCount: steps.filter((s) => s.ok === true).length,
  total: steps.length,
  smoke: s4,
};
mkdirSync(REPORT_DIR, { recursive: true });
writeFileSync(REPORT_FILE, JSON.stringify(report, null, 2));

console.log(`\n审查结论：${conclusion === 'pass' ? 'PASS ✓' : 'FAIL ✗'} ${steps.filter((s) => s.ok === true).length}/${steps.length} 项通过` + (skipped.length ? `（跳过 ${skipped.length} 项）` : ''));
for (const s of failed) {
  console.log(`  ✗ ${s.name}${s.detail ? '\n      ' + s.detail : ''}`);
  console.log(`      修复指引：${s.fix}`);
}
console.log(failed.length ? `报告：${relative(ROOT, REPORT_FILE)}（serve 启动时自检此文件）` : ``);
console.log(conclusion === 'pass' ? `报告：${relative(ROOT, REPORT_FILE)}（serve 启动时自检此文件）` : '');
process.exit(conclusion === 'pass' ? 0 : 1);