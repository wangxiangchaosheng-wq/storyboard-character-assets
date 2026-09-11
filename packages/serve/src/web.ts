/**
 * 静态界面（packages/serve/web/）：根路径给单页入口，/app/* 白名单文件。
 * 只暴露三个文件（index.html / app.css / app.js）——不接受任意路径，
 * 天然杜绝目录穿越；文件在启动时读入内存，运行期不碰磁盘。
 */
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';

const WEB_DIR = fileURLToPath(new URL('../web/', import.meta.url));
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
};
const ALLOWED = new Map<string, string>([['index.html', '.html'], ['app.css', '.css'], ['app.js', '.js']]);

const payloads = new Map<string, { body: string; type: string }>();
for (const [file, ext] of ALLOWED) {
  payloads.set(file, { body: readFileSync(WEB_DIR + file, 'utf8'), type: TYPES[ext] });
}

export function registerWebRoutes(app: FastifyInstance): void {
  app.get('/', (_req, reply) => {
    const p = payloads.get('index.html');
    if (!p) return reply.code(404).send({ error: { code: '404', message: '资源不存在' } });
    reply.type(p.type).send(p.body);
  });
  app.get('/app/:file', (req, reply) => {
    const name = (req.params as { file: string }).file;
    const p = payloads.get(name);
    if (!p) return reply.code(404).send({ error: { code: '404', message: '资源不存在' } });
    reply.type(p.type).send(p.body);
  });
}