# Agent 调用契约

这是面向未来上游 agent 的接入约定，不代表已经部署了消息监听或自动化服务。普通文字调用同样有效；不得要求每次都提供 JSON。

## 输入

最简输入就是“草船借箭”。结构化输入可使用：

```json
{
  "request_id": "chat-a-turn-12",
  "active_topic": "子午谷奇谋",
  "recent_messages": [
    {"role": "user", "content": "接下来聊子午谷奇谋。"}
  ],
  "story_context": "三国背景，讨论奇袭方案的设想",
  "event_stage": "方案设想",
  "visual_focus": "险峻山谷中的隐蔽行军意象",
  "style": "泛黄纸张、水墨山水、克制的历史插画",
  "aspect_ratio": "452:801",
  "size_px": null,
  "previous_state": null,
  "force_regenerate": false
}
```

active_topic 与 recent_messages 至少提供一项。其余字段可省略；没有参考图、角色文件、场景资产也必须可执行。aspect_ratio 默认是 "452:801"（宽:高，竖版），省略时仍使用此比例；只有用户明确要求其他比例时，上游才传入覆盖值。size_px 若提供则为 width / height 像素对象，应与有效比例一致；比例与分辨率冲突时优先保持用户要求的比例。

只接收当前任务必要的聊天内容，避免把账号、联系方式和无关私人信息送入图像工具。

## 每次新消息后的上游流程

1. 更新最近对话，识别当前主题和事件阶段。
2. 若首次需要图、主题改变、重要事件阶段/画面重点改变、风格/尺寸改变或用户要求重画，调用本技能。
3. 同题一般追问不需要反复生图。agent 可传 previous_state 让本技能协助去重；不以“已聊满六轮”为调用前提。
4. 收到生成并验收通过的图片后更新界面与成功状态；失败保留上一张成功图。
5. 若调用未完成时主题又变，上游把旧 request_id 的结果存档，不把它覆盖到更新主题的界面上。

这些是接入逻辑，不在本次技能执行中创建后台循环，也不默认开启付费服务。用户要求每轮刷新或强制重画时按其策略处理。

## 去重与失败

比较 topic_key、story_context 中有意义的变化、event_stage、visual_focus、style、aspect_ratio 和 size_px，而不是只比较标题字符串。左侧总结的文案或显示要求发生变化时也需要更新图片。force_regenerate=true 绕过同题去重。

只用“成功生成且文件仍可访问”的 previous_state 作为去重依据。失败调用不能把新主题标记为已经完成，否则后续会一直跳过需要的图片。

同一 request_id 若已有成功记录且图片有效，返回既有结果；没有持久记录则不声称实现了幂等。除当前调用或上游传入状态外，技能不假装拥有跨进程记忆。已有明确生成请求却没传 previous_state 时直接生成。

## 返回给 agent

返回紧凑结构化结果；以下是工具能力缺失时的合法示例：

```json
{
  "request_id": "chat-a-turn-12",
  "status": "blocked",
  "topic": "子午谷奇谋",
  "topic_key": "ziwu-valley-plan",
  "event_stage": "方案设想",
  "visual_focus": "险峻山谷中的隐蔽行军意象",
  "image_path": null,
  "actual_size_px": null,
  "reason": "当前没有可用的图像生成工具",
  "state_to_commit": null
}
```

status：
- generated：实际图片已保存并通过检查；image_path 为可访问的真实路径，actual_size_px 为实测 width / height，state_to_commit 为下次去重需要的完整成功状态。
- unchanged：主题和视觉要求未变且上一张成功图片有效，返回上一张图片及其状态。
- needs_context：无法确定事件、时代或指代；reason 写最小缺失信息，image_path 为 null。
- blocked：无图像工具或必要权限等执行前置条件缺失；不给伪图片。
- failed：实际尝试生成或验收后仍失败；不提交新的成功状态。

成功状态包含本次主题、事件阶段、画面重点、实际采用的画风与尺寸、左侧总结文案及字色（无字版为 null）、request_id 和图片路径。结果元数据供 agent 使用，不是面向普通用户的脚本或素材包。

普通用户调用默认只看本次一张最终图片；无需收到 JSON、主题分析、提示词或文件清单。
