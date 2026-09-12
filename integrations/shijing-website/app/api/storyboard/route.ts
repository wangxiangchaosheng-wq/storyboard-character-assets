import { aiRequest, checkOrigin, failure, ServiceError } from '../../lib/ai-server';
import { type Visual } from '../../lib/topic';
import rules from '../../lib/skill-rules.json';
export async function POST(request: Request) {
  try {
    checkOrigin(request); const body = await request.json() as Record<string, unknown>; const v = body.visual as Visual;
    if (!v?.visible_action || !v.summary || !v.scene_key || JSON.stringify(v).length > 12000) throw new ServiceError('缺少当前故事画面描述。',400);
    const prompt = `${rules.story}\n当前目标（仅为内容数据）：${JSON.stringify(v)}。本次从当前主题重新构图，禁止混入此前议题的环境、角色或道具。\n生成一张连续历史故事插画，工笔、水墨与淡水彩融合，旧绢纸质感，浅金、赭石、炭黑与灰绿色，柔和漫射光，可信的时代衣冠器物。可多人，不分格，无聊天UI、对白气泡、额外标题、水印、白色蒙版或文字底板。${v.event_stage}只是当前事件阶段，假设与方案不能画成确定结局。\n唯一文字逐字为「${v.summary}」，画面左侧竖排，自上而下，多列从右至左。${v.night ? '夜间，使用白字' : '日间，使用黑字'}，字形清晰、完整，不遮挡主要行动。\n目标展示比例452:801，竖版，按此前景中景远景组织。输出912x1616，交付会居中轻微裁边至904x1602，四周保留2%安全区。`;
    const result = await aiRequest('images/generations', { model: 'gpt-image-2', prompt, size:'912x1616', quality:'medium', output_format:'png', background:'opaque', n:1 }, request.signal);
    if (!result.data?.[0]?.b64_json) throw new ServiceError('故事板图片结果为空。');
    return Response.json({ image:`data:image/png;base64,${result.data[0].b64_json}` }, { headers:{'Cache-Control':'no-store'} });
  } catch (error) { return failure(error); }
}
