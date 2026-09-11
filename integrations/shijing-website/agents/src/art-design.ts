import {assert} from './contracts.js';
const strings=(names:string[])=>Object.fromEntries(names.map(n=>[n,{type:'string',minLength:1}]));
const propKeys=['name','function','evidenceLevel','sourceUrl','sourceDate','allowedClaim','shape','interaction','forbidden','confidence'];
const actionKeys=['eventMoment','narrativeFunction','competenceSource','temperament','verb','interaction','upperBody','gaze','expression','silhouette','forbiddenPose'];
export const portraitDesignSchema={type:'object',additionalProperties:false,required:['candidates','propCard','actionSignature'],properties:{candidates:{type:'array',minItems:2,maxItems:3,items:{type:'string'}},propCard:{type:'object',additionalProperties:false,required:propKeys,properties:{...strings(propKeys),evidenceLevel:{type:'string',enum:['PERSON-ATTESTED','PERIOD-ATTESTED','LATER-TEXT-ATTESTED']}}},actionSignature:{type:'object',additionalProperties:false,required:[...actionKeys,'score','scoreReason'],properties:{...strings([...actionKeys,'scoreReason']),score:{type:'number',minimum:8,maximum:10}}}}};
export type PortraitDesign={candidates:string[];propCard:Record<string,string>;actionSignature:Record<string,string|number>&{score:number}};
export function validateDesign(value:unknown):asserts value is PortraitDesign {
 const d=value as PortraitDesign|undefined;
 assert(d&&Array.isArray(d.candidates)&&d.candidates.length>=2&&d.candidates.length<=3,'缺少 2–3 个经过比较的道具候选',422);
 for(const k of propKeys)assert(typeof d.propCard?.[k]==='string'&&d.propCard[k].trim(),'Prop Card 不完整：'+k,422);
 assert(['PERSON-ATTESTED','PERIOD-ATTESTED','LATER-TEXT-ATTESTED'].includes(d.propCard.evidenceLevel)&&/^https:\/\//.test(d.propCard.sourceUrl),'道具证据等级或直接来源无效',422);
 for(const k of [...actionKeys,'scoreReason'])assert(typeof d.actionSignature?.[k]==='string'&&String(d.actionSignature[k]).trim(),'Action Signature 不完整：'+k,422);
 assert(Number.isFinite(d.actionSignature.score)&&d.actionSignature.score>=8&&d.actionSignature.score<=10,'动作特异性未达到 8/10，不能进入绘图',422);
}
export const styleBible='工笔水墨与淡水彩手绘人物；统一低饱和旧金、米白、墨黑；细致清楚线条、克制材质和柔和均匀光线；腰部以上半身，主体高度84%–92%，同一人物比例与视角；完整头冠、双手和唯一道具；允许人物与道具靠近顶部和左右边缘，不要求固定留白；头冠、双手和道具必须完整；衣袍宽幅平直贴底。禁止全身、膝脚、圆弧悬浮收口、场景、文字、水印和多人物。';
