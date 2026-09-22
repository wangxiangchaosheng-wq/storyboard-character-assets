# 商店页实拍截图（Steam store screenshots）

《史境》Steam 商店页用的**游戏内实拍截图**，全部 1440×900 PNG（对应审计文档
`docs/steam-road/09-Steam上架清单.md` B6 项「5–10 张截图（游戏内 1440×900 窗口即可截）」）。

- 拍摄时间：2026-09-22
- 拍摄基线：打包产物 `D:/shijing-release/win-unpacked/resources`（`史境-0.1.0-x64.exe` 同批 win-unpacked）
- 拍摄方式：`electron/scripts/capture-store-shots.mjs`（起打包态 sidecar + 本地网页服务，用系统 Chrome
  headless 经 CDP 逐页截图；sidecar 以 `AGENT_ALLOW_API_GENERATION=false` 离线模式运行，不依赖任何 API key）
- 视口：1440×900（`Emulation.setDeviceMetricsOverride`，`deviceScaleFactor=1`，PNG 即 1440×900）

## 已拍到（4 张）

| 文件 | 路由 | 分辨率 | 体积 | 内容 |
|---|---|---|---|---|
| `home.png` | `/` | 1440×900 | 1.63 MB | 首页（议题选择 / 开局入口）。首页本身是 `/map/index.html` 的全屏 iframe，所以与 `map.png` 逐字节相同；图中为 228 年战略地图、事件记录侧栏、「＋ 发起新议题」入口、右上角时间选择 |
| `map.png` | `/map/` | 1440×900 | 1.63 MB | 战略地图页（`/` 的 iframe 内容本体）。蜀/魏/吴三色疆域、城市点位、事件列表、发起新议题 |
| `discussion.png` | `/discussion` | 1440×900 | 1.46 MB | 议政界面（默认议题「是否采纳魏延子午谷方案？」，228 年春）。左：五人议事团（魏延/诸葛亮/杨仪/姜维/费祎，蜀汉阵营）；中：史官开场陈述与对话区；右：故事板占位；底部：时间跳转条（跳到推演第 N 日 / +30 日 / +1 年 / 朝政状态）。**此为该构建的真实离线状态，见下方「已知限制」** |
| `major-event.png` | `/major-event/index.html` | 1440×900 | 1.88 MB | 重大事件画廊（静态事件库首条「刘备夺取汉中 · 公元 219 年 · 汉中」展开态）。此页为独立静态页，不依赖 sidecar/LLM |

## 未拍到（1 个页面）

| 路由 | 状态 | 原因 |
|---|---|---|
| `/strategy`（策略地图库） | **未交付** | 页面数据链路完全正常（能读到对局、状态行显示「是否采纳魏延子午谷方案？ · 待决策 · 公元 228 年」），但底图 `<img class="strategy-art">`（`/strategy/map-live-state.svg`）在 Chromium 里**解码失败**（`img.complete === true` 但 `naturalWidth === 0`，即 error 态），策略地图区是一片空白。按「宁缺毋滥」原则不把这种半白屏的图当商店素材交付。**这不是截图脚本或 LLM 的问题，是资产损坏，详见下节。**

## /strategy 底图损坏的根因（重要，影响真机游戏）

**现象**：打包态（以及系统 Chrome 有头/无头）加载 `/strategy/map-live-state.svg` 全部以 error 结束；
小图标（如 `icon-9.png`，1254×1254）正常，说明不是网络/服务问题。

**根因**：该 SVG 在 `</svg>` 之后还拖了约 5.4 MB 的垃圾数据（字面量文本
`data:image/png;base64,...`，不是二进制 PNG），XML 根元素之后出现非空白内容 → 文档非法 →
Chromium 拒绝作为 `<img>` 解码。实测证据：

- `map-live-state.svg`（18,617,854 B）中 `</svg>` 位于偏移 13,210,028，其后仍有 5,407,819 B 内容；
  文件结尾不是 `</svg>` 而是 base64 文本。`map.svg`、`map-live-markers.svg` 同样损坏。
- 把 `</svg>` 之前的部分单独存盘（13,210,035 B）后 Chrome 正常解码为 1725×863；原文件依旧 error。
- 该损坏同时存在于仓库源文件 `integrations/shijing-website/public/strategy/map-live-state.svg`
  （工作区未提交版本，mtime 2026-09-21 15:53）和打包产物
  `D:/shijing-release/win-unpacked/resources/dist/client/strategy/map-live-state.svg` 中——
  也就是说**当前打包构建的策略地图页底图本来就是不渲染的**（同样的 Chromium XML 解析规则）。
- 参考：git 中已提交的旧版（commit d32f0c8，2026-09-13）是 40.9 MB 且结尾完好的另一份文件；
  工作区这三个 SVG 是 9-21 重新导出后未提交的新版本，导出过程写坏了文件尾部。

**修复建议**（任选其一，均需重打包后重跑脚本）：

1. 截掉 `</svg>` 之后的尾部数据（保留 `[0, indexOf('</svg>') + 7)`，约 13.2 MB），三个文件同样处理；
2. 或从素材源头重新导出这三张 SVG，导出后先用 `node -e` 校验 `content.trimEnd().endsWith('</svg>')`。

**修好之后**：重打包（或只同步 `dist/client/strategy/*.svg`），然后一条命令即可补拍：

```bash
node electron/scripts/capture-store-shots.mjs            # 全量重拍
SHOT_ONLY=strategy node electron/scripts/capture-store-shots.mjs   # 只补 strategy
```

## 已知限制（如实说明，都不是 LLM 缺失导致）

1. **议政界面中五个人物栏是占位态（「等待补充素材」）**：打包态 sidecar 的人物立绘任务全部失败，
   错误为「素材路径不能越出人物素材库」。根因是 `integrations/shijing-website/agents/src/asset-library.ts:21`：
   `assert(path.startsWith(this.directory + '/'))` 在 Windows 上恒为 false——`path.resolve` 在 win32 下
   一律返回反斜杠路径，前缀却用 `/` 拼接，于是每次素材库命中都被误判为越出目录。一行修法：
   `this.directory + '/'` → `this.directory + sep`（或按 `server.mjs` 的 `safeJoin` 用 `root + sep` 判包含）。
   该问题自 2026-09-12 提交起就存在，且 Electron 壳不传 `CHARACTER_LIBRARY_DIR`，真机 Windows 同样中招；
   修复后立绘会从「人物素材库」直接复用（诸葛亮/魏延/杨仪/姜维/费祎均在库中），议政界面截图会更完整。
2. **议政界面右侧故事板为占位（「暂无匹配当前话题与阶段的故事板，在线生成已关闭」）**：默认议题的描述含
   「不视为已经实施」，命中故事板库的排除词，且离线模式关闭了在线生成——这是设计内的离线行为，不是故障。
3. **静态页不依赖 LLM**：`/`、`/map/`、`/major-event/index.html` 完全静态可渲染，已如实拍到，无白屏/错误页。

## 复拍方式

```bash
cd integrations/shijing-website
node electron/scripts/capture-store-shots.mjs
```

脚本会自动：检查端口占用（`SHOT_SIDECAR_PORT`/`SHOT_SERVER_PORT`，默认 43181/43182，占用即报可读错误）
→ 起 sidecar（离线模式，临时数据目录）→ 起本地网页服务 → 起 headless Chrome（CDP，1440×900）→
逐页等渲染/网络稳定后截图 → 质量门禁（尺寸必须 1440×900、体积不得小到疑似白屏、页面文本不得含
404/服务未启动等错误特征）→ 落盘本目录 → 无论成败杀掉全部子进程并清理临时目录（孤儿进程不会残留）。

常用环境变量：`SHOT_ONLY=home,map,discussion,strategy,major-event`（逗号分隔只拍部分）、
`SHIJING_BUILD_ROOT`（打包产物目录）、`SHOT_OUT_DIR`（输出目录）、`SHOT_KEEP_TEMP=1`（保留临时目录排查）。
注意：单独拍 `strategy` 时脚本会先确保 sidecar 里有一个已装配世界的默认议题对局（与议政页开机同一路径）；
全量拍摄时 `discussion` 先建好对局，`strategy` 直接复用。
