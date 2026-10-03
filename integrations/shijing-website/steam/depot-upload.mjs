/**
 * Steam depot 上传（steamcmd / SteamPipe）。
 *
 * 四个模式，按对 appid 的依赖程度分：
 *   check     真机预检：跑一次 steamcmd 自己（anonymous 登录即可，不需要 appid/凭据），
 *             确认这台机器上的 steamcmd 真的能起来并联网握手。
 *   validate  解析 env + 出 VDF 到 out/，不碰 steamcmd——appid 都没有也能跑通（本仓提交态）
 *   dry-run   同 validate，额外打印将要执行的完整 steamcmd 命令行——同样不需要 appid
 *   upload    校验通过后才真正 spawn steamcmd（需要 App ID、depot id 与 Steamworks 账号）
 *
 * 账号密码一律从环境变量读（`STEAM_USERNAME` / `STEAM_PASSWORD`），本文件与 out/ 产物
 * 都不含任何凭据——测试用正则把守这条。密码**不上命令行**：Windows 上任何进程都能读到
 * 别人的命令行，所以密码走子进程 stdin，`+login` 只带用户名。
 *
 * 产物（默认 out/，在 .gitignore 里）：
 *   app.vdf          AppBuild，引用下面的 depot 文件
 *   depot_win.vdf    Windows depot 的 FileMapping
 *
 * 用法：
 *   node steam/depot-upload.mjs check          # 真机预检，无需任何配置
 *   node steam/depot-upload.mjs validate
 *   node steam/depot-upload.mjs dry-run
 *   node steam/depot-upload.mjs upload [--yes]
 *
 * 相关环境变量：
 *   STEAM_APP_ID          App ID（upload 必需）
 *   STEAM_DEPOT_ID_WIN    Windows depot ID。**不从 appid 推导**：depot id 是后台创建
 *                         depot 时分配的，猜中了是巧合。upload 前必须显式设。
 *   STEAM_DEPOT_ID_MAC / _LINUX + STEAM_DEPOT_MAC_CONTENT_ROOT / _LINUX_CONTENT_ROOT
 *                         可选；四样都给齐才会在 AppBuild 里列对应 depot。mac/linux 包
 *                         必须在各自平台构建，这里只负责把它们编进同一个构建。
 *   STEAM_CONTENT_ROOT    Windows 内容根；显式设了就只认它、不回落
 *   STEAM_BUILD_DESC      构建描述（默认自动生成）
 *   STEAM_SET_LIVE        设了才把构建切到该分支（default 或后台 beta 分支名）
 *   STEAMCMD              steamcmd.exe 路径，缺省在 PATH 上找
 *   STEAM_USERNAME        Steamworks 合作伙伴账号名。**upload 必需**——anonymous 会话
 *                         没有上传构建的权限，steamcmd 会失败。
 *   STEAM_PASSWORD        密码，只从环境变量读，经 stdin 传给 steamcmd
 */
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, resolve } from 'node:path';

const HERE = fileURLToPath(new URL('.', import.meta.url));
const ROOT = resolve(HERE, '..');

/** 占位常量，不是配置：没有 appid 时用来让 VDF 仍能被写出来、被审阅。 */
const PLACEHOLDER_APP_ID = '480'; // Valve 官方测试应用 SpaceWar，任何 app 上传前都能练手

/**
 * 内容根：打包出的 win-unpacked 目录。electron:pack 用 SHIJING_PACK_OUTPUT 改盘时这里跟着走。
 *
 * 显式设了 STEAM_CONTENT_ROOT 就**只认它、不回落**：操作者明确指了路径，它不存在要说
 * 「不存在」，而不是默默改用另一棵树——那会把旧构建传上去，是最难查的一类事故。
 * 回落链只在什么都没设的时候走，先找 electron-builder 的默认输出（`release/win-unpacked`，
 * 见 electron-builder.yml 的 directories.output），再找本机改盘后的常用位置。
 */
export function resolveContentRoot(env = process.env) {
  const explicit = env.STEAM_CONTENT_ROOT?.trim();
  if (explicit) {
    const p = resolve(explicit);
    return { path: p, exists: existsSync(p) };
  }
  const candidates = [];
  if (env.SHIJING_PACK_OUTPUT?.trim()) candidates.push(join(resolve(env.SHIJING_PACK_OUTPUT.trim()), 'win-unpacked'));
  candidates.push(join(ROOT, 'release', 'win-unpacked'));
  candidates.push('D:/shijing-release/win-unpacked');
  for (const r of candidates) {
    const p = resolve(r);
    if (existsSync(p)) return { path: p, exists: true };
  }
  return { path: resolve(candidates[0]), exists: false };
}

/** 显式内容根（mac/linux 用）：设了就只认它，不参与回落链。 */
export function resolveExplicitRoot(raw) {
  if (!raw?.trim()) return null;
  const p = resolve(raw.trim());
  return { path: p, exists: existsSync(p) };
}

function arg(names, fallback) {
  for (const n of names) {
    const i = process.argv.indexOf(n);
    if (i !== -1 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')) return process.argv[i + 1];
  }
  return fallback;
}
function flag(names) { return names.some((n) => process.argv.includes(n)); }

/**
 * 把 Windows 路径转成 VDF 字符串里**不带反斜杠**的形态。
 *
 * 为什么不用反斜杠：VDF 对 `\` 是不是转义符，各实现不一致——Valve 自己的 app-build.vdf
 * 示例里 `ContentRoot` 写的是单反斜杠（`D:\build_output\`），而 `@node-steam/vdf` 解析时
 * 又不把 `\\` 复义回 `\`。写 `\\` 的话，按转义解析就对了，不按转义解析就得到字面上的
 * 双反斜杠路径、文件找不到；写 `\` 则在另一端有反效果。**两边都可能错的事不能赌。**
 *
 * 正斜杠在任何 VDF 变体里都不是转义符，两种解析语义下结果一致，Windows API 也照常接受。
 * 所以这里统一转成正斜杠，让「路径在不在」与「VDF 怎么解析」解耦。
 */
function vdfPath(p) {
  return String(p).split('\\').join('/');
}

/**
 * 渲染 AppBuild。模板只含非机密标识；appid/depotid/路径/描述由调用方注入。
 * 用整串替换而不是正则，避免模板里出现 ${...} 之类字符时被误当占位符。
 */
export function renderAppBuild(spec) {
  const tpl = readFileSync(join(HERE, 'app-build.vdf.template'), 'utf8');
  const depotLines = spec.depots.map((d) => `\t\t"${d.id}" "depot_${d.platform}.vdf"`).join('\n');
  return tpl
    .split('__APP_ID__').join(spec.appId)
    .split('__DESC__').join(spec.desc)
    .split('__CONTENT_ROOT__').join(vdfPath(spec.contentRoot))
    .split('__BUILD_OUTPUT__').join(vdfPath(spec.buildOutput))
    .split('__SET_LIVE__').join(spec.setLive ? `\t"SetLive" "${spec.setLive}"` : '\t// 未设 STEAM_SET_LIVE：只上传构建，不切换到任何分支')
    .split('__DEPOT_LINES__').join(depotLines);
}

/**
 * 渲染某个平台的 depot VDF。win 用 win-unpacked 模板（exe 就在安装目录顶层）；
 * mac/linux 用同一套模板但内容根来自各自的 *_CONTENT_ROOT——它们的包结构不同
 * （.app bundle / AppImage），FileMapping 的注释里写明了这一点，映射规则本身一致。
 */
export function renderDepotBuild(spec, depot) {
  const tpl = readFileSync(join(HERE, 'depot_build_win.vdf.template'), 'utf8');
  return tpl
    .split('__DEPOT_ID__').join(depot.id)
    .split('__CONTENT_ROOT__').join(vdfPath(depot.contentRoot));
}

/** 兼容旧测试/调用方：等价于 renderDepotBuild(spec, win depot)。 */
export function renderDepotWin(spec) {
  const win = spec.depots.find((d) => d.platform === 'win') ?? { id: spec.depotId, contentRoot: spec.contentRoot };
  return renderDepotBuild(spec, win);
}

/**
 * 组装上传规格。缺 appid 用占位值并标 needsAppId——上传前由 requireUpload() 拦掉。
 *
 * depot id 一律要显式给：depot id 是 Steamworks 后台创建 depot 时分配的，**不能从 appid
 * 推导**（`<appid>1` 只是常见巧合）。猜中的概率不高，猜错的代价是白耗一轮排错。
 */
export function buildSpec(env = process.env, opts = {}) {
  const appIdRaw = env.STEAM_APP_ID?.trim() || '';
  const appId = appIdRaw || PLACEHOLDER_APP_ID;
  const depotWin = env.STEAM_DEPOT_ID_WIN?.trim() || '';
  const winRoot = resolveContentRoot(env);
  const outDir = opts.outDir ? resolve(opts.outDir) : join(ROOT, 'out');
  const desc = env.STEAM_BUILD_DESC?.trim()
    || `史境 ${env.npm_package_version || 'dev'} build ${new Date().toISOString().slice(0, 10)}`;
  const depots = [{ platform: 'win', id: depotWin, contentRoot: winRoot.path, rootExists: winRoot.exists }];
  // mac/linux：id 和内容根四样给齐才收。只给 id 不收——AppBuild 会引用一个永远不存在的
  // depot_*.vdf，steamcmd 加载 AppBuild 时就整个构建失败。
  for (const [p, idVar, rootVar] of [
    ['mac', 'STEAM_DEPOT_ID_MAC', 'STEAM_DEPOT_MAC_CONTENT_ROOT'],
    ['linux', 'STEAM_DEPOT_ID_LINUX', 'STEAM_DEPOT_LINUX_CONTENT_ROOT'],
  ]) {
    const id = env[idVar]?.trim() || '';
    const root = resolveExplicitRoot(env[rootVar]);
    if (id && root) depots.push({ platform: p, id, contentRoot: root.path, rootExists: root.exists });
  }
  return {
    appId, needsAppId: !appIdRaw, depotId: depotWin, desc,
    needsDepotIdWin: !depotWin,
    contentRoot: winRoot.path, contentRootExists: winRoot.exists,
    outDir, buildOutput: join(outDir, 'steam-build'),
    setLive: env.STEAM_SET_LIVE?.trim() || '',
    depots,
  };
}

/**
 * upload 的硬前置，一项都不许猜：appid、win depot id、内容根、账号名、steamcmd。
 * 全部列出来而不是报第一个就停——一次跑完省得反复试。
 */
export function requireUpload(env = process.env, spec = buildSpec(env), execPath) {
  const missing = [];
  if (spec.needsAppId) missing.push('STEAM_APP_ID（Steamworks 后台的 App ID）');
  // depot id 不能从 appid 推导，缺了就必须显式要
  if (spec.needsDepotIdWin) missing.push('STEAM_DEPOT_ID_WIN（后台创建 depot 时分配的 ID，不从 appid 推导）');
  for (const d of spec.depots) {
    if (!d.rootExists) {
      missing.push(`内容根 ${d.platform}（${d.contentRoot} 不存在——先打包，或设对应的 *_CONTENT_ROOT）`);
    } else {
      // 目录在 ≠ 是能用的构建。实测踩过：项目内 release/win-unpacked 是修复前的旧包，
      // 缺 resources/node_modules/steamworks.js。按默认值传上去，玩家拿到的是没有
      // Steam 支持的构建。所以对内容根的**内容**做校验，不只验目录存在。
      const broken = checkContentRoot(d.contentRoot);
      if (broken.length) missing.push(`内容根 ${d.platform} 不完整（${d.contentRoot} 缺 ${broken.join('、')}——重新 npm run electron:pack）`);
    }
  }
  // anonymous 会话没有上传构建的权限，缺用户名必然失败
  if (!env.STEAM_USERNAME?.trim()) missing.push('STEAM_USERNAME（上传需要 Steamworks 合作伙伴账号；anonymous 无权上传）');
  const cmd = findSteamcmd(env, execPath);
  if (!cmd) missing.push(`steamcmd（PATH 上找不到；装好后可用 STEAMCMD 指到 steamcmd.exe，本机装在 D:/steamcmd/steamcmd.exe）`);
  return { ok: missing.length === 0, missing, steamcmd: cmd };
}

/**
 * 内容根里必须有的东西。这些是「这份构建是这次的」的判据，缺任何一样就说明是旧包
 * 或不完整包——传上去不会有任何报错，只会安静地发一个坏版本给玩家。
 */
const REQUIRED_IN_CONTENT_ROOT = [
  ['史境.exe', '可执行文件'],
  ['resources/steam/steam.mjs', 'Steam 桥接预编译产物'],
  ['resources/node_modules/steamworks.js', 'Steamworks 原生模块（2026-09-22 起进包）'],
];
/** 返回缺失项的人类可读描述；空数组表示完整。目录不存在时按「全缺」处理。 */
export function checkContentRoot(root) {
  const missing = [];
  for (const [rel, label] of REQUIRED_IN_CONTENT_ROOT) {
    if (!existsSync(join(root, ...rel.split('/')))) missing.push(label);
  }
  return missing;
}

/**
 * 非 ASCII 路径警告。steamcmd 是 C++ 程序，VDF 是 UTF-8 无 BOM；若它按系统 ANSI 码页
 * （简中 Windows 上就是 936）解析，CJK 路径会乱码、内容根找不到。**这一点无法在本机
 * 验证**（没有 appid 跑不了 run_app_build），所以不猜，只把风险和一条确定的绕法告诉人。
 */
export function nonAsciiPaths(spec) {
  const hits = [];
  if (/[^\x20-\x7E]/.test(spec.contentRoot)) hits.push(`内容根 ${spec.contentRoot}`);
  if (/[^\x20-\x7E]/.test(spec.outDir)) hits.push(`产物目录 ${spec.outDir}`);
  return hits;
}

/**
 * 在 PATH 上找 steamcmd，再退回本机常见安装位置。找不到返回 null（不抛）。
 *
 * 为什么要「常见位置」这一层：steamcmd 装完默认不在 PATH 上（Valve 从没把自己加进去），
 * 只认 PATH 会让「明明装了却报找不到」——门禁因此常红，而人每次都得手动设 STEAMCMD。
 * 常见位置是**只读探测**，装了就认，没装就当没有。
 */
export function findSteamcmd(env = process.env, execPath = (c, a) => spawnSync(c, a, { encoding: 'utf8' })) {
  const explicit = env.STEAMCMD?.trim();
  if (explicit) {
    // 指了就得存在——指到不存在的路径是配置错误，报出来让人改，别默默回落到别处
    return existsSync(explicit) ? { command: explicit, source: 'STEAMCMD 环境变量' } : null;
  }
  const probe = process.platform === 'win32' ? 'where' : 'which';
  const r = execPath(probe, ['steamcmd'], { encoding: 'utf8' });
  const hit = (r.stdout || '').split(/\r?\n/).map((s) => s.trim()).find(Boolean);
  if (hit) return { command: hit, source: `PATH（${probe} steamcmd）` };
  for (const c of COMMON_STEAMCMD) {
    if (existsSync(c)) return { command: c, source: '常见安装位置' };
  }
  return null;
}

/** 本机常见安装位置（Windows 优先，本机装在 D:/steamcmd）。 */
const COMMON_STEAMCMD = process.platform === 'win32'
  ? ['D:/steamcmd/steamcmd.exe', 'C:/steamcmd/steamcmd.exe',
    'C:/Program Files (x86)/SteamCMD/steamcmd.exe', 'C:/Program Files/SteamCMD/steamcmd.exe']
  : ['/usr/games/steamcmd', '/usr/local/games/steamcmd', '/usr/bin/steamcmd', '/opt/steamcmd/steamcmd.sh'];

/** 脱敏：任何可能带密码的字符串，打印前一律过这个。 */
export function redact(text, secrets = []) {
  let out = String(text);
  for (const s of secrets) {
    if (s && s.length > 3) out = out.split(s).join('<redacted>');
  }
  return out;
}

/**
 * 拼 steamcmd 参数。**密码不进 argv**：Windows 上任何进程都能读到别人的命令行，
 * 密码走 stdin（steamcmd 对 `+login <user>` 会提示输入密码），见 runUpload()。
 *
 * `@ShutdownOnFailedCommand` 必须在最前面且**不带 `+` 前缀**——没有它，单个命令失败
 * （登录失败、app build 失败）steamcmd 只会打一行 ERROR 然后继续跑 `+quit`，退出码
 * 仍是 0，失败的上传会被报成成功。这是 CI 圈被反复报道的行为，已在本机实测过一次
 * 纯 `+quit` 也返回非零（首启自更后 exit=7），所以退出码还得配合输出扫描一起看。
 */
export function steamcmdArgs(spec, env = process.env) {
  return [
    '@ShutdownOnFailedCommand',
    '+login', env.STEAM_USERNAME?.trim() || 'anonymous',
    '+run_app_build', join(spec.outDir, 'app.vdf'),
    '+quit',
  ];
}

/**
 * steamcmd 失败关键字。退出码不可信（见上），所以对捕获到的输出做二次判据。
 * 只匹配明确标志失败的行，不用宽泛的 'error'——那会把正常输出里的关键词算成失败。
 */
const FAILURE_MARKERS = /(ERROR!|Failed to|failed to|build failed|Access denied|invalid password|Invalid Password|two-factor|Steam Guard)/i;
export function looksFailed(output) {
  return FAILURE_MARKERS.test(String(output ?? ''));
}

/**
 * 真正 spawn steamcmd。
 *
 * 两条路径的差别只在**密码怎么送**，输出捕获完全一致：
 *   - 有 STEAM_PASSWORD：密码写进子进程 stdin（`input` 选项），全非交互。
 *   - 没有：`stdio[0]` 继承，操作者自己在 steamcmd 的密码提示里敲（首次跑必须走这条，
 *     好让 Steam Guard 的邮箱/2FA 验证过一次）。
 *
 * **交互路径的 stdio 不是整条 inherit**，而是 `['inherit','pipe','pipe']`：stdin 继承才能
 * 敲密码，stdout/stderr 接管才能扫描失败关键字——同时原样回显，操作者看到的输出一点不少。
 * 早先这里整条 inherit，结果交互路径（首次上传唯一能走的那条）**完全没有输出判据**，
 * 退出码 0 + 输出里一行 `ERROR!` 会被判成成功。那是静默失败补丁的漏洞口。
 *
 * spawnImpl 可注入：测试用一个真子进程（Node 脚本假 steamcmd）证明整条链，跨平台。
 */
export function runUpload(spec, steamcmdCommand, env = process.env, spawnImpl = defaultSpawn) {
  const args = steamcmdArgs(spec, env);
  const password = env.STEAM_PASSWORD;
  // env 要到达子进程（调用方给的配置就是给 steamcmd 用的），但不能整块替换——那会让子进程
  // 丢掉 PATH/SystemRoot 之类，steamcmd 直接起不来。所以在 process.env 之上合并。
  const childEnv = env === process.env ? env : { ...process.env, ...env };
  const options = password
    ? { cwd: ROOT, env: childEnv, input: password + '\n', encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 }
    // stdin 继承（敲密码）+ stdout/stderr 接管（扫描 + 回显）
    : { cwd: ROOT, env: childEnv, stdio: ['inherit', 'pipe', 'pipe'], encoding: 'utf8', windowsHide: true, maxBuffer: 64 * 1024 * 1024 };
  const r = spawnImpl(steamcmdCommand, args, options);
  // 接管了 stdio 就把输出回显出来，别让操作者对着一片沉默
  for (const chunk of [r?.stdout, r?.stderr]) {
    if (chunk) process.stdout.write(chunk.endsWith('\n') ? chunk : chunk + '\n');
  }
  return judgeUpload(r);
}

/**
 * 判定上传结果：退出码与输出扫描**两者都看**。任一说失败就算失败——退出码单独不可信，
 * 而 `@ShutdownOnFailedCommand` 也不是每种失败路径都覆盖。宁可误报失败，不要漏报成功。
 */
function judgeUpload(r) {
  const status = typeof r?.status === 'number' ? r.status : 1;
  const output = [r?.stdout, r?.stderr].filter(Boolean).join('\n');
  const byOutput = looksFailed(output);
  return {
    status,
    output,
    error: r?.error,
    ok: status === 0 && !byOutput,
    failedBy: status !== 0 && byOutput ? '退出码与输出' : status !== 0 ? '退出码' : byOutput ? '输出关键字' : null,
  };
}

function defaultSpawn(command, args, options) {
  return spawnSync(command, args, options);
}

/**
 * 落盘全部 VDF，返回写出的文件名。导出是为了让测试能直接验文件系统——
 * 「引用了但没写出来」这类 bug 只有真去看盘才会发现。
 */
export function writeOut(spec) {
  mkdirSync(spec.outDir, { recursive: true });
  // SteamPipe 的 BuildOutput 目录：先建出来。是否强制要求预建未确认，但零成本，
  // 且建了之后「上传后有没有产物落盘」才可检查。
  mkdirSync(spec.buildOutput, { recursive: true });
  // AppBuild 是入口，必须第一个落盘——`+run_app_build` 读的就是它。它引用下面的 depot
  // 文件，所以顺序上先写 app.vdf 再写 depot，读盘的人不会看到「引用了但还没写」的中间态。
  const written = [['app.vdf', renderAppBuild(spec)]];
  for (const [name, text] of written) writeFileSync(join(spec.outDir, name), text, 'utf8');
  // 每个被 AppBuild 引用的 depot 文件都要真的写出来。漏一个，steamcmd 加载 AppBuild 时
  // 整个构建就失败——而报错只会说「找不到文件」，不会说是本脚本漏写的。
  for (const d of spec.depots) {
    written.push([`depot_${d.platform}.vdf`, renderDepotBuild(spec, d)]);
  }
  for (const [name, text] of written.slice(1)) writeFileSync(join(spec.outDir, name), text, 'utf8');
  return written.map(([n]) => n);
}

/** 内容根完整性与 CJK 路径警告——两者都是「静默发坏版本」的成因，必须显眼。 */
function printContentWarnings(spec) {
  const broken = checkContentRoot(spec.contentRoot);
  if (broken.length) {
    console.log(`  ⚠ 内容根不完整：缺 ${broken.join('、')}`);
    console.log('    → 这是旧包或不完整包。传上去不会有报错，只会安静地发一个坏版本。重新 npm run electron:pack。');
  }
  const cjk = nonAsciiPaths(spec);
  if (cjk.length) {
    console.log(`  ⚠ 路径含非 ASCII 字符：${cjk.join('；')}`);
    console.log('    → steamcmd 是 C++ 程序，VDF 是 UTF-8 无 BOM；若它按系统 ANSI 码页解析，中文路径会乱码、内容根找不到。');
    console.log('    → 确定的绕法：把内容根与产物都指到 ASCII 路径，如 STEAM_CONTENT_ROOT=D:/shijing-release/win-unpacked --out D:/shijing-vdf。');
  }
}

function printSpec(spec, written) {
  console.log(`  appid      ${spec.appId}${spec.needsAppId ? '  （占位值，未设 STEAM_APP_ID）' : ''}`);
  console.log(`  depot(win) ${spec.depotId || '（未设 STEAM_DEPOT_ID_WIN）'}`);
  console.log(`  内容根     ${spec.contentRoot}${spec.contentRootExists ? '' : '  （不存在！）'}`);
  console.log(`  描述       ${spec.desc}`);
  console.log(`  SetLive    ${spec.setLive || '（未设：只上传不切分支）'}`);
  console.log(`  产物       ${spec.outDir}`);
  for (const n of written) console.log(`             - ${n}`);
  const top = readdirSafe(spec.contentRoot);
  if (top.length) console.log(`  内容根顶层 ${top.slice(0, 12).join(', ')}${top.length > 12 ? ' …' : ''}`);
}

function readdirSafe(dir) {
  try { return readdirSync(dir); } catch { return []; }
}

/**
 * 真机预检：跑一次 steamcmd 自己。anonymous 登录即可，**不需要 appid 也不需要任何凭据**。
 * 这一步回答「这台机器上的 steamcmd 到底能不能起来并跟 Steam 握手」——那是 upload 的
 * 真正前置，而它是唯一能在没有 appid、没有账号时验证的东西。
 */
function runCheck(env = process.env) {
  const cmd = findSteamcmd(env);
  if (!cmd) {
    console.error('找不到 steamcmd。装法（本机已装于 D:/steamcmd/steamcmd.exe）：');
    console.error('  1. 下载 https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip');
    console.error('  2. 解压到某个目录（别放系统盘，首启要自更新约 150MB）');
    console.error('  3. 首次运行 steamcmd.exe +quit 完成自更新，然后设 STEAMCMD 指过去或加进 PATH');
    return 2;
  }
  console.log(`  steamcmd   ${cmd.command}（${cmd.source}）`);
  console.log('\n以 anonymous 身份登录握手（约 10-30 秒）…');
  const args = ['+login', 'anonymous', '+quit'];
  const r = spawnSync(cmd.command, args, { cwd: ROOT, encoding: 'utf8', windowsHide: true, timeout: 180000, maxBuffer: 64 * 1024 * 1024, killSignal: 'SIGKILL' });
  const out = r.stdout ?? '';
  const err = r.stderr ?? '';
  if (r.error) {
    console.error(`\nsteamcmd 启动失败：${r.error.message}`);
    return 2;
  }
  const connected = /Connecting anonymously to Steam Public\.\.\.\s*OK/i.test(out + err);
  const apiOk = /Loading Steam API\.\.\.OK/i.test(out + err);
  console.log(`  Steam API 加载   ${apiOk ? 'OK' : '未见确认输出'}`);
  console.log(`  anonymous 登录   ${connected ? 'OK' : '未见确认输出'}`);
  if (r.status === 0 && connected && apiOk) {
    console.log('\n预检通过：这台机器上的 steamcmd 可用。接下来只差 appid 与账号。');
    return 0;
  }
  console.error(`\n预检未通过（退出码 ${r.status}）。尾部输出：`);
  const tail = (out + err).split(/\r?\n/).slice(-15).join('\n');
  if (tail) console.error(tail);
  console.error('\n排查方向：网络能否连 Steam（这一步真实联网）；防火墙/代理；目录权限。');
  return 1;
}

function main() {
  const mode = process.argv[2] || 'validate';
  const yes = flag(['--yes', '-y']);
  const outOverride = arg(['--out', '--outDir']);

  if (mode === 'check') {
    console.log('Steam depot 预检 · 真机');
    return runCheck(process.env);
  }

  const spec = buildSpec(process.env, outOverride ? { outDir: outOverride } : {});
  console.log(`Steam depot 上传 · ${mode}`);
  const written = writeOut(spec);
  printSpec(spec, written);
  printContentWarnings(spec);

  if (mode === 'validate') {
    if (spec.needsAppId) console.log('\n说明：未设 STEAM_APP_ID，用占位 appid 出了 VDF——这一步不需要 appid，提交/审阅 VDF 就到这里。');
    if (spec.needsDepotIdWin) console.log('说明：未设 STEAM_DEPOT_ID_WIN。depot id 是后台分配的，不能从 appid 推导，upload 前必须显式设。');
    if (!spec.contentRootExists) console.log('提示：内容根还不存在；上传前先 electron:pack 或指 STEAM_CONTENT_ROOT。');
    console.log(`\nVDF 已生成，可直接 git diff 审阅：${spec.outDir}`);
    return 0;
  }
  if (mode === 'dry-run') {
    const pre = requireUpload(process.env, spec);
    const cmd = [pre.steamcmd?.command || 'steamcmd'].concat(steamcmdArgs(spec));
    console.log(`\nsteamcmd 位置：${pre.steamcmd ? `${pre.steamcmd.command}（${pre.steamcmd.source}）` : '（找不到）'}`);
    console.log('将要执行：');
    console.log('  ' + cmd.join(' '));
    console.log(`  密码：${process.env.STEAM_PASSWORD ? '从 STEAM_PASSWORD 写入子进程 stdin（不进命令行）' : '未设 STEAM_PASSWORD——steamcmd 会提示交互输入'}`);
    if (pre.missing.length) {
      console.log('\n还不能真正上传，缺：');
      for (const m of pre.missing) console.log(`  - ${m}`);
    } else {
      console.log('\n前置齐备，可以 npm run steam:depot:upload -- --yes');
    }
    return 0;
  }
  if (mode === 'upload') {
    const pre = requireUpload(process.env, spec);
    if (pre.missing.length) {
      console.error('\n上传前置不满足，缺：');
      for (const m of pre.missing) console.error(`  - ${m}`);
      return 2;
    }
    if (!yes) {
      console.error('\n这是真正上传，会占 Steamworks 构建配额。确认无误后加 --yes 重跑。');
      return 2;
    }
    const shown = [pre.steamcmd.command].concat(steamcmdArgs(spec)).join(' ');
    console.log(`\n上传中：${shown}`);
    const r = runUpload(spec, pre.steamcmd.command, process.env);
    if (r.error) {
      console.error(`\nsteamcmd 启动失败：${r.error.message}`);
      console.error(`  检查 STEAMCMD 是否指向真正的 steamcmd.exe（当前：${pre.steamcmd.command}）`);
      return 2;
    }
    console.log(`\nsteamcmd 退出码 ${r.status}`);
    if (r.failedBy) console.error(`失败判据：${r.failedBy}`);
    // steamcmd 的报错偶尔会回显输入，密码过了 redact 才打印
    const tail = redact(r.output || '', [process.env.STEAM_PASSWORD])
      .split(/\r?\n/).slice(-20).join('\n');
    if (tail && !r.ok) console.error(tail);
    if (r.ok) console.log('上传完成。构建在 Steamworks 后台「构建」页可见。');
    return r.ok ? 0 : 1;
  }
  console.error(`未知模式：${mode}（可用 validate / dry-run / upload）`);
  return 2;
}

/** CLI 入口：只在被直接执行时跑，被 import（测试）时保持纯函数形态。 */
function isEntryPoint() {
  const entry = process.argv[1];
  if (!entry) return false;
  return resolve(entry) === resolve(fileURLToPath(import.meta.url))
    || resolve(entry) === resolve(HERE, 'depot-upload.mjs');
}

if (isEntryPoint()) process.exit(main());
