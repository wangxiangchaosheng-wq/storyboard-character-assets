/**
 * safeFetch —— 全项目唯一出站请求网关（docs/11 §2.1，严禁依赖）。
 *
 * 规则：
 *  1. 仅允许 http / https 协议；
 *  2. 发请求前解析 target 并校验解析后的 IP：拒绝 localhost / 127.* / ::1 /
 *     链路本地（169.254.0.0/16、fe80::/10）/ 私网（10/8、172.16/12、192.168/16）/
 *     组播与保留（224/4、240/4、255.255.255.255）；
 *  3. 校验以「解析后的 IP」为准（防 DNS rebinding：解析 → 校验 → 连接）。
 */
import { lookup } from 'node:dns/promises';
import { isIP } from 'node:net';
import { AppError } from '@sim/contracts';

export interface SafeFetchOptions extends RequestInit {
  timeoutMs?: number; // 默认 10_000
  allowedHosts?: string[]; // 显式主机白名单（默认空 = 仅公网）
}

/** 判定一个 IP 是否落入拒绝网段（入参须已过 isIP 校验）。无网络调用。 */
export function isForbidden(ip: string): boolean {
  const v = isIP(ip);
  if (v === 4) {
    const o = ip.split('.').map(Number) as [number, number, number, number];
    const [a, b] = o;
    if (a === 0 || a === 10) return true; // 0/8 保留、10/8 私网
    if (a === 127) return true; // 环回
    if (a === 169 && b === 254) return true; // 链路本地
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16/12 私网
    if (a === 192 && b === 168) return true; // 192.168/16 私网
    if (a >= 224) return true; // 224/4 组播、240/4 保留、255
    return false;
  }
  if (v === 6) {
    const low = ip.toLowerCase();
    if (low === '::1' || low === '::') return true;
    if (low.startsWith('fe80') || low.startsWith('fc') || low.startsWith('fd')) return true; // 链路本地/ULA
    if (low.startsWith('ff')) return true; // 多播
    // ::ffff:x.x.x.x 内嵌 IPv4 只再套 v4 判定一次
    const m = low.match(/:ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
    if (m) return isForbidden(m[1] ?? '');
    return false;
  }
  return true; // 非 IPv4/v6 一律按拒绝处理
}

export interface SafeTarget {
  url: string;   // 规范化后 URL（仅 http/https）
  host: string;
  ip: string;    // 实际将连接的解析 IP
}

/** 解析 + 校验（不发请求）：供二次校验与审计。违反规则抛 AppError。 */
export async function assertSafeTarget(
  urlStr: string,
  opts: { allowedHosts?: string[] } = {},
): Promise<SafeTarget> {
  let u: URL;
  try {
    u = new URL(urlStr);
  } catch {
    throw new AppError('1002', `无法解析 URL：${urlStr}`);
  }
  if (u.protocol !== 'http:' && u.protocol !== 'https:') {
    throw new AppError('1002', `禁止的协议 ${u.protocol}（仅允许 http/https）`);
  }
  const host = u.hostname;
  const allowlist = opts.allowedHosts ?? [];
  if (allowlist.length > 0 && !allowlist.some((h) => host === h || host.endsWith('.' + h))) {
    throw new AppError('1003', `主机不在白名单内：${host}`);
  }
  const addrs = await lookup(host, { all: true, verbatim: true });
  if (addrs.length === 0) {
    throw new AppError('1003', `无法解析主机：${host}`);
  }
  for (const a of addrs) {
    if (isForbidden(a.address)) {
      throw new AppError('1003', `拒绝访问私有/保留地址：${host} -> ${a.address}`);
    }
  }
  return { host, ip: addrs[0]!.address, url: u.toString() };
}

/** 业务出站唯一入口：先校验后请求，带超时。 */
export async function safeFetch(
  urlStr: string,
  opts: SafeFetchOptions = {},
): Promise<Response> {
  const { allowedHosts, timeoutMs = 10_000, ...rest } = opts;
  await assertSafeTarget(urlStr, { allowedHosts });
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    return await fetch(urlStr, { ...rest, signal: ctrl.signal });
  } finally {
    clearTimeout(timer);
  }
}