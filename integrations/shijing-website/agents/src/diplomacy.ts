import {assert} from './contracts.js';

/**
 * 外交层 v1：国与国的博弈。
 *
 * 两条轴故意分开（抄《全面战争：三国》）：态度是他有多喜欢我们，信誉是他有多相信我们的
 * 承诺。喜欢可以靠送礼、联姻、放人刷出来，信任只能靠一诺千金攒出来——撕一次条约，
 * 态度掉一截，信誉掉到谷底，而且**所有人都看见了**。一个受欢迎但不可信的国家，和约
 * 没人肯签；一个可信但没人喜欢的国家，连坐下来的机会都没有。混成一个数就丢了这层博弈。
 *
 * 关系是有向的：A→B 记的是 **B 怎么看 A**（attitude / trust / stance 全是 B 单方面的
 * 看法），所以 A→B 与 B→A 是两条——我喜欢他与他喜欢我不是一回事，和约也只约束签字
 * 双方。违约按方向结算：对手重创（信誉 -50、态度 -30），旁观全体对违约者的信任普跌
 * （-20，「所有人都看见了」），撕的是同盟再追加态度 -30；违约者霸名 +5——背信
 * 也是称霸的一种姿势，这就是霸名取代恶名值的原因：它只记强者的事。
 *
 * 砍掉的：市场价格模拟（归经济层）、恶名值（收敛为单一「霸名」）、recognized rank
 * 表格。附庸只占词位（stance 'subject' 与条约 'tribute'）：贡赋比例与吞并代价由
 * 后续模块显式承担，本文件不编数。
 */

export type DiplomaticStance='war'|'hostile'| 'neutral'|'friendly'|'allied'|'subject'; // 交战/敌对/中立/友善/同盟/附庸（我方为宗主）
export type TreatyKind='alliance'|'tribute'|'passage'|'joint-defense'|'joint-war'; // 同盟/进贡/过境/联合防御/联合进攻

export interface Treaty {id:string;kind:TreatyKind;sinceDay:number;untilDay:number|null;breached:boolean}

export interface DiplomaticRelation {
  id:string;                  // `${fromFactionId}->${toFactionId}`
  fromFactionId:string;toFactionId:string;
  /** 态度 -100..100：他有多喜欢我们 */
  attitude:number;
  /** 信誉 -100..100：他有多相信我们的承诺 */
  trust:number;
  stance:DiplomaticStance;
  treaties:Treaty[];
}

export interface DiplomaticState {
  version:1;
  relations:DiplomaticRelation[];
  /** 霸名 0..100：称霸行为降低他国倾向我们的概率 */
  hegemony:number;
}

export const DIPLOMATIC_STANCES:DiplomaticStance[]=['war','hostile','neutral','friendly','allied','subject'];
export const TREATY_KINDS:TreatyKind[]=['alliance','tribute','passage','joint-defense','joint-war'];
export const STANCE_LABELS:Record<DiplomaticStance,string>={war:'交战',hostile:'敌对',neutral:'中立',friendly:'友善',allied:'同盟',subject:'附庸'};
export const TREATY_LABELS:Record<TreatyKind,string>={alliance:'同盟',tribute:'进贡',passage:'过境','joint-defense':'联合防御','joint-war':'联合进攻'};

const ATTITUDE_LIMIT=100,TRUST_LIMIT=100,HEGEMONY_LIMIT=100;
const TRUST_BREACH=-50;         // 撕毁条约：对手对我们的信任重创——承诺从此不作数
const ATTITUDE_BREACH=-30;      // 撕毁条约：对手的态度转冷
const ALLIANCE_BREACH=-30;      // 撕毁的若是同盟：态度再掉一截，盟谊比普通和约值钱
const WITNESS_TRUST=-20;        // 旁观的所有势力：信任普跌——所有人都看见了
const HEGEMONY_BREACH=5;        // 每撕一次条约，霸名 +5：非常手段换来的威势

/** 纳谏概率的立场修正：打着的与敌对的基本谈不拢，同盟最肯通融。 */
const STANCE_ODDS:Record<DiplomaticStance,number>={war:-0.4,hostile:-0.2,neutral:0,friendly:0,allied:0.3,subject:0};
const ATTITUDE_ODDS=0.08;       // 态度每 +10，接受率 +0.08
const TRUST_ODDS=0.05;          // 信誉每 +10，接受率 +0.05：信任比喜欢更能换来签字
const HEGEMONY_ODDS=0.03;       // 霸名每 +10，接受率 -0.03：霸主作风让人不敢沾边

const round8=(n:number)=>Math.round(n*1e8)/1e8; // 抹平浮点尾差：信誉账本经 JSON 往返后仍要恰好可复现
const clamp=(n:number,lo:number,hi:number)=>Math.min(hi,Math.max(lo,n));
const signed=(n:number)=>n>0?`+${n}`:`${n}`;
const relationId=(from:string,to:string)=>`${from}->${to}`;

const assertStance=(x:unknown):DiplomaticStance=>{assert(typeof x==='string'&&DIPLOMATIC_STANCES.includes(x as DiplomaticStance),`立场 ${String(x)} 非法`);return x as DiplomaticStance;};

/**
 * 开局外交：每一对有向组合建一条关系，默认互不相识（态度信誉归零、立场中立）。
 * startDay 入参即开局日：v1 种子不附和约（史实和约留给 preset 之后的播种逻辑），
 * 先校验留着，免得将来播种时又要改签名。
 */
export function seedDiplomacy(factionIds:string[],startDay:number,preset?:Record<string,{attitude:number;trust:number;stance:DiplomaticStance}>):DiplomaticState{
 assert(Array.isArray(factionIds)&&factionIds.every(f=>typeof f==='string'&&f.length>0),'势力列表无效');
 assert(new Set(factionIds).size===factionIds.length,'势力编号重复：有向关系会建重');
 assert(Number.isFinite(startDay)&&startDay>=0,'开局日无效');
 const relations:DiplomaticRelation[]=[];
 for(const from of factionIds)for(const to of factionIds){
  if(from===to)continue; // 没有「我对我自己的态度」这回事：自指关系一律不建
  const p=preset?.[relationId(from,to)];
  if(p)assert(Number.isFinite(p.attitude)&&Number.isFinite(p.trust),'预设的态度与信誉必须是有限数');
  relations.push({id:relationId(from,to),fromFactionId:from,toFactionId:to,
   attitude:p?clamp(round8(p.attitude),-ATTITUDE_LIMIT,ATTITUDE_LIMIT):0,
   trust:p?clamp(round8(p.trust),-TRUST_LIMIT,TRUST_LIMIT):0,
   stance:p?assertStance(p.stance):'neutral',treaties:[]});
 }
 // 预设指了不存在的关系 = 调用方笔误或势力已亡：静默忽略会让「按史实开局」悄悄落空
 if(preset)for(const key of Object.keys(preset)){
  const [from,to]=key.split('->');
  assert(factionIds.includes(from)&&factionIds.includes(to)&&from!==to,`预设关系 ${key} 不在势力列表中`);
 }
 return {version:1,relations,hegemony:0};
}

const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function record(x:unknown,label:string):asserts x is Record<string,unknown>{assert(object(x),`${label}必须是对象`);}
function array(x:unknown,label:string):asserts x is unknown[]{assert(Array.isArray(x),`${label}必须是数组`);}
function text(x:unknown,label:string):asserts x is string{assert(typeof x==='string'&&x.length>0,`${label}无效`);}
function number(x:unknown,label:string,lo=-Number.MAX_SAFE_INTEGER,hi=Number.MAX_SAFE_INTEGER):asserts x is number{assert(typeof x==='number'&&Number.isFinite(x)&&x>=lo&&x<=hi,`${label}超出允许范围`);}

/**
 * 强校验：关系编号与方向绑定（`from->to`），查找、去重、违约结算全依赖这个约定，
 * 所以编号对不上方向一律拦下。校验只管合法性不管齐全性——新势力中途入场时只补
 * 关系，不要求全量重建。
 */
export function validateDiplomacy(s:DiplomaticState,factionIds:string[]):void{
 const x=s as unknown as Record<string,unknown>;
 record(x,'外交状态');assert(x.version===1,'外交状态版本必须为 1');
 assert(Array.isArray(factionIds)&&factionIds.every(f=>typeof f==='string'&&f.length>0),'势力列表无效');
 const known=new Set(factionIds);
 array(x.relations,'关系列表');
 number(x.hegemony,'霸名',0,HEGEMONY_LIMIT);
 const ids=new Set<string>(),pairs=new Set<string>();
 for(const raw of x.relations){
  const r=raw as Record<string,unknown>;record(r,'关系');
  text(r.fromFactionId,'关系起点');text(r.toFactionId,'关系终点');
  const from=r.fromFactionId,to=r.toFactionId;
  assert(known.has(from),`关系起点 ${from} 不是已知势力`);
  assert(known.has(to),`关系终点 ${to} 不是已知势力`);
  assert(from!==to,`关系 ${from}→${to} 不能指向自身`);
  assert(r.id===relationId(from,to),`关系 ${from}→${to} 的编号必须是 ${relationId(from,to)}`);
  text(r.id,'关系编号');
  assert(!ids.has(r.id),`关系编号 ${r.id} 重复`);ids.add(r.id);
  assert(!pairs.has(relationId(from,to)),`有向对 ${from}→${to} 重复`);pairs.add(relationId(from,to));
  number(r.attitude,`${from}→${to} 态度`,-ATTITUDE_LIMIT,ATTITUDE_LIMIT);
  number(r.trust,`${from}→${to} 信誉`,-TRUST_LIMIT,TRUST_LIMIT);
  assertStance(r.stance);
  array(r.treaties,`${from}→${to} 的条约簿`);
  for(const rawT of r.treaties){
   const t=rawT as Record<string,unknown>;record(t,`${from}→${to} 的条约`);
   text(t.id,'条约编号');
   assert(TREATY_KINDS.includes(t.kind as TreatyKind),`条约 ${t.id} 的种类非法`);
   number(t.sinceDay,`条约 ${t.id} 的起始日`,0);
   if(t.untilDay!==null){number(t.untilDay,`条约 ${t.id} 的截止日`,0);assert(t.untilDay>=t.sinceDay,`条约 ${t.id} 的截止日不能早于起始日`);}
   assert(typeof t.breached==='boolean',`条约 ${t.id} 的撕毁标记必须是布尔值`);
  }
 }
}

/** 按方向取关系；关系是有向的，查反方向要用反的编号。 */
export const relationBetween=(s:DiplomaticState,from:string,to:string)=>s.relations.find(r=>r.fromFactionId===from&&r.toFactionId===to);

/** 态度夹紧在 ±100：恩重如山或恨之入骨都有顶，刷好感刷不出永恒的朋友。 */
export function adjustAttitude(s:DiplomaticState,from:string,to:string,delta:number):void{
 const r=relationBetween(s,from,to);
 assert(r,`关系 ${from}→${to} 不存在，无从调整态度`);
 assert(Number.isFinite(delta),'态度变化必须是有限数');
 r.attitude=clamp(round8(r.attitude+delta),-ATTITUDE_LIMIT,ATTITUDE_LIMIT);
}

/** 信誉夹紧在 ±100：守信攒得慢，失信跌得快，且都撞得到天花板与地板。 */
export function adjustTrust(s:DiplomaticState,from:string,to:string,delta:number):void{
 const r=relationBetween(s,from,to);
 assert(r,`关系 ${from}→${to} 不存在，无从调整信誉`);
 assert(Number.isFinite(delta),'信誉变化必须是有限数');
 r.trust=clamp(round8(r.trust+delta),-TRUST_LIMIT,TRUST_LIMIT);
}

/**
 * 撕毁条约的代价：对手信任重创、态度转冷，旁观势力对违约者的信任普跌——
 * 「他喜欢你但不信任你」的另一面：所有人都看见了。撕的是同盟，态度再掉一截；
 * 霸名 +5。条约只标 breached 不删除：史官要能查到「哪一年撕过哪一条」。
 */
export function breachTreaty(s:DiplomaticState,from:string,to:string,treatyId:string):string[]{
 const r=relationBetween(s,from,to);
 assert(r,`关系 ${from}→${to} 不存在，无从撕毁条约`);
 const t=r.treaties.find(x=>x.id===treatyId);
 assert(t,`条约 ${treatyId} 不存在`);
 assert(!t.breached,`条约 ${treatyId} 已遭撕毁，不可二次背弃`);
 // 态度惩罚合成一行：撕约与背盟各扣一次，分成两条同值并列读着像 bug（试玩原话）。
 const attitudeTotal=ATTITUDE_BREACH+(t.kind==='alliance'?ALLIANCE_BREACH:0);
 const out=[`对 ${to} 信誉 ${TRUST_BREACH}`];
 r.trust=clamp(round8(r.trust+TRUST_BREACH),-TRUST_LIMIT,TRUST_LIMIT);
 if(attitudeTotal){
  r.attitude=clamp(round8(r.attitude+attitudeTotal),-ATTITUDE_LIMIT,ATTITUDE_LIMIT);
  out.push(`对 ${to} 态度 ${attitudeTotal}${t.kind==='alliance'?'（撕约且背弃同盟）':''}`);
 }
 t.breached=true;
 // 对方那一侧的条约副本也要打上 breached：条约是**双方**的契约，只改自己那份，
 // 对侧读 liveTreaties 时会认为盟约仍然有效——A 已宣战、B 还以为同盟未断，
 // 任何按「是否毁约」分支的逻辑都会在那侧读出错（QA 实测的两侧不一致）。
 // 信任/态度/霸名的惩罚仍只加在发起方那一侧：那是发起方的账，不该双重扣对方。
 const mirror=relationBetween(s,to,from);
 const mirrorTreaty=mirror?.treaties.find(x=>x.id===treatyId||(x.kind===t.kind&&x.sinceDay===t.sinceDay));
 if(mirrorTreaty)mirrorTreaty.breached=true;
 for(const o of s.relations)if(o.fromFactionId===from&&o.toFactionId!==to)o.trust=clamp(round8(o.trust+WITNESS_TRUST),-TRUST_LIMIT,TRUST_LIMIT);
 out.push(`对其余势力 信誉 ${WITNESS_TRUST}`);
 const before=s.hegemony;
 s.hegemony=clamp(round8(before+HEGEMONY_BREACH),0,HEGEMONY_LIMIT);
 out.push(`霸名 ${before} → ${s.hegemony}`);
 return out;
}

/** 一行一式：外交面板与史官直接取用；记的是「对方怎么看我们」，故只取 from 出发的关系。 */
export const diplomaticSummary=(s:DiplomaticState,factionId:string)=>s.relations.filter(r=>r.fromFactionId===factionId).map(r=>`${r.toFactionId} · 态度 ${signed(r.attitude)} · 信誉 ${signed(r.trust)} · ${STANCE_LABELS[r.stance]}`);

/**
 * 纳谏概率：对方在我方提案上点头的可能性。纯函数、无随机——「求人」是盘算不是
 * 抽奖，提案送出去之前就能算给玩家看。读的是对方看我们的那一条关系（from→to）：
 * 他喜欢我们、相信我们，才肯签字；霸名越盛，小邦越不敢沾边。
 */
export function acceptanceOdds(s:DiplomaticState,from:string,to:string):number{
 const r=relationBetween(s,from,to);
 assert(r,`关系 ${from}→${to} 不存在，无从估算纳谏概率`);
 const raw=0.5+r.attitude/10*ATTITUDE_ODDS+r.trust/10*TRUST_ODDS+STANCE_ODDS[r.stance]-s.hegemony/10*HEGEMONY_ODDS;
 return clamp(round8(raw),0,1);
}
