import type {WorldEvent,WorldSnapshot,FieldChange,JsonValue} from './world-contracts.js';
import {provinceTotals} from './province.js';
import {assert} from './contracts.js';

/**
 * 史官 v1：系统的第四个组件——从 world_events 流水提炼「人能读、AI 能懂」的一局记录。
 *
 * 定位：前三个组件（确定性引擎、AI 决策层、玩家界面）把一局跑起来，史官把这一局
 * 讲成「可分享、可被其他 AI 解读的因果分析材料」。所以本纪不是故事：每条决策都
 * 必须能回答「玩家想干什么（原话）→ AI 具体做了什么（操作序列）→ 结果如何」。
 *
 * 七条铁律见 HISTORIAN_RULES。其中「只记公开情报」让史官与战争迷雾一致，
 * 「区分玩家决策与 AI 代决」与「保留玩家原话」让「AI 在用户意志下做事」可被验证——
 * 这也是 validateChronicle 作为验收工具存在的原因：看不出因果链，是游戏没做好。
 */

export type DecisionKind='player'|'ai-delegated';

export interface ChronicleDecision {
  id:string;
  day:number;
  title:string;
  kind:DecisionKind;
  /** 玩家原话，逐字入档，不许改写 */
  prompt?:string;
  /** AI 执行序列：具体操作，证明「AI 确实在用户意志下做事」 */
  aiActions:string[];
  /** 结果与因果 */
  results:string[];
  /** 史官注，中立 */
  note?:string;
}

export interface ChronicleRecord {
  opening:{era:string;faction:string;prompt:string;initial:{label:string;value:string}[]};
  decisions:ChronicleDecision[];
  ending:{title:string;summary:string;verdict:'victory'|'defeat'|null};
  /** 本纪生成时的推演天数 */
  totalDays:number;
  /** 超量截断时从略的琐务条数；未截断时缺省，不占字段 */
  omitted?:number;
}

/** 七条铁律：史官的全部纪律，抄魔搭「太史令」五条扩充而来，顺序即优先级。 */
export const HISTORIAN_RULES:string[]=[
 '忠于事实表：只许引用 world_events 里真实发生的事，不许编',
 '兵力段位化：「数万」而非「47300」，防精确数字泄露战争迷雾',
 '只记公开情报：史官不知道玩家没被告知的事',
 '中立：不褒贬，不下判断',
 '原样引用 id：事件、决策、提案都带 id，保证可追溯',
 '区分玩家决策与 AI 代决：decidedBy 必须显式',
 '保留玩家原话：玩家的 prompt 原文逐字入档，不许改写',
];

const MAX_DECISIONS=60; // 一局记录的决策链上限：再多就成了流水账，LLM 读不动
const KIND_LABELS:Record<DecisionKind,string>={player:'玩家拍板','ai-delegated':'AI 代决'};
export const decisionKindLabel=(k:DecisionKind)=>KIND_LABELS[k]||k;
const FIELD_LABELS:Record<string,string>={troops:'兵力',foodKg:'粮草',morale:'士气',defense:'城防',ownerFactionId:'归属',status:'状态',location:'位置',progress:'进度',elapsedDays:'天数',approval:'认可',clout:'势力',prestige:'朝望',absenceDays:'缺席'};
const fieldLabel=(f:string)=>FIELD_LABELS[f]||f;
// 兵力只报段位：凡是人头数，一律先过 bandTroops，精确到个位的数字不许出现在史官笔下
const TROOP_FIELDS=new Set(['troops','garrisonTroops','transportPeople','people','manpower']);
const SEASONS=['春','夏','秋','冬'];

/** 兵力段位化：铁律 2 的落地函数，史官与汇报一律取用，不出现精确到个位的兵力。 */
export function bandTroops(n:number):string{
 assert(Number.isFinite(n)&&n>=0,'兵力必须是非负有限数');
 if(n<500)return '数百';
 if(n<2000)return '千余';
 if(n<10000)return '数千';
 if(n<50000)return '数万';
 if(n<200000)return '十数万';
 return '数十万众';
}

/** 年代标尺：与 anchors.ts 同口径（一年 364 天、四季各 91 天），从开局年推算事件所处的年季。 */
const eraLabel=(day:number,startLabel:string):string=>{
 const startYear=Number(startLabel.match(/公元\s*(\d+)\s*年/)?.[1]);
 if(!startYear)return `推演第${Math.floor(day)+1}日`;
 return `${startYear+Math.floor(day/364)}年${SEASONS[Math.floor((day%364)/91)]||''}`;
};

/**
 * 一局记录：开局国力 → 决策链 → 终局。
 *
 * 去重按 revision 合流：一次推演结算产生的多条事件是同一次意志的多个侧面，
 * 拆成多条会让「一个决策」读起来像好几次拍脑袋。截断按 changes 条数降序取前
 * 60 条再恢复时序——选重要的，但读起来仍是编年，不是排行榜。
 */
export function buildChronicle(input:{events:WorldEvent[];world:WorldSnapshot;cast:{id:string;name:string;role:string}[];openingPrompt:string;ending:{title:string;summary:string;verdict:'victory'|'defeat'|null}}):ChronicleRecord{
 const world=input.world,cast=input.cast||[];
 const playerId=world.simulation?.playerFactionId??Object.keys(world.factions)[0];
 const faction=world.factions[playerId]?.name??Object.values(world.factions)[0]?.name??'—';
 // 实体名一律取世界现况，演员表只作兜底：史官引用的必须是簿册上的名字
 const nameOf=(id:string)=>world.armies[id]?.name||world.cities[id]?.name||world.factions[id]?.name||world.decisions[id]?.title||cast.find(c=>c.id===id)?.name||id;
 const fmtValue=(v:JsonValue,field:string,unit?:string):string=>{
  if(v===null)return '未设定';
  // 与 strategy-view 同口径：≥1000 取整，避免千分位夹小数被看成大千倍（BUG-006）。
  if(typeof v==='number')return TROOP_FIELDS.has(field)?bandTroops(v):(Math.abs(v)>=1000?Math.round(v):Math.round(v*10)/10).toLocaleString('zh-CN')+(unit?` ${unit}`:'');
  if(typeof v==='string')return v;
  if(typeof v==='boolean')return v?'是':'否';
  const r=v as {kind?:string;cityId?:string;label?:string};
  if(r.kind==='city')return nameOf(String(r.cityId));
  if(r.kind==='route')return '行军途中';
  if(r.kind==='field')return String(r.label);
  return '已更新';
 };
 const entityLabel=(c:FieldChange)=>c.entity.type==='clock'?'时轮':nameOf(c.entity.id);
 // 「AI 执行序列」只收军、城、行、时的变化：决策簿条目的登记与状态变迁（id/title/
 // orderText/issuerId/status…）不是「AI 具体做了什么」的操作，而是决策自身的账——
 // 那道令的旨意已由本条的「玩家决策」原话承载，再原样挤进行列就是把同一句话印两遍。
 const operational=(c:FieldChange)=>c.entity.type!=='decision';
 // 玩家拍板的决策，其原话逐字取决策簿上的旨意原文（orderText）；AI 大臣/本地守军代决的
 // orderText 是它们的执行记录、不是玩家说的话，不挂。取不到就留空——宁缺勿造，
 // 史官不许替玩家编一句话，宁可这条决策没有原话行。
 // 判定只认决策簿里的 issuerId，不能再按 source 筛：本地局每一条世界命令的 source 都是
 // 'rules'（本地裁判），照它滤会把玩家亲自下的每道军令原话整段挡掉——QA 实测玩家裁卡
 // 十余次、下令数次，导出的 60 条决策里没有一条带原话，病根就在这一行。
 const decisionPrompt=(e:WorldEvent):string|undefined=>{
  if(!e.decisionId)return undefined;
  const order=world.decisions[e.decisionId];
  if(!order||order.issuerId!=='player')return undefined;
  return order.orderText?.trim()||undefined;
 };
 // 代决痕迹：jump/advance 的落库事件 decisionId 为 null（commitLocal 只给 order 挂
 // decisionId），AI 大臣在那一轮里代决的事并进同一条事件的 summary，得靠痕迹认领——
 // ① summary 带【已行】/【未行】前缀（commander-runtime 代决回执的固定起头）；
 // ② 变更里碰了决策簿条目，直接查簿上那道令的 issuerId（ai-marshal/local-defender）。
 // decisionId 非空的事件不走这里：那道令的 issuerId 在簿上，一说一个准。
 const DELEGATED_NOTE=/【(?:已行|未行)】/;
 const AUTO_ISSUERS=new Set(['ai-marshal','local-defender']);
 const looksDelegated=(g:WorldEvent[]):boolean=>
  g.some(e=>DELEGATED_NOTE.test(e.summary)
   ||e.changes.some(c=>c.entity.type==='decision'&&AUTO_ISSUERS.has(world.decisions[c.entity.id]?.issuerId??'')));
 const toDecision=(g:WorldEvent[]):ChronicleDecision=>{
  const first=g[0];
  const aiActions=g.flatMap(e=>e.changes.filter(operational).map(c=>`${entityLabel(c)}·${fieldLabel(c.field)} ${fmtValue(c.before,c.field,c.unit)} → ${fmtValue(c.after,c.field,c.unit)}`));
  const results=g.flatMap(e=>e.summary.split('\n').map(s=>s.trim()).filter(Boolean));
  const prompt=decisionPrompt(first);
  // 归属两步走：① 有 decisionId 的看**决策簿里这道令的 issuerId**。簿记 player 才是玩家
  // 拍板；ai-marshal/local-defender 是代决；簿上查不到（旧存档、例行代决已被淘汰）时
  // 保守记代决，不抢功。不能只看事件的 source——世界命令的 source 一律是 'rules'（本地
  // 裁判），照它判会把玩家自己下的每道令都记成「AI 代决」：实测进攻长安、撤退全被标成
  // 代决，例行推进反倒成了玩家决策，两处完全颠倒。
  // ② decisionId 为空的是裁决决策卡、天候与 jump/advance 合并结算：有代决痕迹的记
  // ai-delegated（太尉在这一轮里代决的事），没有的是玩家侧。
  const issuer=first.decisionId?world.decisions[first.decisionId]?.issuerId:undefined;
  const kind=first.decisionId?(issuer==='player'?'player':'ai-delegated'):(looksDelegated(g)?'ai-delegated':'player');
  return {id:first.decisionId??`rev-${first.revision}`,day:first.toDay,title:first.title,
   kind,
   ...(prompt?{prompt}:{}),aiActions,results};
 };
 const groups=new Map<number,WorldEvent[]>();
 for(const e of [...input.events].sort((a,b)=>a.revision-b.revision)){
  const g=groups.get(e.revision);
  if(g)g.push(e);else groups.set(e.revision,[e]);
 }
 const raw=[...groups.values()].map(toDecision);
 let decisions=raw,omitted=0;
 if(raw.length>MAX_DECISIONS){
  const ranked=raw.map((d,i)=>({d,i})).sort((a,b)=>b.d.aiActions.length-a.d.aiActions.length||a.i-b.i);
  decisions=ranked.slice(0,MAX_DECISIONS).sort((a,b)=>a.i-b.i).map(x=>x.d);
  omitted=raw.length-MAX_DECISIONS;
 }
 const provinces=Object.values(world.provinces??{}).filter(p=>p.ownerFactionId===playerId);
 // 「初始国力」必须取**开局时**的值。直接拿传入的世界算是终局快照：10 年挂机局会显示
 // 「粮草 31236 千斤」，而开局其实只有 472 千斤——整局叙事的地理全错。
 // ledger.initialFoodKg 被 accrueProvinceFood 一路累加，早就是「开局 + 期间产出」；
 // 减掉单列的 producedKg 才是开局存量。
 const initial:{label:string;value:string}[]=[];
 const ledger=world.simulation?.ledger;
 // 开局粮草存量：ledger 记的 initialFoodKg 含期间产出，减掉 producedKg 才是开局值。
 // ledger 为 0/缺失（旧世界、手搓 fixture）时回落到省汇总现值——那至少是个真实量级，
 // 比直接不报这一项好。
 const openingFoodKg=ledger&&ledger.initialFoodKg>0
  ?Math.max(0,ledger.initialFoodKg-(ledger.producedKg??0))
  :provinces.reduce((n,p)=>n+provinceTotals(world,p).foodKg,0);
 if(provinces.length){
  const troops=provinces.reduce((n,p)=>n+provinceTotals(world,p).troops,0);
  initial.push({label:'兵力',value:bandTroops(troops)});
  if(openingFoodKg>0)initial.push({label:'粮草',value:`${Math.round(openingFoodKg/1000)} 千斤`});
 }
  // 开局城池数取引导时落档的 openingCities，不是记事时点的当前归属——否则打下半壁江山后，
  // 起居注会把「初始国力：城池 6 座」写成开局（实测即如此）。旧存档没这个字段才退回现值。
  const openingCityIds=world.openingCities??Object.values(world.cities).filter(c=>c.ownerFactionId===playerId).map(c=>c.id);
  initial.push({label:'城池',value:`${openingCityIds.length} 座`});
 return {opening:{era:world.clock.startLabel,faction,prompt:input.openingPrompt,initial},decisions,
  ending:input.ending,totalDays:world.clock.elapsedDays,...(omitted?{omitted}:{})};
}

/**
 * 一键复制的 Markdown：给 LLM 读的因果分析材料，不是给人读的故事。
 * 四个必填字段（玩家原话 / AI 执行序列 / 结果与因果 / 性质标记）缺一不可——
 * 缺一个，别的 AI 就写不好解读文章。
 */
export function renderChronicleMarkdown(r:ChronicleRecord):string{
 const lines:string[]=['# 史境·三国 一局记录','','## 开局',`- 年代：${r.opening.era}`,`- 势力：${r.opening.faction}`,
  `- 玩家战略原话：「${r.opening.prompt}」`,`- 初始国力：${r.opening.initial.map(i=>`${i.label} ${i.value}`).join(' / ')||'未载'}`,'','## 决策链'];
 r.decisions.forEach((d,i)=>{
  lines.push('',`### D${String(i+1).padStart(2,'0')} · ${eraLabel(d.day,r.opening.era)}（${decisionKindLabel(d.kind)}）`,`- 情境：${d.title}`);
  if(d.prompt)lines.push(`- 玩家决策：「${d.prompt}」`);
  else if(d.kind==='ai-delegated'&&r.opening.prompt)lines.push(`- 依据：玩家战略「${r.opening.prompt}」`);
  if(d.aiActions.length)lines.push(`- AI 执行：${d.aiActions.join('；')}`);
  if(d.results.length)lines.push(`- 结果：${d.results.join('；')}`);
  if(d.note)lines.push(`- 史官注：${d.note}`);
 });
 if(r.omitted)lines.push('',`另有 ${r.omitted} 条琐务从略`);
 const verdict=r.ending.verdict==='victory'?'（此局为胜）':r.ending.verdict==='defeat'?'（此局为负）':'';
 lines.push('','## 终局',`- ${r.ending.title}`,`- 史官总评：${r.ending.summary}${verdict}`,'','---','本记录由史官依事件流水生成，未经玩家修饰。');
 return lines.join('\n')+'\n';
}

/** 强校验：验收工具，不是文案检查。因果链断裂（无执行亦无结果）必须在此拦下。 */
export function validateChronicle(r:ChronicleRecord):void{
 assert(Array.isArray(r.decisions)&&r.decisions.length>0,'一局记录至少要有一条决策');
 assert(typeof r.opening?.prompt==='string'&&r.opening.prompt.trim().length>0,'开局必须载有玩家战略原话');
 r.decisions.forEach((d,i)=>{
  assert(Object.hasOwn(KIND_LABELS,d.kind),`第 ${i+1} 条决策的性质标记无效`);
  assert(d.aiActions.length>0||d.results.length>0,`第 ${i+1} 条决策既无 AI 执行也无结果，因果链断裂`);
 });
 assert(r.ending.verdict===null||r.ending.verdict==='victory'||r.ending.verdict==='defeat','终局判定必须是 victory / defeat / null');
}
