import { aiRequest, checkOrigin, failure, ServiceError } from '../../lib/ai-server';
import { parseTopic, slotIds, type CastMember } from '../../lib/topic';
import rules from '../../lib/skill-rules.json';
import styleReference from '../../lib/character-style.json';
export async function POST(request: Request) {
  try {
    checkOrigin(request); const body = await request.json() as Record<string, unknown>; const topic = parseTopic(body.topic); const c = body.character as CastMember;
    if (!c || !slotIds.includes(c.id) || !c.name || !c.action || !c.prop || !/^https:\/\//.test(c.source) || JSON.stringify(c).length > 10000) throw new ServiceError('人物资料不完整，请重新选角。', 400);
    const chroma = true; // gpt-image-2 has no native transparent background parameter.
    const prompt = `HARD ASSET ATOMICITY: Exactly ONE character, ONE action, ONE researched prop, waist-up half-body portrait, both hands visible, lower robe broadly cropped straight by bottom canvas edge. No knees, feet, crouching, kneeling, full body, rounded or floating lower silhouette, second person, collage, scenery or text.\n${rules.atomicity}\n主题：${JSON.stringify(topic)}。目标人物：${c.name}，${c.role}。时代化形象：${c.appearance}。动作签名：${c.action}。唯一道具：${c.prop}；史据：${c.evidence}；来源：${c.source}。\n风格参考图仅用于细腻工笔、水彩、墨线、低饱和米白墨黑旧金、柔和左上光的风格，不复制参考人物身份与姿势。统一腰上半身；头冠、双手、道具完整，顶部与左右留8%安全边距，衣袍宽幅贴底平直裁切。无文字、边框、地图背景、军帐、地面或演员相貌。\n${chroma ? 'OUTPUT OVERRIDE: Background is perfectly uniform solid pure magenta #FF00FF edge to edge. No magenta anywhere on subject. No gradient, shadow, glow, floor or grid. Ignore earlier transparency wording: output opaque magenta backdrop for chroma processing.' : 'Output a true transparent RGBA PNG; no checkerboard pattern, background, shadows or halo.'}`;
    const reference = new Blob([Uint8Array.from(atob(styleReference.png), c => c.charCodeAt(0))], { type: 'image/png' });
    const form = new FormData();
    form.set('model', 'gpt-image-2'); form.set('prompt', prompt); form.set('size','1024x1024'); form.set('quality','medium'); form.set('output_format','png'); form.set('background',chroma ? 'opaque' : 'transparent'); form.set('image', reference, 'style-reference.png');
    const result = await aiRequest('images/edits', form, request.signal);
    if (!result.data?.[0]?.b64_json) throw new ServiceError('人物图片结果为空。');
    return Response.json({ image: `data:image/png;base64,${result.data[0].b64_json}`, mode: chroma ? 'chroma' : 'native' }, { headers: { 'Cache-Control':'no-store' } });
  } catch (error) { return failure(error); }
}
