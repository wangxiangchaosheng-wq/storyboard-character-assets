/**
 * 预合成战略地图整幅底图 public/strategy/map-canvas.png（1725×863）。
 *
 * 为什么要有这一步：地图主页的底图必须是**一张普通的 2D PNG**当 <img> 用。
 * 本机渲染器（IAB WebView）对以下形态全都在首屏只画中间一条窄带（逐个实测，见
 * fix-report-20260929-map-first-play.md 的证据链表）：<img src="*.svg">（缩放 SVG 内嵌
 * 外链图）、data URI 内联、内联 SVG、CSS background-image、带 inset 偏移的图、
 * 以及任何 GPU 合成层提升（translateZ(0)/will-change 反而加重）。
 * 所以把纸色底与地形窗口按 map-world.svg 的同一套坐标一次烤平成整幅 PNG，
 * <img> 回到 0,0 满幅、零技巧。
 *
 * 坐标口径必须与 world-bootstrap.ts 的城池点归一化、map-world.svg 注释三者一致——
 * 改窗口坐标必须三处一起改并重跑本脚本：node scripts/make-map-canvas.mjs
 */
import sharp from 'sharp';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const W = 1725, H = 863;          // 舆图画布（与 SVG 的 width/height 一致）
const TX = 436, TY = 143;         // 地形窗口左上角（SVG 坐标）
const TW = 1172, TH = 662;        // 地形窗口尺寸
const PAPER = '#eee7db';          // SVG 里那只纸色 rect 的填充

const terrain = await sharp(resolve(ROOT, 'public/strategy/world-terrain.png'))
  .resize(TW, TH, { fit: 'fill' })   // 原窗口就是 preserveAspectRatio=none 的满铺，这里同样满铺
  .toBuffer();

await sharp({ create: { width: W, height: H, channels: 3, background: PAPER } })
  .composite([{ input: terrain, left: TX, top: TY }])
  .png({ compressionLevel: 9, effort: 6 })
  .toFile(resolve(ROOT, 'public/strategy/map-canvas.png'));

const meta = await sharp(resolve(ROOT, 'public/strategy/map-canvas.png')).metadata();
console.log(`map-canvas.png 已生成：${meta.width}x${meta.height}（窗口 ${TX},${TY} ${TW}x${TH}）`);
