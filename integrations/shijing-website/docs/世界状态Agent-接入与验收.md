# 世界状态 Agent：接入与验收

世界状态后台与接口已实现，正式页面仅接入地图标记及原有详情弹窗，具体展示范围如下。

## 当前交付范围（按用户最新要求）

正式网页恢复用户原有排版、人物卡片、文字、城池图标、卷轴动画和详情弹窗交互。只替换行动箭头、位置点和旗帜。`map.svg` 不修改；`map-live-markers.svg` 与它相比只移除了一个固定旗帜图层，让旗帜由状态驱动。没有新增演示按钮或面板。

刷新原网站后可检查地图标记。世界状态已初始化时，军队、路线和原详情弹窗读取 strategy 数据；未初始化时保留原交互示意，弹窗未知值显示待接入。原 SVG 左侧人物卡片及文字仍为用户设计素材，并未改成动态数值；不要把它当作裁判的实际结算。后续如要绑定这部分数据，需保持用户原设计单独实施。

独立演示仍能通过后台 `/world-demo` 和 `/world-demo-step` 联调，不在正式页面加入口。演示数值不代表史实。

## 职责与流程

历史研究/导演提供初始世界 → 世界状态 Agent 校验并入库 → 角色与裁判读取 → 裁判提交确认的结构化结算 → 世界状态 Agent 在一笔事务内校验、更新、写入历史 → 网页轮询呈现。

世界状态 Agent 不解读聊天文字来决定战果，不自行决定损耗，也不会因刷新网页而推进时间。它是明确的状态工具和校验器，不需要再配置一个语言模型。队友可以从自己的 Agent 工具调用中使用下面的接口。

## 数据格式 v1

准确类型以 `agents/src/world-contracts.ts` 为准；工具实现在 `agents/src/world-agent.ts`。

| 对象 | 关键字段 | 约束 |
|---|---|---|
| 世界 | worldId、scenarioId、mapId、revision、clock | 一局一世界；mapId 固定 event-map-v1 |
| 时间 | startLabel、elapsedDays | 起始日期文案由研究 Agent 提供；经过天数为整数 |
| 势力 | id、name、color | 颜色为六位十六进制 |
| 军队 | factionId、commander、troops、foodKg、morale、location、status | 人数整数；粮草 kg；士气 0–100 |
| 城池 | point、ownerFactionId、governor、foodKg、defense | 驻军从城内军队合计，避免重复统计 |
| 行动 | decisionId、armyId、kind、origin、target、route、progress、status、日期 | 进度 0–1；抵达不等于占领 |
| 决策 | title、orderText、issuerId、issuedDay、status、related | 只记录已下达命令 |
| 事件 | settlementId、revision、fromDay、toDay、changes、summary | 自动记录变化前后、单位、原因及关联对象 |

ID 使用字母、数字、下划线、短横线，最多 120 字符。军队、城池、行动和决策 ID 在同一世界内不能重名。当前实现每类最多 500 个对象，单次结算最多 200 项变化。

坐标是地图内容区的 0–1 比例。当前素材内容区在原 SVG 坐标中为 x=436…1608，y=143…805；转换式 `x=(svgX-436)/1172`、`y=(svgY-143)/662`。投影层负责转换为页面坐标。军队在路线上按 progress 插值移动，旗帜会避开附近城池，用细线指向真实位置；视觉偏移不改变世界坐标。

## 队友接口

以下地址直接访问本机 Agent 服务，默认 `http://127.0.0.1:4318`。若配置了 AGENT_SERVICE_TOKEN，服务端请求加 `Authorization: Bearer <token>`。不要把服务令牌放进浏览器。远程多人部署前需要团队自己的鉴权和会话隔离。

| 方法与路径 | 用途 |
|---|---|
| POST /runs/:runId/world | 初始世界，只能初始化一次 |
| GET /runs/:runId/world | 完整状态与来源 basis |
| POST /runs/:runId/world-events | 提交确认结算 |
| GET /runs/:runId/world-events | 持久化事件历史，支持分页和筛选 |
| GET /runs/:runId | 原有返回值加 strategy，网页直接使用 |
| POST /world-demo | 建立/恢复独立演示，body 为 requestId |
| POST /runs/:runId/world-demo-step | 按 expectedRevision 推进固定演示步骤 |

网页走 `/api/agents` 同源代理。代理仅开放世界查询和隔离演示，不允许网页直接向 world/world-events 写入正式数值；队友后端直接调用服务端地址。当前是全局观察者视角，未实现角色私有情报/战争迷雾。

### 初始化

提交 `{ initializationId, snapshot, basis: { kind: 'research' | 'mixed' | 'demo', note } }`。

snapshot.worldId 必须等于 runId；snapshot.scenarioId 必须等于该局已有 spec.id；revision 必须为 0。初始军队、城池等需要完整提供，未知资源不要填成 0 冒充事实。重复初始化只有编号与内容均相同才会返回已有世界，不能覆盖已经推进的对局。

`agents/examples/world-initial.example.json` 提供完整可替换模板；其中 `REPLACE_RUN_ID` 和 `REPLACE_SCENARIO_ID` 必须换为实际值，示例数值不能直接当史料。

### 结算示例

```json
{
  "settlementId": "referee-turn-001",
  "expectedRevision": 0,
  "decisionId": null,
  "source": "rules",
  "elapsedDays": 2,
  "title": "两日驻扎消耗",
  "summary": "确认魏延部在汉中驻扎两日，消耗750千克军粮。",
  "mutations": [
    {"kind":"army.adjust","armyId":"army-wei-yan","foodKgDelta":-750,"reason":"两日消耗已确认"}
  ]
}
```

支持 army.create/adjust/move、city.adjust/capture、action.create/update、decision.create/update、resource.transfer。补给调拨优先使用 resource.transfer 同时扣出方、加接收方；合法运输条件由裁判决定，本模块检查同势力、资源守恒与余额。city.capture 必须显式指定新控制方，且同笔结算处理仍在城内的敌军。

成功 POST 返回 HTTP 202，已在响应前完成入库。world-events 响应中的 worldResult 包含 alreadyApplied、appliedRevision、currentRevision、eventId。相同 settlementId 和相同内容重试不会再扣粮，即使世界已推进到更高版本。相同编号不同内容或版本冲突返回 409；非法数值/关联通常 400，缺失对象 404，演示越界 403。错误体为 `{ "error": "说明" }`，没有部分成功。

版本冲突时重新读取、重新裁定，不能简单替换版本后盲目重放旧结算。超时重试必须沿用同一 settlementId 和同一内容。

历史查询例：`GET /runs/:runId/world-events?afterRevision=0&limit=50&entityId=army-wei-yan`。也支持 decisionId；每页最多 200 条，下一页用上一页最后一条 revision。地图展示最近 100 个事件的变化，完整历史仍在分页接口中。

## 与原 Agent 的关系

原有角色素材、故事板、讨论和引擎模块保持独立。没有结构化世界的旧局仍能使用原 /events；某局初始化世界后，旧 /events 写入会被拒绝，避免两套账本同时修改城池和时间。

现有引擎同步不会自动把文本、metrics 或原始结算转换成结构化军队/路线。队友需要提交初始化及 world-events；世界模块仅把日期与城池归属同步到旧返回值，legacy metrics/version 仍归旧引擎管理，页面使用 strategy.revision。不要在两条接口重复提交同一资源变化。

故事板 Agent 可订阅/轮询 world-events，按事件编号去重后自行决定是否生成画面。本模块没有自动触发新生图。

数据库沿用 AGENT_DATA_DIR/agents.sqlite，新增 world_states、world_events、world_demos 三张表。每次结算使用 SQLite 事务，快照和历史一起保存；查询不产生事件，不推进时间。当前版本未提供删除事件、撤销、分支回滚或多人权限功能。

## 验证

- 前后端 TypeScript 编译检查。
- 10 项新增世界状态测试：完整演示、幂等、冲突、整笔回滚、资源调拨、占城一致性、非法输入、持久化与多连接、初始化及接口流程。
- 浏览器验证：开卷、行军、军队详情、城池详情、箭头详情、结局、刷新后保留。
- 原项目回归：初次全量 49 项中 48 项通过，1 项旧素材库检查要求恰好 30 个人物，但当前素材库已是 31 个。未为了让测试变绿而修改队友的素材库或测试。

运行新增检查：`npm run agents:build && node --test agents/tests/world-state.test.mjs`。
