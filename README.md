# Storyboard Character Assets

一个用于**故事板 / 论坛模拟 / 历史互动页面**的人物资产生成 Skill。

输入一个事件、议题或故事主题后，Skill 会研究并选择默认 **5 个最不可替代角色**，为每个角色建立具有叙事功能的动作与历史道具约束，并生成风格统一的**单人物、单主动作、单人物道具、腰部以上、真实透明背景 PNG**。

## 核心约束

- 默认选择 5 个最不可替代角色；只有额外角色显著改变关键因果链时才扩展。
- 一个资产 = 一个角色 = 一个主动作 = 一个核心人物道具。
- 默认腰部以上半身构图，衣袍在画布底边形成自然、平直、连续裁切。
- 历史人物道具需通过史实适配与来源检查，不使用无依据的“伪古董”或现代概念古代化道具。
- 透明 PNG 采用“原生 Alpha 优先 + 纯色幕布转 Alpha 回退”的双路径，并通过实际 Alpha 校验验收。
- 禁止群像、人物表、贴纸页、场景海报、额外人物、额外道具、文字信息图。

## 仓库结构

```text
storyboard-character-assets/
├── SKILL.md                       # Skill 主规则
├── CHANGELOG.md                   # 版本变更记录
├── agents/
│   └── openai.yaml                # Skill 展示/默认调用配置
├── references/                    # 详细契约、工作流与质量标准
├── scripts/                       # Alpha、裁切与资产校验脚本
└── assets/
    └── style-reference/           # 可选风格参考资产
```

## 关键文件

- `SKILL.md`：主入口与完整执行流程。
- `references/character-selection.md`：核心五人选角与扩展门槛。
- `references/atomicity-contract.md`：单人物原子资产硬约束。
- `references/action-signature.md`：把角色功能转换为人物特异性动作。
- `references/historical-props.md`：历史道具的证据等级与 Prop Card。
- `references/transparency-contract.md`：透明输出能力边界与失败判定。
- `references/transparency-workflow.md`：原生 Alpha / 纯色幕布回退流程。
- `references/quality-standard.md`：批量资产质量验收。

## 本地脚本

```bash
python3 scripts/validate_character_assets.py <png> [<png> ...]
```

纯色幕布回退示例：

```bash
python3 scripts/chroma_to_alpha.py draft.png final.png \
  --key '#FF00FF' --mode all --allow-bottom-touch --preview-dir qa
python3 scripts/align_bottom_crop.py final.png aligned.png
python3 scripts/validate_character_assets.py --require-bottom-touch aligned.png
```

## 版本

当前包：**v6.3.1**。

详细版本变化见 `CHANGELOG.md`。
