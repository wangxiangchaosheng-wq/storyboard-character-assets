# 06 · LLM 网关与多模态（llm）

> 产物：`packages/llm/` —— provider 抽象 + 适配器 + 缓存 + 护栏。
> 被 01(管线)、02(回合)、03(裁判)、05(服务) 、08(生图) 调用。
> **cpk-agnes 用你的 key 接入；base URL / 模型名待官方文档确认**（未确认前用 `mock` provider 开发）。

## 1. 目标

把「模型是什么/在哪」与「业务怎么用」解耦：业务侧只依赖 `ChatStreamer/Generator/Embedder/ImageGen` 四个接口；换任何模型 = 改 `.env`，不碰业务代码。

## 2. Provider 接口

```ts
interface ChatProvider {            // 聊天/补全（含 SSE 流式）
  name: string;
  stream(prompt: Prompt, opts): AsyncIterable<StreamChunk>;   // chunk: {delta|tool|err}
  generate(prompt: Prompt, opts): Promise<Completion>;        // 非流式(用于校验/少量)
}
interface EmbedProvider  { embed(texts: string[]): Promise<number[][]>; }
interface ImageProvider  { gen(req: {prompt: string; size?: string}): Promise<{url|b64}>; }
```
- 请求统一经 `safeFetch()`（§3）出站。
- 流式透传：`stream` 产生的增量原样转发到服务端 SSE（05），`retry/backoff` 与超时在 provider 层处理。
- ZIP 环境：`MockProvider`（本地随机/预置剧本台词），供无 key & CI 时开发/测试（`MOCK_LLM=1`）。

## 3. safeFetch（全项目共享出站安全）

```
safeFetch(url, {headers, body, method, timeoutMs}) =>
  1. 仅允许 http/https 协议；否则抛 1002
  2. 解析 host → 解析 IP：拒绝 localhost / 127.* / ::1 / 10.* / 172.16-31.* / 192.168.* / 保留段(0/169.254/组播/链路本地)，否则抛 1003
  3. 常规 fetch + 超时/重试选项
```
- **所有**外部请求（话题抓取 01、生图 06、搜索 07、RAG 上游）必须走它；对 `ApiResponse` 的 error 也设区。
- 单测是固定的（见 11 号）：本地/环回/私网/保留 全拒。

## 4. 路由与调度（性能/成本护栏）

- `Router.schedule({kind, modelTier, budgetMs, importance})`：
  - `tier=fast`（角色回复、改写）：用便宜/快模型；
  - `tier=strong`（裁判、生成骨架、校验）：慢而强；
  - `tier=cheap`（摘要/标题）：强限制。
- 并发：`LLM_CONCURRENCY`（默认 3）信号量；超时默认 30s（stream 另计）。
- 重试：仅 429/5xx，指数退避 + 抖动，最多 3 次。
- 预算：`budget` 记录每次调用 tokens/耗时/单价到 `kv`（05 表 assets 旁边，或独立表），供 10 号验收查"回合 token 曲线"。

## 5. Prompt 规范（同库，各模块引用）

```
【三段式】
1. system：角色卡/常青记忆（来自 04 viewOf）—— 固定不变
2. context：窗口事件（04 给）+ 本回合事实（结构化）
3. task：要交付的具体 JSON / 可选列表
全部 prompt 必须：禁"角色看到整个状态"；禁"预言未来"；禁私有系统信息外泄；
输出强制 JSON 时给 schema，解析失败 → 自动重试 1 次，再失败走 mock 降级。
```
每个模块（01/02/03/04）会登记自己 prompt 的模板文件（`packages/llm/prompts/*.ts`），模板更新与代码走同一 PR 评审。

## 6. 多模态（生图）路径

```
POST /api/assets (SPA 前端) → 05 → llm.images.generate({prompt,size})
   → safeFetch(cpk-agnes images endpoint) → 缓存 assets 表 → 返回 url
```
- prompt 组装遵循 §5；成品补"立绘风/历史风"等稳定化词 + 负面词（占位常量）。
- 缓存：同 prompt 首次生成后永久复用（assets 表 hash 键）；批量排队限速。
- 生图失败 → 用占位图 + 边框提示"待生成"（不阻塞游戏）。

## 7. 降级链（保 MVP 永不卡死）

```
llm.strong(裁判) 失败 → 走 deterministic 结算（03 A 引擎）→ 附 hidden 里记 "llm 降级"
llm.fast(角色回复) 失败 → 用模板说"……（考虑中）"，后续回合重试
embed 失败 → 关键词评分回退（BM25），不阻塞 07
```
每条降级事件都进日志 + SSE `error 事件`（code 4002/4003/4001）。

## 8. 验收清单

- [ ] 四个接口可独立 mock 单测；`stream` 流式条数断言
- [ ] safeFetch：见 §3 列表全拒绝 + 正常 https 通过（连 11 测试一起跑）
- [ ] 无 key 环境（`AGNES_*`空）+ mock → 全链路可跑
- [ ] .env 中 AGNES key 无任何硬编码；产物无 key 痕迹（git grep 检查）