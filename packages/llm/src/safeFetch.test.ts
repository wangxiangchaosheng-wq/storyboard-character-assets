/**
 * safeFetch 安全网关门禁单测（docs/11 §2.1）—— 全部离线：不发出任何真实请求。
 * 判定标准：以「解析后的 IP」为准，私网/环回/链路本地/组播/保留全拒。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isForbidden, assertSafeTarget } from './safeFetch.ts';
import { AppError } from '@sim/contracts';

const FORBIDDEN_IPV4 = [
  '0.0.0.0', '0.1.2.3',        // 0/8
  '10.0.0.0', '10.255.255.255', // 10/8
  '127.0.0.1', '127.255.255.255', // 环回
  '169.254.0.1', '169.254.169.254', // 链路本地（云元数据）
  '172.16.0.1', '172.31.255.255', // 172.16/12
  '192.168.0.1', '192.168.255.254', // 192.168/16
  '224.0.0.1', '239.255.255.255', // 组播
  '240.0.0.1', '255.255.255.255', // 保留
];
const OK_IPV4 = ['1.1.1.1', '8.8.8.8', '114.114.114.114', '172.32.0.1', '192.169.0.1'];

for (const ip of FORBIDDEN_IPV4) {
  test(`isForbidden 拒绝 IPv4 ${ip}`, () => {
    assert.equal(isForbidden(ip), true, ip);
  });
}
for (const ip of OK_IPV4) {
  test(`isForbidden 放行公网 IPv4 ${ip}`, () => {
    assert.equal(isForbidden(ip), false, ip);
  });
}

const FORBIDDEN_IPV6 = [
  '::', '::1',                        // 未指定 / 环回
  'fe80::1', 'fe80::abcd:1234',       // 链路本地
  'fc00::1', 'fd12:3456:789a::1',     // ULA
  'ff02::1', 'ff00::',                // 组播
  '::ffff:127.0.0.1', '::ffff:10.0.0.8', // v4 映射环回/私网
  '::ffff:169.254.169.254',
];
const OK_IPV6 = [
  '2606:4700:4700::1111',         // Cloudflare
  '2001:4860:4860::8888',         // Google DNS
  '::ffff:8.8.8.8',               // v4 映射公网
  '2600:1900:4000::1',
];
for (const [ip, ok] of [...FORBIDDEN_IPV6.map((i) => [i, true] as const), ...OK_IPV6.map((i) => [i, false] as const)]) {
  test(`isForbidden ${ok ? '拒绝' : '放行'} IPv6 ${ip}`, () => {
    assert.equal(isForbidden(ip), ok, ip);
  });
}

test('isForbidden 拒绝非 IP 字符串', () => {
  assert.equal(isForbidden('not-an-ip'), true);
  assert.equal(isForbidden(''), true);
});

test('assertSafeTarget 拒绝非 http/https 协议', async () => {
  await assert.rejects(assertSafeTarget('ftp://example.com/x'), AppError);
  await assert.rejects(assertSafeTarget('file:///etc/passwd'), AppError);
  await assert.rejects(assertSafeTarget('data:text/plain;base64,SGk='), AppError);
});

test('assertSafeTarget 拒绝环回/私网目标（IP 字面量，无需 DNS）', async () => {
  for (const bad of [
    'http://127.0.0.1/',
    'http://127.0.0.1:8787/api',
    'http://[::1]/',
    'http://10.0.0.8/x',
    'http://169.254.169.254/latest/meta-data',
    'http://172.16.0.1/',
    'http://192.168.1.1/',
    'http://224.0.0.1/',
  ]) {
    await assert.rejects(assertSafeTarget(bad), (e: unknown) => {
      assert.ok(e instanceof AppError);
      assert.equal(e.code, '1003');
      return true;
    }, bad);
  }
});

test('assertSafeTarget 拒绝 localhost（走 hosts 解析，无外网依赖）', async () => {
  // localhost 在 hosts 文件里解析为 127.0.0.1/::1，属于环回
  await assert.rejects(assertSafeTarget('http://localhost:3000/'), AppError);
});

test('assertSafeTarget 放行公网 IP 字面量（不发请求）', async () => {
  const t = await assertSafeTarget('https://8.8.8.8/x?y=1');
  assert.equal(t.host, '8.8.8.8');
  assert.equal(t.ip, '8.8.8.8');
  assert.ok(t.url.startsWith('https://'));
});

test('assertSafeTarget 白名单：不在列表即拒（IP 字面量，无需 DNS）', async () => {
  // 白名单命中：8.8.8.8 在列 → 通过
  const t = await assertSafeTarget('http://8.8.8.8/', { allowedHosts: ['8.8.8.8'] });
  assert.equal(t.host, '8.8.8.8');
  // 白名单外：9.9.9.9 不在列表 → 校验前置，不发 DNS
  await assert.rejects(
    assertSafeTarget('http://9.9.9.9/', { allowedHosts: ['8.8.8.8'] }),
    (e: unknown) => e instanceof AppError && e.code === '1003',
  );
  // 白名单内但解析命中的是私网 → 仍拒绝（校验以解析后 IP 为准）
  await assert.rejects(
    assertSafeTarget('http://127.0.0.1/', { allowedHosts: ['127.0.0.1'] }),
    (e: unknown) => e instanceof AppError && e.code === '1003',
  );
});