# Steam 集成 v1：成就系统与云存档

史境·三国 接入 Steam 的发售硬门槛。本目录自包含：**只依赖 `agents/` 的类型契约，不反向依赖任何
其他模块**；没有 Steam 的环境原样运行，全部 API 退化为安全 no-op。

## 文件清单

| 文件 | 职责 |
| --- | --- |
| `achievements.ts` | 24 条成就定义 + `evaluateAchievements` 纯函数判定 + `achievementSummary` |
| `achievements.json` | Steam 官方格式的成就配置，与 `ACHIEVEMENTS` 的 id 集合一一对应（测试把守） |
| `steam.ts` | `initSteam` 探测链、成就/统计的读写 API，无 Steam 时全部 no-op |
| `cloud-save.ts` | 云存档两套后端（文件系统 / Steam 云端）+ 对局存档的导出与恢复 |
| `index.mjs` | electron 主进程的钩子入口（壳动态 import 的就是它） |
| `steam.test.mjs` | 15 个用例：清单不变式、判定规则、确定性、云存档往返、损坏恢复、无 Steam 降级、凭据扫描 |

## 四条设计取舍

1. **没有 Steam 也能跑。** `initSteam()` 拿不到 appid 或 `steamworks.js` 不可用时返回
   `{available:false,reason}`，之后 `unlockAchievement`/`setStat` 返回 `false`、`getStat` 返回
   `null`，一个都不抛。Steam 是发售渠道，不是运行前提。
2. **成就由世界状态推导，不另记一本账。** 一局发生了什么都在 `world_events` 流水里。成就若单开
   账本，就会出现「账上解锁了、流水里查无此事」的纠纷。`evaluateAchievements` 是纯函数：同一份
   `(world, events)` 输入，任何机器、任何时候跑出的解锁集合一致——可单测、可复现、可回放。
3. **云存档 v1 做「对局档案」粒度。** 导出一局为一段 JSON（`run` + 世界快照 + 事件流水），写入
   云存档命名空间。不做按 tick 的增量同步：v1 一局百来条事件，一个 JSON 文件就装得下。
4. **不把凭据写进任何文件。** 本目录零凭据字面量（测试用正则把守：`token: "..."`、私钥头、
   云厂商 AK 一类模式一律拒）。appid 不是凭据，它是公开标识。

## 怎么拿 appid

1. 登录 [Steamworks 合作伙伴后台](https://partner.steamgames.com/)，为游戏创建应用，拿 **App ID**
   （一串数字，如 `480`）。
2. 开发期如果没有自己的应用，用 Valve 官方的测试应用 **SpaceWar（appid `480`）**——它的成就与
   统计在后台有完整演示数据，适合打通链路。
3. App ID 只需要在三个地方出现：`STEAM_APP_ID` 环境变量、`steam_appid.txt`、或打包配置。
   **都不要提交进仓库**（`.gitignore` 已忽略 `steam_appid.txt` 之外的本地名，请自行确认）。

## steam_appid.txt 放哪

`steam_appid.txt` 是 Steam 官方的开发期约定：一个只含 appid 数字的纯文本文件，放在**可执行文件 /
启动目录**里，Steam API 初始化时自动读取。

`initSteam()` 的探测顺序（任一环失败即返回 `{available:false,reason}`）：

```
① process.env.STEAM_APP_ID
② steam_appid.txt —— 从进程当前目录逐级向上找到文件系统根（覆盖 npm run / electron 打包 / sidecar 三种启动形态）
③ steamworks.js 能否加载并初始化成功（restartAppIfNecessary → init）
```

日常开发推荐 ②：在仓库外或启动目录放一个 `steam_appid.txt`，不用改任何代码。CI 上用 ①。

## 成就在 Steamworks 后台怎么配

1. 后台进入应用 → **成就** 页面，**逐条添加**。每条三要素必须与本目录严格一致：
   - **API 名** = `achievements.json` 里的 `name`（如 `first_run_complete`）。大小写敏感，改一个字符
     Steam 就不认，`unlockAchievement` 会静默失败。
   - **显示名称 / 描述** = `displayName` / `description` 的 `zh-cn` 值。
   - **隐藏** = `hidden`。目前有两条隐藏成就（`eunuch_dominance`、`harem_year`），都是「做坏了也算
     成就」的趣味项， Steam 约定是解锁前不展示描述。
2. **图标**：`icon`（已解锁）与 `icongray`（未解锁）在 json 里留空，上传图标后后台会自动回填；
   本地这份 json 是单一事实源，回填后请同步回来，保持两边一致。
3. **统计项**：`setStat`/`getStat` 用的统计项要在后台 **统计** 页面单独配（如 `runs_completed`），
   类型选 INT；成就与统计是两套东西，别混。
4. 后台不支持批量导入时，用 `achievements.json` 当清单逐条核对——它就是为这个用途维护的格式。

## 云存档命名空间与目录布局

两套后端共用同一命名空间 `cloud-saves/`，换后端不改存档位置：

```
文件系统后端（createCloudSave(dir)）：
<dir>/cloud-saves/<gameId>.json        # gameId 即 Run.id（UUID），一局一个档案位，覆写即 latest wins
<dir>/cloud-saves/<gameId>.json.tmp    # 写一半掉线只会留下它；原子改名后才是正式存档

Steam 云端后端（createSteamCloudSave()）：
云端相对路径同为 cloud-saves/<gameId>.json，只认这个命名空间下的文件，别的一概不碰
```

`gameId` 走 `^[A-Za-z0-9_-]{1,80}$` 白名单——它直接当文件名，一个点号就是目录穿越。
条目结构见 `CloudSaveEntry`；`payload` 内嵌 `{format:'shijing-run/v1', run, world, events}`，
格式号升级必须换号，旧号一律拒绝恢复（宁可拒恢复，不半截恢复）。

## 非 Steam 用户会怎样

什么都不会少：

- `initSteam()` 返回 `{available:false,reason:'……'}`，`index.mjs` 打一行日志，游戏照常启动。
- 成就照常在世界里推导（`evaluateAchievements` 不碰 Steam），只是不上传 Steam 服务器；
  面板/史官想展示就用 `achievementSummary`。
- 云存档走 `createCloudSave(dir)` 本地目录，`available:true`，行为与云端后端完全一致。
- `unlockAchievement`/`setStat` 返回 `false`、`getStat` 返回 `null`、`shutdownSteam()` 空转——
  调用方不需要写 `if (steam)` 分支。

## electron 接线

桌面壳（`electron/main.mts`）已预留钩子：发现 `steam/` 目录就动态 import 入口并调用
`init(context)`，找不到或抛错都只记日志、不影响启动。本目录的入口是 `index.mjs`：

```js
import {init, shutdownSteam} from './steam/index.mjs'; // 壳侧：await init({mode,root,window,versions})
// 退出前：shutdownSteam();
```

注意：`index.mjs` 直接 import TypeScript 源文件，需要 **Node ≥ 22.18**（类型剥离默认开启）。
更低版本的运行时 import 会失败，壳按约定记一行日志后跳过 Steam 集成——不影响游戏。
`init()` 幂等；`shutdownSteam()` 之后可再 `initSteam()` 重来。

游戏内建议的接线位置（宿主侧，非本目录职责）：每个结算提交后
`evaluateAchievements({world,events})` → 对新增解锁项 `unlockAchievement(id)`；退出对局时
`exportRunToSave(run,world,events)` → `provider.write(entry)`。

## 打包 checklist

- [ ] `steamworks.js` 装为**可选依赖**并用 electron-builder 的 `asarUnpack` / 原生模块重编译处理
      （它是 C++ 原生模块，跨平台必须各自编译；别指望一份二进制通吃）。
- [ ] `steam_appid.txt` 打进可执行文件同目录（或打包器写入 `STEAM_APP_ID`）。
- [ ] Steamworks 后台的成就 API 名与 `achievements.json` 逐条核对一致（跑测试会把守本地不变式）。
- [ ] 云同步在后台 **应用 → 云存档** 里开启，配额 ≥ 一局 JSON 的体积（百 KB 量级，默认 1GB 富余）。
- [ ] 打包产物里再跑一遍 `node --test steam/steam.test.mjs` 当冒烟。
- [ ] 确认没有任何文件含凭据字面量（测试已扫描，人工再过一眼 CI 日志）。

## 测试

```bash
npx tsc -p agents/tsconfig.json          # 先确保契约侧编译干净
node --test steam/steam.test.mjs         # 15 个用例（含云存档往返）
node --test steam/icons.test.mjs         # 6 个用例（48 张图）
node --test steam/depot-upload.test.mjs  # 16 个用例（VDF 渲染 + 凭据不泄漏）
npm run steam:test                       # 以上三套一起跑
```

## Steam depot 上传（steamcmd）

`depot-upload.mjs` 把打包产物推上 Steamworks。三个模式，按对 appid 的依赖程度分：

```bash
npm run steam:depot:check      # 真机预检：跑一次 steamcmd 自己，**不需要 appid 也不需要凭据**
npm run steam:depot:validate   # 出 VDF 到 out/，不碰 steamcmd——**没有 appid 也能跑**
npm run steam:depot:dry        # 同上，另打印将要执行的完整命令行
npm run steam:depot:upload     # 真正上传，需要 --yes 与下列环境变量
```

`check` 是 upload 的真前置里唯一能在没有 appid、没有账号时验证的一环：它用 anonymous
身份让 steamcmd 真连一次 Steam，确认这台机器上的工具链能起来。本机（D:/steamcmd）实测
通过；`pnpm review` 已把它纳为第 9 步。

| 环境变量 | 说明 |
| --- | --- |
| `STEAM_APP_ID` | App ID，upload 必需。不设时用占位值 `480`（Valve 测试应用）出 VDF |
| `STEAM_DEPOT_ID_WIN` | Windows depot ID。**不给默认值**：depot id 是后台创建时分配的，不能从 appid 推导 |
| `STEAM_DEPOT_ID_MAC` / `_LINUX` | 可选；须与 `STEAM_DEPOT_MAC_CONTENT_ROOT` / `_LINUX_CONTENT_ROOT` 成对给，才会进 AppBuild |
| `STEAM_CONTENT_ROOT` | Windows 内容根；默认依次找 `SHIJING_PACK_OUTPUT/win-unpacked` → `release/win-unpacked` → `D:/shijing-release/win-unpacked` |
| `STEAM_BUILD_DESC` | 构建描述，默认自动生成 |
| `STEAM_SET_LIVE` | 设了才把构建切到该分支（default 或 beta 分支名）；不设只上传不切 |
| `STEAMCMD` | steamcmd.exe 路径，缺省在 PATH 上找 |
| `STEAM_USERNAME` | Steamworks 合作伙伴账号名。**upload 必需**——anonymous 无权上传构建 |
| `STEAM_PASSWORD` | 密码，只从环境变量读，经 stdin 传给 steamcmd |

三条硬规矩，测试把守：

1. **密码不上命令行。** Windows 上任何进程都能读到别人的命令行，所以密码走子进程
   stdin，`+login` 只带用户名；不设 `STEAM_PASSWORD` 时整条 stdio 继承，操作者自己在
   steamcmd 的密码提示里敲。测试用注入式假 spawn 记录 argv 与 stdin，跨平台地断言这一点。
2. **失败不能装作成功。** steamcmd 的退出码不可信——本机实测一次纯 `+quit` 在首启自更后
   就返回过 `exit=7`，而单条命令失败时它只打一行 ERROR 然后继续跑 `+quit`、退出码仍为 0。
   所以参数置顶 `@ShutdownOnFailedCommand`（注意**不带 `+` 前缀**），并对输出做失败关键字
   扫描；两者任一判失败就算失败。测试用退出码 0 + `ERROR!` 的输出断言 `ok:false`。
3. **目录存在不等于构建能用。** `requireUpload` 会查内容根里有没有 `史境.exe`、
   `resources/steam/steam.mjs`、`resources/node_modules/steamworks.js` 三样。
   实测踩过：项目内 `release/win-unpacked` 是修复前的旧包、缺 steamworks.js，按默认值
   传上去**不会有任何报错**，只会安静地发一个没有 Steam 支持的版本。所以只验目录存在不够。

另外两条会把坏版本传上去而不报错的路，脚本会显式警告：

- **CJK 路径**：steamcmd 是 C++ 程序、VDF 是 UTF-8 无 BOM，若它按系统 ANSI 码页
  （简中 Windows 上就是 936）解析，中文路径会乱码、内容根找不到。**这一点无法在本机验证**
  （没有 appid 跑不了 `run_app_build`），所以不猜，只警告并给一条确定的绕法：内容根与
  产物都指到 ASCII 路径。
- **VDF 路径统一用正斜杠**：VDF 对 `\` 是不是转义符各实现不一致——Valve 官方示例用单
  反斜杠，而 `@node-steam/vdf` 解析时又不把 `\\` 复义回 `\`。写 `\\` 在一端对、在另一端
  就得到字面上的双反斜杠路径。**两边都可能错的事不能赌**，正斜杠在任何 VDF 变体里都
  不是转义符，Windows API 也照常接受。

VDF 的正确性用**第三方解析器**（`@node-steam/vdf`，devDependency，只活在测试里）校验，
而不是拿自己的模板渲染自证——自己生成自己验是循环论证。测试 24 项里有两条专门守落盘与往返。

`validate` 的产物（`out/app.vdf` + `out/depot_*.vdf`）在 `.gitignore` 里，但模板
（`*.vdf.template`）入库：appid 是注入的，仓库里不写死任何数字，否则克隆到别人机器上
就会朝别人的 app 上传。

### 本机推荐的上传命令

```bash
STEAM_APP_ID=<后台的 App ID> \
STEAM_DEPOT_ID_WIN=<后台分配的 depot ID> \
STEAM_USERNAME=<合作伙伴账号> \
STEAM_CONTENT_ROOT=D:/shijing-release/win-unpacked \
npm run steam:depot:upload -- --out D:/shijing-vdf --yes
```

内容根与产物都指到 ASCII 的 D: 路径：既绕开 CJK 解析风险，`D:/shijing-release` 也是
当前最新的构建（项目内 `release/` 那份缺 steamworks.js，会被完整性校验拦住）。
**首次不要设 `STEAM_PASSWORD`**——走交互登录，让 Steam Guard 的邮箱/2FA 验证过一次，
之后才能在 CI 里用 stdin 管道。

### steamcmd 安装（本机已装于 `D:/steamcmd/steamcmd.exe`）

```bash
# 1. 下载（约 757KB）
#    https://steamcdn-a.akamaihd.net/client/installer/steamcmd.zip
# 2. 解压到非系统盘——首启要自更新约 150MB，别放快满的盘
# 3. 首次运行完成自更新（这一步会静默下载并重launch自己）
steamcmd.exe +quit
# 4. 之后设 STEAMCMD=D:/steamcmd/steamcmd.exe，或把该目录加进 PATH
```

两个实测行为值得记住：首启自更新后进程退出码可能是 **7**（不是 0）；第二次起就是 0。
`@ShutdownOnFailedCommand` 因此不能省。

## 已知边界（v1 刻意不做）

- **计策类成就靠事件标题关键词**（火攻/空城/离间 + 同结算敌军受创或己方零损的双条件）。计策由 AI
  提议、以决策形式执行，流水里只有标题摘要承载计策名；等流水长出计策实体类型后再改判据。
- **请旨与玩家拍板在 v1 事件流里同形**（都走 referee 结算且带 decisionId），故 `first_edict` 两者都算。
- **断敌粮道用代理指标**：EntityRef 没有 shipment 类型，战役层「粮队被截」进不了 FieldChange，
  故以「敌军粮草跌破断粮线 500 kg」为准——账目上与断粮道等价且可复现。
- **跨局累计成就**（`veteran_five_runs`）的数字由宿主经 `stats.runs_completed` 传入，本模块不记账。
- **Steam 云端后端未在真机验证**：`steamworks.js` 不在依赖里，可用路径只有防御性实现与单元测试
  覆盖的不可用路径；首次真机联调时重点看 `fileIterate` 的返回形态。
