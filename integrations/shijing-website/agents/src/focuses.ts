import type {WorldSnapshot,Id} from './world-contracts.js';
import {AgentError,assert} from './contracts.js';
import {clamp,round} from './simulation-types.js';
import type {DecisionEffect} from './decisions.js';

/**
 * 国策（national focus）v1：政治点驱动的「玩家自己定的国家议程」。
 *
 * 为什么要有它：历史决策卡（DECISION_EVENTS）是既成史实节点，玩家只能在那儿选边；
 * 天下新闻（NEWS_EVENTS）连选项都没有。对一个不太懂这段史的玩家，开局后到第一张卡
 * 之前的十几个游戏日里**没有任何可点的东西**——而这正是 P 社国策树存在的原因：
 * 给玩家一条「我想把国家带向哪」的自选轨道。政治点就是这条轨道的燃料。
 *
 * 与决策卡的边界（用户给的三分法）：
 *   数值消耗决策 = 国策：花政治点换来持续一段时间的国家方向，效果按日或完成时兑现；
 *   突发事件决策 = DECISION_EVENTS：史实节点临时摆到案上，不花政治点；
 *   新闻类决策   = NEWS_EVENTS：只告知，一个「知道了」。
 * 国策的效果词汇与决策卡完全共用（DecisionEffect），不另造一套结算器。
 *
 * 派生：通用国策（GENERIC_FOCUSES）任何剧本都能用；议题相关的国策由 LLM 从玩家
 * 输入的议题文本里读出来（deriveFocuses），读不出来就退回通用那套——**永远有得点**。
 */

export type FocusCategory='军政'|'民政'|'人事'|'邦交';

export interface ScenarioFocus {
  id:string;
  title:string;
  /** 事件叙述：这个国策要做什么、做到什么算完。 */
  text:string;
  category:FocusCategory;
  /** 树三层：1 根基 / 2 中层 / 3 质变。前置只能来自更低的层——想「出师北伐」先得「练为铁骑」。 */
  tier:1|2|3;
  /** 树上的格子位置（row 与 tier 一致，column 是同层内的左右次序），供界面画树。 */
  row:number;column:number;
  /** 前置国策 id。 */
  requires:Id[];
  /** 政治点花费。点了就扣，取消不还（P 社口径：点下去的国策没有回头路）。 */
  cost:number;
  /** 持续游戏日。推进够这么多天才算完成。 */
  days:number;
  /** 完成时一次性兑现。 */
  effects:DecisionEffect[];
  /** 开始与完成时起居注各一句话。 */
  startSummary:string;
  doneSummary:string;
  /** true = 从玩家议题里派生；通用树不带这个字段。 */
  derived?:boolean;
  source?:string;
}

/** 世界快照上的国策层。旧存档没有这一层，读取时按无国策处理。 */
export interface FocusState {
  version:1;
  /** 手里剩多少政治点。 */
  points:number;
  /** 每日累积与上限。久不视事（朝政层）会让累积打折。 */
  pointsPerDay:number;
  pointsCap:number;
  /** 可点的国策：通用 + 本局派生。 */
  available:ScenarioFocus[];
  /** 进行中：最多同时三项——三项以上玩家只是在盖章。 */
  active:{focusId:Id;startedDay:number;endsDay:number}[];
  completed:Id[];
}

export const FOCUS_CATEGORIES:FocusCategory[]=['军政','民政','人事','邦交'];
export const MAX_ACTIVE_FOCUSES=3;
/** 政治点起步与节奏：20 点起步、每日 1 点、上限 100——一个 5 点国策约等于五天的功课。 */
export const PP_START=20;
export const PP_PER_DAY=1;
export const PP_CAP=100;

/**
 * 通用国策：任何三国剧本都立得住的八条。刻意不绑年份与城池——
 * 玩家架空的议题（「如果孙权先伐合肥」）也用这一套起步。
 * 效果都走引擎已有能力，不新增隐藏数值。
 */
export const GENERIC_FOCUSES:ScenarioFocus[]=[
 // 国策树：四支军政/民政/人事/邦交，每支 2 根基 + 1 中层 + 1 质变，共 16 项。
 // tier 越低越根基：tier1 无前置、tier2 依赖本支两条 tier1、tier3 依赖 tier2。
 // 内容口径：三国语境立得住的国政，浅易文言，不绑具体年份——玩家架空的议题也用这一套。
 // ── 军政 ────────────────────────────────────────────────
 {id:'focus-military-drill',title:'整军经武',category:'军政',tier:1,row:0,column:0,cost:5,days:20,requires:[],
  text:'简拔精锐、日教之射御，使行伍知法令。将帅得人则兵可用，此百战之先务。',
  startSummary:'主上下诏整军，遴选精锐、日肄攻战。',doneSummary:'军容既整，士卒知上下之分。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:5},{kind:'treasury',coin:300,corvee:60,manpower:0}]},
 {id:'focus-horse-breeding',title:'牧马渭滨',category:'军政',tier:1,row:0,column:1,cost:4,days:25,requires:[],
  text:'马者，军之用也。置牧苑于渭滨、陇右，募民孳牧，岁课其息。苑马蕃息，则骑士渐盛，缓急可恃焉。',
  startSummary:'置牧苑于渭滨、陇右，募民孳牧岁课之。',doneSummary:'苑马蕃息，陇右之骏渐充厩。',
  effects:[{kind:'province-mode',provinceId:'prov-liangzhou',mode:'horse'},{kind:'treasury',coin:200,corvee:40,manpower:0}]},
 {id:'focus-iron-cavalry',title:'练为铁骑',category:'军政',tier:2,row:1,column:0,cost:7,days:32,requires:['focus-military-drill','focus-horse-breeding'],
  text:'卒既习、马既孳，乃选壮士乘骏马，教以驰骤击刺之法。步骑并进，可决机于原野。',
  startSummary:'简壮士、乘苑马，教之骑战。',doneSummary:'骑阵初成，驰骤可用。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:5},{kind:'army-food',armyId:'army-wei-yan',deltaKg:10000},{kind:'approval',faction:'military',delta:2}]},
 {id:'focus-northern-expedition',title:'出师北伐',category:'军政',tier:3,row:2,column:0,cost:11,days:54,requires:['focus-iron-cavalry'],
  text:'仓廪既实、骑阵既成，遂举大众由汉中向秦川，窥长安。天不丧汉，机不可失。',
  startSummary:'诸军毕集，出汉中而向秦川。',doneSummary:'王师已出，魏人关右震动。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:8},{kind:'army-food',armyId:'army-wei-yan',deltaKg:15000},{kind:'prestige',delta:3}]},

 // ── 民政 ────────────────────────────────────────────────
 {id:'focus-tuntian',title:'劝农积粟',category:'民政',tier:1,row:0,column:0,cost:5,days:30,requires:[],
  text:'分兵屯田、因田制谷，耕者得以自赡，饷不耗于转输。边田既辟，民亦安其耕耨。',
  startSummary:'分兵屯田、因田制谷，使兵农相即。',doneSummary:'屯田既就，军粮取给于田。',
  effects:[{kind:'city-food',cityId:'hanzhong',deltaKg:15000},{kind:'city-food',cityId:'chengdu',deltaKg:15000}]},
 {id:'focus-market',title:'通商惠工',category:'民政',tier:1,row:0,column:1,cost:4,days:25,requires:[],
  text:'除关津之禁、平市价，则商贾辐辏而货贿通行。工贾之利既厚，器用以阜，国用以充。',
  startSummary:'除关津之禁、平市价，以通货贿。',doneSummary:'关市无壅，工贾之利稍苏。',
  effects:[{kind:'treasury',coin:350,corvee:40,manpower:0},{kind:'province-mode',provinceId:'prov-chengdu',mode:'commerce'}]},
 {id:'focus-irrigation',title:'决渠溉田',category:'民政',tier:2,row:1,column:0,cost:7,days:30,requires:['focus-tuntian','focus-market'],
  text:'都江之水，可引以溉成都之田。因故渎而决新渠，旱则引灌，潦则泄之，岁入可倍。',
  startSummary:'因都江故渎，决渠溉田。',doneSummary:'渠流分注，腴田倍入。',
  effects:[{kind:'city-food',cityId:'chengdu',deltaKg:25000},{kind:'city-food',cityId:'hanzhong',deltaKg:20000},{kind:'treasury',coin:0,corvee:70,manpower:0}]},
 {id:'focus-bountiful-tianfu',title:'天府殷阜',category:'民政',tier:3,row:2,column:0,cost:10,days:52,requires:['focus-irrigation'],
  text:'渠成之后，成都之野，膏壤弥望，水旱从人，不知饥馑。天府之富，庶几复见于今。',
  startSummary:'天府大稔，仓廪、民食并丰。',doneSummary:'仓储充溢，民不知凶年。',
  effects:[{kind:'city-food',cityId:'chengdu',deltaKg:40000},{kind:'treasury',coin:800,corvee:110,manpower:0},{kind:'approval',faction:'commoner',delta:3}]},

 // ── 人事 ────────────────────────────────────────────────
 {id:'focus-recruit',title:'广开荐举',category:'人事',tier:1,row:0,column:0,cost:4,days:15,requires:[],
  text:'察孝廉、举贤才，令郡国各以名上，试以事效。野无遗士，则在位皆知劝勉。',
  startSummary:'诏察孝廉、举贤才，广开荐进之路。',doneSummary:'郡国举士，名上于有司焉。',
  effects:[{kind:'approval',faction:'literati',delta:3},{kind:'prestige',delta:1}]},
 {id:'focus-court-reform',title:'整顿宫府',category:'人事',tier:1,row:0,column:1,cost:5,days:20,requires:[],
  text:'核宫府之籍、省浮冗之费，然后廪禄不滥，出纳有经，岁省之资可佐军国之用。',
  startSummary:'核宫府之籍、省浮冗之费，以清出纳。',doneSummary:'浮冗稍省，府库乃有常储。',
  effects:[{kind:'treasury',coin:250,corvee:0,manpower:0},{kind:'approval',faction:'literati',delta:2}]},
 {id:'focus-merit-assessment',title:'考课殿最',category:'人事',tier:2,row:1,column:0,cost:7,days:32,requires:['focus-recruit','focus-court-reform'],
  text:'令守相各上属吏之殿最，核其功状，勿为虚誉。贤者劝、不肖者惧，吏治日肃。',
  startSummary:'定考课之法，第属吏以殿最。',doneSummary:'殿最有常，吏知劝惧。',
  effects:[{kind:'approval',faction:'literati',delta:3},{kind:'treasury',coin:400,corvee:70,manpower:0},{kind:'prestige',delta:2}]},
 {id:'focus-court-renewal',title:'朝堂一新',category:'人事',tier:3,row:2,column:0,cost:10,days:48,requires:['focus-merit-assessment'],
  text:'考课既行，逾年之后，在位者皆其选也。浮言不作，庶务咸熙，朝廷气象为之一新。',
  startSummary:'在位者各修其职，百度俱举。',doneSummary:'庶绩咸熙，朝野改观。',
  effects:[{kind:'prestige',delta:3},{kind:'approval',faction:'literati',delta:4},{kind:'treasury',coin:500,corvee:90,manpower:40}]},

 // ── 邦交 ────────────────────────────────────────────────
 {id:'focus-wu-alliance',title:'通好东吴',category:'邦交',tier:1,row:0,column:0,cost:6,days:20,requires:[],
  text:'遣使东吴、申盟修好，吴不我图，我得专力以北向。鼎足之势，不可一日无也。',
  startSummary:'遣使东吴、申盟修好，以纾西顾。',doneSummary:'盟好复申，吴使报聘于境。',
  effects:[{kind:'prestige',delta:2},{kind:'note',text:'自通好之后，吴魏之衅复起于淮南。'}]},
 {id:'focus-frontier-fort',title:'严守隘口',category:'邦交',tier:1,row:0,column:1,cost:5,days:30,requires:[],
  text:'修葺剑阁、葭萌之险，因险为垒，储粮缮械。兵不劳而粟不费，可以当千百之敌。',
  startSummary:'发卒修葺剑阁、葭萌之险，且守且积。',doneSummary:'险塞完固，可当北面之冲。',
  effects:[{kind:'city-defense',cityId:'hanzhong',delta:10},{kind:'army-morale',armyId:'army-wei-yan',delta:3}]},
 {id:'focus-wu-mutual',title:'约为唇齿',category:'邦交',tier:2,row:1,column:0,cost:7,days:30,requires:['focus-wu-alliance','focus-frontier-fort'],
  text:'吴与我，唇齿也。约为唇齿，载书申誓，缓急相救，东西相应，则曹氏不敢倾国以向一方。',
  startSummary:'与吴载书申誓，约为唇齿之邦。',doneSummary:'镇静边防，盟好益固。',
  effects:[{kind:'prestige',delta:2},{kind:'treasury',coin:400,corvee:70,manpower:0},{kind:'note',text:'吴使委贽相望于道，魏人疑贰于江外。'}]},
 {id:'focus-wu-shu-pact',title:'吴蜀之盟',category:'邦交',tier:3,row:2,column:0,cost:11,days:55,requires:['focus-wu-mutual'],
  text:'载书再盟，约共击曹氏，画分其地。兄弟之国，世世无相犯，有渝此盟，明神殛之。',
  startSummary:'与吴歃血再盟，约共击曹。',doneSummary:'吴蜀之盟既定，东西并力。',
  effects:[{kind:'prestige',delta:3},{kind:'treasury',coin:650,corvee:100,manpower:0},{kind:'note',text:'二邦并力，曹氏分兵以备，中原骚然。'}]},
];

export function validateFocusState(raw:unknown):void{
 if(raw===undefined||raw===null)return;
 assertShape(raw);
 function assertShape(v:unknown):void{
  const s=v as FocusState;
  if(!s||typeof s!=='object')throw new AgentError('国策层格式无效',500);
  if(s.version!==1)throw new AgentError('不支持的国策层版本',500);
  if(typeof s.points!=='number'||!Number.isFinite(s.points)||s.points<0||s.points>s.pointsCap+1e-9)throw new AgentError('政治点越界',500);
  if(!Number.isFinite(s.pointsPerDay)||!Number.isFinite(s.pointsCap)||s.pointsPerDay<0||s.pointsCap<1)throw new AgentError('政治点累积参数无效',500);
  if(!Array.isArray(s.available)||s.available.length>32)throw new AgentError('国策清单无效',500);
  if(!Array.isArray(s.active)||s.active.length>MAX_ACTIVE_FOCUSES)throw new AgentError('进行中的国策过多',500);
  if(!Array.isArray(s.completed))throw new AgentError('国策完成记录无效',500);
  for(const a of s.active){
   if(typeof a.focusId!=='string'||!Number.isFinite(a.startedDay)||!Number.isFinite(a.endsDay))throw new AgentError('进行中的国策格式无效',500);
   if(a.endsDay<a.startedDay)throw new AgentError('国策结束日早于开始日',500);
  }
 }
}

/** 校验一条国策本身：id、花费、天数、效果都必须在界内。 */
export function validateFocus(raw:unknown):ScenarioFocus{
 const f=raw as ScenarioFocus;
 if(!f||typeof f!=='object')throw new AgentError('国策格式无效',500);
 if(typeof f.id!=='string'||!/^[\w-]{1,80}$/.test(f.id))throw new AgentError('国策编号无效',500);
 if(typeof f.title!=='string'||f.title.length<2||f.title.length>40)throw new AgentError('国策标题应为 2—40 字',500);
 if(typeof f.text!=='string'||f.text.length<8||f.text.length>800)throw new AgentError('国策叙述应为 8—800 字',500);
 if(!FOCUS_CATEGORIES.includes(f.category))throw new AgentError('国策类别无效',500);
 if(![1,2,3].includes(f.tier))throw new AgentError('国策分层只能是 1/2/3',500);
 if(!Number.isInteger(f.row)||!Number.isInteger(f.column)||f.row<0||f.column<0||f.column>3)throw new AgentError('国策树坐标无效',500);
 if(!Array.isArray(f.requires)||f.requires.length>3)throw new AgentError('前置国策最多三项',500);
 if(!Number.isFinite(f.cost)||f.cost<0||f.cost>100)throw new AgentError('国策政治点花费应在 0—100',500);
 if(!Number.isInteger(f.days)||f.days<1||f.days>365)throw new AgentError('国策持续应在 1—365 日',500);
 if(!Array.isArray(f.effects))throw new AgentError('国策效果无效',500);
 for(const e of f.effects)if(!e||typeof e!=='object'||typeof e.kind!=='string')throw new AgentError('国策效果格式无效',500);
 if(typeof f.startSummary!=='string'||f.startSummary.length>500)throw new AgentError('国策起始语无效',500);
 if(typeof f.doneSummary!=='string'||f.doneSummary.length>500)throw new AgentError('国策完成语无效',500);
 return f;
}

/** 组织一国策层：通用清单 + 本局派生（去重、限量）。 */
export function buildFocusState(derived:ScenarioFocus[]=[]):FocusState{
 const seen=new Set<string>(),available:ScenarioFocus[]=[];
 for(const f of [...derived,...GENERIC_FOCUSES]){
  if(seen.has(f.id))continue;
  seen.add(f.id);available.push(validateFocus(f));
 }
 // 前置必须指向更低层：树不能横生枝节（一条 tier2 依赖另一条 tier2 会画出环）
 const known=new Set(available.map(f=>f.id));
 for(const f of available)for(const r of f.requires){
  assert(known.has(r),`前置国策 ${r} 不在清单内`);
  const pre=available.find(x=>x.id===r)!;
  assert(pre.tier<f.tier,`前置 ${pre.title} 必须低于 ${f.title} 一层`);
 }
 // 树序：分支 → 层 → 列。玩家眼里第一屏左边的就是军政的根基。
 const order=new Map(FOCUS_CATEGORIES.map((c,i)=>[c,i]));
 available.sort((a,b)=>((order.get(a.category)??0)-(order.get(b.category)??0))||a.row-b.row||a.column-b.column);
 return {version:1,points:PP_START,pointsPerDay:PP_PER_DAY,pointsCap:PP_CAP,available,active:[],completed:[]};
}

/**
 * 点下一个国策：扣政治点、记入 active。行为与规则：
 *  - 幂等由 commandId 保证（调用方），这里只认当前状态；
 *  - 政治点不够、已在身、同时进行超过三项，都被拒并说清原因；
 *  - 「点了就扣、取消不还」——与 P 社一致，也让政治点稀缺有意义。
 */
export function adoptFocus(state:FocusState,focusId:string,day:number):{state:FocusState;focus:ScenarioFocus}{
 const focus=state.available.find(f=>f.id===focusId);
 if(!focus)assert(false,`没有这个国策：${focusId}`,404);
 if(state.active.some(a=>a.focusId===focusId))assert(false,`国策「${focus.title}」已在进行，不必重复点`,409);
 if(state.completed.includes(focusId))assert(false,`国策「${focus.title}」已经办完`,409);
 const missing=missingFocusPrereqs(state,focusId);
 assert(!missing.length,`前置未办：${missing.map(r=>state.available.find(f=>f.id===r)?.title||r).join('、')}`,409);
 assert(state.active.length<MAX_ACTIVE_FOCUSES,`同时进行不超过 ${MAX_ACTIVE_FOCUSES} 项国策：${state.active.length} 项在进行`,409);
 assert(state.points>=focus.cost,`政治点不足：此策需 ${focus.cost} 点，现有 ${Math.floor(state.points)} 点`,409);
 const next:FocusState={...state,points:round(state.points-focus.cost),active:[...state.active,{focusId,startedDay:round(day),endsDay:round(day+focus.days)}]};
 return {state:next,focus};
}

/** 推进中的国策到日子就完成：回写效果、清 active、记 completed。 */
export function completeFocuses(state:FocusState,day:number):{state:FocusState;done:ScenarioFocus[]}{
 const due=state.active.filter(a=>a.endsDay<=day);
 if(!due.length)return{state,done:[]};
 const byId=new Map(state.available.map(f=>[f.id,f]));
 const done=due.map(a=>byId.get(a.focusId)).filter((f):f is ScenarioFocus=>!!f);
 const doneIds=new Set(done.map(f=>f.id));
 return {state:{...state,active:state.active.filter(a=>!doneIds.has(a.focusId)),completed:[...state.completed,...doneIds]},done};
}

/** 政治点按日累积，受朝政「久不视事」打折；上限截断。 */
export function accruePoints(state:FocusState,days:number,absentDays=0):FocusState{
 if(days<=0)return state;
 // 后宫游猎/久不视事：朝政愈懈，政令愈难出——accumulator 按 absenceDays 折半再折半。
 const damp=absentDays>=30?0.5:1;
 const gained=state.pointsPerDay*days*damp;
 return {...state,points:clamp(round(state.points+gained),0,state.pointsCap)};
}

/**
 * 点数加急（第 7 轮）：政治点封顶后的消费出口——花 1 点缩短 1 日。
 * 只加速**进行中**的国策：已完成的不必、未开始的该走 adoptFocus。单次上限 30 日
 * （防手滑一把梭把几个月的国策瞬间点完，朝望来得太廉价）；加急到 0 日时 endsDay=day，
 * 下一次 completeFocuses 自然结算——不在这里冒充完成，效果兑现仍走同一条流水。
 */
export function expediteFocus(state:FocusState,focusId:string,day:number):{state:FocusState;focus:ScenarioFocus;cost:number;daysCut:number}{
 const focus=state.available.find(f=>f.id===focusId);
 if(!focus)assert(false,`没有这个国策：${focusId}`,404);
 const entry=state.active.find(a=>a.focusId===focusId);
 if(!entry)assert(false,`国策「${focus.title}」不在进行中，无从加急`,409);
 const remaining=Math.max(0,Math.ceil(entry.endsDay-day));
 if(remaining<=0)assert(false,`国策「${focus.title}」今日即成，无需加急`,409);
 const cost=Math.min(Math.floor(state.points),remaining,30);
 if(cost<=0)assert(false,`政治点不足：加急 1 日需 1 点，现有 ${Math.floor(state.points)} 点`,409);
 const active=state.active.map(a=>a.focusId===focusId?{...a,endsDay:round(a.endsDay-cost)}:a);
 return {state:{...state,points:round(state.points-cost),active},focus,cost,daysCut:cost};
}

/** 国策树视图：按四支三层分组，附每项「可点/前置未办/进行中/已办」与缺哪几项。 */
export function focusTree(state:FocusState,day:number){
 const byId=new Map(state.available.map(f=>[f.id,f]));
 const prog=new Map(state.active.map(a=>{
  const span=Math.max(1e-9,a.endsDay-a.startedDay);
  return[a.focusId,{progress:clamp((day-a.startedDay)/span,0,1),remainingDays:Math.max(0,Math.ceil(a.endsDay-day))}];
 }));
 return FOCUS_CATEGORIES.map(category=>({category,tiers:[1,2,3].map(tier=>({tier,
  items:state.available.filter(f=>f.category===category&&f.tier===tier).map(f=>{
   const missing=f.requires.filter(r=>!state.completed.includes(r));
   const p=prog.get(f.id);
   const st=(state.completed.includes(f.id)?'done':p?'active':missing.length?'blocked':'idle') as 'idle'|'blocked'|'active'|'done';
   return{id:f.id,title:f.title,text:f.text,cost:f.cost,days:f.days,tier:f.tier,column:f.column,derived:f.derived,source:f.source,state:st,
    progress:Math.round((p?.progress??0)*100),remainingDays:p?.remainingDays??0,
    missing:missing.map(r=>byId.get(r)?.title||r)};
  })}))}));
}
/** 前置没办齐的有哪几项（按标题回给玩家看）。 */
export function missingFocusPrereqs(state:FocusState,focusId:string):string[]{
 const f=state.available.find(x=>x.id===focusId);if(!f)return [];
 return f.requires.filter(r=>!state.completed.includes(r));
}
export function focusProgress(state:FocusState,day:number):{focus:ScenarioFocus;startedDay:number;endsDay:number;progress:number;remainingDays:number}[]{
 return state.active.map(a=>{
  const focus=state.available.find(f=>f.id===a.focusId)!;
  const span=Math.max(1e-9,a.endsDay-a.startedDay);
  const progress=clamp((day-a.startedDay)/span,0,1);
  return {focus,startedDay:a.startedDay,endsDay:a.endsDay,progress,remainingDays:Math.max(0,Math.ceil(a.endsDay-day))};
 });
}
