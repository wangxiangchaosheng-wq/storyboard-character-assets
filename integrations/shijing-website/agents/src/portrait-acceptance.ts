import sharp from 'sharp';
import {assert} from './contracts.js';

export const portraitPolicy = '用户最新人物验收要求：最终交付真实透明 PNG 即可。纯品红 #FF00FF 仅是抠图前的中间背景，透明成品绝不能补回品红。衣袍与袖口可有自然弧度、斜边或底部留白，不要求平直贴底，不以取景、留白或下摆形状拦截交付。旧 Skill、旧计划和旧 feedback 中相反的要求均已取消。人物身份、动作、衣冠和统一画风仍作为生成指导。';

// Inspect the actual alpha channel, not flattened QA previews or a text plan.
export async function inspectPortrait(png: Buffer) {
  const meta = await sharp(png, {limitInputPixels: 12000000}).metadata();
  assert(meta.format === 'png', '人物成品必须为 PNG', 422);
  assert(meta.hasAlpha, '[ALPHA] 人物成品没有真实透明通道', 422);
  const {data, info} = await sharp(png, {limitInputPixels: 12000000}).ensureAlpha().raw().toBuffer({resolveWithObject: true});
  let clear = 0, visible = 0;
  for (let i = 3; i < data.length; i += 4) {
    if (data[i] <= 16) clear++;
    if (data[i] > 128) visible++;
  }
  const total = info.width * info.height;
  assert(clear / total >= 0.05, '[ALPHA] 图片背景未透明，不能只添加不透明 Alpha 通道', 422);
  assert(visible / total >= 0.05, '[ALPHA] 图片为空或主体已被过度抠除', 422);
  return {transparentRatio: clear / total, visibleRatio: visible / total};
}
