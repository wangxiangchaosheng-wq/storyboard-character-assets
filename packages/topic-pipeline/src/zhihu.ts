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

export interface ZhihuRead {
  title: string;
  body: string;
}

/**
 * 通过官方 CLI 读取知乎问题的回答摘要。
 * 失败（未装/未认证/网络）一律返回 null，不做二次包装。
 */
export async function readZhihuViaCli(url: string): Promise<ZhihuRead | null> {
  const bin = findZhihuCli();
  if (!bin) return null;
  const m = url.match(QUESTION_URL_RE);
  if (!m) return null;
  const qUrl = `https://www.zhihu.com/question/${m[1]}`;
  try {
    const { stdout } = await execFileP(
      bin,
      ['question', 'answers', '--question-url', qUrl, '--limit', '10'],
      { timeout: 30_000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
    );
    const j = JSON.parse(stdout) as { ok?: boolean };
    if (j?.ok === false) return null;
    const { title, summaries } = extractTitleAndSummaries(j);
    if (!summaries.length) return null;
    // 摘要拼接为考据正文（每条限 500 字，最多 8 条）
    const body = summaries
      .slice(0, 8)
      .map((s, i) => `回答${i + 1}：${s.replace(/\s+/g, ' ').slice(0, 500)}`)
      .join('\n');
    if (body.length < 40) return null;
    return { title, body };
  } catch {
    return null;
  }
}
