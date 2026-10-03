# 成就图标（Steam Achievement Icons）

24 条成就的图标产物目录，由仓库内脚本从单一事实来源生成，不手绘、不下载外部素材。

```
steam/
  make-achievement-icons.mjs   生成器：图形语义表 + 档位画框 → PNG，并回填 achievements.json
  icons/
    <achievement-id>.png       彩色版（已解锁状态）
    <achievement-id>-gray.png  灰度版（未解锁状态）
```

## 图标规范（Steam 要求）

| 项 | 约定 | 为什么 |
| --- | --- | --- |
| 格式 | PNG | Steamworks 成就图标只收 PNG |
| 尺寸 | 64×64，正方形 | Steam 官方建议尺寸；Steam 会自行缩放到各显示尺寸，源图给 64 不会失真 |
| 背景 | 透明 | 覆盖层里图标叠在成就列表背景上，不透明的方底会很脏 |
| 灰度版 | 同一图形的去饱和（BT.601 亮度，R==G==B） | Steam 用 `icongray` 渲染「未解锁」，必须与彩色版同构图 |

## 视觉语言：「青铜 / 鎏金 / 水墨」

与 `public/favicon.svg`、`electron/build/icon.ico` 同一套品牌色：

- **画框**：圆角金属铭牌（渐变底 + 内沿暗纹 + 四颗铆钉 + 宣纸晕光），背后按成就类别叠一层
  6% 透明度的淡墨底纹（军事=交叉戟影、经济=钱环、政治=方印、外交=交结环、计策=云卷、
  首局=启卷弧、趣味=烟波、耐力=纪年轴）。
- **档位即价值**：金 = 鎏金底、银 = 银灰底、铜 = 青铜底。玩家扫一眼外框就知道成就档位，
  测试（`icons.test.mjs`）守着「同档外框像素级一致、三档互不相同」。
- **图形**：水墨深褐主色 + 宣纸受光面 + 朱砂点睛色，全部为几何路径，无字体依赖
  （librsvg 在 Windows 上找字体不可靠，任何文字都不进 SVG）。

## 如何重新生成

```bash
node steam/make-achievement-icons.mjs
```

- 幂等：同样输入 Byte 级一致的输出，可反复覆盖跑。
- 顺手清理 `icons/` 里已删成就的残留 `.png`（只删 `.png`，本文件不碰）。
- 自动回填 `achievements.json` 每条成就的 `icon` / `icongray` 字段
  （`icons/<id>.png` 与 `icons/<id>-gray.png`）——不要手改 json，保持单一事实来源。
- 渲染管线：SVG（256 画布）→ sharp `density:384` 超采样到约 1365px → Lanczos 降到 64×64，
  边缘比直接渲染发毛的 64px 干净得多；灰度版由彩色版 `greyscale()` 得到。

## 新增一条成就时

1. `achievements.ts` 加成就（id / name / description / tier + RULES 规则）；
2. 跑 `node steam/build.mjs` 预编译出 `achievements.mjs`；
3. `make-achievement-icons.mjs` 里补三处：
   - `GLYPH`：给新 id 画一个图形函数（可区分的语义，别跟已有的撞）；
   - `CATEGORY`：指定类别（决定淡墨底纹）；
   - tier 配色若新增档位，补 `TIER` 表；
4. 跑 `node steam/make-achievement-icons.mjs`（json 的 icon 字段会自动回填）；
5. 跑 `node --test steam/icons.test.mjs` 与 `node --test steam/steam.test.mjs` 必须全过。

## 图形语义速查

| 成就 | 图形 | 成就 | 图形 |
| --- | --- | --- | --- |
| first_run_complete | 启卷（横开卷轴 + 朱砂印） | capture_first_city | 城郭（城墙 + 城门 + 旌旗） |
| first_year_jump | 岁星（虚线星轨 + 星 + 彗尾） | cut_enemy_supply | 粮车断索（大车 + 斩痕 + 撒粮） |
| first_edict | 诏书（竖轴诏 + 印 + 绶） | outnumbered_victory | 以少胜多（三小戟 vs 一巨刃） |
| bloodless_capture | 盾牌护城门 + 勾 | annihilate_army | 断戟（折戟 + 断茬 + 火花） |
| treasury_10k | 钱串（三枚方孔钱） | province_surplus | 谷仓（坡顶 + 仓门 + 谷堆） |
| tuntian_effective | 犁（犁辕 + 犁柄 + 垄沟） | all_factions_loyal | 印绶（官印 + 朱绶带） |
| no_one_angry | 天平（平衡梁 + 双盘） | eunuch_dominance | 阴影（小人 + 巨影） |
| alliance_formed | 结绳（双环相扣 + 朱砂结） | treaty_breached | 裂简（对半撕裂的简牍） |
| hegemony_100 | 冠冕（三峰冠 + 珠宝） | fire_attack | 火焰（朱砂外焰 + 琥珀焰心） |
| empty_fort | 空城门（城楼 + 敞开的城门 + 抚琴人） | sow_discord | 离间双影（两人 + 身际裂痕） |
| harem_year | 宫灯（红灯笼 + 流苏） | historian_100 | 史笔（简牍堆 + 狼毫 + 墨痕） |
| thirty_years | 年轮（同心轮 + 朱砂心） | veteran_five_runs | 老将盔（红缨 + 五铆盔） |
