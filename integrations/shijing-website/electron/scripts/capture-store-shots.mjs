#!/usr/bin/env node
/**
 * capture-store-shots.mjs — 为 Steam 商店页拍摄游戏内实拍截图（1440×900 PNG）。
 *
 * 一条命令完成：起打包态 sidecar → 起本地网页服务 → 用系统 Chrome（headless + CDP）逐个页面
 * 截图 → 校验质量 → 落盘 → 关掉所有子进程并清理临时目录。端口占用、启动失败都会给可读报错。
 *
 * 用法（在 integrations/shijing-website/electron/scripts/ 下）：
 *   node capture-store-shots.mjs
 *
 * 环境变量（均有默认值，可覆盖）：
 *   SHOT_SIDECAR_PORT     sidecar 端口            （默认 43181）
 *   SHOT_SERVER_PORT      本地网页服务端口        （默认 43182）
 *   SHIJING_BUILD_ROOT    打包产物 resources 目录 （默认 D:/shijing-release/win-unpacked/resources）
 *   SHOT_OUT_DIR          截图输出目录            （默认 <仓库>/store-assets/screenshots）
 *   SHOT_KEEP_TEMP=1      保留临时数据目录（默认清理）
 *   CHROME_PATH           指定 chrome.exe 路径    （默认自动探测常见安装位置）
 *   SHOT_ONLY=home,map    只拍指定页面（逗号分隔；默认全部）
 *
 * 依赖：只用 node 内置模块 + 系统 Chrome（经 DevTools Protocol 驱动，Node 22+ 自带全局 WebSocket）。
 * 不需要任何第三方包，也不需要 OpenAI key：sidecar 以 AGENT_ALLOW_API_GENERATION=false 离线模式运行，
 * 人物立绘走人物素材库、本地推演世界由 buildInitialWorld 自动装配——这正是游戏设计的离线可玩路径。
 */

import { spawn, execFileSync } from 'node:child_process';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync, readFileSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import http from 'node:http';

/* ---------------------------------------------------------------- 配置 ---- */
const HERE = dirname(fileURLToPath(import.meta.url));
const DEFAULT_OUT_DIR = resolve(HERE, '..', '..', 'store-assets', 'screenshots');
const DEFAULT_BUILD_ROOT = 'D:/shijing-release/win-unpacked/resources';

const env = (name, fallback) => {
  const value = process.env[name];
  return value === undefined || value === '' ? fallback : value;
};

const SIDECAR_PORT = Number(env('SHOT_SIDECAR_PORT', '43181'));
const SERVER_PORT = Number(env('SHOT_SERVER_PORT', '43182'));
const BUILD_ROOT = resolve(env('SHIJING_BUILD_ROOT', DEFAULT_BUILD_ROOT));
const OUT_DIR = resolve(env('SHOT_OUT_DIR', DEFAULT_OUT_DIR));
const KEEP_TEMP = env('SHOT_KEEP_TEMP', '') === '1';
const VIEW_W = 1440;
const VIEW_H = 900;
const ONLY = env('SHOT_ONLY', '')
  .split(',')
  .map((s) => s.trim())
  .filter(Boolean);

const SIDECAR_MAIN = join(BUILD_ROOT, 'agents', 'dist', 'main.js');
const SERVER_MAIN = join(BUILD_ROOT, 'electron', 'dist', 'server.mjs');

for (const [name, value] of [
  ['SHOT_SIDECAR_PORT', SIDECAR_PORT],
  ['SHOT_SERVER_PORT', SERVER_PORT],
]) {
  if (!Number.isInteger(value) || value < 1 || value > 65535) {
    console.error(`✗ ${name}=${value} 不是合法端口`);
    process.exit(2);
  }
}

const sleep = (ms) => new Promise((done) => setTimeout(done, ms));

function log(line) {
  process.stdout.write(`[截图] ${line}\n`);
}

function fail(line) {
  process.stderr.write(`[截图] ✗ ${line}\n`);
}

/* ------------------------------------------------------------ 小工具 ---- */
/** 端口是否已被占用（能建立 TCP 连接即视为占用） */
function portBusy(port) {
  return new Promise((done) => {
    const req = http.get({ host: '127.0.0.1', port, path: '/', timeout: 1200 }, (res) => {
      res.resume();
      done(true);
    });
    req.on('error', () => done(false));
    req.on('timeout', () => {
      req.destroy();
      done(false);
    });
  });
}

function httpGetText(url, timeoutMs = 10000) {
  return new Promise((done, bad) => {
    const req = http.get(url, { timeout: timeoutMs }, (res) => {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', (chunk) => (body += chunk));
      res.on('end', () => done({ status: res.statusCode || 0, body }));
    });
    req.on('error', bad);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
  });
}

/** 直接请求 sidecar（脚本自身不是浏览器，不带 Origin 头，符合 sidecar 的同源约束） */
function postJson(url, payload, timeoutMs = 60000) {
  return new Promise((done, bad) => {
    const body = JSON.stringify(payload);
    const req = http.request(
      url,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, timeout: timeoutMs },
      (res) => {
        let out = '';
        res.setEncoding('utf8');
        res.on('data', (chunk) => (out += chunk));
        res.on('end', () => done({ status: res.statusCode || 0, body: out }));
      },
    );
    req.on('error', bad);
    req.on('timeout', () => req.destroy(new Error('请求超时')));
    req.end(body);
  });
}

/** 轮询直到 fn() 返回真值；超时抛错。fn 抛出的 error.fatal 错误立即上抛（用于「子进程已死」这类不该重试的情况） */
async function poll(fn, { timeout = 30000, interval = 350, label = '条件' } = {}) {
  const started = Date.now();
  let lastError;
  for (;;) {
    try {
      const value = await fn();
      if (value) return value;
    } catch (error) {
      if (error && error.fatal) throw error;
      lastError = error;
    }
    if (Date.now() - started > timeout) {
      throw new Error(`等待超时（${label}，${Math.round(timeout / 1000)} 秒）${lastError ? `：${lastError.message}` : ''}`);
    }
    await sleep(interval);
  }
}

/** 结束进程树：Windows 用 taskkill /T，失败退回 kill */
function killTree(pid, name) {
  if (!pid) return;
  try {
    if (process.platform === 'win32') {
      execFileSync('taskkill', ['/pid', String(pid), '/t', '/f'], { stdio: 'ignore' });
    } else {
      process.kill(pid, 'SIGKILL');
    }
    log(`${name}（pid ${pid}）已关闭`);
  } catch {
    /* 进程可能已经退出 */
  }
}

/** 起子进程，按行收集 stdout，等到匹配 readyPattern 的那一行 */
function spawnAndWatch(cmd, args, options, { name, readyPattern, timeout = 60000 }) {
  const child = spawn(cmd, args, {
    cwd: options.cwd,
    env: options.env,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  const lines = [];
  let buffer = '';
  let settled = false;
  let settleOk;
  let settleBad;
  const ready = new Promise((ok, bad) => {
    settleOk = ok;
    settleBad = bad;
  });
  const timer = setTimeout(() => {
    if (!settled) {
      settled = true;
      settleBad(new Error(`${name} 就绪超时（${Math.round(timeout / 1000)} 秒）`));
    }
  }, timeout);
  child.on('exit', (code) => {
    if (!settled) {
      settled = true;
      settleBad(new Error(`${name} 提前退出，code=${code}`));
    }
    log(`${name} 进程已退出，code=${code}`);
  });
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    let index;
    while ((index = buffer.indexOf('\n')) >= 0) {
      const line = buffer.slice(0, index).trim();
      buffer = buffer.slice(index + 1);
      if (!line) continue;
      lines.push(line);
      if (!settled && readyPattern.test(line)) {
        settled = true;
        clearTimeout(timer);
        settleOk(line);
      }
    }
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => process.stderr.write(`  ${name} | ${chunk}`));
  return {
    child,
    lines,
    ready,
    kill: () => killTree(child.pid, name),
  };
}

/* ---------------------------------------------------- 极简 CDP 客户端 ---- */
/** 只实现本脚本用到的能力：Runtime.evaluate / Page.* / Network.* / Emulation.setDeviceMetricsOverride */
class Cdp {
  constructor(ws) {
    this.ws = ws;
    this.nextId = 0;
    this.pending = new Map();
    this.inflight = new Set();
    ws.addEventListener('message', (event) => {
      const message = JSON.parse(String(event.data));
      if (message.id !== undefined && this.pending.has(message.id)) {
        const { resolve: ok, reject } = this.pending.get(message.id);
        this.pending.delete(message.id);
        if (message.error) reject(new Error(message.error.message));
        else ok(message.result);
        return;
      }
      if (message.method === 'Network.requestWillBeSent') this.inflight.add(message.params.requestId);
      if (message.method === 'Network.loadingFinished' || message.method === 'Network.loadingFailed') {
        this.inflight.delete(message.params.requestId);
      }
    });
  }
  send(method, params = {}) {
    return new Promise((ok, bad) => {
      const id = ++this.nextId;
      this.pending.set(id, { resolve: ok, reject: bad });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression) {
    const result = await this.send('Runtime.evaluate', { expression, returnByValue: true });
    if (result.exceptionDetails) {
      throw new Error(result.exceptionDetails.exception?.description || '页面脚本执行失败');
    }
    return result.result.value;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* 已关闭 */
    }
  }
}

/* ------------------------------------------------------------- 主流程 ---- */
const CHROME_CANDIDATES = [
  process.env.CHROME_PATH,
  'C:/Program Files/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Google/Chrome/Application/chrome.exe',
  'C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe',
  'C:/Program Files/Microsoft/Edge/Application/msedge.exe',
  '/usr/bin/google-chrome',
  '/usr/bin/chromium',
  '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome',
].filter(Boolean);

function findChrome() {
  for (const candidate of CHROME_CANDIDATES) {
    if (existsSync(candidate)) return candidate;
  }
  throw new Error('找不到 Chrome/Edge，请设置 CHROME_PATH 指向 chrome.exe');
}

/** 读 Chrome 写下的 DevToolsActivePort（第一行是端口） */
async function waitForDevtoolsPort(userDataDir, timeout = 30000) {
  const file = join(userDataDir, 'DevToolsActivePort');
  return poll(() => {
    try {
      const port = Number(readFileSync(file, 'utf8').split('\n')[0].trim());
      return Number.isInteger(port) && port > 0 ? port : false;
    } catch {
      return false;
    }
  }, { timeout, interval: 200, label: 'Chrome 调试端口' });
}

/* 每个页面的「稳定就绪」判定与最小交互。
 * ready 是页面主帧里执行的表达式，返回真值视为可拍。
 * pre 是拍照前的可选最小交互（开局 / 跳过一次性引导）。 */
const SHOTS = [
  {
    name: 'home',
    url: '/',
    title: '首页 · 议题选择与开局入口（iframe 即战略地图页）',
    timeout: 90000,
    ready: `
      (() => {
        const frame = document.querySelector('iframe');
        if (!frame) return false;
        const doc = frame.contentDocument;
        if (!doc) return false;
        if (doc.querySelector('#loading')) return false;
        if (!doc.querySelector('#event-list')?.children.length) return false;
        if (!doc.querySelector('#art')?.children.length) return false;
        return [...doc.images].every(i => i.complete && i.naturalWidth > 0);
      })()`,
  },
  {
    name: 'map',
    url: '/map/',
    title: '战略地图',
    timeout: 90000,
    ready: `
      (() => {
        if (document.querySelector('#loading')) return false;
        if (!document.querySelector('#event-list')?.children.length) return false;
        if (!document.querySelector('#art')?.children.length) return false;
        return [...document.images].every(i => i.complete && i.naturalWidth > 0);
      })()`,
  },
  {
    name: 'discussion',
    url: '/discussion',
    title: '议政界面（议题推演）',
    timeout: 150000,
    // 最小交互：新玩家首次进入会被「选局面板」挡住，点一次「开局」；随后的一次性新手引导点「跳过」。
    pre: async (cdp) => {
      const started = await poll(
        () =>
          cdp.evaluate(
            `(() => { const b = document.querySelector('.scenario-picker-start'); if (b) { b.click(); return true; } return false; })()`,
          ),
        { timeout: 30000, interval: 300, label: '选局面板' },
      ).catch(() => false);
      if (started) log('discussion：已点击选局面板「开局」');
      await sleep(600);
      const skipped = await poll(
        () =>
          cdp.evaluate(
            `(() => { const b = document.querySelector('.onboard-skip'); if (b) { b.click(); return true; } return false; })()`,
          ),
        { timeout: 10000, interval: 300, label: '新手引导' },
      ).catch(() => false);
      if (skipped) log('discussion：已跳过一次性新手引导');
    },
    // 就绪：本地推演世界装配完（跳转条出现）、人物栏 5 人、对话已渲染、无连接错误、准备态遮罩已收起
    ready: `
      (() => {
        if (document.querySelector('.agent-error')) return false;
        if (document.querySelector('.topic-transition')) return false;
        if (document.querySelectorAll('.character-list button').length < 5) return false;
        if (!document.querySelector('.dialogue-panel .conversation article')) return false;
        if (!document.querySelector('.jump-bar')) return false;
        return document.querySelectorAll('svg image[href]').length > 0;
      })()`,
  },
  {
    name: 'strategy',
    url: '/strategy',
    title: '策略地图库',
    timeout: 120000,
    // 库为空时页面只会显示「暂无已初始化的议题战略数据」；先确保有一个已装配世界的对局
    pre: async () => {
      await ensureStrategyRun();
    },
    ready: `
      (() => {
        const status = document.querySelector('.strategy-gallery-status');
        if (!status) return false;
        const text = status.textContent || '';
        if (text.includes('正在读取') || text.includes('暂无') || text.includes('失败')) return false;
        if (!text.includes('公元')) return false;
        const art = document.querySelector('img.strategy-art');
        if (!art || !art.complete || art.naturalWidth === 0) return false;
        // 卷轴展开动画结束后再拍
        const paper = document.querySelector('.strategy-paper');
        if (paper) {
          const value = getComputedStyle(paper).clipPath || '';
          const inner = value.match(/inset\\(([^)]+)\\)/);
          if (inner) {
            const parts = inner[1].trim().split(/[\\s]+/);
            if (parseFloat(parts[1] || '0') > 1) return false;
          }
        }
        return true;
      })()`,
    // 超时时的诊断：底图 SVG 解码失败 / 库里没有对局，两种原因分开报
    diagnose: async (cdp) => {
      const info = await cdp.evaluate(`JSON.stringify({
        status: document.querySelector('.strategy-gallery-status')?.textContent || '',
        artComplete: document.querySelector('img.strategy-art')?.complete ?? null,
        artNatural: [document.querySelector('img.strategy-art')?.naturalWidth, document.querySelector('img.strategy-art')?.naturalHeight],
      })`);
      return info;
    },
  },
  {
    name: 'major-event',
    url: '/major-event/index.html',
    title: '重大事件画廊',
    timeout: 120000,
    ready: `
      (() => {
        const status = document.querySelector('#status');
        if (!status) return false;
        const text = status.textContent || '';
        if (text.includes('正在') || text.includes('失败') || text.includes('尚未就绪') || text.includes('暂无')) return false;
        const art = document.querySelector('#art');
        if (!art || art.hidden || !art.complete || art.naturalWidth === 0) return false;
        const paper = document.querySelector('#paper');
        if (paper) {
          const value = getComputedStyle(paper).clipPath || '';
          const inner = value.match(/inset\\(([^)]+)\\)/);
          if (inner) {
            const parts = inner[1].trim().split(/[\\s]+/);
            if (parseFloat(parts[1] || '0') > 1) return false;
          }
        }
        return true;
      })()`,
  },
];

/** PNG 宽高（读 IHDR） */
function pngSize(file) {
  const handle = readFileSync(file);
  if (handle.length < 24 || handle.readUInt32BE(0) !== 0x89504e47) return null;
  return { width: handle.readUInt32BE(16), height: handle.readUInt32BE(20) };
}

/**
 * 默认议题的本地对局规格——与 agents/src/local-topic.ts 的 localTopicSpec(defaultTopic) 同形：
 * 议政页开机走的就是这条路径（离线模式 + buildInitialWorld 自动装配本地推演世界）。
 * 策略地图库要靠一个已装配世界的对局才有内容，所以拍 /strategy 前确保库里有这么一个对局。
 */
const DEFAULT_TOPIC_SPEC = {
  id: 'local-' + Date.now().toString(36),
  title: '是否采纳魏延子午谷方案？',
  scenario: {
    background:
      '公元228年春。讨论奇袭方案的可行性，权衡战机、险道、接应和后勤。方案推演，不视为已经实施。\n当前使用本地预设讨论人物，未调用 AI 选角；名单不代表经考证的实际在场人物。',
  },
  cast: [
    { id: 'local-person-0', name: '诸葛亮', role: '蜀汉丞相' },
    { id: 'local-person-1', name: '魏延', role: '蜀汉将领' },
    { id: 'local-person-2', name: '杨仪', role: '蜀汉幕僚' },
    { id: 'local-person-3', name: '姜维', role: '蜀汉将领' },
    { id: 'local-person-4', name: '费祎', role: '蜀汉文臣' },
  ].map((p) => ({ ...p, description: '使用现有素材库形象；人物立场与行动尚未推演。', stance: '待讨论' })),
  metrics: [],
};

/** 确保 sidecar 的策略地图库里有一个已装配世界的对局（幂等） */
async function ensureStrategyRun() {
  const library = async () => {
    const response = await httpGetText(`http://127.0.0.1:${SIDECAR_PORT}/strategy-library?limit=100`);
    const parsed = JSON.parse(response.body);
    return Array.isArray(parsed.maps) ? parsed.maps : [];
  };
  if ((await library()).length) {
    log('strategy：策略地图库已有对局，跳过建局');
    return;
  }
  log('strategy：策略地图库为空，先按议政页开机同一条路径建一个默认议题对局…');
  const created = await postJson(`http://127.0.0.1:${SIDECAR_PORT}/runs`, {
    reuseKey: 'store-shots-default-topic',
    spec: { ...DEFAULT_TOPIC_SPEC, id: 'local-' + Date.now().toString(36) },
  });
  if (created.status !== 200 && created.status !== 201 && created.status !== 202) {
    throw new Error(`建局失败：HTTP ${created.status} ${created.body.slice(0, 200)}`);
  }
  await poll(async () => (await library()).length > 0, { timeout: 30000, interval: 1000, label: '对局进入策略地图库' });
  log('strategy：默认议题对局已就绪');
}

/** 错误页 / 代理失败特征词 */
const ERROR_MARKERS = ['未找到页面', '桌面壳', '后台 Agent 服务尚未启动', '请先启动本机 Agent 服务', '请求内容过大', '接口路径无效'];

async function main() {
  /* 0. 前置检查 */
  if (!existsSync(SIDECAR_MAIN)) throw new Error(`找不到 sidecar 入口：${SIDECAR_MAIN}（检查 SHIJING_BUILD_ROOT）`);
  if (!existsSync(SERVER_MAIN)) throw new Error(`找不到本地服务入口：${SERVER_MAIN}（检查 SHIJING_BUILD_ROOT）`);
  for (const [name, port] of [
    ['SHOT_SIDECAR_PORT', SIDECAR_PORT],
    ['SHOT_SERVER_PORT', SERVER_PORT],
  ]) {
    if (await portBusy(port)) {
      throw new Error(`端口 ${port} 已被占用（${name}）。请先关掉占用进程，或用环境变量换个端口，例如 ${name}=43281`);
    }
  }
  mkdirSync(OUT_DIR, { recursive: true });

  const wanted = ONLY.length ? SHOTS.filter((s) => ONLY.includes(s.name)) : SHOTS;
  if (!wanted.length) {
    throw new Error(`SHOT_ONLY=${ONLY.join(',')} 没有匹配到任何页面（可选：${SHOTS.map((s) => s.name).join(', ')}）`);
  }

  const tempRoot = mkdtempSync(join(tmpdir(), 'shijing-shots-'));
  const agentDataDir = join(tempRoot, 'agent-data');
  const chromeProfile = join(tempRoot, 'chrome-profile');
  mkdirSync(agentDataDir, { recursive: true });
  mkdirSync(chromeProfile, { recursive: true });
  if (KEEP_TEMP) log(`临时目录已保留：${tempRoot}`);

  const killAll = [];
  const cleanupTemp = async () => {
    if (KEEP_TEMP) return;
    // Windows 上 taskkill 之后文件句柄不会立刻释放（chrome profile / sqlite WAL），多重试几次
    await sleep(1500);
    for (let attempt = 1; attempt <= 8; attempt++) {
      try {
        rmSync(tempRoot, { recursive: true, force: true, maxRetries: 3, retryDelay: 500 });
        log('临时目录已清理');
        return;
      } catch (error) {
        if (attempt === 8) {
          fail(`临时目录清理失败（可手动删除）：${tempRoot} — ${error.message}`);
          return;
        }
        await sleep(700);
      }
    }
  };
  for (const signal of ['SIGINT', 'SIGTERM']) {
    process.on(signal, () => {
      for (const kill of killAll) kill();
      // 异步清理需要一点时间，延迟退出让 rmSync 跑完
      void cleanupTemp().finally(() => process.exit(signal === 'SIGINT' ? 130 : 143));
    });
  }

  const results = [];
  let cdp = null;
  try {
    /* 1. sidecar（离线模式：关闭自动 API 生成，人物立绘走素材库） */
    log(`启动 sidecar（端口 ${SIDECAR_PORT}，数据目录 ${agentDataDir}）…`);
    const sidecar = spawnAndWatch(
      process.execPath,
      [SIDECAR_MAIN],
      {
        cwd: BUILD_ROOT,
        env: {
          ...process.env,
          AGENT_PORT: String(SIDECAR_PORT),
          AGENT_DATA_DIR: agentDataDir,
          AGENT_ALLOW_API_GENERATION: 'false',
        },
      },
      { name: 'sidecar', readyPattern: /史境 Agent 服务/, timeout: 60000 },
    );
    killAll.push(sidecar.kill);
    await sidecar.ready;
    const health = await poll(
      () => httpGetText(`http://127.0.0.1:${SIDECAR_PORT}/health`).then((r) => (r.status === 200 ? JSON.parse(r.body) : false)),
      { timeout: 20000, interval: 400, label: 'sidecar /health' },
    );
    if (health.generationEnabled !== false) {
      throw new Error('sidecar 未进入离线模式（generationEnabled 应为 false）');
    }
    log('sidecar 就绪（离线模式，generationEnabled=false）');

    /* 2. 本地网页服务 */
    log(`启动本地网页服务（端口 ${SERVER_PORT}）…`);
    const server = spawnAndWatch(
      process.execPath,
      [SERVER_MAIN],
      {
        cwd: BUILD_ROOT,
        env: {
          ...process.env,
          SHIJING_MODE: 'prod',
          SHIJING_ROOT: BUILD_ROOT,
          AGENT_SERVICE_URL: `http://127.0.0.1:${SIDECAR_PORT}`,
          SHIJING_SERVER_PORT: String(SERVER_PORT),
        },
      },
      { name: 'server', readyPattern: /"port"\s*:/, timeout: 60000 },
    );
    killAll.push(server.kill);
    await server.ready;
    const homeBytes = await poll(
      () => httpGetText(`http://127.0.0.1:${SERVER_PORT}/`).then((r) => (r.status === 200 ? r.body.length : false)),
      { timeout: 20000, interval: 400, label: 'GET /' },
    );
    log(`本地服务就绪（GET / 200，${homeBytes} 字节）`);

    /* 3. Chrome（headless + CDP） */
    const chromePath = findChrome();
    log(`启动 Chrome（headless）：${chromePath}`);
    const chrome = spawn(
      chromePath,
      [
        '--headless=new',
        '--remote-debugging-port=0',
        `--user-data-dir=${chromeProfile}`,
        '--no-first-run',
        '--no-default-browser-check',
        '--disable-dev-shm-usage',
        '--disable-extensions',
        '--hide-scrollbars',
        '--force-device-scale-factor=1',
        '--window-size=1440,900',
        '--lang=zh-CN',
        '--mute-audio',
        '--disable-features=Translate,TranslateUI,MediaRouter',
        '--remote-allow-origins=*',
        'about:blank',
      ],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    );
    killAll.push(() => killTree(chrome.pid, 'chrome'));
    chrome.stderr.resume();

    const devtoolsPort = await waitForDevtoolsPort(chromeProfile);
    const wsUrl = await poll(
      () =>
        httpGetText(`http://127.0.0.1:${devtoolsPort}/json/list`)
          .then((r) => (r.status === 200 ? JSON.parse(r.body) : []))
          .then((list) => list.find((t) => t.type === 'page')?.webSocketDebuggerUrl || false),
      { timeout: 20000, interval: 400, label: 'CDP 目标页' },
    );
    const ws = new WebSocket(wsUrl);
    await new Promise((ok, bad) => {
      ws.addEventListener('open', ok, { once: true });
      ws.addEventListener('error', () => bad(new Error('CDP WebSocket 连接失败')), { once: true });
    });
    cdp = new Cdp(ws);
    await cdp.send('Page.enable');
    await cdp.send('Network.enable');
    await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: VIEW_W, height: VIEW_H, deviceScaleFactor: 1, mobile: false });
    log(`CDP 已连接（devtools 端口 ${devtoolsPort}），视口 ${VIEW_W}×${VIEW_H}`);

    /* 4. 逐页拍摄 */
    // 子进程中途死掉要立刻报出来，而不是让页面一直等到超时（清理阶段的退出不报警）
    let servicesAlive = true;
    let shootingDone = false;
    const watchDeath = (proc, name) =>
      proc.child.on('exit', () => {
        servicesAlive = false;
        if (!shootingDone) fail(`${name} 进程中途退出，本次拍摄无法继续`);
      });
    watchDeath(sidecar, 'sidecar');
    watchDeath(server, '本地网页服务');
    const guard = (fn) => () => {
      if (!servicesAlive) {
        const error = new Error('sidecar 或本地网页服务进程已退出');
        error.fatal = true;
        throw error;
      }
      return fn();
    };

    const base = `http://127.0.0.1:${SERVER_PORT}`;
    for (const shot of wanted) {
      const file = join(OUT_DIR, `${shot.name}.png`);
      const record = { name: shot.name, url: shot.url, title: shot.title, file, status: 'ok', notes: [] };
      results.push(record);
      try {
        log(`拍摄 ${shot.name} → ${shot.url}`);
        const navigation = await cdp.send('Page.navigate', { url: base + shot.url });
        if (navigation?.errorText) throw new Error(`导航失败：${navigation.errorText}`);
        await poll(guard(() => cdp.evaluate(`document.readyState === 'complete'`)), { timeout: 30000, interval: 250, label: 'load' });
        cdp.inflight.clear();
        if (shot.pre) await shot.pre(cdp);
        await poll(guard(() => cdp.evaluate(shot.ready)), { timeout: shot.timeout, interval: 500, label: `${shot.name} 就绪` });
        // 网络基本空闲（避免拍到半截加载的画面）
        await poll(guard(() => cdp.inflight.size === 0), { timeout: 25000, interval: 300, label: `${shot.name} 网络空闲` });
        await sleep(700); // 等尾帧动效与图片解码
        const capture = await cdp.send('Page.captureScreenshot', {
          format: 'png',
          captureBeyondViewport: false,
          fromSurface: true,
        });
        writeFileSync(file, Buffer.from(capture.data, 'base64'));
        const size = pngSize(file);
        const bytes = statSync(file).size;
        record.bytes = bytes;
        record.dimensions = size ? `${size.width}×${size.height}` : '未知';

        /* 5. 质量门禁：尺寸精确、体积不像白屏、页面不含错误特征词 */
        const pageInfo = await cdp.evaluate(
          `({ title: document.title, text: (document.body?.innerText || '').replace(/\\s+/g, ' ').slice(0, 160) })`,
        );
        record.pageTitle = pageInfo?.title || '';
        record.pageText = pageInfo?.text || '';
        const problems = [];
        if (!size || size.width !== VIEW_W || size.height !== VIEW_H) {
          problems.push(`尺寸 ${record.dimensions} ≠ ${VIEW_W}×${VIEW_H}`);
        }
        if (bytes < 15000) problems.push(`文件仅 ${bytes} 字节，疑似白屏`);
        for (const marker of ERROR_MARKERS) {
          if (record.pageText.includes(marker)) problems.push(`页面含错误特征「${marker}」`);
        }
        if (problems.length) {
          record.status = 'suspect';
          record.notes.push(...problems);
          fail(`${shot.name}：${problems.join('；')}`);
          log(`${shot.name} 页面文本摘录：${record.pageText}`);
        } else {
          log(`${shot.name} ✓ ${file}（${record.dimensions}，${(bytes / 1024).toFixed(0)} KB）`);
        }
      } catch (error) {
        let message = error.message;
        if (shot.diagnose) {
          try {
            message += `；诊断：${await shot.diagnose(cdp)}`;
          } catch {
            /* 诊断本身失败就不追加 */
          }
        }
        record.status = 'failed';
        record.notes.push(message);
        fail(`${shot.name} 拍摄失败：${message}`);
        if (existsSync(file)) rmSync(file, { force: true });
      }
    }
    shootingDone = true;
  } finally {
    if (cdp) cdp.close();
    for (const kill of killAll) kill();
    await cleanupTemp();
  }

  /* 6. 汇总 */
  const ok = results.filter((r) => r.status === 'ok');
  const bad = results.filter((r) => r.status !== 'ok');
  log(`完成：${ok.length} 张成功${bad.length ? `，${bad.length} 张未拍到/存疑` : ''}`);
  for (const record of results) {
    const summary =
      record.status === 'ok'
        ? `${record.dimensions} · ${(record.bytes / 1024).toFixed(0)} KB`
        : `${record.status} · ${record.notes.join('；')}`;
    log(`  ${record.status === 'ok' ? '✓' : '✗'} ${record.name}.png  ← ${record.url}  ${summary}`);
  }
  if (bad.length) process.exitCode = 1;
}

main().catch((error) => {
  fail(error.stack || error.message);
  process.exit(1);
});
