/**
 * 把 steam/*.ts 预编译成同目录的 *.mjs。
 *
 * 为什么需要：sidecar 在 Electron 壳里是 `process.execPath` 拉起的独立进程，跑的是 Electron
 * 自带的 Node（33.x → Node 20.18.3），**没有类型剥离能力**（要 22.18+）。agents/src 里那套
 * `require('../../steam/*.ts')` 运行时桥接在开发机（Node 24）上全绿，到了真机上
 * achievements / saves / cloud-save 三个路由会全部 500——而 node --test 全跑系统 Node，
 * 复现不了这条路径（M7 的布局实测也只起了系统 node）。
 *
 * 输出与 .ts 同目录同基名（.mjs），所以 `../../steam/achievements.mjs` 与
 * `../../steam/achievements.ts` 在开发态和打包态都能解析到——打包态 extraResources 把整个
 * steam/ 搬进 resources/steam/，相对路径不变。
 *
 * 注意：仓库 package.json 是 "type":"module"，tsc 会把 *.ts emit 成 *.js；这里再改名成 *.mjs，
 * 避免 require() 一个 ESM .js 时踩 Node 版本的 ERR_REQUIRE_ESM 差异。
 */
import { spawnSync } from 'node:child_process';
import { existsSync, readdirSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const tsconfig = join(HERE, 'tsconfig.json');
if (!existsSync(tsconfig)) {
  console.error('steam/build.mjs：找不到 steam/tsconfig.json');
  process.exit(1);
}

// 只清 tsc 自己会 emit 的 *.js（type:module 包下 .ts → .js）。**绝不能删 *.mjs**：
// index.mjs 是 electron 壳的适配入口，steam.test.mjs 是测试，删了不报错但功能直接没了。
for (const f of readdirSync(HERE)) {
  if (f.endsWith('.js')) rmSync(join(HERE, f));
}
rmSync(join(HERE, '.tmp-out'), { recursive: true, force: true });

const bin = join(HERE, '..', 'node_modules', 'typescript', 'bin', 'tsc');
const run = spawnSync(process.execPath, [bin, '-p', tsconfig], { cwd: HERE, stdio: 'inherit' });
if (run.status !== 0) {
  console.error('steam/*.ts 预编译失败——打包态 Electron 的 Node 20 加载不了 .ts，成就/存档/云存档会 500');
  process.exit(1);
}

// tsc 会顺着 import 链把 agents/src/*.ts 一并 emit 到 outDir 下（.tmp-out/agents/...），
// 而 steam 自己的产物在 .tmp-out/steam/。只取后者，其余整棵删掉。
const tmp = join(HERE, '.tmp-out');
if (!existsSync(tmp)) {
  console.error('steam/*.ts 预编译没有产出 .tmp-out');
  process.exit(1);
}
const inner = join(tmp, 'steam');
if (!existsSync(inner)) {
  console.error(`预编译产物缺少 ${inner}`);
  process.exit(1);
}
// .js → .mjs：require() ESM 的扩展名在不同 Node 版本上行为不一致，统一用 .mjs 最稳。
const renamed = [];
for (const f of readdirSync(inner)) {
  if (!f.endsWith('.js')) continue;
  const to = f.slice(0, -3) + '.mjs';
  renameSync(join(inner, f), join(HERE, to));
  renamed.push(to);
}
rmSync(tmp, { recursive: true, force: true });
console.log(`steam/*.ts 已预编译为 .mjs：${renamed.join(', ') || '(无)'}`);
