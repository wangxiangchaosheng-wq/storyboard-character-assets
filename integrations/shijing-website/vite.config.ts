import { sites } from '@openai/sites-vite-plugin';
import tailwindcss from '@tailwindcss/postcss';
import vinext from 'vinext';
import { defineConfig, loadEnv, type ViteDevServer, type ProxyOptions } from 'vite';
import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const hostingPath = fileURLToPath(new URL('./.openai/hosting.json', import.meta.url));
const hostingConfig: { d1?: string; r2?: string } | null = existsSync(hostingPath)
  ? JSON.parse(readFileSync(hostingPath, 'utf8'))
  : null;

const SITE_CREATOR_PLACEHOLDER_DATABASE_ID =
  '00000000-0000-4000-8000-000000000000';

const { d1, r2 } = hostingConfig ?? {};

// macOS Seatbelt blocks FSEvents, so Codex previews need polling for HMR.
const isCodexSeatbeltSandbox = process.env.CODEX_SANDBOX === 'seatbelt';

const localBindingConfig = {
  main: 'vinext/server/app-router-entry',
  compatibility_flags: ['nodejs_compat'],
  d1_databases: d1
    ? [
        {
          binding: d1,
          database_name: 'site-creator-d1',
          database_id: SITE_CREATOR_PLACEHOLDER_DATABASE_ID,
        },
      ]
    : [],
  r2_buckets: r2
    ? [
        {
          binding: r2,
          bucket_name: 'site-creator-r2',
        },
      ]
    : [],
};

export default defineConfig(async () => {
  // Keep Wrangler and Miniflare state project-local. These are non-secret tool
  // settings; application environment belongs in ignored `.env*` files.
  process.env.WRANGLER_WRITE_LOGS ??= 'false';
  process.env.WRANGLER_LOG_PATH ??= '.wrangler/logs';
  process.env.MINIFLARE_REGISTRY_PATH ??= '.wrangler/registry';

  // Wrangler snapshots its log path while the Cloudflare plugin is imported.
  const hostedPlugins = hostingConfig ? await (async () => {
    const { cloudflare } = await import('@cloudflare/vite-plugin');
    return [sites(), cloudflare({
      viteEnvironment: { name: 'rsc', childEnvironments: ['ssr'] },
      config: localBindingConfig,
    })];
  })() : [];

  const agentEnv = loadEnv('development', process.cwd(), '');
  return {
    css: { postcss: { plugins: [tailwindcss()] } },
    server: {
      ...(isCodexSeatbeltSandbox ? { watch: { useFsEvents: false, usePolling: true } } : {}),
      proxy: {
        '/api/agents': {
          target: agentEnv.AGENT_SERVICE_URL || 'http://127.0.0.1:4318',
          rewrite: (path: string) => path.replace(/^\/api\/agents/, ''),
          configure: (proxy: Parameters<NonNullable<ProxyOptions['configure']>>[0]) => proxy.on('proxyReq', (outgoing, incoming) => {
            // A browser may only call this proxy from the current dev-site origin.
            const origin = incoming.headers.origin;
            let sameOrigin = !origin;
            try { if (origin) sameOrigin = new URL(origin).host === incoming.headers.host; } catch { /* Invalid origins stay rejected by the service. */ }
            if (!sameOrigin) return;
            outgoing.removeHeader('origin');
            if (agentEnv.AGENT_SERVICE_TOKEN) outgoing.setHeader('Authorization', `Bearer ${agentEnv.AGENT_SERVICE_TOKEN}`);
          }),
        },
      },
    },
    plugins: [
      vinext(),
      { name: 'world-write-boundary', configureServer(server: ViteDevServer) {
        server.middlewares.use((req, res, next) => {
          let path = ''; try { path = decodeURIComponent(new URL(req.url || '/', 'http://localhost').pathname).replace(/\/+/g, '/'); } catch { res.writeHead(400); res.end(); return; }
          if (req.method === 'POST' && /^\/api\/agents\/runs\/[^/]+\/(world|world-events)\/?$/.test(path)) {
            res.writeHead(403, {'Content-Type':'application/json; charset=utf-8'});
            res.end(JSON.stringify({error:'世界写入仅供可信服务端调用，网页只能查询或运行独立演示。'})); return;
          }
          next();
        });
      } },
      ...hostedPlugins,
    ],
  };
});
