# 启动器 + 浏览器调试形态（2026-09-29）

## 出发点
用户反馈两件事：① Steam 相关代码「有什么用，这个界面完全不像启动器」；② **steam 不能是唯一必须，
调试要用浏览器形态**。本轮据此做浏览器形态的启动器与调试控制台，并把途中打瘫整站 API 的真 bug 修掉。

## 交付物

### 1. 启动器（根页面 `/`）
`app/components/LauncherScreen.tsx` 替换原来的 iframe 直铺：

- 标题画面「史境 · 三國」+ 三个入口：**开始新局**（4 剧本 × 3 难度）、**继续对局**（读本机 runs 列表）、
  **调试模式**（`/play/debug`）；另有语言切换与「舆图」入口。
- 引擎状态一行：本地裁判就绪 / 已接引擎 / 未连接；并注明「不填密钥也能玩」。
- 开局走 `POST /api/agents/runs {spec: toRunSpec(scenario)}`（spec 直建，离线可玩），
  写 `shijing-scenario-v1` / `shijing-difficulty-v1` 两个本机键（与 AgentDiscussion 原契约一致），
  随后进 `/discussion?run=<id>`。
- **选局面板新增诚实标注**：每张剧本卡标明「可战役推演」还是「问对与阅览」。判据是引擎自己的
  `specSupportsSimulation`（227—235 蜀汉窗口），不是 UI 复制的年份表——否则引擎改门槛、标注骗人。

### 2. 调试控制台（`/play/debug`）
`app/play/debug/page.tsx`，四个分区：

- **世界状态**：原始快照摘要（玩家阵营/朝望/军队/在册军队/国策点/科技点/决策数）+ 可折叠原始 JSON；
- **事件流水**：最近 40 条 world-events（版本/日/标题/变化数/摘要）；
- **指令台**：口语指令输入 + act 勾选 → `POST messages`；推进按钮 +1/+7/+30/+90 日与「跳转一年」
  → `world-advance` / `world-jump`；运行日志回显每条写操作的真实结果；
- **AI 分析**：派生国策 / 史实锚点 / 脑洞岔路 / 成就核算四个按钮 + 当前清单。

不引私有通道：所有端点与游戏内界面共用，写操作同样带 commandId 幂等键与 expectedRevision 乐观锁。

## 途中抓到的真 bug

### BUG-124 反代双斜杠 —— 整站 API 404「接口不存在」
`app/api/agents/[...path]/route.ts` 用 URL 对象做模板字符串拼目标地址：

```ts
const base = new URL(rawBase);          // base 是 URL 对象
fetch(`${base}/${path.join('/')}${search}`)   // ${base} 走 toString()，永远带一个尾斜杠
```

`http://127.0.0.1:4318` 的 toString() 是 `http://127.0.0.1:4318/`，再手工补 `/` 就成了
`//health`。sidecar 那头是 `new URL('//health', 'http://localhost')`——**协议相对 URL**，
`health` 被当成主机名，pathname 退化成 `/`，路由表全落空：网页侧每个接口都 404「接口不存在」，
而直连 sidecar 完全正常。极易误判成 sidecar 挂了。

修复：改为 `base.origin + prefix + 路径段` 自己拼（保留 AGENT_SERVICE_URL 的路径前缀），
与 electron/server.mts 的反代同口径（那边一直是对的）。回归测试
`app/lib/agents-proxy.test.mjs` 直接拿**构建产物里的真路由**对回显服务器跑，锁住：
单斜杠、前缀保留、非本机 503、`..`/超长路径 400 四条。

### 客户端打包不许 import world-bootstrap
一度把「剧本是否带推演」的判据 helper 放进 world-bootstrap 并让选局面板 import 它：
ScenarioPicker 的客户端 chunk 从 20KB 涨到 **721KB**，SSR 直接吐空壳。world-bootstrap 拉着
省/政治/外交/国库/锚点整张服务端图。改成零依赖叶子函数 `specSupportsSimulation`（scenarios.ts），
**引擎反过来 import 它**——单一事实来源，客户端零负担。

## 顺带修
- 治政模式 i18n 键 typo：`panel.province.mode.商榷` → `.通商`（引擎标签是「通商」，i18n 测试抓住的）
- 调试台 `第 {day} 日` 插值没传参、政治点取了不存在的 `politics.points`（NaN）——已修
- `.locale-switch` 是绝对定位（为游戏画面设计），在启动器/调试台 flex 头部会飘出流外压住
  相邻按钮（实测遮住调试台「重试」）——作用域内改回流内

## 验证（全部浏览器实测，未启动 Steam/Electron）
- `npm run test:app`（构建 + app 测试）25/25；`agents:test` 413/413；`steam:test` 46/46
- 真机链路（生产服务器 3099，IAB 浏览器）：
  启动器渲染 + hydrate → 开始新局 → 择局（4 剧本，标注正确）→ 开局 →
  `/discussion?run=…` 进入对局，史官等裁第一道决策 → 调试台选局 → 世界快照 →
  指令台 +1 日 → 第 1 日版本 2 → 第 2 日版本 3，日志「推进 24 小时：完成」
- 已知边界（诚实行为，非 bug）：官渡 200 / 赤壁 208 / 白帝 223 三局按 BUG-108 守门走
  「问对与阅览」独立模式，卡面已标注；只有子午谷之议（228）挂完整战役推演。

## 踩坑备忘
- `vinext start` 不会自动重建：**改了代码必须重启服务再测**。我先后两次拿旧构建的 HTML 去测，
  看到 chunk 404 / 不 hydrate，差点误判成产品坏了。
- 开发服务器（vinext dev）在本次改动后崩在 `sharp/lib/index.js does not provide an export named
  'default'`（CJS/ESM 互操作，HMR 时触发）；生产构建与生产服务器不受影响。要浏览器调试，
  起 `npm run build && PORT=3099 npm start` 更稳。
- Node 直拉 agents 源码时，带 `./x.js` 运行时依赖的模块 import 不了（i18n 测试文件自己注明过），
  零依赖叶子函数才能被两侧共用。
