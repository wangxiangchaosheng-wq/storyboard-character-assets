# 史境前端 · 素材替换约定

这是 Group 18.svg 的前端实现。原始 SVG 和桌面素材不作修改。

## 运行

需要 Node.js 22.13 或以上。安装依赖后运行 `npm run dev`，发布前运行 `npm run build`。沿用 React 19 + Vinext 项目；页面和两个已有对话/故事板接口都保留。

## 原稿坐标

设计画布：1672 × 941，所有屏幕均整体等比例缩放并居中，保持原稿完整构图，不重排。

- 背景：x=0, y=0, 1672 × 941。
- 竹简：x=128, y=24, 1416 × 893。
- 人物列表：x=258，从 y=131 开始，固定五个独立槽位。
- 主人物：x=491, y=47, 290 × 202。
- 对话外框：x=485, y=243, 491 × 571。
- 输入外框：x=485, y=807, 491 × 67。
- 故事板蒙版几何边界：x=983, y=74, 452 × 801.5。
- 故事板图片：x=977, y=70, 456 × 809，居中裁切填满。

`app/lib/original-design.json` 保存原 SVG 的完整节点树。`scripts/prepare-original-svg.py` 无损提取原始内嵌 PNG 到 `public/original/`，所有文字轮廓、坐标、矩阵、裁切、蒙版、混合模式和图层顺序保留；没有转成整页截图。`OriginalScene` 将原节点直接渲染为 React SVG，透明 HTML 控件负责交互。之前的 `public/art/` 素材仅用于交互后新增消息及替换内容的回退展示。

## 方式一：持久替换

由人物 agent 或故事板 agent 修改 `public/scene-assets.json`，将新图片放入 `public/`，配置中使用以 `/` 开头的 URL（不写 `public/`）。部署后刷新即加载新素材。

人物槽位 ID 固定为 `zhuge`、`weiyan`、`yangyi`、`jiangwei`、`feiyi`。ID 是布局定位键，不代表替换后必须保持同一人物身份。`name` 和 `role` 是可编辑文字；`card`、`avatar`、`hero` 分别用于左侧卡片、对话头像、顶部大立绘。三处复用同一透明 PNG/WebP 也可以，建议正面/半身图底部对齐。初始可见标签严格保留 SVG 的文字轮廓，包括原稿中重复的标签。配置中的 ID 和名称用于 agent 及对话逻辑；主动修改名称时才以动态文字显示更新。

故事板只需替换 `storyboard.image`，可以同时更新 `sceneKey`、`title`、`location`、`caption`。建议输出接近 456:809 的竖图；任何宽高的新图都由容器居中裁切，布局不变。蒙版和混合模式不能放进生成图片里。

## 方式二：运行中的页面更新

页面加载后提供 `window.shijing`。这是前端集成桥，适用于同页面 agent 宿主/浏览器执行环境，不是面向远程服务的 HTTP 写入接口。刷新会重新读取上面的持久配置。当前没有绑定用户的人物 agent 或故事板 agent 服务。

```js
// 一张图片同步替换同一人物的三种展示位置；也可分别传 card/avatar/hero。
await window.shijing.updateAssets({
  characters: [{ id: 'weiyan', name: '魏延', role: '蜀汉前军将军', image: '/characters/weiyan-v2.png' }]
});

// 仅换故事板；蒙版、位置和 darken 均保持不变。
await window.shijing.updateAssets({
  storyboard: { image: '/stories/ziwu-v2.webp', sceneKey: 'ziwu-v2', title: '子午谷行军', location: '子午谷' }
});

const current = window.shijing.getAssets();
```

也可派发 `CustomEvent('shijing:assets-update', { detail: patch })`；需要确认替换成功时优先等待 `updateAssets()` 返回的 Promise。新图先预加载，格式错误、加载失败或超时会拒绝更新并保留原图。同一个批次全部加载成功才提交；不同人物槽位和故事板可以并行替换，同一槽位以最后一次请求为准。传入 `image` 可覆盖三处图片，显式 `card/avatar/hero` 会优先于 `image`。

## 蒙版与 Darken

`app/components/OriginalScene.tsx` 与 `app/lib/original-design.json` 原样保留 SVG 的 alpha mask 路径：

```svg
<path d="M983 75.5L984.5 875.5H1435L1419 74L983 75.5Z" />
```

几何边界为 452 × 801.5；原 SVG 的 mask region 为 x=982, y=73, 454 × 803，这是包含描边余量的范围，并非不同设计尺寸。外层 CSS `mix-blend-mode: darken`，直接与下方竹简混合。不要改成 `multiply`、普通透明度或在故事板单独增加隔离背景。

## 对话与生成

继续使用 `/api/chat`、`/api/storyboard`。无密钥时返回预设演示数据，页面会显示“演示模式”。已有实时接口可在部署环境配置后使用；本次未新增密钥，也未连接外部 agent。

前端素材替换支持改人物名称；现有对话后端仅有内置三国人物的 persona。若换成其他历史人物，需要人物 agent 同时提供对应的对话后端能力，单改头像与名称不会自动创建新 persona。

输入支持发送、Enter 发送、Shift+Enter 换行，并避免中文输入法候选确认时误发送。麦克风使用浏览器语音识别能力，不支持或拒绝权限时保留文字输入。纸飞机按钮展开对话建议。

## 原稿一致性检查

初始状态使用原始文字轮廓与原始图片；开始交谈后，对话区域切换为可滚动的动态消息。素材更新仅改动对应的插槽。已将实际 React 组件输出的 SVG 与原文件逐节点比较：全部节点、属性、路径、矩阵、蒙版、darken 和 18 张图片的 SHA-256 均一致（仅增加无视觉影响的 class、aria-hidden，图片改为引用无损提取的同一文件）。
