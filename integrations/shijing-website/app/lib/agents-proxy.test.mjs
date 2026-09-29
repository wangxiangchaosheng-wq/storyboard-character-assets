import { test } from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

/**
 * sidecar 反代的回归测试。
 *
 * 锁的是一个真把整站打瘫过的 bug：代理用 URL 对象做模板字符串拼目标地址
 * （`fetch(`${base}/health`)`），URL 对象的 toString() 永远带一个尾斜杠，于是实际
 * 请求的是 `//health`；sidecar 那头 `new URL('//health','http://localhost')` 把它当
 * **协议相对 URL**——'health' 成了主机名，pathname 退化成 '/'，路由全落空。症状是
 * 网页侧每个接口都 404「接口不存在」，而直连 sidecar 完全正常，极易误判成 sidecar 挂了。
 *
 * 测的是**构建产物里的真路由**（浏览器打的就是它），上游用一个回显服务器，
 * 转发路径对不对由它亲口说。路由源码含 TS 参数属性（`constructor(m, public status)`），
 * Node 的类型剥离不认那种语法，所以只能测产物——先 `npm run build`。
 */

const ROUTE_DIR = fileURLToPath(new URL('../../dist/server/_next/static/', import.meta.url));

/** 在构建产物里找 /api/agents/[...path] 那个路由模块（文件名带哈希，按内容认）。 */
async function loadAgentsRoute() {
  let files = [];
  try { files = readdirSync(ROUTE_DIR); } catch { /* 没构建过 */ }
  for (const f of files.filter(f => f.startsWith('route-') && f.endsWith('.js'))) {
    if (!readFileSync(join(ROUTE_DIR, f), 'utf8').includes('AGENT_SERVICE_URL')) continue;
    return import(pathToFileURL(join(ROUTE_DIR, f)).href);
  }
  return null;
}

const routeModule = await loadAgentsRoute();
const PREV = process.env.AGENT_SERVICE_URL;

/** 回显服务器：把「我实际收到的路径」原样回给测试。 */
async function echoServer() {
  const server = http.createServer((req, res) => {
    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ path: req.url }));
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  return { server, url: `http://127.0.0.1:${/** @type {import('node:net').AddressInfo} */ (server.address()).port}` };
}

test.afterEach(() => { if (PREV === undefined) delete process.env.AGENT_SERVICE_URL; else process.env.AGENT_SERVICE_URL = PREV; });

test('反代转发单斜杠路径：不能拼出「//health」（整站 404 那个 bug）', async t => {
  if (!routeModule) return t.skip('未找到构建产物里的反代路由，先跑 npm run build');
  const { server, url } = await echoServer();
  process.env.AGENT_SERVICE_URL = url;
  try {
    const call = (path, requestUrl = 'http://launcher.test/api/agents/' + path.join('/')) =>
      routeModule.GET(new Request(requestUrl, { method: 'GET' }), { params: Promise.resolve({ path }) });
    const res = await call(['health']);
    assert.equal(res.status, 200);
    assert.deepEqual(await res.json(), { path: '/health' }, 'sidecar 必须收到 /health，不是 //health');

    const runs = await call(['runs'], 'http://launcher.test/api/agents/runs?limit=3');
    assert.equal(await runs.json().then(j => j.path), '/runs?limit=3', '查询串原样带上，路径段不带 api/agents 前缀');
  } finally { server.close(); }
});

test('反代保留 AGENT_SERVICE_URL 的路径前缀，多段路径逐段转义', async t => {
  if (!routeModule) return t.skip('未找到构建产物里的反代路由，先跑 npm run build');
  const { server, url } = await echoServer();
  process.env.AGENT_SERVICE_URL = url.replace(/\/$/, '') + '/base/';
  try {
    const res = await routeModule.GET(new Request('http://launcher.test/api/agents/runs/x y/chronicle'), { params: Promise.resolve({ path: ['runs', 'x y', 'chronicle'] }) });
    assert.equal(await res.json().then(j => j.path), '/base/runs/x%20y/chronicle');
  } finally { server.close(); }
});

test('反代拒绝非本机 sidecar 地址（SSRF 防线不因重构松动）', async t => {
  if (!routeModule) return t.skip('未找到构建产物里的反代路由，先跑 npm run build');
  for (const bad of ['http://169.254.169.254/', 'http://10.0.0.5:8080', 'https://evil.example.com']) {
    process.env.AGENT_SERVICE_URL = bad;
    const res = await routeModule.GET(new Request('http://launcher.test/api/agents/health'), { params: Promise.resolve({ path: ['health'] }) });
    assert.equal(res.status, 503, `${bad} 必须被拒`);
    assert.match(await res.json().then(j => j.error), /本地服务/);
  }
  process.env.AGENT_SERVICE_URL = 'not-a-url';
  const res = await routeModule.GET(new Request('http://launcher.test/api/agents/health'), { params: Promise.resolve({ path: ['health'] }) });
  assert.equal(res.status, 503);
  assert.match(await res.json().then(j => j.error), /地址格式无效/);
});

test('反代拒绝带 .. 与超长路径（路径穿越防线不因重构松动）', async t => {
  if (!routeModule) return t.skip('未找到构建产物里的反代路由，先跑 npm run build');
  const { server, url } = await echoServer();
  process.env.AGENT_SERVICE_URL = url;
  try {
    for (const path of [['..'], ['runs', '..', '..'], ['a', 'b', 'c', 'd'], [''], ['runs', 'x/y']]) {
      const res = await routeModule.GET(new Request('http://launcher.test/api/agents/' + path.join('/')), { params: Promise.resolve({ path }) });
      assert.equal(res.status, 400, `${JSON.stringify(path)} 必须被拒`);
    }
  } finally { server.close(); }
});
