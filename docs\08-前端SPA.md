# 08 · 前端 SPA（apps/web）

> 产物：`apps/web/`（React 18 + Vite + TS strict + zustand + tailwind 或 CSS Modules 二选一先固定）。
> 只消费 `05` 的接口契约（不 import 服务端内幕）。

## 1. 页面清单（7 页，MVP）

| # | 路由 | 页面 | 核心数据 |
|---|---|---|---|
| 1 | `/` | 首页：链接/描述输入 | POST ingest |
| 2 | `/world/:topicId` | 世界生成（多轮进度 + 校验中状态） | SSE 进度条/文案式卡片流 |
| 3 | `/world/:topicId/board` | 战略地图（canvas 可视化 + 指标面板） | map + metrics + 立绘 |
| 4 | `/game/:gameId/character` | 人物页（立绘 + 记忆 + 关系） | playerView |
| 5 | `/game/:gameId/decide` | 决策页（当前事件 + 可选行动 + 廷议流） | options + stream |
| 6 | `/game/:gameId/events` | 事件列表（大事记 + 故事板时间线） | log(公开) |
| 7 | `/game/:gameId/ending` | 结局卡（胜利/失败 + 复盘数据） | ending |

## 2. 组件树（可复用划分）

```
AppRouter
├─ Layout（三栏：左=地图/状态，中=主剧情流, 右=角色/行动）
│   ├─ <MapPanel>      地图 Canvas + metric 面板
│   ├─ <StoryStream>   事件/对话流（每回合卡片，可并行流式）
│   ├─ <DecisionPanel> 可选行动 → POST decide
│   ├─ <CastPanel>     角色列表/立绘 → 点选
│   └─ <Storyboard>    故事板时间线（回合锚点卡片）
└─ InfoBanner          估算徽标 / 加载态 / error
```

## 5. 状态与事件（zustand）

```ts
interface GameStore {
  spec: ScenarioSpec; gameId: string; turn: number; latest: TurnView;
  stream: StreamFeed;         // SSE 尾插
  decide(key): Promise<void>;  // POST
  actions: Option[];           // 当前可用
  error?: AppError;
}
```
- 唯一来源：服务端 `state` + `playerView`（04/05）。
- 所有对未来的感知都在 `playerView`（禁止直读 hidden 或 eventLog 全量）。

## 5a. 视觉素材只走插槽（见 12 号文档）

```tsx
import { useAsset } from '@/assets';
// 组件内禁止写死图片路径：
const { url, isPlaceholder } = useAsset('portrait/zhuge-liang');
<img src={url} alt="诸葛亮" data-placeholder={isPlaceholder} />
```
- key 全部登记在 `apps/web/assets/manifest.json`（视觉同学填充，示例见 docs/assets.manifest.example.json）。
- 未交付时 `isPlaceholder=true`，渲染占位卡（虚线框+名称），**流程不阻塞**。
- 布局四区固定为参考图的三段式（左角色/中对话/右地图/底输入），坐标基准见 12 号 §3。

## 6. 客户端 SSE（fetch → ReadableStream 同源）

```ts
function openStream(gameId, { onEvent, onError, lastSeq }) {
  // fetch('/api/games/:id/events?since='+lastSeq, {headers:{Accept:'text/event-stream'}})
  // 按 event: 分帧 → onEvent；断线自动重连（指数退避，max 5）
}
```
- 心跳 30s 不活 → 认为掉线重连；`game.error` 事件 → toast + 重试按钮。

## 7. 契约与类型生成

- 手维护类型 → **禁用 any**；全部来自 `@hare/contracts`（turbo 子包），dev 时 `pnpm gen:types` 同步。
- form 校验：zod（与 server 相同 schema 复用在客户端提前校验，双保险）。

## 8. 可访问性与文案规范

- 每个交互有 `aria-label`；加载态统一 Skeleton；
- 所有 LLM 生成内容以"角色说话"渲染（不渲染"系统喷码"）；Markdown 用白名单渲染（无 `dangerouslySetInnerHTML` 之外的渲染）。
- 语言：中文文案库（`src/i18n/zh.ts`，key 化，便于后期加英文）。

## 9. 验收清单

- [ ] 7 页路由跳转 + 空态/加载/错误三态齐
- [ ] 打开一场 MVP 局：出现抽取、决策、回显、结局全流程
- [ ] SSE 断线重连可验证（devtools 停网 5s 后恢复）
- [ ] 无可执行 HTML 注入（XSS 抽样点通过 11 审查）
- [ ] 移动端宽度（375px）可用性 baseline（壳复用）