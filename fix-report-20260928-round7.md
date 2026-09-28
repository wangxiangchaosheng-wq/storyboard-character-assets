# 第七轮修复报告（2026-09-28）

## 本轮目标
游玩找 bug：巡边 stall / 点数封顶出口 / 义仓粜粮 / 长局体验

## 新增机制

### BUG-122 探索语法守卫
`模拟-commands.ts`：`kind==='explore'&&!spot` 时直接抛 `GrammarRejection`，带引导文案「请指明目标城」，不落入 LLM。同时追加口语后缀剥离（`的虚实/动向/底细/兵力/布防/详情/状况/情况/情形`），使「探查长安虚实」正确解析为 target='长安'。

### 点数加急
`focuses.ts` / `techs.ts`：新增 `expediteFocus(state,focusId,day)` 与 `expediteTech(state,techId,day)` 纯函数。1 点 = 缩短 1 日，单次上限 30 日，仅允许对进行中的条目操作，点不足 / 不在进行中 / 今日即成 均 409。
`world-agent.ts`：对应 `expediteFocus()` / `expediteTech()` 方法，事务化，指纹口径 `focus-expedite` / `tech-expedite`。
`server.ts`：`POST /runs/{id}/focus-expedite`、`POST /runs/{id}/tech-expedite`。

### BUG-123 粜粮出口
`simulation-commands.ts`：新增 `parseSellGrain(w,text)`，识别 `粜/卖粮/开仓` 关键词，解析 `X万` 格式金额，缺省 5 万公斤，默认选本方最富城池，上限 100 万公斤。
`command-understanding.ts`：catch 分支加 `parseSellGrain` 兜底；`ORDER_KINDS` 已含 `explore`（上轮）。
`world-agent.ts`：新增 `sellGrain(runId,raw)` 方法：
- 版本锁 + commandId 幂等（指纹口径 `decision`，与 `commitLocal` 落库一致）
- 城粮 ≥ amountKg + 10000 底仓守卫
- 仅限己方城池
- 每 2.5 万公斤 → +1 朝望/+1 寒门认可，单次各上限 +5
- 事务外调用（localMessage 先调 sellGrain 再补消息流，避免事务嵌套）
`server.ts`：`POST /runs/{id}/sell-grain`。

## 发现的真实 Bug

### sellGrain 幂等指纹口径错误
**根因**：`sellGrain` 计算指纹用 `{kind:'sell-grain', input}`，但 `commitLocal` 落库用 `{kind:'decision', input:{commandId,expectedRevision,choiceId}}`，两者不匹配，导致幂等重放时 `prior.digest !== fingerprint`，误报「相同请求编号对应不同内容」。
**修复**：`sellGrain` 内部直接计算 event 口径指纹 `digest({kind:'decision', input:{commandId,expectedRevision,choiceId:'sell-grain:'+input.cityId}})`，与 `commitLocal` 落库口径完全对齐。
**影响**：仅卖粮幂等路径受影响，首次提交不受影响。

## 测试
- `npm run agents:test`：413/413 pass
- `npm run steam:test`：全绿
- 新增 4 个第 7 轮用例：
  1. 探索必须指明目标城（BUG-122 GrammarRejection）
  2. 国策加急（1 点=1 日、上限 30、仅进行中）
  3. 科技加急同口径
  4. 粜粮济民（城粮减少/朝望/寒门/幂等/底仓守卫/敌城拒绝）

## 归档
报告归档至 `playtest-20260927-agent-rounds.md`（append）。
