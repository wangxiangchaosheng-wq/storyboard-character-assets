import type {PortraitDesign} from './art-design.js';
export type Persona = {id:string;name:string;role:string;description:string;stance?:string};
export type Metric = {key:string;label:string;start:number;min:number;max:number;unit?:string};
export type Spec = {id:string;title:string;scenario:{background:string};cast:Persona[];metrics:Metric[]};
export type World = {version:number;day:number;metrics:Record<string,number>;cities:Record<string,string>};
export type Settlement = {id:string;expectedVersion:number;confirmed:true;summary:string;deltas:{metric:string;by:number}[];elapsedDays:number;cityChanges:{city:string;from:string;to:string}[];significant:boolean};
export type Message = {id:string;kind:string;name?:string;from?:string;text:string;deltas?:{metric:string;by:number}[]};
export type Run = {id:string;spec:Spec;world:World;mode:'standalone'|'engine';gameId?:string;engineTurn:number;messages:Message[];createdAt:string};
export type Job = {id:string;runId:string;kind:'portrait'|'storyboard';subjectId:string;majorEvent?:boolean;majorCandidate?:boolean;status:'queued'|'planning'|'generating'|'checking'|'succeeded'|'failed'|'interrupted';attempts:number;draftAttempt?:number;resumeDraft?:boolean;transparency?:'native'|'chroma';input:unknown;priorDesigns?:PortraitDesign[];plan?:ArtPlan;feedback:string;error?:string;asset?:string;assetSource?:'provided'|'generated'|'library';createdAt:string;updatedAt:string;trace:{at:string;step:string;detail:string}[]};
export type ArtPlan = {prompt:string;summary:string;night:boolean;evidence:string[];portraitDesign?:PortraitDesign};
export class AgentError extends Error {status:number;constructor(message:string,status=400){super(message);this.status=status;}}
export function assert(ok:unknown,message:string,status=400):asserts ok {if(!ok)throw new AgentError(message,status);}
export function parseSpec(raw:unknown):Spec {
  assert(raw && typeof raw==='object','缺少剧本'); const s=raw as Spec;
  assert(typeof s.id==='string'&&s.id.length>0&&s.id.length<=300,'剧本编号无效');
  assert(typeof s.title==='string'&&s.title.length>0&&s.title.length<=300,'剧本标题无效');
  assert(typeof s.scenario?.background==='string'&&s.scenario.background.length<=20000,'缺少剧本背景');
  assert(Array.isArray(s.cast)&&s.cast.length>0&&s.cast.length<=12,'人物数量应为 1–12');
  assert(new Set(s.cast.map(p=>p.id)).size===s.cast.length,'人物编号重复');
  for(const p of s.cast)for(const k of ['id','name','role','description'] as const)assert(typeof p[k]==='string'&&p[k].length<=6000&&(k==='description'||p[k].length>0),'人物资料格式不正确');
  assert(Array.isArray(s.metrics)&&s.metrics.length<=60,'指标格式不正确');
  assert(new Set(s.metrics.map(m=>m.key)).size===s.metrics.length,'指标编号重复');
  for(const m of s.metrics)assert(typeof m.key==='string'&&/^[a-zA-Z0-9_-]{1,80}$/.test(m.key)&&!['__proto__','constructor','prototype'].includes(m.key)&&typeof m.label==='string'&&[m.start,m.min,m.max].every(Number.isFinite)&&m.min<=m.start&&m.start<=m.max,'指标范围不正确');
  return {id:s.id,title:s.title,scenario:{background:s.scenario.background},cast:s.cast.map(p=>({id:p.id,name:p.name,role:p.role,description:p.description,stance:p.stance})),metrics:s.metrics.map(m=>({...m}))};
}
