/**
 * 知乎官方 CLI 读取通道（黑客松 skill 0.5.3+ / zhihu-cli 0.6.0-beta）。
 *
 * 设计约束（docs/11 安全规范）：
 *  - Access Secret 由 zhihu-cli 自行保管（`auth set --secret-stdin` 写入用户目录），
 *    本模块绝不读取、传递或存储任何凭证；
 *  - CLI 二进制定位顺序：ZHIHU_CLI_BIN 环境变量 → 平台标准安装路径；
 *  - CLI 未安装 / 未认证 / 调用失败时一律返回 null，由上层回退到其他抓取策略。
 */
import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

const QUESTION_URL_RE = /zhihu\.com\/question\/(\d+)/;

/** zhihu-cli 用非零退出码 + stdout JSON 报告业务错误（rate limit、未认证等）。
 *  这些属于"可预期的业务失败"，应当重试（退避）而非立刻宣告失败。 */
function parseCliJson(stdout: string | null): { ok: boolean; code?: number; msg?: string } {
  if (!stdout) return { ok: false };
  try {
    const j = JSON.parse(stdout) as { ok?: boolean; Code?: number; Message?: string };
    return {
      ok: j?.ok !== false && (j?.Code === 0 || j?.Code === undefined),
      code: j?.Code,
      msg: j?.Message,
    };
  } catch {
    return { ok: false };
  }
}

/** CLI 返回的业务错误码（rate limit / 未认证 / 无权限）。重试可恢复。 */
function isRetryableCliError(code?: number, msg?: string): boolean {
  if (code === undefined) return false; // 真正的执行失败不重试
  // 30001 = rate limit，30002 = 未认证，30003 = 已登录但额度用完
  return code >= 30000 && code < 40000;
}

/** 定位 zhihu-cli 可执行文件；找不到返回 null */
export function findZhihuCli(): string | null {
  const envBin = String(process.env.ZHIHU_CLI_BIN ?? '').trim();
  if (envBin && existsSync(envBin)) return envBin;
  const candidates =
    process.platform === 'win32'
      ? [join(process.env.LOCALAPPDATA ?? '', 'ZhihuCLI', 'current', 'zhihu-cli.exe')]
      : [
          join(homedir(), '.local', 'share', 'zhihu-cli', 'current', 'zhihu-cli'),
          join(homedir(), '.zhihu-cli', 'current', 'zhihu-cli'),
        ];
  for (const c of candidates) {
    if (c && existsSync(c)) return c;
  }
  return null;
}

/** 从任意 JSON 结构中防御性抽取问题标题与回答摘要文本 */
function extractTitleAndSummaries(root: unknown): { title: string; summaries: string[] } {
  let title = '';
  const summaries: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (v == null || typeof v !== 'object' || depth > 8 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.length > 8) {
        if (/^question_title$|^title$/i.test(k) && !title) title = val.trim();
        else if (/^(summary|content|excerpt|description)$/i.test(k) && val.length > 20) {
          summaries.push(val);
        }
      } else if (val && typeof val === 'object') {
        walk(val, depth + 1);
      }
    }
  };
  walk(root, 0);
  return { title, summaries };
}

/** 从摘要文本中提取候选检索词（去 [图片] 占位；短词频次 + 长专名两类候选） */
function keywordCandidates(summaries: string[]): string[] {
  const STOP = new Set(['我们', '什么', '这个', '那个', '如何', '为什么', '因为', '所以', '但是', '而且', '已经', '应该', '可能', '就是', '不是', '自己', '他们', '还有', '一些', '问题', '回答', '知乎', '时候', '知道', '出现', '内容', '其实', '当时', '后来', '认为', '开始', '现在', '一下', '这些', '那些', '没有', '可以', '这么', '那么', '图片', '编辑', '发布']);
  const cleaned = summaries.slice(0, 5).map((s) => s.replace(/\[[^\]]*\]|【[^】]*】/g, ' '));
  const freq = new Map<string, number>();
  for (const s of cleaned) {
    const runs = s.match(/[\u4e00-\u9fa5]{2,8}/g) ?? [];
    for (const run of runs) {
      // 3 字滑窗（跨词边界的概率低，能捞出土木堡/清高宗/在欧洲这类专名与关键短语）
      for (let i = 0; i + 3 <= run.length; i++) {
        const g = run.slice(i, i + 3);
        if (STOP.has(g)) continue;
        freq.set(g, (freq.get(g) ?? 0) + 1);
      }
    }
  }
  const shortTop = [...freq.entries()].sort((a, b) => b[1] - a[1]).map(([w]) => w);
  const candidates: string[] = [];
  if (shortTop[0] && shortTop[1]) candidates.push(`${shortTop[0]} ${shortTop[1]}`);
  if (shortTop[0] && shortTop[1] && shortTop[2]) candidates.push(`${shortTop[0]} ${shortTop[1]} ${shortTop[2]}`);
  if (shortTop[0]) candidates.push(shortTop[0]);
  return [...new Set(candidates)].filter(Boolean).slice(0, 2);
}

/** search zhihu 反查问题标题：结果链接须含同一 question id（防串题）；尽力而为 */
async function resolveTitleViaSearch(
  bin: string,
  qid: string,
  summaries: string[],
): Promise<string> {
  const candidates = keywordCandidates(summaries);
  for (const query of candidates) {
    try {
      const { stdout } = await execFileP(
        bin,
        ['search', 'zhihu', '--query', query, '--count', '10'],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      );
      const j = JSON.parse(stdout) as { Code?: number; Data?: { Items?: { Url?: string; Title?: string }[] } };
      if (j?.Code !== 0) continue;
      for (const it of j.Data?.Items ?? []) {
        const u = String(it.Url ?? '');
        if (u.includes('/question/' + qid)) {
          return String(it.Title ?? '').replace(/\s*-\s*知乎\s*$/, '').trim();
        }
      }
    } catch {
      /* 单次检索失败 → 试下一候选 */
    }
  }
  // 反查失败：用首条摘要的有信息前缀作题面（正文素材完整，考据司仍可提实体）
  const first = (summaries[0] ?? '').replace(/\[[^\]]*\]|【[^】]*】/g, ' ').replace(/\s+/g, ' ').trim();
  return first.slice(0, 40);
}

export interface ZhihuRead {
  title: string;
  body: string;
}

/**
 * 通过官方 CLI 读取知乎问题的回答摘要。
 * 失败（未装/未认证/网络）返回 null；
 * rate-limit / 登录态过期等可预期业务错误会重试 2 次（退避），再失败才返回 null。
 */
export async function readZhihuViaCli(url: string): Promise<ZhihuRead | null> {
  const bin = findZhihuCli();
  if (!bin) return null;
  const m = url.match(QUESTION_URL_RE);
  if (!m) return null;
  const qUrl = `https://www.zhihu.com/question/${m[1]}`;
  // 最多重试 2 次（含首次），退避 1s / 3s
  const maxAttempts = 3;
  const delays = [0, 1000, 3000];
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    if (attempt > 0) await new Promise((r) => setTimeout(r, delays[attempt]));
    let stdout: string | undefined;
    let stderr: string | undefined;
    try {
      const res = await execFileP(
        bin,
        ['question', 'answers', '--question-url', qUrl, '--limit', '10'],
        { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      );
      // promisify(execFile) 的返回类型不含 exit code；通过 stdout 里的 JSON 判断业务状态
      stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString() : res.stdout;
      stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString() : res.stderr;
    } catch (e: unknown) {
      // 非零退出码时 Node 会把 stdout/stderr 挂到 error 对象上（而非抛出纯 Error）
      const err = e as { stdout?: unknown; stderr?: unknown };
      stdout = err.stdout != null ? (Buffer.isBuffer(err.stdout) ? err.stdout.toString() : String(err.stdout)) : undefined;
      stderr = err.stderr != null ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString() : String(err.stderr)) : undefined;
    }
    const parsed = parseCliJson(stdout ?? null);
    // 成功的业务响应（ok=true / Code=0）
    if (parsed.ok) {
      const j = JSON.parse(stdout!) as { ok?: boolean };
      const { title: cliTitle, summaries } = extractTitleAndSummaries(j);
      if (!summaries.length) continue;
      const body = summaries
        .slice(0, 8)
        .map((s, i) => `回答${i + 1}：${s.replace(/\s+/g, ' ').slice(0, 500)}`)
        .join('\n');
      if (body.length < 40) continue;
      const title = cliTitle || (await resolveTitleViaSearch(bin, m[1], summaries));
      return { title, body };
    }
    // 可重试的业务错误（rate limit / 未认证 / 额度耗尽）
    if (isRetryableCliError(parsed.code, parsed.msg) && attempt < maxAttempts - 1) {
      console.warn(`[zhihu-cli] attempt ${attempt + 1} failed (${parsed.code}:${parsed.msg})，退避重试...`);
      continue;
    }
    // 不可恢复（找不到 CLI、真正的执行失败、或重试耗尽）
    if (stderr) console.warn(`[zhihu-cli] stderr: ${stderr.slice(0, 120)}`);
    return null;
  }
  return null;
}
