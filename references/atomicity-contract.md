# 单人物资产原子性契约

本文件定义本 skill 最重要的输出边界：**一个资产 = 一个人物 = 一个主动作 = 一个人物道具 = 一个腰部以上半身像 = 一个独立文件**。

该规则优先级高于“完整表达主题”“展示阵容”“让画面更丰富”等任何审美或叙事倾向。主题用于决定**选谁**，不是决定**一张图里放多少人**。

## 1. 硬规则：ONE ASSET = ONE CHARACTER = ONE ACTION = ONE CHARACTER PROP

每一次图片生成/编辑调用最终必须只产出：

- **恰好 1 个目标角色**；
- **恰好 1 个主动作**，动作来自该角色的 Action Signature；
- **恰好 1 个人物道具**，即 Prop Card 中唯一列出的核心道具；不得漏画，也不得增加第二件独立人物道具；
- 默认是**腰部以上半身像**，不是全身人物插画；
- 一个独立透明 PNG 文件；
- 无场景、无第二人物、无群体、无角色表、无拼贴、无故事板分镜、无信息图、无标题或标签文字。

允许：

- 1 个角色；
- 1 个主动作；
- 1 件与动作直接发生物理关系且通过时代/设定依据检查的人物道具，例如有来源支持的文书载体、兵符、兵器或工具；
- 道具随人物一起成为免抠资产，但不得扩张成完整环境。

“人物道具”指人物正在握持、佩用、查看或操作的独立核心物件。常规衣袍、内衬、腰带和发冠作为服装结构不另计；可独立拿取的兵器、扇、简牍、印、符、书刀、笔等均计为人物道具。不得把两件物品称为“一套”来绕过数量限制。

禁止：

- 2 个或更多人物；
- 0 件人物道具，或 2 件及以上相互独立的人物道具；
- 同一人物的多个姿态或多个版本；
- character sheet / sticker sheet / collage / lineup / group composition；
- 群众、士兵队列、背景助手、陪衬人物、剪影人群；
- 场景化桌案、军帐、战场、建筑、天空、地面、山水背景；
- 为“解释主题”增加的无人机、旗帜、信息板、文字、图例、标题、标语；
- 把多个真实器物拼接成没有来源的“伪古董”，例如古代数据板、流程筹板、调度控制台；
- 将多个角色资产排在一张大图里再让后续步骤自行裁切。

如果一个主题最终选出 N 个角色，必须执行 **N 次彼此独立的图片生成调用**，得到 N 个独立文件；每个文件都必须各自包含恰好 1 个人物道具。

## 2. 群体概念如何处理

当主题中出现“1 万大学生”“军队”“百姓”“研究团队”等群体时，默认将其视为一个叙事角色类型，生成 **1 个代表性人物资产**，除非群体内部不同子角色会显著改变事件走向。

例如“1 万大学生穿越三国北伐”默认：

- 大学生群体 → 只生成 1 个“大学生代表”资产；
- 不生成 1 万人、人群、队列或多人小组；
- 若医学、工程、物流三个学生子群在因果链中确实承担不可替代的不同作用，只有通过角色扩展门槛后才可分别作为额外角色；每个仍然单独生成。

## 3. 道具边界：动作道具可以，环境不可以

判断一个物件是否允许出现，问三个问题：

1. 它是否显著提高当前动作的可读性或角色辨识度？
2. 这个物件是否正在被角色使用、佩用或查看，而不是作为环境陈列？
3. 它是否已经完成 [historical-props.md](historical-props.md) 的 Prop Card？

三项均为“是”时可以保留。道具不必达到“删掉后动作完全无法成立”的程度；史据充分、能显著提高身份辨识的器物也可以保留。

历史题材还必须核对：

4. 这个物件的类型和图中形制是否有可靠的同时代/相邻时代文献或考古依据？人物专属使用关系属于哪一证据等级？

唯一人物道具必须记录：`PERSON-ATTESTED`、`PERIOD-ATTESTED` 或 `LATER-TEXT-ATTESTED`，并附直接来源与允许声称范围。只有后世图像惯例而没有史料/器物依据时不允许出现；`LATER-TEXT-ATTESTED` 还必须确认器物类型本身符合时代，并标出证据年代差。无法回答时先换候选；未找到合格道具前不得生成。不得因为“看起来古代”就把简牍、算筹、棋盘、兵符等不同器物拼成新装置；不得把抽象的现代知识、战略能力或组织能力自动实体化成伪古代仪器。

例如：

- 诸葛亮“作出北伐决断” → 羽扇只有在记录《语林》等早期后世文献来源、确认羽扇类型在时代上可解释并标为 `LATER-TEXT-ATTESTED` 后才可用；不添加所谓“筹板”“调度板”。不可保留完整军帐、桌面陈设、士兵、旗帜。
- 大学生“把现代知识转成古代文书” → 如确需道具，只用一种来源清楚的普通书写载体与笔具；不要把竹简、算筹和棋盘拼成现代计算界面的古代替身。**不要因为北伐主题自动给大学生地图。**
- 魏延“推动突袭方案” → 优先用上身前压、伸手请战和另一手收紧形成进攻性，不默认添加刀鞘、兵符或军令；**地图不是必需物**。只有当动作本身是‘指认具体地理路线’、没有地图就无法读懂，且地图形制通过史实门槛时，才允许极小局部路线图。不可增加随从、战马、军阵。


## 3.1 地图不是默认战略道具

地图、军图、疆域图、路线图属于**高风险高频道具**，特别容易让三国/战争题材的所有角色趋同。必须通过以下门槛：

1. 当前主动作是否明确是“读取 / 标注 / 推演 / 指认具体地理路线”之一？
2. 移除地图后，动作是否会失去关键因果关系或无法一眼读懂？
3. 角色的手或视线是否正在直接操作地图，而不是地图只是悬挂/摊开作为题材说明？

只有三项均为“是”才允许地图。否则禁止。

同时禁止：

- 因为人物是军师、将领、三国人物、北伐参与者就自动加地图；
- 大面积地图、完整疆域、地名标签、红蓝箭头、战略信息图；
- 同组多人重复“拿地图 / 指地图 / 看地图”；
- 用地图替代动作设计。

**组内去重规则：** 若两名及以上角色都通过地图门槛，必须进一步证明他们的物理操作方式与叙事功能明显不同；若只是同一种“指地图”，至少一人必须改用其他动作或道具。

## 4. 构图要求

- 画面主体只能是目标角色；必要道具为从属元素。
- 用户未指定取景时，固定为腰部以上半身像：完整头冠/头发、肩臂、双手及必要道具；腰/胯上缘以下衣袍必须由画布底边形成宽幅连续的平直裁切，不得留下透明缝。
- “完整轮廓”是指半身框内的头部、肩臂、双手和必要道具完整，不代表必须画出整个人。
- 主体通常占画布高度约 84%–92%；顶部与左右留出安全边距，底边作为半身裁切线。
- 动作结构必须在半身框内一眼可读，差异来自手势、道具操作、肩线、头部角度、视线和表情。
- 默认不得出现膝盖、脚、蹲姿、跪姿、盘坐、跨步或全身轮廓；不得为了展示动作自动扩大到四分之三身或全身。
- 不得把衣袍底部做成圆弧、椭圆、徽章、悬浮或渐隐收口；透明背景不要求人物底部离开画布。
- 不用“丰富构图”填空白；透明留白是正确结果。
- 不把人物放进海报、卡片、故事板边框或场景底图。
- 不为主题完整性添加第二个角色来“互动”。需要互动时，用视线方向、手势和动作意图暗示对方，但对方不得出现在该资产中。

## 5. 生成失败的处置规则

以下情况属于 **Atomicity Hard Fail**：

- 出现第二个人物；
- 出现多人、群像、人物表、拼贴或分镜；
- 同一个角色出现多个姿势；
- 大面积场景或海报式背景；
- 自动添加标题、标签、旗帜文字或说明图；
- 将多个独立资产塞进同一画布。

以下情况属于 **Framing Hard Fail**（除非用户明确要求该取景）：

- 画成全身或四分之三身；
- 露出膝盖或脚；
- 蹲、跪、盘坐、跨步、奔跑或依赖地面的姿态；
- 双手或主动作道具因错误取景被截断；
- 需要事后硬裁切才能看起来像半身像。
- 半身衣袍底部被做成圆弧、椭圆、徽章式、悬浮式或渐隐式收口。

发生 Atomicity Hard Fail 时：

1. **立即作废该图，不进入资产库。**
2. **不要基于错误群像继续编辑。** 群像、拼贴、角色表会把构图先验持续带入后续编辑。
3. 从空白重新生成该单个角色，并在 prompt 最前加入原子性硬前缀。
4. 只有当人物数量已经正确、只是透明边缘/局部道具/裁切等局部问题时，才允许定向编辑原图。

发生 Framing Hard Fail 时同样从空白重生成，并重写 Action Signature 使动作在半身框内成立；不得把全身/蹲跪图直接裁成半身。

## 6. 原子性硬前缀

每个单人物 prompt 顶部应加入：

```text
HARD ASSET ATOMICITY:
Generate exactly ONE target character and exactly ONE primary action.
Default framing is a WAIST-UP HALF-BODY PORTRAIT with the lower robe naturally cropped straight by the bottom canvas edge; the complete head, shoulders, both arms, both hands, and exactly ONE character prop are visible.
This is a single isolated character asset, NOT a poster, NOT a character sheet, NOT a sticker sheet, NOT a collage, NOT a storyboard panel, NOT a group composition.
Do not add any supporting/background people, crowds, duplicate poses, titles, labels, flags with text, scenery, or explanatory graphics.
Include exactly the one researched, historically supported role-signature prop specified in the Prop Card; it must be used or worn by the target character and remain subordinate to the action. Do not omit it, do not add a second prop, and do not disguise multiple objects as one set.
For historical subjects, every visible prop requires a cited period-appropriate documentary or archaeological basis plus an explicit evidence level (PERSON-ATTESTED, PERIOD-ATTESTED, or LATER-TEXT-ATTESTED); iconography alone is insufficient, and hybrid pseudo-historical devices are forbidden.
No knees, no feet, no crouching, no kneeling, no sitting on the ground, no stepping, and no full-body or three-quarter-body composition unless the user explicitly requested it.
No rounded, oval, badge-like, floating, or faded lower-body silhouette; the lower robe is cut straight by the bottom edge.
Leave all unused canvas area transparent.
```

提示词中的其他内容不得与此规则冲突。

## 7. 参考图防拼贴规则

- 风格参考图只用于线条、材质、色彩与渲染语言，不复制其多人构图。
- 每次生成时，尽量只使用 **1 张包含人物的参考图**。若必须同时使用身份参考和风格参考，必须逐张声明用途，并重复“只生成目标角色、不要复制其他人物或原构图”。
- 多人物参考图属于高风险输入；能裁出/换用单人物参考时优先使用单人物参考。
- 前一次失败生成的群像、拼贴、角色表不得作为下一次单人物生成的参考图。

## 8. 原子性质检

每张图在透明校验之前先做视觉硬检查：

- 人物数量 = 1；
- 主动作数量 = 1；
- 无第二人、无群众、无重复人物；
- 无人物表、拼贴、分镜；
- 无场景背景；
- 无文字、标语、标签；
- 道具均服务动作；
- 透明留白没有被“装饰性元素”填满。

任一项失败，该图直接 FAIL，不进入 alpha 校验后的交付流程。
