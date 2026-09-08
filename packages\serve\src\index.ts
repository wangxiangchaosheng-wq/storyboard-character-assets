/**
 * serve 入口（docs/05）：读环境变量监听端口；生产/本地共用同一 buildServer。
 * PORT 缺省 8787；LOG_LEVEL 缺省 info；DB_PATH 缺省 .data/sim.sqlite（落盘，重启不丢局）。
 *
 * 启动自检（审查工作流）：根 review/report.json 是 `pnpm review` 的产物——
 *   12h 内审查通过 → INFO 摘要；缺失/过期/未通过 → WARN 提示先跑 `pnpm review`
 *   （仅提示不阻塞监听；REVIEW_FILE / REVIEW_MAX_AGE_H 可覆盖路径与有效期）。
 */
import { mkdirSync, existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { buildServer } from './server.ts';

const REVIEW_FILE = process.env.REVIEW_FILE
  ? resolve(process.env.REVIEW_FILE)
  : join(resolve(import.meta.dirname, '../../..'), 'review', 'report.json');
const REVIEW_MAX_AGE_H = Number(process.env.REVIEW_MAX_AGE_H ?? 12);
const REVIEW_TTL = Number.isFinite(REVIEW_MAX_AGE_H) && REVIEW_MAX_AGE_H > 0 ? REVIEW_MAX_AGE_H : 12;

function startupAudit(): { ok: boolean; note: string } {
  try {
    if (existsSync(REVIEW_FILE)) {
      const rep = JSON.parse(readFileSync(REVIEW_FILE, 'utf8')) as {
        conclusion?: string; finishedAt?: string; okCount?: number; total?: number;
      };
      // 报告字段校验：缺失/异常一律按「未通过」处理（不会把坏报告当成通过）
      const finishedMs = rep.finishedAt ? new Date(rep.finishedAt).getTime() : NaN;
      const ageH = Number.isFinite(finishedMs) ? (Date.now() - finishedMs) / 3_600_000 : Infinity;
      if (rep.conclusion === 'pass' && ageH <= REVIEW_TTL) {
        return {
          ok: true,
          note: `启动审查通过（${rep.okCount ?? '?'} / ${rep.total ?? '?'} 项 · ${new Date(finishedMs).toLocaleString('zh-CN')}）`,
        };
      }
      return {
        ok: false,
        note: Number.isFinite(finishedMs) && ageH > REVIEW_TTL
          ? `审查报告已过期（${ageH.toFixed(1)}h > ${REVIEW_TTL}h），请先运行 pnpm review`
          : '最近一次审查未通过或报告不完整（见 review/report.json），请先运行 pnpm review',
      };
    }
    return { ok: false, note: '未找到审查报告（review/report.json），请先运行 pnpm review' };
  } catch (err) {
    return { ok: false, note: `审查报告读取失败：${err instanceof Error ? err.message : String(err)}` };
  }
}

const port = Number(process.env.PORT ?? 8787);
const dbPath = process.env.DB_PATH
  ? resolve(process.env.DB_PATH)
  : resolve('.data', 'sim.sqlite');
mkdirSync(dirname(dbPath), { recursive: true });
const { app } = buildServer({ dbPath });

try {
  await app.listen({ port, host: '0.0.0.0' });
  app.log.info(`@sim/serve 已监听 http://0.0.0.0:${port}`);
  const audit = startupAudit();
  if (audit.ok) app.log.info('[启动自检] ' + audit.note);
  else app.log.warn('[启动自检] ' + audit.note);
} catch (err) {
  app.log.error(err);
  process.exit(1);
}