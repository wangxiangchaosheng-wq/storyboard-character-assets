# 上游接入与结果契约

本契约是可采用的接入约定，不代表监听器或产品界面已经部署。自然语言调用同样有效，不强制用户填写 JSON。只传当前故事必要的决策和对话，不传无关私人数据。

## 输入

至少传入相关对话或一个明确要求可视化的重大结果。可选字段：

| 字段 | 用途 |
|---|---|
| request_id | 本次调用标识 |
| branch_id | 当前故事分支，防止同一事件不同结局混用 |
| decision | 用户已经作出的决策 |
| recent_messages | 决策后的相关推演对话、结果及最新纠正 |
| event_result | 上游识别的事件、结果、性质及成立依据；不能压过最新纠正 |
| story_time | 已知年份、日期或相对时间，以及依据 |
| style / reference_images | 已确认画风与可访问参考图；图片需说明是风格还是角色参考 |
| summary_text / time_text | 用户指定文案；省略时由技能提炼 |
| aspect_ratio / size_px | 默认 1537:636；像素对象包含 width 和 height |
| previous_state | 同分支已有成功资产的状态及可访问路径 |
| force_regenerate | 用户明确要求重画时为 true |

字段缺省不代表需要逐项向用户询问。没有 previous_state 就不宣称有跨调用记忆。

## 处理新对话

1. 从当前分支识别决策、后果、成立状态与重要性，未形成重大结果则返回 `not_triggered`。
2. 只有事件、结果、时间、分支、画风、题记、字色或尺寸要求发生变化，或用户明确重画时生成。同一分支同一结果的重复解释可以复用已有成功图。
3. 复用前验证图片仍可访问；失败、预览或缺失文件不能作为成功状态去重。
4. 仅在生成与验收成功后更新成功状态。迟到的旧 request_id 结果可以存档，不覆盖较新的分支或结果。

## 返回

面向 agent 返回紧凑对象，面向普通用户不展示 JSON：

```json
{
  "request_id": "event-request-17",
  "branch_id": "current-branch",
  "status": "not_triggered",
  "event": null,
  "result": null,
  "narrative_type": "hypothetical",
  "summary_text": null,
  "time_text": null,
  "text_color": null,
  "image_path": null,
  "actual_size_px": null,
  "reason": "目前只有出兵方案，尚未推演出重大结果。",
  "state_to_commit": null
}
```

状态：

- `generated`：真实图片已保存，内容、题记和比例验收通过。
- `unchanged`：同分支结果和视觉要求未变，已有成功图可访问；返回该图。
- `not_triggered`：仍在提议或推演中，或结果未达到重大事件门槛。
- `needs_context`：用户已要求结局图，但无法判断关键结果或互相冲突的分支；reason 指明最小缺失信息。
- `partial`：有可查看预览，但比例、文字或其他必要要求未通过；返回实际路径及偏差，state_to_commit 为 null。
- `blocked`：没有工具或必要权限等前置能力；不虚构图片路径。
- `failed`：已尝试生成但没有可用结果；不提交成功状态。

成功状态至少记录分支、事件及结果、性质、时间、总结文案、昼夜与字色、画风、实际尺寸、图片路径和 request_id。用户明确要求的假设图可作为该假设分支的图片状态保存，但不能据此把假设写成主线事件已发生。
