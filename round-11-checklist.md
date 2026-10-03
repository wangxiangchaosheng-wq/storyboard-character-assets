# 第 11 轮清单：多智能体测试与迭代改 bug

> 上一轮（Round 10）已修完并提交：BUG-001 整局锁死（粜粮不记总账）、计策面板白屏、
> 地图底图改满幅 terrain PNG + 坐标换算、SSR localStorage、存档抽屉/清存档方法、
> 终局与无推演守卫、抽屉遮地图、Tab 陷阱、连点建两局、敌方驻守刷屏、撕约单向标注。
> 本清单只收录**尚未修**的条目，作为本轮三个子智能体的打靶图。

## 一、Round 10 审查发现但未修（前端）

| # | 位置 | 问题 |
|---|---|---|
| 1 | `PlayScreen.tsx` boot/poll effect 依赖 `[locale]` | 切语言会整局重拉并重置轮询计时器；应只依赖 URL 里的 run |
| 2 | `PlayScreen.tsx` submit 失败 | 直接显示裸错误；缺 `error.orderFailed`（超时后令可能已生效，别催玩家重下）与 `error.orderEmpty`（空「下达行动」拦截） |
| 3 | `PlayScreen.tsx` jump 拦停 | 只说「途中暂停：X」；未用更清楚的 `discussion.jumpHalted` / `jumpCourier`，`leisure`/`fiscal` 汇报完全没用上 |
| 4 | `PlayScreen.tsx` updateProvince | `reason:'玩家在省政面板交付'` 写死中文，EN 起居注混中文 |
| 5 | `StrategyScreen.tsx` 全文 0 处 `t()` | `aria-label`/`alt`/详情表字段名全硬编码中文（`strategy.aria/alt/viewDecision/detailsClose/field.*` 两表都有键） |
| 6 | `StrategyScreen.tsx` `onProvinceUpdate` | 解构了却从未使用的死 prop（inline 模式省政归侧轨） |
| 7 | `PlayScreen.tsx` `onboardingProgress` | 死 import（会撞 noUnusedLocals） |
| 8 | `debug/page.tsx` `AchievementsView` | 类型写成 `{unlocked?,locked?}`，真实响应是 `{progress,newlyUnlocked,summary,steamAvailable}` → 调试台永远显示「已解锁 0/0」 |
| 9 | `LauncherScreen.tsx` 续局浮层 | `role="dialog" aria-modal` 但无焦点管理（打开不移焦、Tab 可逃逸）、无 Esc 关闭 |
| 10 | `globals.css` `.alarm-banner{z-index:7}` | 会盖在 `z-index:auto` 的抽屉之上，告警卡与打开的面板互相叠 |
| 11 | `LauncherScreen.tsx` / `debug/page.tsx` 的 fetch 兜错 | 写死中文「请求失败（status）」；已新增 `error.http` 键但两处未接 |
| 12 | `PlayScreen.tsx` 抽屉 | `drawer()` 每次渲染调两次；无 Esc 关闭；dock 按钮无 `aria-controls` 指向抽屉 |
| 13 | `StrategyScreen.tsx` 对象 `<g role="button">` | 有 aria-label 但无可见焦点环（键盘用户看不出选中谁） |

## 二、Round 10 审查发现的样式/一致性问题

- 抽屉里同时驻着深色原生面板（朝政）与复用的纸色面板（国力/国库/外交/军情/存档，仍带
  `position:absolute;left:50%`），视觉上两套 UI 叠在一起；抽屉宽度变窄时排版散。
- `.play-map .strategy-scroll` 的宽度按 `100svh - 172px` 推导，而顶栏会 flex-wrap、
  告警条/note/error 行、时间按钮换行都会增高 → 窄屏总高超首屏、底部指令栏折出屏。
- 终局横幅 `role="status"`，建议 `role="alertdialog"` 并移焦。

## 三、功能面待探明（本轮 QA 重点，尚未系统测过）

1. **存档/读档闭环**：`/play` 与 `/discussion` 两侧存槽互通、读档回滚（BUG-114 的后端回滚）、
   槽满时的自动存档、跨局读档（`saves/load` 的 gameId 不是本局时跳转）。
2. **成就链路**：`GET /runs/{id}/achievements` 的真实响应形状、`newlyUnlocked` 的 toast、
   推 Steam 的 no-op 降级。
3. **史官导出**：`/chronicle` 记录体积、`ChronicleExport` 的复制与下载、长局（300+ 日）下的表现。
4. **方针→代决闭环**：`commander` 的 mandate 下达/撤销/plan，三种朝政态（attending/delegated/indulging）
   下的代决明细差异。
5. **省政经济反馈**：治政模式 → 年产 → 库藏/粮草的完整回路，税率与腐耗的影响，欠饷（arrears）后果。
6. **谍报/迷雾**：`FogPanel` 的情报层级、`stale` 标记、探索令（explore）后的情报更新。
7. **三个非推演剧本**：官渡/赤壁/白帝在阅览室模式下的问对、故事板、时间线派生。
8. **长局极限**：连续推进至 verdict 终局，观察 SQLite 体积、轮询带宽、有无数值漂移。

## 四、工程面

- 打包体积与首屏：`/play` 首屏需要哪些 chunk，`map-canvas.png`（已弃用）是否还在产物里。
- 2.5s 轮询在长会话下的请求量与内存（`setView` 每次都换整个 view 对象）。
- `docs/` 与代码注释的同步（上一轮的踩坑记录是否落到了记忆与报告）。

## 五、已知设计如此（不要当 bug 报）

- 只有子午谷之议（228，蜀汉窗口 227—235）挂本地战役推演；官渡/赤壁/白帝走「问对与阅览」，
  选局面板已标注（BUG-108 守门）。
- 军队携粮上限 120t，补给 10000 只到余量 250 公斤是**设计**（余粮随运输队返回）。
- 成都存粮随省产累加无上限——这正是「粜粮济民」出口存在的原因。
- `agents/tests/agents.test.mjs` 的「topic: fast draft」在本机因生图域名被 SSRF 守卫
  判成本机地址而失败，与代码无关（干净树上同样挂）。

## 第 11 轮已修（2026-09-29，三项测试 + 浏览器验收）

| 项 | 修法 |
|---|---|
| B1 运输队追军越界锁局 | `simulation-engine.ts` 追军目标 clamp 到运输队所在路的 `[0, distanceKm]`；回归测试 |
| B4 单次推进不结算财政/预警 | `world-agent.ts` advance 路径补 `settleFiscal` + `assessUpheaval`；`SimulationReport` 增 `fiscal`/`alarms` 字段；回归测试 |
| B6 终局后仍可改授权簿 | `server.ts` commander mandate/revoke 加 `worldVerdict` 守卫 |
| B5 卡面 30 年 vs 实际 10 年 | `scenarios.ts` 新增 `effectiveYears()`（与 `world-bootstrap.goalYears` 同口径）；选局面板用它 |
| ProvincePanel 条件 Hook 崩 | 三个 `useState` 移到 early return 之前 |
| S1/G3 抽屉定位崩 | `.play-drawer` 改 `position:relative` + 抽屉内作废复用面板的 absolute；告警条在 `/play` 走流内 |
| N13 计策资格恒不合格 | `StratagemPanel` 传真世界给 `eligibility` |
| N6 成就页签切不动 | drawer 的 deps 补 `saveTab` |
| #1 切语言重拉整局 | boot effect 只依赖 URL 里的 run 参数 |
| N1 debug 锚点空白 | `label` → `title`（真字段名） |
| #8 debug 成就恒 0/0 | `AchievementsView` 换真实形状按 `progress` 计数 |
| #2 submit 裸错误/空话 | 接 `error.orderFailed` / `error.orderEmpty` |
| #4 province reason 写死中文 | 走 `play.provinceReason` 两语言 |
| #11 两处兜错写死中文 | 接 `error.http`（新增 `detectLocale`） |

## 下一轮打靶（本章以上均未修）

| # | 位置 | 问题 |
|---|---|---|
| A | `StrategyScreen.tsx` 全文 0 处 `t()` | aria/alt/详情字段名硬编码中文（`strategy.*` 与 `field.*` 约 50 键两表齐全却没人用） |
| B | `LauncherScreen`/`ScenarioPicker`/`SaveSlotsPanel` 的 `role="dialog"` | 无移焦/无 Esc/无 Tab 圈闭（StrategyScreen 有现成范式可抽 `useDialogFocus`） |
| C | `/play` 跨局读档 | 未校验目标 run 存在（/discussion 有），换机器存档会跳到 500 页 |
| D | `SaveSlotsPanel.tsx` 整块 0 i18n | 约 25 个壳层键待补 |
| E | `.play-map .strategy-scroll` 的 `100svh - 172px` | 裸魔法数；顶栏折行/告警条/提示行会挤爆首屏；改 max-width/max-height + aspect-ratio |
| F | 2.5s 轮询带全量 history 与 changes | 随局长线性膨胀；建议 revision 短路或服务端截断 |
| G | `world_strategy_snapshots` 不淘汰 | 生产库已 7.13GB，磁盘 98%——会吃满磁盘的事故 |
| H | `.strategy-objects g:focus` 被 `filter:none` 覆盖 | 选中高亮与键盘焦点环都不渲染 |
| I | `debug/page.tsx` 事件页 `changes` 只报计数 | FieldChange 的 before/after/unit 全没展示 |
| J | 敌对行军财政口径（B3） | treasury 按全图 12 省/全军征收发饷，与省政层属主校验矛盾 |
| K | B2 本地局史官 | `first_edict` 永不可解锁、终局导出 60 条决策无一条带玩家原话（`orderText` 就在簿里） |
| L | B7/B8/B9/B10 | 探索情报即时生效却写「4 日后到军中」；fog 城市情报不点亮军队、summary 恒 0；满槽 auto 存档 409 而注释写「静默跳过」；court 超 20 字静默清空 |
