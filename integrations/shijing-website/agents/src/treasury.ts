import type {Army,Province,WorldSnapshot} from './world-contracts.js';
import {provinceOutputForDays} from './economy.js';
import {assert} from './contracts.js';

/**
 * 国库与财政结算 v1：让钱、民力、兵役真正累积起来的实体。
 *
 * 经济层（economy.ts）只回答「一省一年产多少」，粮食直接结余到治所库存；
 * 可钱、民力、兵役没有地方存——每年被算出来，又每年凭空蒸发。本模块就是
 * 给它们一个家。三条不变量贯穿全模块：
 * 一、粮食不走国库。它已记在城池 foodKg 与 simulation ledger 上，国库再记
 *    一份就是两处账本，守恒检查必错；所以 fiscalIncome 的 food 恒为 0。
 * 二、腐败只吃财政收入，不吃军饷支出。军饷是刚性支出：发不出就是欠饷，
 *    「官吏贪墨」解释不了士兵为什么饿着肚子跟你出征。
 * 三、欠饷按天累积。它是哗变的直接诱因，天数比任何形容词都更接近军心。
 *
 * 四、国库只认**本方阵营**的省份与军队（属主口径）。省政层早有严格属主校验
 *    （province-update.ts「省 X 不归你治」），国库若「全国一体征收、全军一起发饷」，
 *    玩家开局只辖汉中、益州两省，30 日却按全图 12 省入库 40 万钱，还替魏吴
 *    30,000 守军发 22,800 军饷——QA 深度试玩实测（B3）的六倍虚账就是这么来的。
 *    属主之外的钱与饷，一分都不该过我的手。无 simulation 的局（阅览室、外部引擎
 *    快照、旧存档）没有「本方」可言，按全图征收、全军发饷，与修复前完全一致。
 */

export type TreasuryResource='coin'|'food'|'corvee'|'manpower';

export interface FiscalState {
  version:1;
  treasury:Record<TreasuryResource,number>;
  /** 税率 0..1：只作用于钱粮收入 */
  taxRate:number;
  /** 腐败折损 0..1：只吃财政收入，不吃军饷支出 */
  corruption:number;
  /** 欠饷累计天数；军饷发不出时增长，是「哗变」的直接诱因 */
  arrearsDays:number;
  lastSettlement:{day:number;income:Record<TreasuryResource,number>;expense:Record<TreasuryResource,number>;note:string}[];
}

const TREASURY_KEYS:TreasuryResource[]=['coin','food','corvee','manpower'];
const RESOURCE_LABELS:Record<TreasuryResource,string>={coin:'钱',food:'粮',corvee:'民力',manpower:'兵役'};
const TAX_START=0.3;         // 开局三十税一之下的常规年景：不横征暴敛，也不轻徭薄赋
const CORRUPTION_START=0.15; // 模拟设定：仓场耗折与地方克扣的常规损耗
const MAX_SETTLEMENTS=50;    // 只留最近 50 次结算：史官要看近期得失，不要无限账本

/**
 * 军饷单价：币/人/日。**国库口径内的数**（有 simulation 层的本机推演局）。
 *
 * 校准锚在粮上，不凭空拍：兵丁日食 1 kg（SOLDIER_RATIONS_PER_DAY），粮价 0.5 币/kg
 * （economy-model.FOOD_PRICE），一人口粮值 0.5 币/日。军饷取口粮之值的**四成**：
 * 日支二币（0.2），月得六币，折粮 12 kg——衣装器械盐菜之费。口粮另六成走城池库存、
 * 不过国库（不变量一），两笔合起来才是一个兵的全部代价，别把这 0.2 当「一个兵的
 * 全部开销」读。
 *
 * 于是军费回到它该在的位置（v1 的 0.02 是旧刻度：一支 5,000 人的军年薪饷 3.65 万，
 * 只占两省岁入的 4%，养兵近乎免费，国库只会一路涨到四千五百万——正是 QA 实测到的
 * 虚账来源）。以校准后的数重算开局蜀汉（汉中+益州两省、本方两军 8,000 人）：
 *   · 两省岁入 83.0 万（3,255,000 × 税率 30% × (1−腐耗 15%)），年饷 58.4 万——
 *     占七成：有余裕，不阔绰，国库年净增 24.6 万；
 *   · 两省 levy 全募（汉中 5,990 + 益州 4,998 ≈ 1.1 万人）年饷 80.3 万，与岁入
 *     打平——「屯田还是募兵」自此是真取舍（province.ts 的校准注释在粮那一侧讲了
 *     同一件事）；
 *   · 全图 12 省、38,000 全军，年饷 277 万占国库岁入 469 万的近六成：养兵是财政
 *     主项，不是零头。
 * 后两条同时让「欠饷→哗变」走得通，见 settleFiscal 上的欠饷注释。
 */
export const ARMY_PAY_PER_DAY=0.2;
/**
 * 旧刻度饷率：0.02 币/人/日，v1 起步值，只给**国库口径之外**的局用。
 *
 * 与属主过滤（scopedProvinces/scopedArmies）是同一条边界：无 simulation 层的快照
 * （外部引擎对局、阅览室、手写夹具）连饷率也一并沿用旧数。别家引擎的账本不是本机
 * 推演局该改的数——改了就是对上游对局的静默破坏，且本模块的测试夹具正是按旧刻度
 * 钉死的算例。
 */
const LEGACY_ARMY_PAY_PER_DAY=0.02;
/** 建设工时单价：民力/人/日。模拟设定——与军饷同口径的人日价，供营造层取用；国库是民力的账本，故与此处同列。 */
export const CORVEE_PER_DAY=0.05;
/** 兵丁日食 1 kg：与 economy.ts、战役层同一口径，此处再显式一次，免得各处硬编码。 */
const SOLDIER_RATIONS_PER_DAY=1;

const round8=(n:number)=>Math.round(n*1e8)/1e8; // 抹平浮点尾差：国库经 JSON 往返后仍要收支两清
/** 夹紧到 0..1 并 round8；NaN 按 0——滑块预览宁可算少，不可把 NaN 写进国库。 */
const clamp01=(n:number)=>Number.isFinite(n)?round8(Math.min(1,Math.max(0,n))):0;
const object=(x:unknown):x is Record<string,unknown>=>!!x&&typeof x==='object'&&!Array.isArray(x);
function record(x:unknown,label:string):asserts x is Record<string,unknown>{assert(object(x),`${label}必须是对象`);}
function array(x:unknown,label:string):asserts x is unknown[]{assert(Array.isArray(x),`${label}必须是数组`);}
function number(x:unknown,label:string,min=0,max=Number.MAX_SAFE_INTEGER):asserts x is number{assert(typeof x==='number'&&Number.isFinite(x)&&x>=min&&x<=max,`${label}超出允许范围`);}

/** 国库开局：四项全空，税率三成，腐耗一成五，无欠饷，无旧账。 */
export function seedFiscal():FiscalState{
 return {version:1,treasury:{coin:0,food:0,corvee:0,manpower:0},taxRate:TAX_START,corruption:CORRUPTION_START,arrearsDays:0,lastSettlement:[]};
}

/** 强校验：国库是第一处「真会累积」的账本，坏状态必须在进入推演前被拦下。 */
export function validateFiscal(s:FiscalState):void{
 const x=s as unknown as Record<string,unknown>;
 record(x,'国库财政');assert(x.version===1,'国库财政版本必须为 1');
 const t=x.treasury as Record<string,unknown>;record(t,'国库库存');
 assert(Object.keys(t).length===TREASURY_KEYS.length&&TREASURY_KEYS.every(k=>Object.hasOwn(t,k)),'国库必须恰有 钱、粮、民力、兵役 四项');
 for(const k of TREASURY_KEYS)number(t[k],`国库${RESOURCE_LABELS[k]}`,0);
 number(x.taxRate,'税率',0,1);number(x.corruption,'腐败折损',0,1);number(x.arrearsDays,'欠饷天数',0);
 const ls=x.lastSettlement;array(ls,'结算记录');
 assert(ls.length<=MAX_SETTLEMENTS,`结算记录不得超过 ${MAX_SETTLEMENTS} 条`);
 for(const [i,row] of ls.entries()){
  const r=row as Record<string,unknown>;record(r,`第 ${i+1} 条结算`);
  number(r.day,`第 ${i+1} 条结算的日号`,0);
  for(const k of ['income','expense'] as const){
   const rec=r[k] as Record<string,unknown>;record(rec,`第 ${i+1} 条结算的${k==='income'?'收入':'支出'}明细`);
   for(const res of TREASURY_KEYS)number(rec[res],`第 ${i+1} 条结算${k==='income'?'收入':'支出'}${RESOURCE_LABELS[res]}`,0);
  }
  assert(typeof r.note==='string'&&r.note.length<=500,`第 ${i+1} 条结算摘要无效`);
 }
}

/**
 * 「本方」是谁：有 simulation 的局按 `playerFactionId`，没有的局返回 null。
 *
 * null 的含义是**不设属主过滤**（阅览室局、外部引擎快照、旧存档），而不是「谁都不认」——
 * 那些局没有推演层，硬按某个阵营过滤会把本来有的账平白抹成零。
 */
const playerFactionOf=(w:WorldSnapshot):string|null=>{
 const id=w.simulation?.playerFactionId;
 return typeof id==='string'&&id.length>0?id:null;
};

/** 属主口径下的本方省份：无推演层时返回全图省份（修复前行为）。 */
export const scopedProvinces=(w:WorldSnapshot):Province[]=>{
 if(!w.provinces)return[];
 const mine=playerFactionOf(w);
 return Object.values(w.provinces).filter(p=>!mine||p.ownerFactionId===mine);
};

/** 属主口径下的本方军队：无推演层时返回全部军队（修复前行为）。 */
export const scopedArmies=(w:WorldSnapshot):Army[]=>{
 const mine=playerFactionOf(w);
 return Object.values(w.armies||{}).filter(a=>!mine||a.factionId===mine);
};

/**
 * N 天财政收入汇总：**本方省份**的产出过一遍税率与腐败折损。
 *
 * 折算公式：coin = Σ本方各省 coin产出 × taxRate × (1 - corruption)；
 * corvee = Σ本方各省 corvee产出 × (1 - corruption)——民力是征发不是买卖，无税可言，
 * 但层层克扣照样吃掉它；manpower = Σ本方各省 manpower产出——兵役人口既不收税也不被
 * 贪墨，那是活生生的人，不是账面上的数字。
 * food 恒为 0：粮食不走国库，它直接结余在治所库存（economy.ts 的 accrueProvinceFood），
 * 这里若也记一份，同一吨粮就会在两处账本上各出现一次。
 */
export function fiscalIncome(w:WorldSnapshot,days:number,taxRate:number,corruption:number):Record<TreasuryResource,number>{
 const out:Record<TreasuryResource,number>={coin:0,food:0,corvee:0,manpower:0};
 if(!w.provinces||!(days>0))return out;
 const tax=clamp01(taxRate),rot=clamp01(corruption);
 let coin=0,corvee=0,manpower=0;
 for(const p of scopedProvinces(w)){
  const gain=provinceOutputForDays(w,p.id,days);
  if(!gain)continue;
  coin+=gain.coin;corvee+=gain.corvee;manpower+=gain.manpower;
 }
 out.coin=round8(coin*tax*(1-rot));
 out.corvee=round8(corvee*(1-rot));
 out.manpower=round8(manpower);
 return out;
}

/**
 * 军饷与军粮开支。军饷是刚性支出：腐败只吃收入，从来吃不掉当兵的饷——
 * 所以这个函数没有 corruption 参数，也永远不需要有。
 *
 * 属主口径：只给**本方**军队发饷。魏吴守军吃谁的粮、领谁的饷是他们自家的事，
 * 拿蜀汉的库银去养魏军，既是六倍虚账，也让「入不敷出」这道预警永远不准。
 * 饷率随局而分：国库口径内（有 simulation 层）用校准后的 ARMY_PAY_PER_DAY，
 * 口径之外沿用旧刻度 LEGACY_ARMY_PAY_PER_DAY。
 */
export function armyUpkeep(w:WorldSnapshot,days:number):{coin:number;food:number}{
 const d=Number.isFinite(days)&&days>0?days:0;
 // 覆没的军队不再领军粮军饷：它已经不在编制里了
 const troops=scopedArmies(w).filter(a=>a.status!=='destroyed').reduce((n,a)=>n+(a.troops>0?a.troops:0),0);
 const rate=playerFactionOf(w)?ARMY_PAY_PER_DAY:LEGACY_ARMY_PAY_PER_DAY;
 return {coin:round8(troops*rate*d),food:round8(troops*SOLDIER_RATIONS_PER_DAY*d)};
}

/**
 * 一次财政结算：收钱、发饷、记账，返回人类可读的摘要。
 *
 * 顺序刻意是「先入账、后发饷」：本期的税先落库，再从中支饷。先发后收会让
 * 「今年刚开的税」伪装成「去年的积蓄」，玩家对不上账。
 *
 * **欠饷这条通道什么时候才走得通**（写给调参与排障的人，别让 assessUpheaval 的
 * 欠饷分支变成死代码）：判定只看一条——本期入库（含历年积存）够不够本期军饷。
 * 默认参数（税率 30%、腐耗 15%）的算术，以国库口径内的 0.2 币/人/日为准：
 *   · 开局蜀汉两省（汉中+益州）岁入 83.0 万，本方两军 8,000 人年饷 58.4 万——占
 *     七成，净增 24.6 万/年，不欠；
 *   · 两省 levy 全募（约 1.1 万人）年饷 80.3 万 ≈ 岁入——**打平**。再多募一支兵、
 *     或少一省，扣完成交入库国库就见底，欠饷按日累加；
 *   · 只剩一省（汉中，岁入 24.1 万）而仍养 8,000 人（年饷 58.4 万）——**必欠**。
 *     国势倾颓、州郡日蹙之日，就是「欠饷→哗变」该响的时候；
 *   · 税率调到 0（免税年景）或一省不剩（无省可征）：入库归零，军饷照发，每期都欠。
 * 反过来，正常治理与养一支常备军在默认参数下**不会**欠饷——国库本该养得起自己的
 * 军队，预警通道要报的是「养不起」，不是「每期都给点颜色看」。
 */
export function settleFiscal(s:FiscalState,w:WorldSnapshot,days:number):string[]{
 // 0 天不结算：同日重复调用会把「欠饷清零」错记成一次豁免，还平白多一条旧账
 if(!(Number.isFinite(days)&&days>0))return[];
 const income=fiscalIncome(w,days,s.taxRate,s.corruption);
 const upkeep=armyUpkeep(w,days);
 // 钱、民力、兵役入账；粮不入库——它已直接在治所库存结余，见 fiscalIncome
 s.treasury.coin=round8(s.treasury.coin+income.coin);
 s.treasury.corvee=round8(s.treasury.corvee+income.corvee);
 s.treasury.manpower=round8(s.treasury.manpower+income.manpower);
 // 发多少只看国库深浅，与腐败无关：军饷是刚性支出，短饷即欠饷，没有折扣可打
 const pay=Math.min(s.treasury.coin,upkeep.coin);
 s.treasury.coin=round8(s.treasury.coin-pay);
 // 欠饷判定放在 round8 之后：浮点尘（1e-9 级）不算欠，发不出一个铜板才算
 const short=round8(upkeep.coin-pay);
 s.arrearsDays=short>0?round8(s.arrearsDays+days):0;
 const pct=(n:number)=>Math.round(n*100);
 // 属主口径要写在账上：玩家辖几省、养几军，结算行里说得出来才对得上账
 const hasProvinces=!!w.provinces&&Object.keys(w.provinces).length>0;
 const mine=playerFactionOf(w);
 const mineProvinces=mine?scopedProvinces(w).length:0;
 const mineArmies=mine?scopedArmies(w).filter(a=>a.status!=='destroyed'&&a.troops>0):[];
 const scope=mine?(mineProvinces>0?`，本方 ${mineProvinces} 省`:'，本方无省可征'):(hasProvinces?'':'，无省可征');
 const ownArmyNote=mine?`（本方 ${mineArmies.length} 军 ${mineArmies.reduce((n,a)=>n+a.troops,0)} 人）`:'';
 const out=[`库入 钱 ${income.coin}、民力 ${income.corvee}、兵役 ${income.manpower}（税率 ${pct(s.taxRate)}%，腐耗 ${pct(s.corruption)}%${scope}）`,
  `军饷 ${upkeep.coin}${ownArmyNote}，实发 ${pay}${short>0?`，短 ${short}`:''}`];
 if(short>0)out.push(`欠饷 ${s.arrearsDays} 日`);
 s.lastSettlement.push({day:w.clock?.elapsedDays??0,income,expense:{coin:pay,food:0,corvee:0,manpower:0},note:out.join('；')});
 while(s.lastSettlement.length>MAX_SETTLEMENTS)s.lastSettlement.shift();
 return out;
}

/** 一行一式：面板与史官直接取用；欠饷必须显式标注——玩家不能对军心后知后觉。 */
export const fiscalSummary=(s:FiscalState):string[]=>[
 `库钱 ${round8(s.treasury.coin)}`,`民力 ${round8(s.treasury.corvee)}`,`兵役 ${round8(s.treasury.manpower)}`,
 `欠饷 ${round8(s.arrearsDays)} 日${s.arrearsDays>0?'（恐生哗变）':''}`];

/** 税率夹紧在 0..1：UI 滑块与 AI 建议都可能越界，落账前必须夹平。 */
export function setTaxRate(s:FiscalState,rate:number):void{s.taxRate=clamp01(rate);}
/** 腐败折损同样夹紧在 0..1：再贪的官吏也变不出负数的库银。 */
export function setCorruption(s:FiscalState,rate:number):void{s.corruption=clamp01(rate);}
