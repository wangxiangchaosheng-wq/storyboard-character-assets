import type {Army,Province,WorldSnapshot} from './world-contracts.js';
import {angryFactions} from './politics.js';
import {provinceOutput} from './economy.js';
import {provinceTotals} from './province.js';

/**
 * 吃粮的嘴：兵 + 伤 + 运输队。与 simulation-engine 的 `total` 同口径——消耗按这个算，
 * 存粮能撑几天也必须按这个算，否则文案与账实不符（用 troops 会少算运输队那一截）。
 */
function mouths(w:WorldSnapshot|undefined,a:Army):number{
 const m=w?.simulation?.armies[a.id];
 const wounded=m?.wounded??0,transport=m?.transportPeople??0;
 return Math.max(1,a.troops+wounded+transport);
}

/**
 * 失败模式 v1：从既有状态算出五类动荡的风险——只评估、不执行。
 *
 * 设计取舍：叛乱的执行属于裁判层，且必须经玩家或 AI 决策介入；v1 的责任是把风险
 * 变得可见、可预警。「托管的安全感比托管的智能更重要」——玩家敢把朝政交给 AI，
 * 前提是「哪支军队要哗变、哪个省要起义、哪个派系要政变」永远有一份确定性的呈报，
 * 而不是等叛乱既成事实后才从战报里得知。
 *
 * 全部确定性、无随机项：同一世界状态评估两次必须深相等，玩家与 AI 才能事先推演
 * 「我再欠一个月饷，谁会反」。所有诱因都从既有状态（politics 的认可/忠诚/势力、
 * army 的士气/携粮、province 的产出/太守）算出，不新增字段、不修改入参。
 * 风险为 0 不呈报：列进报告的每一行，都必须是玩家还能有所作为的事。
 */

export type UpheavalKind='mutiny'|'revolt'|'defection'|'coup'|'secession';
export const UPHEAVAL_KINDS:UpheavalKind[]=['mutiny','revolt','defection','coup','secession'];
export const UPHEAVAL_LABELS:Record<UpheavalKind,string>={mutiny:'哗变',revolt:'起义',defection:'投诚',coup:'政变',secession:'自立'};

export interface UpheavalRisk {
  kind:UpheavalKind;
  /** 作用对象 id：军队 id / 省 id / 派系 key */
  subjectId:string;
  subjectName:string;
  /** 0..1 */
  risk:number;
  /** 一句话说明主要诱因，供玩家与 AI 看懂因果 */
  reason:string;
  /** 映射到朝政呈报级别：risk >= 0.75 为 critical（灭国级，任何状态都打断玩家） */
  tier:'notable'|'major'|'critical';
}

export interface UpheavalReport {
  risks:UpheavalRisk[];
  /** 最高风险 */
  peak:UpheavalRisk|null;
  summary:string[];
}

const FOOD_PER_TROOP_DAY=1;  // kg/人/日：与 province.ts 的校准口径一致，兵丁日食 1 kg
const MUTINY_DAYS_FULL=3;    // 携粮不足 3 日：缺粮系数记 1
const MUTINY_DAYS_SAFE=30;   // 够吃 30 日：缺粮系数记 0，中间线性
const ARREARS_FULL_DAYS=30;  // 欠饷满 30 日：欠饷系数记 1
const REVOLT_RATIO_FULL=0.5; // 产出/需求 < 0.5：饥馑系数记 1
const REVOLT_RATIO_SAFE=1.2; // 产出/需求 > 1.2：饥馑系数记 0，中间线性
const TAX_BURDEN=0;          // 重税系数：税率早已接入 treasury.ts（FiscalState.taxRate → settleFiscal），
                             // 但「重税激民变」要有独立的民怨口径才测得准，v1 不拿税率硬套，恒 0；
                             // M3 接太守满意度模型后替换
const TIER_MAJOR=0.4;
const TIER_CRITICAL=0.75;    // 与 court.ts 的 critical 同级：灭国级，任何朝政状态都打断玩家

export const clamp01=(v:number)=>Math.min(1,Math.max(0,v));

/** 诱因折线：x<=lo 记 1、x>=hi 记 0、中间线性。阈值都做成可指认的区间，不搞曲线玄学。 */
const ramp=(x:number,lo:number,hi:number)=>x<=lo?1:x>=hi?0:(hi-x)/(hi-lo);

/** 呈报级别：与 court.surfacesToPlayer 同约定——critical 无论朝政状态如何都打断玩家。 */
export const upheavalTierOf=(risk:number):UpheavalRisk['tier']=>risk>=TIER_CRITICAL?'critical':risk>=TIER_MAJOR?'major':'notable';

/** 有兵且未覆没的军队才谈得上哗变/投诚：残兵败将的险情是既成事实，不是预警。 */
const viable=(a:Army)=>a.troops>0&&a.status!=='destroyed';

/**
 * 哗变：士气低 + 缺粮 + 欠饷，三因加权 0.5/0.3/0.2——哪个重，哪个先在 reason 里说话。
 *
 * 「存粮」按 **mouths（兵 + 伤 + 运输队）** 算日数，不是 troops：消耗口径本来就用 mouths
 * （simulation-engine 的 consume），这里用 troops 会少算一截——实测携粮 18000kg 时报
 * 「缺粮 3 日」，按 6000 人算其实还有 3.6 日，文案与真实账不符。
 *
 * 更要紧的是 **risk 与「实际可行动」挂钩**：驻地部队有后方属地输粮兜底（observe 的
 * autoSupply 维持三日口粮），粮掉不到 0，shortage 权重却仍按当前存粮逼近满分，于是每个
 * 跳转都弹 critical 告警——玩家手动补粮只能延缓几小时，唯一告警通道变成狼来了。
 * 所以驻地且后方有粮的部队，缺粮这项不计入：那不是险情，是常态。
 */
function mutinyRisk(a:Army,arrearsDays:number,w?:WorldSnapshot):UpheavalRisk{
 // 残兵败将的险情是既成事实，不是预警：覆没/空壳军队不上报（与 defectionRisk 同口径）
 if(!viable(a))return{kind:'mutiny',subjectId:a.id,subjectName:a.name,risk:0,reason:'',tier:'notable'};
 const eaters=mouths(w,a);
 const days=a.foodKg/(eaters*FOOD_PER_TROOP_DAY);
 const model=w?.simulation?.armies[a.id];
 const garrisoned=!!model?.atCityId&&w?.cities[model.atCityId]?.ownerFactionId===a.factionId;
 const shortage=garrisoned&&rearHasFood(w,a.factionId)?0:ramp(days,MUTINY_DAYS_FULL,MUTINY_DAYS_SAFE);
 // 欠饷系数：0.2 的权重是**三因加权里的一份子**，不是 solo 触发器——单靠欠饷最高只到
 // 0.2（notable），要与士气塌陷或断粮并发才够得上 major(0.4)/critical(0.75)。这是刻意
 // 的：欠饷从来不是孤立的军心问题。arrearsDays 由 treasury.settleFiscal 累积（默认参数下
 // 两省全募即与入库打平、丢一省必欠，见其欠饷注释），经 assessUpheaval 的调用方喂进来。
 const arrears=arrearsDays>0?Math.min(1,arrearsDays/ARREARS_FULL_DAYS):0;
 const risk=clamp01(0.5*(1-a.morale/100)+0.3*shortage+0.2*arrears);
 return {kind:'mutiny',subjectId:a.id,subjectName:a.name,risk,
  reason:`士气 ${Math.round(a.morale)} · 存粮 ${Math.floor(days*10)/10} 日 · 欠饷 ${Math.floor(arrearsDays)} 日`,tier:upheavalTierOf(risk)};
}

/** 该阵营是否还有任意城池有粮：后方有粮，驻地部队就断不了粮。 */
function rearHasFood(w:WorldSnapshot|undefined,factionId:string):boolean{
 if(!w)return false;
 return Object.values(w.cities).some(c=>c.ownerFactionId===factionId&&c.foodKg>0);
}

/**
 * 起义：一省日产粮养不起驻军口粮就民不聊生。v1 只算驻军——省层没有民口数据，
 * 居民消耗留给 M3 的太守满意度模型；重税系数同样留到税率接入 treasury.ts 之后。
 */
function revoltRisk(w:WorldSnapshot,p:Province):UpheavalRisk{
 const {troops}=provinceTotals(w,p);
 const demand=troops*FOOD_PER_TROOP_DAY;
 const output=provinceOutput(w,p).day.food;
 const famine=demand>0?ramp(output/demand,REVOLT_RATIO_FULL,REVOLT_RATIO_SAFE):0; // 无驻军则无从断饥
 const risk=clamp01(0.6*famine+0.4*TAX_BURDEN);
 const reason=demand>0?`日产粮 ${Math.round(output)} kg · 驻军 ${troops} 人日需 ${Math.round(demand)} kg`:`日产粮 ${Math.round(output)} kg · 无驻军`;
 return {kind:'revolt',subjectId:p.id,subjectName:p.name,risk,reason,tier:upheavalTierOf(risk)};
}

/**
 * 投诚：v1 军队没有独立忠诚字段，用军头派的 loyalty 作全军头的忠诚代理——
 * 刻意的简化（全军头共用一个结构性底色），M3 接人物五维后按主将逐部计算。
 * 无派系层的旧存档没有代理可依，退化为无风险，而不是拍一个默认忠诚值糊弄。
 */
function defectionRisk(w:WorldSnapshot,a:Army):UpheavalRisk|null{
 if(!viable(a))return null;
 const loyalty=w.politics?.factions.military?.loyalty??Number.NaN;
 if(!Number.isFinite(loyalty))return null;
 // 衡量「不忠」而非「不够忠」：忠诚 50（中立）不该有风险，否则每支军队都报一半风险，
 // 预警就从信号变成噪声。loyalty<50 才线性升到 1，>=50 记 0。
 const risk=clamp01((50-loyalty)/50);
 return {kind:'defection',subjectId:a.id,subjectName:a.name,risk,reason:`军头派忠诚 ${Math.round(loyalty)}`,tier:upheavalTierOf(risk)};
}

/** 政变：愤怒且势大才危险——认可 <= -10 是翻脸线（politics.ANGRY_AT），clout 决定他掀得起多大浪。 */
function coupRisks(w:WorldSnapshot):UpheavalRisk[]{
 const pol=w.politics;
 if(!pol)return[]; // 无派系层的旧存档：没有朝堂，就无所谓政变
 return angryFactions(pol).map(k=>{
  const f=pol.factions[k];
  const risk=clamp01((f.clout/100)*(1+(-f.approval)/20));
  return {kind:'coup',subjectId:k,subjectName:f.name,risk,reason:`${f.name}派认可 ${f.approval} · 势力 ${f.clout}`,tier:upheavalTierOf(risk)};
 });
}

/**
 * 自立：v1 简化为「无太守记 0.5，有太守记 0」——省不能没有主人。
 * 归属方朝望低这一维留到 M3 接太守满意度后替代：那时「谁在怨、怨多深」才有数据
 * 可算，v1 不编造「看起来算了其实没算」的数值。
 */
function secessionRisk(p:Province):UpheavalRisk{
 const risk=p.governor?0:0.5;
 const reason=p.governor?`太守 ${p.governor.name} 在任`:'无太守 · 一省无人署理';
 return {kind:'secession',subjectId:p.id,subjectName:p.name,risk,reason,tier:upheavalTierOf(risk)};
}

/**
 * 只评估**本方**的危机。敌方军队吃不吃得饱、敌方城池有没有太守，与玩家无关——
 * 把它们的风险一起报上来，预警就从信号变成噪声。玩家方由 simulation.playerFactionId 决定。
 */
export function assessUpheaval(w:WorldSnapshot,arrearsDays=0,scope:'player'|'all'='player'):UpheavalReport{
 const risks:UpheavalRisk[]=[];
 const mine=scope==='all'?null:w.simulation?.playerFactionId;
 const ownArmy=(a:Army)=>!mine||a.factionId===mine;
 const ownProvince=(p:import('./world-contracts.js').Province)=>!mine||p.ownerFactionId===mine;
 for(const a of Object.values(w.armies))if(ownArmy(a))for(const r of [mutinyRisk(a,arrearsDays,w),defectionRisk(w,a)])if(r)risks.push(r);
 if(w.provinces)for(const p of Object.values(w.provinces))if(ownProvince(p))risks.push(revoltRisk(w,p),secessionRisk(p));
 // 朝堂派系是本院的事，与 scope 无关：无论评估本方还是全图，政变风险都要算
 risks.push(...coupRisks(w));
 // 同分按 subjectId 定序：排序必须可复现，不能依赖引擎的排序稳定性
 const shown=risks.filter(r=>r.risk>0).sort((x,y)=>y.risk-x.risk||(x.subjectId<y.subjectId?-1:x.subjectId>y.subjectId?1:0));
 return {risks:shown,peak:shown[0]??null,summary:shown.map(r=>`${UPHEAVAL_LABELS[r.kind]} · ${r.subjectName} · ${r.risk.toFixed(2)} · ${r.reason}`)};
}

export const risksByKind=(report:UpheavalReport,kind:UpheavalKind)=>report.risks.filter(r=>r.kind===kind);

/**
 * 只取 critical：灭国级风险（哗变将成、政变将发）必须无论朝政状态如何都打断玩家——
 * 与 court.surfacesToPlayer 的 critical 分支是同一条约定：托管可以漏掉 major，不能漏掉亡国。
 */
export const criticalRisks=(report:UpheavalReport)=>report.risks.filter(r=>r.tier==='critical');
