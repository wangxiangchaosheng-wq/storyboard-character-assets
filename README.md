# AI 历史模拟引擎（知乎黑客松 · 赛道三）

**任何知乎话题 / 一句话提问 → 一局能在通用引擎里玩的推演剧本**：剧本、人物、
数值指标、演化公式全部由 AI 动态生成（mock 模式下按史实线索确定性推导），
**不为任何话题写死数值或台词**。只有 `ScenarioSpec` 一个契约，话题只是输入。

```
一句话/知乎链接 ──▶ 考据司 ─▶ 构演司 ─▶ 数值司 ─▶ 审校司 ──▶ ScenarioSpec ──▶ 推演引擎
                  (史实/缺口)   (人物/剧本)  (指标+公式)  (对齐校验≤3轮)  (provenance/derivation 随附)   (可玩)
```

- 数值司 `packages/topic-pipeline/src/values.ts`：每个指标带 **provenance**（这个数去哪找真实：
  出处/检索路径/估算链），每条规则带 **derivations**（公式为什么这样推）。
- 双实现同 schema：真 LLM 生成（`deriveNumbers`），mock/离线确定性启发（`deriveNumbersOffline`——
  从考据原文抽「名词+数字+单位」构指标，如「前秦 80 万 vs 东晋 8 万」→ 两个指标；无数字按语域给科目并标注估算）。
- 详细设计见 `docs/00` 起的 13 篇文档目录。

## 现在就玩（全离线，无需任何 key）

```bash
pnpm install

# ① 一句话提问 → 剧本 + 数值 + 公式 + 溯源
pnpm topic "淝水之战：前秦 80 万大军为何败给东晋 8 万北府兵？"
pnpm topic "唐朝安史之乱后藩镇割据，中央为何无力节制河北三镇？"
pnpm topic "创业公司 C 轮融资：增长与烧钱之争"

# ② 知乎/任意公开链接（safeFetch 门禁：拒绝私网/环回）
pnpm topic:url <链接>          # 如 https://www.zhihu.com/question/19735470

# ③ 服务端（REST + SSE）：ingest → build → 轮询 → spec → 建局 → 每回合 decide
pnpm serve                    # 默认 http://localhost:8787
#   会话/终局/剧本落盘 SQLite（.data/sim.sqlite，可 DB_PATH 覆盖）→ 重启不丢局；
#   URL 哈希 #g=游戏Id / #t=话题Id 可直接回到对应页面。

# ④ 网页界面（单页应用）：输入一句话/贴链接 → 实时阶段演示 → 剧本页（人物/数值条/规则+公式溯源）
#    → 「以我之名，投入推演」开局 → 每回合看过程选方针 → 终局判定。手机端自适应。
#    浏览器打开 http://localhost:8787 即玩；Windows 下也可双击仓库根目录 start.cmd 一键启动。

# ④ 六话题验收脚本（全 ready + cast/指标差异化断言复跑）
node --experimental-strip-types packages/topic-pipeline/scripts/verify-topics.mts
```

## 测试与检查

```bash
pnpm check   # 全仓 tsc --noEmit
pnpm test    # 89 用例（llm 50 / facts 12 / topic-pipeline 16 / serve 9 e2e+静态页 / engine 2）
pnpm review  # 一键审查工作流（运行初始化/交付前自检，无需人工逐项验收）：
             #   S1 类型检查  S2 全量测试  S3 静态审计（禁游戏化指标词/前端单位/脚本语法/凭据字面量）
             #   S4 真实进程冒烟（起服务→建话题→构建→spec 纪律断言→建局）
             #   结论与明细写入 review/report.json；任一失败 exit 1 并红字列出
pnpm smoke   # 仅进程级冒烟（review 的第 4 步，可单跑）
```

> **启动自检**：`pnpm serve` 启动时自动读取 `review/report.json`——
> 12 小时内审查通过则日志打 `[启动自检] 启动审查通过（N / N 项）`；
> 缺失/过期/未通过则 `WARN` 提示先跑 `pnpm review`（仅提示，不阻塞监听）。
> 改完代码后的标准交付动作：`pnpm review` → 重启服务 → 启动日志即自带审查结论。

> 真实 LLM 时：`packages/llm` 读 `.env`（见 `docs/06`），管线自动切换
> LLM 动态生成分支；未配置则全程离线确定性，产物 schema 一致。

## 仓库布局

```
shared/contracts    契约 DTO（单一事实源）
packages/llm        LLM 网关 + 安全 fetch（SSRF 门禁）
packages/facts      SQLite 史实库 + BM25（+可选向量）检索 + 估算器
packages/topic-pipeline  四司流水线（考据/构演/数值/审校）+ 数值司动态推导
packages/engine-core    通用推演引擎（确定性结算、规则引擎、发散检测）
packages/serve      服务端（REST + SSE 进度）
apps/*              Web / 桌面 / 小程序 / 移动端壳脚手架
docs/               《后端架构方案.md》细分为 13 篇（00 起）
```