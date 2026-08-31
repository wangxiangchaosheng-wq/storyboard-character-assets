# 人物资产提示词模板

实际生成前必须先读取 [atomicity-contract.md](atomicity-contract.md)。**每个 prompt 只服务一个人物、一个主动作和一个人物道具。**提示词要把“全组不变项”和“单人变量”分开，防止每生成一个人物就发生画风漂移。

## 1. 共享 style bible

先写一段全组逐字复用的规范：

```text
系列用途：<故事板/论坛模拟/游戏/互动页面>
世界与时期：<时间、地点、世界观；准确度要求>
画风与媒介：<工笔、水彩、写实、3D、漫画等>
线条与材质：<边缘、笔触、布料、金属、皮肤等>
镜头与比例：默认腰部以上半身像；完整头冠、肩臂、双手和唯一人物道具；主体约占画布高度 84%–92%；只有用户明确指定时才改为其他取景
构图：单个人物居中或按布局偏置，腰/胯上缘以下衣袍必须由画布底边形成宽幅连续的平直裁切且不留透明缝；半身框内轮廓完整；不做圆弧/椭圆/徽章/悬浮/渐隐收口；不出现膝盖、脚、蹲跪或全身
光线与色彩：<统一主光方向、对比度、饱和度、公共色彩逻辑>
输出：PNG，真实透明背景，无环境、无地面、无底座
共同限制：无文字、无水印、无签名、无边框、无额外人物、无现代错置元素
```

如果页面布局需要人物朝向某一侧或预留文案空间，应由布局需求决定；不要凭习惯随意指定左右位置。

## 2. 单个人物提示词

每个 prompt 最前必须先加入 [atomicity-contract.md](atomicity-contract.md) 中的 **HARD ASSET ATOMICITY** 前缀。

在写 prompt 前先按 [action-signature.md](action-signature.md) 建立人物 Action Signature。使用 `$imagegen` 的共享提示词结构，并只保留有帮助的字段：

```text
Use case: <historical-scene | stylized-concept | photorealistic-natural 等准确 slug>
Asset type: transparent character cutout for <具体用途>
Primary request: 仅生成 <人物名称> 这一个人的单人免抠角色资产；不要生成任何其他人物、群众、重复姿态、拼贴或角色表
Input images: <逐张说明身份/服饰/姿态/风格参考用途；没有则省略>
Subject: <身份、年龄阶段、可信外貌特征；不要编造精确相貌>
Event moment: <当前事件链中的具体瞬间>
Narrative function: <决策/说服/执行/反制/观察/记录/发明/质疑等>
Competence source: <角色此刻真正依赖的能力>
Action verb: <一个强、可画出的主动动词>
Object interaction: <双手分别如何握、佩、阅、写、按或递交已经核验的核心道具>
Prop Card: <只写唯一人物道具的规范名称、角色/事件功能、PERSON-ATTESTED / PERIOD-ATTESTED / LATER-TEXT-ATTESTED、直接来源、来源年代、允许声称范围、图中形制、人物交互与禁加项；不得列第二件道具>
Upper-body posture: <上身前倾/后收/转向、肩线、手肘开合、头部角度；动作必须在半身框内成立>
Gaze target: <明确看向谁或什么>
Expression: <与任务一致的情绪强度>
Silhouette cue: <从剪影也能区分角色的动作结构>
Wardrobe/props: <时代、职业或设定准确的服装与同时通过叙事适配、史实适配的道具；写明只保留哪 1 件核心道具及其有依据的外形，禁止模型补加其他物件；身份和抽象能力不得触发地图、面板或现代设备的古代替身>
Shared style bible: <逐字粘贴全组不变段落>
Composition/framing: waist-up half-body portrait; lower robe broadly and continuously cropped straight by the bottom canvas edge with no transparent gap; complete head, shoulders, both arms, both hands, and exactly one character prop visible; subject occupies about 84%–92% of canvas height; safe top/side margins; bottom-edge contact required
Constraints: exactly one target character; exactly one primary action; exactly one character prop; no zero-prop result; no second prop; actual transparent background; clean alpha edges; no rounded, oval, badge-like, floating, or faded lower silhouette; no knees; no feet; no crouching; no kneeling; no sitting on the ground; no stepping; no full-body or three-quarter-body composition; no invented pseudo-historical device; no second person; no crowd; no duplicate pose; no character sheet; no sticker sheet; no collage; no storyboard panel; no poster; no scene; no text; no watermark
Avoid: <角色特有混淆项 + forbidden generic pose + 错置物 + 重复肢体 + 裁断 + 题材自动触发的高频道具；三国/军师/将领默认禁止地图，除非 Action Signature 通过地图门槛>；除非用户明确指定，必须避免 rounded/floating bottom, full body, three-quarter body, crouching, kneeling, seated-on-ground pose, invented ancient data board, tally dashboard, process panel, hybrid pseudo-historical artifact
```

透明不能只靠 prompt，也不能通过编造工具字段实现。先查看当前图片工具实际暴露的参数：有透明字段就使用；没有就按 [transparency-workflow.md](transparency-workflow.md) 先校准原生 Alpha，失败后自动进入纯色幕布路径。Images API/CLI 仅在实际可用且已获授权时设置其支持的 `background="transparent"` 与 `output_format="png"`。

## 3. 透明提示模式

### 原生 Alpha 校准

使用上面的单人物模板，保留 `actual transparent background`、`no scene` 和 `clean alpha edges`，生成后立即保存并验证。一次失败后不要继续用失败的棋盘格图编辑透明背景，改从空白生成纯色幕布草稿。

### 纯色幕布回退

全组默认锁定纯品红 `#FF00FF`。这一模式下，保持身份、Action Signature、服饰和公共画风不变，但把所有透明措辞替换为：

```text
Background/output mode: the entire canvas background is one perfectly uniform solid pure magenta #FF00FF color, edge to edge.
Color separation: no #FF00FF or magenta hues anywhere on the character, skin, hair, clothing, props, outline, lighting, reflected light, or effects.
Isolation: exactly one target character, one primary action, and one character prop; waist-up half-body portrait with the lower robe naturally cropped straight by the bottom canvas edge; complete head, shoulders, both arms, both hands, and the single prop; no zero-prop result and no second prop; at least 8% uninterrupted solid-magenta safety margin at the top, left, and right; intentional bottom-edge contact is required.
Framing exclusions: no knees, no feet, no crouching, no kneeling, no sitting on the ground, no stepping, no full-body or three-quarter-body composition.
No floor, no cast shadow, no gradient, no texture, no grid, no glow, no scenery, no border, no text, no watermark.
```

纯色幕布提示词中不要再出现“transparent”“alpha”或“checkerboard”，避免模型画出棋盘格或半透明视觉效果。草稿不是最终资产；必须运行 `scripts/chroma_to_alpha.py`，再用黑底、白底预览和 Alpha 校验验收。

若人物必须使用品红，整组改用与主体配色明确分离的纯青 `#00FFFF` 或纯绿 `#00FF00`，并同步修改提示词和转换命令。不得逐人物随意更换幕布色。

## 4. 参考图使用规则

- 身份参考：要求保留人物可识别特征，但不要顺带复制不相关的背景、服装或姿态。
- 服饰/器物参考：只借用能被来源支持的造型和材质，不把参考图风格当成默认风格。
- 姿态参考：借用动作与重心，不复制身份。
- 风格参考：借用线条、材质、色彩和渲染方式，不复制具体人物。
- 多张参考图必须按 Image 1、Image 2 逐张说明用途，避免模型自行混合身份。**尽量每次只使用 1 张包含人物的参考图；前一次失败的群像/拼贴不得作为单人物生成参考。**

内置三国示例图只能在国风历史立绘方向下使用，并标注“风格参考”。如果用户提供了自己的风格参考，以用户参考为准。

## 5. 三国示例

以下示例展示结构，并刻意避免把“北伐 = 地图”写成默认模式：

```text
HARD ASSET ATOMICITY:
Generate exactly ONE target character and exactly ONE primary action.
Default framing is a WAIST-UP HALF-BODY PORTRAIT with the lower robe naturally cropped straight by the bottom canvas edge; the complete head, shoulders, both arms, both hands, and exactly ONE character prop are visible.
This is a single isolated character asset, NOT a poster, NOT a character sheet, NOT a sticker sheet, NOT a collage, NOT a storyboard panel, NOT a group composition.
Do not add any supporting/background people, crowds, duplicate poses, titles, labels, flags with text, scenery, or explanatory graphics.
Include the one researched, historically supported role-signature prop specified in the Prop Card; it must be used or worn by the target character and remain subordinate to the action. Do not omit it and do not add unlisted props.
For historical subjects, every visible prop requires a cited period-appropriate documentary or archaeological basis plus an explicit evidence level (PERSON-ATTESTED, PERIOD-ATTESTED, or LATER-TEXT-ATTESTED); iconography alone is insufficient, and hybrid pseudo-historical devices are forbidden.
No knees, no feet, no crouching, no kneeling, no sitting on the ground, no stepping, and no full-body or three-quarter-body composition.
No rounded, oval, badge-like, floating, or faded lower silhouette.
Leave all unused canvas area transparent.

Use case: historical-scene
Asset type: transparent character cutout for an interactive Three Kingdoms storyboard
Primary request: 生成诸葛亮单人角色立绘，表现北伐部署中的冷静战略整合者
Input images: Image 1 is style reference only; do not copy its exact pose or composition
Subject: 诸葛亮，基于三国时期语境的时代化视觉演绎，不宣称真实肖像还原
Event moment: 北伐前作出是否改变既定部署节奏的决断
Narrative function: 核心决策者 / 战略整合者
Competence source: 军政统筹、后勤组织与风险权衡
Action verb: 定令
Object interaction: 一手在胸前稳持羽扇，另一手向画外做克制、明确的发令手势；不添加筹板、棋盘、算筹、地图或现代装置
Prop Card: 白羽扇；角色功能 = 发令时的后世早期文献识别物；证据等级 = LATER-TEXT-ATTESTED；直接来源 = 《语林》“诸葛亮持白羽扇，指麾三军” <https://www.shidianguji.com/book/SK2007/chapter/1lc6yo4jfady2>；允许声称 = 后世早期文献传统，晚于诸葛亮时代，《三国志》本传未作近同时代实物证明；图中形制 = 素白羽片 + 朴素木/竹柄；交互 = 一手在胸前稳持；禁加项 = 太极、八卦、宝石、机关、筹板、棋盘、算筹、地图；无其他道具
Upper-body posture: 腰上半身微向画外命令对象转动，肩线稳定，抬起手臂形成明确但克制的指令方向
Gaze target: 画外接受命令的将领；对方不入画
Expression: 克制、略有疲惫但高度专注
Silhouette cue: 稳定长袍轮廓 + 胸前羽扇 + 一侧发令手势
Wardrobe/props: 端正汉末文士服饰，克制纹样；只保留已记录证据等级与来源的白羽扇，不添加其他器物
Shared style bible: 细腻工笔与淡水彩结合；统一暖灰纸本质感；清晰墨线；低饱和米白、墨黑与旧金；统一腰部以上半身像；柔和左上主光；PNG 真实透明背景；无环境、文字、水印或边框
Composition/framing: waist-up half-body portrait; lower robe naturally cropped straight by the bottom canvas edge; complete head, shoulders, both arms, both hands and feather fan visible; subject occupies about 84%–92% of canvas height; safe top/side margins; intentional bottom-edge contact
Constraints: exactly one target character; exactly one primary action; exactly one character prop; no zero-prop result; no second prop; actual transparent background; clean alpha edges; no rounded, oval, badge-like, floating, or faded lower silhouette; no knees; no feet; no crouching; no kneeling; no sitting on the ground; no stepping; no full-body or three-quarter-body composition; no invented pseudo-historical device; no second person; no crowd; no duplicate pose; no character sheet; no sticker sheet; no collage; no storyboard panel; no poster; no scene; no text; no watermark
Avoid: modern clothing, fantasy magic, actor likeness, background scenery, cropped hat/hands/fan, rounded or floating lower silhouette, generic front-facing fan pose, full body, three-quarter body, crouching, kneeling, seated-on-ground pose, tally board, game board, ancient data board, hybrid device, map, route arrows, place labels, strategic infographic
```

### 地图确实不可替代时的写法

只有 Action Signature 已通过地图门槛，才在单人变量中明确加入：

```text
Map necessity: PASS — the primary action is explicitly geographic route comparison; removing the small local map would make the action unreadable.
Object interaction: 一手压住仅占画面很小比例的局部无文字军图，另一手移动一个军标；地图为从属动作道具，不出现地名、路线箭头、疆域轮廓或信息图。
Avoid: large map, labeled map, territory map, infographic map, repeated map pose used by other characters.
```

如果不能写出 `Map necessity: PASS` 的具体原因，就不要加地图。

## 6. 定向修正

出现问题时先判断是否为原子性失败。**若出现第二人物、群像、拼贴、角色表、多个姿态或海报场景，直接作废并从空白重新生成，禁止继续编辑该错误图。** 只有人物数量已经正确时，才一次只修一个主要局部问题。例如：

```text
仅修正背景：把背景变为真实透明，保留人物身份、姿态、服装、道具、画风、光线、构图和画布尺寸完全不变；不要新增文字、边框、阴影或环境元素。
```

不要用“更好看”“再优化一下”之类无法验证的反馈触发整图漂移。
