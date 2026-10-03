import type {PlanDomain,PlanStep} from './strategy-planner.js';
import type {WorldSnapshot} from './world-contracts.js';
import {assert} from './contracts.js';
import type {Locale} from './content-i18n.js';
import {contentText} from './content-i18n.js';

/**
 * 计策库与提案：玩家可以用 prompt 提出机制里没有的妙计，判定走规则或 LLM，执行走确定性引擎。
 *
 * 与战略规划器的分工：战略是「我要达成什么」，计策是「我怎么骗过/打垮对手」。
 * 每条计策必须带史例依据与副作用——没有依据的妙计不入池，收益必须配代价。
 */

export type StratagemKind='fire'|'supply-cut'|'sow-discord'|'feign-defect'|'flood'|'empty-fort'|'ambush'|'relieve-besiege';
export const STRATAGEM_KINDS:StratagemKind[]=['fire','supply-cut','sow-discord','feign-defect','flood','empty-fort','ambush','relieve-besiege'];
export const STRATAGEM_LABELS:Record<StratagemKind,string>={fire:'火攻','supply-cut':'断粮道','sow-discord':'离间','feign-defect':'诈降',flood:'水淹','empty-fort':'空城',ambush:'伏击','relieve-besiege':'围魏救赵'};

export interface StratagemRequires {
  ownArmy?:boolean; enemyArmy?:boolean; targetCity?:boolean; road?:boolean;
  /** 需要的季节；火攻宜在风高物燥季，水淹宜在汛期 */
  season?:string[];
  /** 我方/敌方 最小兵力比；不宜以寡击众 */
  minForceRatio?:number;
}

export interface Stratagem {
  id:string;
  kind:StratagemKind;
  title:string;
  /** 依据：史例。没有依据的计策不许入池 */
  basis:string;
  /** 史料出处；演义类没有出处，留 undefined 并在 basis 标明 */
  source?:string;
  domain:PlanDomain;
  requires:StratagemRequires;
  steps:PlanStep[];
  /** 必填非空：每一条收益都要配一条代价 */
  sideEffects:PlanStep[];
  estimatedDays:number;
  reversibility:'revocable'|'locked';
  /** 基础成功率 0..1；实际成功率由 stratagemSuccess 结合态势推算 */
  baseSuccess:number;
}

const step=(domain:PlanDomain,action:string,extra:Partial<PlanStep>={}):PlanStep=>({domain,action,...extra});
const wiki=(vol:string)=>`https://zh.wikisource.org/wiki/${vol}`;

/** 计策池。演义类显式标注，不把《三国演义》当史实。 */
export const STRATAGEMS:Stratagem[]=[
 {id:'stratagem-fire-wuchao',kind:'fire',title:'火烧乌巢',basis:'官渡之战，曹操从许攸之谋夜袭乌巢，烧袁军粮谷；见《三国志·武帝纪》与《荀攸传》。',source:wiki('三国志/卷1'),domain:'military',requires:{ownArmy:true,enemyArmy:true,road:true},
  steps:[step('military','选轻骑五千，夜出间道袭乌巢',{target:'route-ziwu',effects:[{label:'敌军粮草',delta:-1}]})],
  sideEffects:[step('military','轻骑离营，本阵防备为之一空',{risk:'主力分兵，若被察觉则反受其败'})],estimatedDays:10,reversibility:'locked',baseSuccess:0.55},
 {id:'stratagem-fire-chibi',kind:'fire',title:'赤壁风火',basis:'建安十三年冬，孙刘联军以火攻大破曹军于赤壁；见《三国志·吴主传》与《周瑜传》。',source:wiki('三国志/卷47'),domain:'military',requires:{ownArmy:true,enemyArmy:true,season:['冬','秋']},
  steps:[step('military','以轻舟载薪灌油，趋北舰放火',{effects:[{label:'敌军兵力',delta:-1}]})],
  sideEffects:[step('military','东南风不可恃，风改则火及己船',{risk:'天时不验，反烧本阵'})],estimatedDays:15,reversibility:'locked',baseSuccess:0.5},
 {id:'stratagem-supply-cut',kind:'supply-cut',title:'断敌粮道',basis:'官渡相持，袁军粮谷被焚而溃；诸葛亮以北伐屡因粮尽退兵，见《三国志·诸葛亮传》。',source:wiki('三国志/卷35'),domain:'military',requires:{ownArmy:true,enemyArmy:true,road:true},
  steps:[step('military','出兵绝其转运，屯兵于粮道之侧',{target:'route-ziwu',effects:[{label:'敌军粮草',delta:-1}]})],
  sideEffects:[step('economy','分兵则己方转运亦紧，粮道同险',{risk:'断人粮道者，己亦悬于一线'})],estimatedDays:30,reversibility:'revocable',baseSuccess:0.5},
 {id:'stratagem-sow-discord',kind:'sow-discord',title:'离间二将',basis:'曹操离间马超与韩遂，遂有关中之内溃；见《三国志·武帝纪》裴注引《典略》。',source:wiki('三国志/卷1'),domain:'politics',requires:{enemyArmy:true},
  steps:[step('politics','伪与敌将通书，字涂改若敌将自改',{effects:[{label:'敌军忠信',delta:-1}]})],
  sideEffects:[step('politics','书信若被识破，反成敌将固宠之由',{risk:'事泄则我方信誉大损'})],estimatedDays:45,reversibility:'revocable',baseSuccess:0.45},
 {id:'stratagem-feign-defect',kind:'feign-defect',title:'苦肉诈降',basis:'赤壁之役，黄盖豫降书以焚曹船；见《三国志·吴主传》裴注引《江表传》。',source:wiki('三国志/卷47'),domain:'military',requires:{ownArmy:true,enemyArmy:true},
  steps:[step('military','先受挞杖若获罪，继奉降书输诚',{effects:[{label:'敌军戒心',delta:-1}]})],
  sideEffects:[step('personnel','行苦肉者须忍捶扑，将校体面尽失',{risk:'将士离心，且降书被察则主帅难得'})],estimatedDays:20,reversibility:'locked',baseSuccess:0.45},
 {id:'stratagem-flood',kind:'flood',title:'水淹七军',basis:'建安二十四年，汉水暴溢，关羽乘船攻于禁七军；见《三国志·关羽传》。',source:wiki('三国志/卷36'),domain:'military',requires:{ownArmy:true,enemyArmy:true,season:['秋','夏']},
  steps:[step('military','俟水涨，决堤以舟师趋敌',{effects:[{label:'敌军兵力',delta:-1}]})],
  sideEffects:[step('economy','决堤则田庐漂没，郡县赋税数年难复',{risk:'自毁民田，民心随失'})],estimatedDays:25,reversibility:'locked',baseSuccess:0.5},
 {id:'stratagem-empty-fort',kind:'empty-fort',title:'披扇空城',basis:'《三国演义》第九十五回，诸葛亮于西城披扇阶上，司马懿疑而不进。**演义，非史实**；史无其事，不敢入正史。',source:undefined,domain:'military',requires:{ownArmy:false,enemyArmy:true,targetCity:true},
  steps:[step('military','尽去旌旗，开门独坐，若有所伏',{effects:[{label:'敌军疑心',delta:-1}]})],
  sideEffects:[step('military','万一被试，一城之众无噍类',{risk:'空城乃险着，不成则全师覆没'})],estimatedDays:3,reversibility:'locked',baseSuccess:0.3},
 {id:'stratagem-ambush-ziwu',kind:'ambush',title:'险道设伏',basis:'魏延请直从褒中出子午谷，诸葛亮以为危不如安；险道设伏之理见《三国志·魏延传》裴注引《魏略》。',source:wiki('三国志/卷40'),domain:'military',requires:{ownArmy:true,road:true},
  steps:[step('military','伏精兵于谷中，纵敌入险',{target:'route-ziwu',effects:[{label:'敌军兵力',delta:-1}]})],
  sideEffects:[step('military','谷道回远，粮不继则伏兵自困',{risk:'进不得战，退无所食'})],estimatedDays:12,reversibility:'revocable',baseSuccess:0.5},
 {id:'stratagem-ambush-maling',kind:'ambush',title:'马陵伏弩',basis:'战国齐魏马陵之战，孙膑减灶伏弩射杀庞涓；见《史记·孙子吴起列传》。',source:wiki('史记/卷65'),domain:'military',requires:{ownArmy:true,enemyArmy:true,road:true},
  steps:[step('military','曳柴减灶若怯，伏弩于隘口',{effects:[{label:'敌军兵力',delta:-1}]})],
  sideEffects:[step('military','示怯须真怯，士卒不知伏则易哗',{risk:'军行疑贰，令不行则伏不成'})],estimatedDays:8,reversibility:'locked',baseSuccess:0.5},
 {id:'stratagem-relieve-besiege',kind:'relieve-besiege',title:'围魏救赵',basis:'战国齐孙膑围魏救赵，攻其必救以解邯郸；见《史记·孙子吴起列传》。',source:wiki('史记/卷65'),domain:'military',requires:{ownArmy:true,targetCity:true},
  steps:[step('military','不问其野战，直趋其必救之城',{effects:[{label:'敌军回援',delta:-1}]})],
  sideEffects:[step('military','分兵远袭，本境空虚为他敌所乘',{risk:'解人之围，自启其围'})],estimatedDays:40,reversibility:'revocable',baseSuccess:0.45},
];

const MATCH_KEYWORDS:Record<StratagemKind,string[]>={
 fire:['火攻','火烧','纵火','风火'],'supply-cut':['断粮','绝粮','粮道','焚粮'],'sow-discord':['离间','反间','间书'],'feign-defect':['诈降','伪降','苦肉'],flood:['水淹','决堤','灌城'],'empty-fort':['空城'],ambush:['设伏','埋伏','伏击','险道'],'relieve-besiege':['围魏救赵','攻其必救'],
};

/** 按一句话匹配计策；命中返回副本，玩家改副本不污染池。 */
export function matchStratagem(w:WorldSnapshot,prompt:string):Stratagem|null{
 void w;
 const line=prompt.trim();
 if(!line)return null;
 for(const s of STRATAGEMS)if(MATCH_KEYWORDS[s.kind].some(k=>line.includes(k)))return structuredClone(s);
 return null;
}

const SEASONS=['春','夏','秋','冬'];
function currentSeason(w:WorldSnapshot):string|null{
 const label=w?.clock?.startLabel||'';
 const hit=SEASONS.find(s=>label.includes(s));
 if(hit)return hit;
 // 无年代标签时按推演天数折算：以春为起点，91 天一季
 const day=w?.simulation?w.simulation.timeHours/24:w?.clock?.elapsedDays??0;
 return SEASONS[Math.floor(Math.max(0,day)/91)%4]??null;
}

function forceRatio(w:WorldSnapshot):number|null{
 const armies=w?.armies??{};
 const own=Object.values(armies).filter(a=>a.factionId===w.simulation?.playerFactionId);
 const enemy=Object.values(armies).filter(a=>a.factionId!==w.simulation?.playerFactionId);
 if(!own.length||!enemy.length)return null;
 const sum=(list:typeof own)=>list.reduce((n,a)=>n+a.troops,0);
 return sum(own)/Math.max(1,sum(enemy));
}

export function eligibility(s:Stratagem,w:WorldSnapshot):{ok:boolean;missing:string[]} {
 // 快照可能还没到（面板按需拉取，或本局没有推演层）：宁可判「不具备资格」，
 // 也不能 Object.values(undefined) 把整页炸白屏（曾经拿 `{} as never` 传进来正是如此）。
 const armies=w?.armies??{},cities=w?.cities??{},roads=w?.simulation?.roads??{};
 const missing:string[]=[];
 const own=Object.values(armies).filter(a=>a.factionId===w.simulation?.playerFactionId&&a.troops>0);
 const enemy=Object.values(armies).filter(a=>a.factionId!==w.simulation?.playerFactionId&&a.troops>0);
 if(s.requires.ownArmy&&!own.length)missing.push('本方无可遣之军');
 if(s.requires.enemyArmy&&!enemy.length)missing.push('未探得可图之敌');
 if(s.requires.targetCity&&!Object.keys(cities).length)missing.push('无可指之城');
 if(s.requires.road&&!Object.keys(roads).length)missing.push('无可用道路');
 if(s.requires.season?.length){
  const season=currentSeason(w);
  if(!season||!s.requires.season.includes(season))missing.push(`时节不合：宜 ${s.requires.season.join('/')}`);
 }
 if(s.requires.minForceRatio!==undefined){
  const ratio=forceRatio(w);
  if(ratio===null||ratio<s.requires.minForceRatio)missing.push(`兵力不逮：需我方达敌之 ${s.requires.minForceRatio} 倍`);
 }
 return {ok:missing.length===0,missing};
}

const round8=(n:number)=>Math.round(n*1e8)/1e8;
/** 成功率：情报、主将、奇袭皆可加分；硬条件不足仍可一试，但希望大减。 */
export function stratagemSuccess(s:Stratagem,w:WorldSnapshot,mods?:{intelligence?:number;commanderSkill?:number;surprise?:boolean}):number {
 let odds=s.baseSuccess;
 odds+=((mods?.intelligence??0)/100)*0.15;
 odds+=((mods?.commanderSkill??0)/100)*0.15;
 if(mods?.surprise)odds+=0.1;
 if(!eligibility(s,w).ok)odds*=0.5;
 return round8(Math.min(1,Math.max(0,odds)));
}

export function validateStratagem(s:Stratagem):void {
 assert(s&&typeof s==='object','计策格式无效');
 assert(typeof s.basis==='string'&&s.basis.trim().length>0&&s.basis.length<=2000,'计策必须写明依据',400);
 assert(Array.isArray(s.sideEffects)&&s.sideEffects.length>0,'计策必须写明副作用：每一条收益都要配一条代价',400);
 assert(Number.isSafeInteger(s.estimatedDays)&&s.estimatedDays>=1&&s.estimatedDays<=3650,'预计见效天数应为 1—3650 的整数',400);
 assert(Array.isArray(s.steps)&&s.steps.length>0,'计策必须至少包含一步操作',400);
 assert(STRATAGEM_KINDS.includes(s.kind),'不支持的计策类型',400);
 assert(typeof s.baseSuccess==='number'&&Number.isFinite(s.baseSuccess)&&s.baseSuccess>=0&&s.baseSuccess<=1,'基础成功率应在 0—1 之间',400);
 assert(typeof s.id==='string'&&/^[\w-]{1,120}$/.test(s.id),'计策编号无效',400);
 assert(typeof s.title==='string'&&s.title.length>0&&s.title.length<=100,'计策标题无效',400);
 for(const list of [s.steps,s.sideEffects])for(const p of list){
  assert(p&&typeof p.action==='string'&&p.action.trim().length>0&&p.action.length<=2000,'计策的每一步都要写明做什么',400);
  assert(typeof p.domain==='string'&&p.domain.length>0,'计策步骤缺少所属域',400);
 }
}

/** AI 提案通道：把 LLM 产出的部件组装成一条计策并立刻校验，不合规即拒。 */
export function proposeStratagem(prompt:string,basis:string,kind:StratagemKind,steps:PlanStep[],sideEffects:PlanStep[],estimatedDays:number):Stratagem {
 assert(typeof prompt==='string'&&prompt.trim().length>0&&prompt.length<=2000,'提案原话无效',400);
 const s:Stratagem={id:'stratagem-ai-'+Math.abs(hash(prompt)).toString(36).slice(0,12),kind,title:prompt.slice(0,100),basis,
  domain:'military',requires:{ownArmy:true},steps,sideEffects,estimatedDays,reversibility:'revocable',baseSuccess:0.4};
 validateStratagem(s);
 return s;
}
function hash(text:string):number{let h=0;for(let i=0;i<text.length;i++)h=(Math.imul(31,h)+text.charCodeAt(i))|0;return h;}

export function stratagemSummary(s:Stratagem,w?:WorldSnapshot):string[] {
 const out=[`${STRATAGEM_LABELS[s.kind]} · ${s.title}`,`依据：${s.basis}`,`基础成功率 ${Math.round(s.baseSuccess*100)}% · 预计 ${s.estimatedDays} 日 · ${s.reversibility==='revocable'?'可撤销':'不可逆'}`];
 if(w){const e=eligibility(s,w);out.push(`此际成功率 ${Math.round(stratagemSuccess(s,w)*100)}%`);if(!e.ok)out.push('资格欠缺：'+e.missing.join('；'));}
 return out;
}

/**
 * 内容层双语取值入口（v1）：走 content-i18n 表，英文缺失回落中文，未知 id（AI 提案
 * stratagem-ai-*）回落数据原值。stratagemSummary 等既有函数保持中文不动。
 */
export function stratagemTitle(s:Stratagem,locale:Locale):string{return contentText(`stratagem.${s.id}.title`,locale,s.title);}
export function stratagemBasis(s:Stratagem,locale:Locale):string{return contentText(`stratagem.${s.id}.basis`,locale,s.basis);}
