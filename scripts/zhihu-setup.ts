#!/usr/bin/env node
/**
 * 知乎 CLI 一键检测与安装助手
 *
 * 用法:
 *   node --experimental-strip-types scripts/zhihu-setup.ts              # 检测当前状态
 *   node --experimental-strip-types scripts/zhihu-setup.ts --install    # 显示安装指引
 *   node --experimental-strip-types scripts/zhihu-setup.ts --verify     # 仅验证认证状态
 *
 * 功能:
 *   1. 定位 zhihu-cli 可执行文件
 *   2. 检查 Access Secret 认证状态
 *   3. 给出安装/重新认证指引
 *   4. 测试一次读取（验证 CLI 可用）
 */

import { execFile } from 'node:child_process';
import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';

const execFileP = promisify(execFile);

// ── 定位 CLI ────────────────────────────────────────────────────────────────
function findZhihuCli(): string | null {
  const envBin = String(process.env.ZHIHU_CLI_BIN ?? '').trim();
  if (envBin && existsSync(envBin)) return envBin;

  const candidates: string[] = [];
  if (process.platform === 'win32') {
    const localAppData = process.env.LOCALAPPDATA ?? '';
    candidates.push(join(localAppData, 'ZhihuCLI', 'current', 'zhihu-cli.exe'));
  } else {
    candidates.push(join(homedir(), '.local', 'share', 'zhihu-cli', 'current', 'zhihu-cli'));
    candidates.push(join(homedir(), '.zhihu-cli', 'current', 'zhihu-cli'));
  }
  return candidates.find((c) => existsSync(c)) ?? null;
}

// ── 运行 CLI 命令 ────────────────────────────────────────────────────────────
async function runCli(
  bin: string,
  args: string[],
): Promise<{ ok: boolean; stdout: string; stderr: string; code: number | null }> {
  try {
    const res = await execFileP(bin, args, { timeout: 15_000, maxBuffer: 1024 * 1024 });
    const stdout = Buffer.isBuffer(res.stdout) ? res.stdout.toString() : res.stdout;
    const stderr = Buffer.isBuffer(res.stderr) ? res.stderr.toString() : res.stderr;
    return { ok: true, stdout, stderr, code: res.status };
  } catch (e: unknown) {
    const err = e as { stdout?: unknown; stderr?: unknown; status?: number };
    const stdout = err.stdout != null ? (Buffer.isBuffer(err.stdout) ? err.stdout.toString() : String(err.stdout)) : '';
    const stderr = err.stderr != null ? (Buffer.isBuffer(err.stderr) ? err.stderr.toString() : String(err.stderr)) : '';
    return { ok: false, stdout, stderr, code: err.status ?? null };
  }
}

// ── 从 CLI JSON 中提取回答摘要 ───────────────────────────────────────────────
function extractSummaries(j: Record<string, unknown>): string[] {
  const results: string[] = [];
  const seen = new Set<unknown>();
  const walk = (v: unknown, depth: number) => {
    if (v == null || typeof v !== 'object' || depth > 6 || seen.has(v)) return;
    seen.add(v);
    if (Array.isArray(v)) {
      for (const item of v) walk(item, depth + 1);
      return;
    }
    for (const [k, val] of Object.entries(v as Record<string, unknown>)) {
      if (typeof val === 'string' && val.length > 20) {
        if (/^(summary|content|excerpt|description)$/i.test(k)) {
          results.push(val);
        }
      } else if (val && typeof val === 'object') {
        walk(val, depth + 1);
      }
    }
  };
  walk(j, 0);
  return results.slice(0, 2);
}

// ── 主逻辑 ───────────────────────────────────────────────────────────────────
async function main() {
  const args = process.argv.slice(2);
  const mode = args[0] ?? 'check';

  const bin = findZhihuCli();

  console.log('\n═══════════════════════════════════════════════');
  console.log('  知乎 CLI 检测助手');
  console.log('═══════════════════════════════════════════════\n');

  // 1. 定位
  console.log('【1】zhihu-cli 位置');
  if (bin) {
    console.log(`  ✓ 已找到: ${bin}`);
  } else {
    console.log('  ✗ 未找到');
    showInstallGuide();
    console.log();
    return;
  }

  // 2. 认证状态
  console.log('\n【2】Access Secret 认证状态');
  const authResult = await runCli(bin, ['auth', 'status']);
  try {
    const j = JSON.parse(authResult.stdout) as { ok?: boolean; source?: string; masked?: string; last_verified_at?: string; Code?: number; Message?: string };
    if (j?.ok) {
      console.log(`  ✓ 已认证（source: ${j.source ?? 'keychain'}）`);
      if (j.masked) console.log(`    Token: ${j.masked}`);
      if (j.last_verified_at) console.log(`    最后验证: ${j.last_verified_at}`);
    } else if (j?.Code === 30002 || j?.Code === 30003) {
      console.log(`  ✗ 认证失效（code: ${j.Code}）`);
      console.log(`    ${j.Message ?? '请重新认证'}`);
      showInstallGuide();
    } else {
      console.log('  ? 认证状态未知');
      console.log(`    ${authResult.stdout.slice(0, 120)}`);
    }
  } catch {
    console.log(`  ? 无法解析: ${authResult.stdout.slice(0, 80)}${authResult.stderr?.slice(0, 40)}`);
  }

  // 3. 连通性测试
  if (mode !== 'install') {
    console.log('\n【3】连通性测试（读取一个公开问题）');
    const testResult = await runCli(bin, [
      'question', 'answers',
      '--question-url', 'https://www.zhihu.com/question/2022087207087875165',
      '--limit', '1',
    ]);
    try {
      const j = JSON.parse(testResult.stdout) as { ok?: boolean; Code?: number; Message?: string };
      if (j?.ok || j?.Code === 0) {
        const summaries = extractSummaries(j as Record<string, unknown>);
        console.log(`  ✓ CLI 工作正常（获取到 ${summaries.length} 条回答摘要）`);
        if (summaries.length > 0) {
          console.log(`    示例: ${summaries[0].slice(0, 60)}…`);
        }
      } else if (j?.Code === 30001) {
        console.log('  ⏳ 触发 rate limit（1次/分钟配额），请稍后重试');
      } else {
        console.log(`  ✗ CLI 返回错误: ${j?.Message ?? 'unknown'}`);
      }
    } catch {
      const err = testResult.stderr?.trim() || testResult.stdout?.trim();
      console.log(`  ✗ CLI 执行失败: ${err?.slice(0, 100)}`);
    }
  }

  console.log('\n═══════════════════════════════════════════════\n');
}

function showInstallGuide() {
  console.log('\n  【安装指引】\n');
  if (process.platform === 'win32') {
    console.log('  方式一（推荐）: 从官网下载 Windows 安装包');
    console.log('    https://developer.zhihu.com/zhihu-cli/releases\n');
    console.log('  方式二: 使用 winget（如有）');
    console.log('    winget install Zhihu.CLI\n');
  } else {
    console.log('  方式一: 使用包管理器');
    console.log('    brew install zhihu-cli   # macOS');
    console.log('    # 或下载:');
    console.log('    https://developer.zhihu.com/zhihu-cli/releases\n');
  }
  console.log('  安装后确认路径:');
  console.log('    Windows: %LOCALAPPDATA%\\ZhihuCLI\\current\\zhihu-cli.exe');
  console.log('    macOS:   ~/.local/share/zhihu-cli/current/zhihu-cli');
  console.log('    Linux:   ~/.local/share/zhihu-cli/current/zhihu-cli\n');
  console.log('  认证:');
  console.log('    zhihu-cli auth set --secret-stdin');
  console.log('    # 粘贴 Access Secret（从 https://developer.zhihu.com/apis 获取）');
}

main().catch((e) => {
  console.error('错误:', e.message);
  process.exit(1);
});
