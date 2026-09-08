/**
 * 占位图生成（docs/12 §原则2）：美术未交付时返回确定性 SVG data-uri，
 * 绝不让布局出现破图。随 key 的内容（alt/建议尺寸）变化，方便肉眼区分区域。
 */
import type { AssetCategory } from '@sim/contracts';

export function placeholderDataUri(
  alt: string,
  category?: AssetCategory,
  w = 320,
  h = 240,
): string {
  const label = alt || '素材待补';
  const hue =
    category === 'portrait' ? '#c9a86a' : category === 'map' ? '#8ba888' : '#b08968';
  const svg =
    `<svg xmlns="http://www.w3.org/2000/svg" width="${w}" height="${h}" viewBox="0 0 ${w} ${h}">` +
    `<rect width="100%" height="100%" fill="${hue}"/>` +
    `<rect x="8" y="8" width="${w - 16}" height="${h - 16}" fill="none" stroke="#f5ead6" stroke-width="2" stroke-dasharray="10 6"/>` +
    `<text x="50%" y="48%" text-anchor="middle" font-family="'Noto Serif SC','Songti SC',serif" font-size="${Math.min(28, h / 6)}" fill="#f5ead6">${label}</text>` +
    `<text x="50%" y="62%" text-anchor="middle" font-family="sans-serif" font-size="${Math.min(14, h / 12)}" fill="#d9c9a3">素材占位 · 待美术交付</text>` +
    `</svg>`;
  return `data:image/svg+xml;charset=utf-8,${encodeURIComponent(svg)}`;
}