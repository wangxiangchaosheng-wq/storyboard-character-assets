/**
 * 视觉/UI 素材契约 —— 全项目唯一素材接口（另一队友/视觉同学按此填充）
 *
 * 原则：
 *  1. 业务代码只依赖 素材 key（字符串 id），不关心文件路径、尺寸、是否存在；
 *  2. 缺失/未完成 -> 运行时返回确定性「占位图」（SVG 生成，绝不破布局）；
 *  3. 所有素材通过 manifest.json 登记，`pnpm assets:check` 校验 key 全覆盖。
 *
 * 真源声明：本文件为类型真源；运行时实现见 apps/web 的 `useAsset`，
 * 清单文件见 `apps/web/assets/manifest.json`（示例：docs/assets.manifest.example.json）。
 */

export const ASSET_CATEGORIES = [
  'portrait',   // 人物立绘（左栏角色卡 + 对话头像）
  'map',        // 战略地图（底图/地点标记/兵牌/补给线）
  'bg',         // 场景背景（廷议/行军/事件插画底）
  'event',      // 事件插画（关键事件大图，可 AI 生成）
  'ui',         // UI 元件（面板/气泡/按钮/输入框/滚动条）
  'audio',      // 音效/BGM（可选，MVP 可空）
] as const;
export type AssetCategory = (typeof ASSET_CATEGORIES)[number];

/** 素材清单条目 —— 美术同学只需要维护这个 */
export interface ManifestEntry {
  key: string;                    // 资源稳 key，形如 'portrait/zhuge-liang'
  category: AssetCategory;
  file: string;                   // 相对 assets/ 的路径，如 'portrait/zhuge-liang.png'
  alt: string;                    // 无障碍/占位文本（名称）
  w?: number; h?: number;         // 建议尺寸（px），缺失=自适应
  suggest?: string;               // 一句用途提示（给美术看）
  variantOf?: string;             // 变体继承（换朝代/换心情时复用）
}

export type AssetManifest = { version: 1; entries: ManifestEntry[] };

/** 运行时解析结果 */
export interface AssetResolution {
  url: string;              // 正常资源 / 占位 SVG 的 url
  isPlaceholder: boolean;   // 美术未交付时为 true（前台可打"素材完善中"角标）
}

/**
 * 运行时接口（实现：apps/web/src/assets/useAsset.ts；消费方如 docs/08 §5a 所示，
 * 组件一律不得硬编码图片路径）。
 */
export declare function getAsset(
  key: string, kind?: 'image' | 'audio'
): AssetResolution;
export declare function useAsset(key: string): AssetResolution; // React hook

/** key 归属校验：manifest 中必须存在对应 entry；缺 -> 开发期 w.palance；实现见 check:asset CLI */
export declare function assertAssetCovered(manifest: AssetManifest): string[];