# 史境 · 四模块 Agent 首版

交付范围：人物视觉 Agent、故事板 Agent、世界状态 Agent，以及沿用原美术的网页展示与交互。人物人格、角色对话和裁判由队友的历史推演引擎负责。本项目不把图片 Skill 的文件名当作运行中的 Agent：这里有实际任务队列、OpenAI 工具调用、检查与修正、状态落盘和供网页查询的接口。

## 当前验证范围

2026-09-09：13 项离线 Agent 测试覆盖结算、防重复、数据恢复、图片检查、重试、HTTP 和推演适配；网页类型检查与构建已完成；原有 12 项网页接口测试也通过。测试使用明确标记的模拟图片与模拟模型，不证明真实生图质量。尚待用户在本机填入 API Key 后完成真实人物和故事图验收；未发布线上站点、未推送队友 GitHub。

## 本机启动

Mac 可双击整合版目录中的 `启动史境.command`，同时启动后台与网页（默认网页端口 3002）。需要先安装 Node.js。也可以在整合版源码目录执行：

```sh
npm ci
npm run agents:build
# 复制 .env.example 为 .env，在本机填写 OPENAI_API_KEY
npm run agents:start
# 另开一个终端
npm run dev
```

Agent 服务默认只监听本机 127.0.0.1:4318，网页默认 http://localhost:3000。网页请求通过同源 /api/agents 代理；OpenAI 密钥只在服务端读取。默认 OpenAI Responses 文本模型与 gpt-image-2 图像模型都可在 .env 设置；图片尺寸与透明背景按本版 gpt-image-2 接口设计。每个图片任务最多 3 次质量尝试；连接中断、密钥或额度失败不会自动重新付费请求。用户重试会开始新一轮有限尝试。

.env、.agent-data、数据库与输出图片均不进入源码交付包。浏览器关闭后，已入队任务继续执行（本机 Agent 进程须保持运行）。进程重启时已完成任务复用；中断中的任务标记为 interrupted，用户决定是否重试，避免未知请求被重复扣费。

## 两种接入方式

**已有队友服务：** 在 .env 设置 SIM_ENGINE_URL（例如 http://127.0.0.1:4000，填写真实服务地址）。主页输入议题后由队友创建剧本和对局，本服务严格采用返回的人物 ID。对话 /messages 转发到队友 /api/games/:id/message；act=false 只讨论，act=true 由队友裁判结算。本服务读取已经结算的世界快照，不再重复扣除数值。若请求中断，先同步状态，不能自动重发行动。

已存在的对局可 POST /api/agents/import {"gameId":"实际对局编号"}，打开返回的 /discussion?run=<id>。当前适配版本依据仓库 efd2b80 的真实 /message 接口，不使用旧 apps/web 的 /options 或 /decide。

**先独立做视觉：** 不配置 SIM_ENGINE_URL 时，沿用现有议题规划接口生成一次人物设定，存入后台；之后人物视觉和故事板 Agent 自动完成图片。没有上游初始世界数据时指标留空，不编造兵力粮草。角色对话和行动输入明确停用，等待引擎连接。也可直接 POST /runs 导入队友 ScenarioSpec，测试世界状态与绘画。

## 世界状态边界

- standalone 模式：POST /runs/:id/events 接收可信裁判已确认的 Settlement。必须包含唯一 id、expectedVersion、confirmed:true、summary、deltas、elapsedDays、cityChanges、significant。同事件重复提交不重复执行；同 ID 改内容拒绝；旧版本、负天数、指标越界、未知城市或错误旧归属拒绝，事务整体回滚。
- engine 模式：数字指标由队友引擎裁判并落盘，本服务同步确认快照。当前上游 state 只提供数字指标；没有明确城市归属与经过天数时保留未知，不根据叙事猜测。若将世界状态写入职责移交本模块，队友需将裁判结果改为 Settlement 契约，调用本模块 apply 后再广播，不得两边各算一次。
- significant=true 的确认事件自动入故事板队列；查询、闲聊、重复事件不触发新图。开场图独立标明方案尚未实施。历史图按事件 ID 留存。

## 接口（前缀 /api/agents，直连本机服务可省略前缀）

| 方法 | 路径 | 用途 |
|---|---|---|
| GET | /health | 只返回配置是否存在，不返回密钥 |
| POST | /runs | {spec,cities} 导入剧本，或 {topic,player} 通过队友服务建局 |
| GET | /runs | 最近对局 |
| GET | /runs/:id | 人物、世界、任务进度、通过的素材、事件历史 |
| POST | /runs/:id/events | standalone 模式裁判事件落盘 |
| POST | /runs/:id/messages | {commandId,text,to?,act}，转发队友讨论/行动 |
| POST | /runs/:id/sync | 读取队友最新状态，恢复漏掉的结果 |
| GET | /runs/:id/manifest | 素材编号、用途和图片地址 |
| POST | /jobs/:id/retry | 仅重试 failed/interrupted 任务 |
| GET | /assets/:filename | 读取已保存 PNG |

示例位于 examples/ziwu.json 与 examples/settlement.json。它们是明确标记的接口测试设定，数值和事件不能当作历史事实。

## 队友仓库中已发现的接入问题

efd2b80 的 topics 路由把文本截成前 16 字，并用该截断文本生成剧本；不同议题也可能撞 ID。integration/team-topic-input.patch 提供针对该版本的修正：完整输入摘要作为 ID、build 从数据库取原文，同时更新旧测试断言。此补丁未自动改动或推送队友仓库，合入前应在队友当前分支检查并运行其测试。

## 部署限制

本版是 Node.js 后台 Agent 服务（SQLite、文件存储、Sharp），适合本机或有持久磁盘的私有服务器；不能把该服务直接放进 Cloudflare Worker。原 Sites 网页仍可独立构建。要上线，先部署此服务到受保护的服务器，配置认证和网页代理地址，再发布网页；本机地址不能作为线上服务地址。服务有可选 AGENT_SERVICE_TOKEN，同源代理会转发；当前交付面向单人开发与团队联调，不包含多用户账号隔离。

## 官方接口依据

- OpenAI 图片生成：https://developers.openai.com/api/docs/guides/image-generation
- OpenAI 结构化输出：https://developers.openai.com/api/docs/guides/structured-outputs

创建对局可传 `reuseKey` 作为同议题复用标识；重复提交返回已建对局，建立中或中断时拒绝重复付费创建。中断后可以 GET /runs 查找已建立的对局并使用其 run 链接恢复；明确新建时使用新的 reuseKey。

故事板生成会复用本局已经通过检查的人物图作为身份与画风参考（最多 5 张），没有参考图时仍可根据事件资料独立生成。

## 2026-09-09 连接修复

议题规划与生图统一由 Node 后台请求，避免本地 Worker 不继承系统代理。Mac 自动识别已启用的本机 HTTPS 代理，localhost 保持直连。兼容服务根地址自动补 /v1；仅在用户确认目标服务后设置 OPENAI_COMPATIBLE_CONFIRMED=true。官方 api.openai.com 不需要该标记。

本次在用户实际运行目录验证：兼容服务模型列表 HTTP 200，gpt-5.6-luna 真实 Responses 调用 HTTP 200；已完成 17 项模拟测试与网页构建。完整议题与图片验收结果另行记录，不能仅凭网络连通标记生图完成。

议题准备已拆成轻量选角与后台逐图考据，避免进入页面前等待五个人物的全部研究。兼容服务不支持的 max_tool_calls 参数已移除，web_search 和结构化输出保留。真实选角与首个人物画面规划已通过；图片生成与质量验收仍需以任务记录为准。

模型分工：议题、画面计划、验收只使用 OPENAI_CHAT_MODEL 指定的一个文字模型；所有生图固定为 gpt-image-2，不枚举或自动切换服务模型列表。OPENAI_IMAGE_MODEL 误填其他值时，后台在付费请求前报错。图片请求总等待上限 10 分钟，文字请求 4 分钟；超时不等于服务端未计费，所以不会自动重发。
