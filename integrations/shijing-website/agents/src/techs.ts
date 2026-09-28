import type {WorldSnapshot,Id} from './world-contracts.js';
import {AgentError,assert} from './contracts.js';
import {clamp,round} from './simulation-types.js';
import type {DecisionEffect} from './decisions.js';

/**
 * 科技树 v1（政治 / 军事 / 经济 / 科技 四枝，每枝三层）。
 *
 * 为什么单独一套而不是塞进国策：国策回答「这个国家往哪走」，科技回答「我们会什么」。
 * 前者花政治点、有先后手；后者花科技点、按研究天数逐步推进，且**前置构成树**——
 * 想造霹雳车先得会百炼刀，想立九品中正先得有月旦评。P 社把这两棵树分开也是这个理由：
 * 混在一起玩家就只剩一条线可走。
 *
 * 与本项目其它系统共用三条纪律：
 *  - 效果词汇与决策卡/国策**完全共用**（`applyDecisionEffect`），不另造结算器；
 *  - 幂等、版本锁、校验都在世界层（world-agent.adoptTech），这里只做纯函数；
 *  - 无守恒约束（粮草/人口）的效果不许出现在树里——科技不能凭空变出人。
 */

export type TechCategory='政治'|'军事'|'经济'|'科技';
export const TECH_CATEGORIES:TechCategory[]=['政治','军事','经济','科技'];

export interface Tech {
  id:string;
  title:string;
  category:TechCategory;
  /** 1/2/3，越高越「质变」；前置只能来自更低的层 */
  tier:1|2|3;
  text:string;
  /** 科技点花费 */
  cost:number;
  /** 研究天数 */
  days:number;
  requires:Id[];
  effects:DecisionEffect[];
  source:string;
}

/** 世界快照上的科技层。 */
export interface TechState {
  version:1;
  points:number;
  pointsPerDay:number;
  pointsCap:number;
  /** 本局可研究的清单（通用 24 项 + 议题派生） */
  available:Tech[];
  /** 进行中：同一时刻最多两项 */
  active:{techId:Id;startedDay:number;endsDay:number}[];
  completed:Id[];
}

export const MAX_ACTIVE_TECHS=2;
/** 科技点比政治点慢但别抠门：开局 40 点够点任意一层，之后每日 1 点——
 * 实测 10 点起步时前 25 天一个科技都点不了，玩家以为树是假的。 */
export const TP_START=40;
export const TP_PER_DAY=1;
export const TP_CAP=200;

/** 校验一条科技本身：id/标题/分层/花费/天数/前置都在界内。 */
export function validateTech(raw:unknown):Tech{
 const t=raw as Tech;
 if(!t||typeof t!=='object')throw new AgentError('科技格式无效',500);
 if(typeof t.id!=='string'||!/^[\w-]{1,80}$/.test(t.id))throw new AgentError('科技编号无效',500);
 if(typeof t.title!=='string'||t.title.length<2||t.title.length>12)throw new AgentError('科技标题应为 2—12 字',500);
 if(!TECH_CATEGORIES.includes(t.category))throw new AgentError('科技类别无效',500);
 if(![1,2,3].includes(t.tier))throw new AgentError('科技分层只能是 1/2/3',500);
 if(typeof t.text!=='string'||t.text.length<10||t.text.length>200)throw new AgentError('科技叙述应为 10—200 字',500);
 if(!Number.isInteger(t.cost)||t.cost<5||t.cost>80)throw new AgentError('科技点花费应在 5—80',500);
 if(!Number.isInteger(t.days)||t.days<10||t.days>120)throw new AgentError('研究天数应在 10—120',500);
 if(!Array.isArray(t.requires)||t.requires.length>3)throw new AgentError('前置科技最多三项',500);
 if(!Array.isArray(t.effects)||t.effects.length>3)throw new AgentError('科技效果最多三条',500);
 if(typeof t.source!=='string'||t.source.length>120)throw new AgentError('科技出处无效',500);
 return t;
}

/** 组织科技层：通用清单 + 本局派生，按「类别 → 层 → 表内序」稳定排序。 */
export function buildTechState(derived:Tech[]=[]):TechState{
 const seen=new Set<string>(),available:Tech[]=[];
 for(const t of [...derived,...BASE_TECHS]){
  if(seen.has(t.id))continue;
  seen.add(t.id);available.push(validateTech(t));
 }
 const order=new Map(TECH_CATEGORIES.map((c,i)=>[c,i]));
 available.sort((a,b)=>((order.get(a.category)??0)-(order.get(b.category)??0))||a.tier-b.tier);
 return{version:1,points:TP_START,pointsPerDay:TP_PER_DAY,pointsCap:TP_CAP,available,active:[],completed:[]};
}

/** 前置是否都已完成。未完成返回缺的那几项（说给玩家听）。 */
export function missingPrereqs(state:TechState,techId:string):string[]{
 const t=state.available.find(x=>x.id===techId);if(!t)return [];
 return t.requires.filter(r=>!state.completed.includes(r));
}

export function adoptTech(state:TechState,techId:string,day:number):{state:TechState;tech:Tech}{
 const tech=state.available.find(t=>t.id===techId);
 if(!tech)throw new AgentError(`没有这门技艺：${techId}`,404);
 if(state.completed.includes(techId))throw new AgentError(`「${tech.title}」已经研究完成`,409);
 if(state.active.some(a=>a.techId===techId))throw new AgentError(`「${tech.title}」正在研究中，不必重复立项`,409);
 if(missingPrereqs(state,techId).length)throw new AgentError(`前置未备：${missingPrereqs(state,techId).map(r=>state.available.find(t=>t.id===r)?.title||r).join('、')}`,409);
 assert(state.active.length<MAX_ACTIVE_TECHS,`同时在研不超过 ${MAX_ACTIVE_TECHS} 项：${state.active.length} 项在研`,409);
 assert(state.points>=tech.cost,`科技点不足：此技需 ${tech.cost} 点，现有 ${Math.floor(state.points)} 点`,409);
 const next:TechState={...state,points:round(state.points-tech.cost),active:[...state.active,{techId,startedDay:round(day),endsDay:round(day+tech.days)}]};
 return{state:next,tech};
}

/** 推进到日子就研究完成：兑现效果、出 active、进 completed。 */
export function completeTechs(state:TechState,day:number):{state:TechState;done:Tech[]}{
 const due=state.active.filter(a=>a.endsDay<=day);
 if(!due.length)return{state,done:[]};
 const byId=new Map(state.available.map(t=>[t.id,t]));
 const done=due.map(a=>byId.get(a.techId)).filter((t):t is Tech=>!!t);
 const doneIds=new Set(done.map(t=>t.id));
 return{state:{...state,active:state.active.filter(a=>!doneIds.has(a.techId)),completed:[...state.completed,...doneIds]},done};
}

/**
 * 点数加急（第 7 轮）：与 expediteFocus 同一口径——花 1 科技点缩短 1 日，单次上限 30 日。
 * 科技树买穿后日涨的点数从此有出口；加急到 0 日由下一次 completeTechs 自然结算。
 */
export function expediteTech(state:TechState,techId:string,day:number):{state:TechState;tech:Tech;cost:number;daysCut:number}{
 const tech=state.available.find(t=>t.id===techId);
 if(!tech)assert(false,`没有这门技艺：${techId}`,404);
 const entry=state.active.find(a=>a.techId===techId);
 if(!entry)assert(false,`「${tech.title}」不在研究中，无从加急`,409);
 const remaining=Math.max(0,Math.ceil(entry.endsDay-day));
 if(remaining<=0)assert(false,`「${tech.title}」今日即成，无需加急`,409);
 const cost=Math.min(Math.floor(state.points),remaining,30);
 if(cost<=0)assert(false,`科技点不足：加急 1 日需 1 点，现有 ${Math.floor(state.points)} 点`,409);
 const active=state.active.map(a=>a.techId===techId?{...a,endsDay:round(a.endsDay-cost)}:a);
 return{state:{...state,points:round(state.points-cost),active},tech,cost,daysCut:cost};
}

/** 科技点按日累积，受上限截断。 */
export function accrueTechPoints(state:TechState,days:number):TechState{
 if(days<=0)return state;
 return{...state,points:clamp(round(state.points+state.pointsPerDay*days),0,state.pointsCap)};
}

/** 树形视图：按四枝三层分组，附带每项的「可研/前置未备/在研/已成」状态。 */
export function techTree(state:TechState,day:number):{category:TechCategory;tiers:{tier:number;items:{id:string;title:string;cost:number;days:number;tier:number;text:string;source:string;state:'idle'|'blocked'|'active'|'done';progress:number;remainingDays:number;missing:string[]}[]}[]}[]{
 const byId=new Map(state.available.map(t=>[t.id,t]));
 const progress=new Map(state.active.map(a=>{
  const span=Math.max(1e-9,a.endsDay-a.startedDay);
  return[a.techId,{progress:clamp((day-a.startedDay)/span,0,1),remainingDays:Math.max(0,Math.ceil(a.endsDay-day))}];
 }));
 return TECH_CATEGORIES.map(category=>({category,tiers:[1,2,3].map(tier=>({tier,
   items:state.available.filter(t=>t.category===category&&t.tier===tier).map(t=>{
    const missing=t.requires.filter(r=>!state.completed.includes(r));
    const p=progress.get(t.id);
    const st=(state.completed.includes(t.id)?'done':p?'active':missing.length?'blocked':'idle') as 'idle'|'blocked'|'active'|'done';
    return{id:t.id,title:t.title,cost:t.cost,days:t.days,tier:t.tier,text:t.text,source:t.source,state:st,
     progress:Math.round((p?.progress??0)*100),remainingDays:p?.remainingDays??0,
     missing:missing.map(r=>byId.get(r)?.title||r)};
   })}))}));
}

/** 通用科技树：四枝各 6 项、三层。内容由 `scripts/generate-tech-tree.mjs` 的设计稿誊入。 */
export const BASE_TECHS:Tech[]=[
 // ── 政治 ────────────────────────────────────────────────
 {id:'tech-xinlv',title:'新律',category:'政治',tier:1,cost:25,days:40,requires:[],source:'《晋书·刑法志》',
  text:'魏明帝即位，以汉末律令繁杂，命陈群、刘劭删定科条，作新律十八篇，刑名之旨始粲然大备，为后世律学之所宗。',
  effects:[{kind:'approval',faction:'literati',delta:2},{kind:'prestige',delta:1}]},
 {id:'tech-duguan-kaohe',title:'都官考课',category:'政治',tier:1,cost:20,days:35,requires:[],source:'《三国志·魏书·明帝纪》',
  text:'魏明帝诏刘劭作都官考课七十二法，察群吏之能否，课其殿最而黜陟之，汉家考绩之法至是复明。',
  effects:[{kind:'approval',faction:'literati',delta:2},{kind:'prestige',delta:2}]},
 {id:'tech-yuedanping',title:'月旦评',category:'政治',tier:2,cost:30,days:50,requires:['tech-xinlv'],source:'《后汉书·许劭传》',
  text:'汝南许劭、许靖有鉴裁，每月辄更品题乡人，号曰月旦评，一言所下，人辄信服，由是名士藉兹以进身。',
  effects:[{kind:'approval',faction:'literati',delta:3},{kind:'prestige',delta:2}]},
 {id:'tech-zhihuan',title:'质任',category:'政治',tier:2,cost:25,days:45,requires:['tech-duguan-kaohe'],source:'《三国志·魏书·辛毗传》',
  text:'汉魏之际，诸将所部多异姓之士，朝廷因徙其家属于邺下，谓之质任，所以防携贰也。',
  effects:[{kind:'approval',faction:'imperial',delta:3},{kind:'approval',faction:'military',delta:-2}]},
 {id:'tech-jiupin-zhongzheng',title:'九品中正',category:'政治',tier:3,cost:45,days:70,requires:['tech-yuedanping'],source:'《通典·选举典》',
  text:'延康元年，陈群以乡论淆乱，请立九品官人之法，郡置中正，平次人才之高下，家世德业并计，号为中正品第。',
  effects:[{kind:'approval',faction:'literati',delta:3},{kind:'approval',faction:'commoner',delta:-2},{kind:'prestige',delta:2}]},
 {id:'tech-dudu',title:'都督制',category:'政治',tier:3,cost:50,days:80,requires:['tech-zhihuan'],source:'《晋书·宣帝纪》',
  text:'魏文承汉末方镇之制，置都督诸州军事，假节钺以专征伐，又以质任系其宗族，方面之兵权始一。',
  effects:[{kind:'city-defense',cityId:'bingzhou',delta:10},{kind:'approval',faction:'military',delta:3},{kind:'prestige',delta:2}]},

 // ── 军事 ────────────────────────────────────────────────
 {id:'tech-bailian-dao',title:'百炼刀',category:'军事',tier:1,cost:20,days:35,requires:[],source:'《艺文类聚》引《百辟刀令》',
  text:'魏武有《百辟刀令》，命百炼精钢为刀以试良工；环首长刀，淬以清流，断牛马于顷刻，军旅以为宝器。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:4}]},
 {id:'tech-ruxu-wu',title:'濡须坞',category:'军事',tier:1,cost:25,days:40,requires:[],source:'《三国志·吴书·吴主传》',
  text:'建安中，孙权徙治濡须，夹水立坞以屏魏师；坞壁高峻，楼橹相望，曹公临流叹其齐肃，号为江左锁钥。',
  effects:[{kind:'city-defense',cityId:'jianye',delta:12}]},
 {id:'tech-yuanrong-nu',title:'元戎连弩',category:'军事',tier:2,cost:35,days:55,requires:['tech-bailian-dao'],source:'《三国志·蜀书·诸葛亮传》裴注引《魏氏春秋》',
  text:'蜀人巧于机械，诸葛亮损益连弩，以铁为镞，一弩十矢俱发，军中号为元戎；守隘拒险，魏师惮之。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:4},{kind:'city-defense',cityId:'hanzhong',delta:8}]},
 {id:'tech-mengchong-doujian',title:'蒙冲斗舰',category:'军事',tier:2,cost:30,days:50,requires:['tech-ruxu-wu'],source:'《三国志·吴书·周瑜传》',
  text:'江东水国，舟楫为守，造蒙冲斗舰，覆以牛革，前后左右设弩窗矛穴，冲突横行，北师之舟莫敢当。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:3},{kind:'city-defense',cityId:'jianye',delta:6}]},
 {id:'tech-muniu-liuma',title:'木牛流马',category:'军事',tier:3,cost:55,days:85,requires:['tech-yuanrong-nu'],source:'《三国志·蜀书·诸葛亮传》',
  text:'建兴九年，亮出祁山，以木牛运粮；十二年，复造流马于斜谷。人不大劳而山道赡足，伐魏之饷赖以弗匮。',
  effects:[{kind:'army-food',armyId:'army-wei-yan',deltaKg:20000},{kind:'army-morale',armyId:'army-wei-yan',delta:3}]},
 {id:'tech-pili-che',title:'霹雳车',category:'军事',tier:3,cost:50,days:80,requires:['tech-yuanrong-nu'],source:'《三国志·魏书·武帝纪》',
  text:'官渡之役，袁绍起土山高楼以瞰魏军，太祖乃造发石车，激石如雷，尽碎其楼橹，军中号为霹雳车，攻城之术为之一变。',
  effects:[{kind:'city-defense',cityId:'luoyang',delta:12},{kind:'army-morale',armyId:'army-wei-yan',delta:3}]},

 // ── 经济 ────────────────────────────────────────────────
 {id:'tech-xuxia-tuntian',title:'许下屯田',category:'经济',tier:1,cost:25,days:45,requires:[],source:'《三国志·魏书·武帝纪》',
  text:'建安元年，用枣祗、韩浩等议，始兴屯田许下，募民耕之，岁得谷百万斛；自是州郡例置田官，军国之用稍稍赡。',
  effects:[{kind:'city-food',cityId:'luoyang',deltaKg:15000},{kind:'treasury',coin:150,corvee:0,manpower:0}]},
 {id:'tech-yantie-guanying',title:'盐铁官营',category:'经济',tier:1,cost:30,days:50,requires:[],source:'《三国志·蜀书·王连传》',
  text:'魏置司金中郎将以主鼓铸，蜀置司盐校尉以榷盐井，利归公上，别立军资，不夺于正赋，故魏蜀吴皆沿其制。',
  effects:[{kind:'treasury',coin:300,corvee:-100,manpower:0},{kind:'approval',faction:'commoner',delta:-2}]},
 {id:'tech-dujiangyan-suixiu',title:'都江堰岁修',category:'经济',tier:2,cost:35,days:60,requires:['tech-xuxia-tuntian'],source:'《水经注·江水》',
  text:'蜀人以都江堰为农本，诸葛亮设堰官，岁发丁夫深淘滩、低作堰，分内外二江以灌成都之田，水旱不能为灾。',
  effects:[{kind:'city-food',cityId:'chengdu',deltaKg:15000},{kind:'treasury',coin:100,corvee:-100,manpower:0}]},
 {id:'tech-shujin-guanzhi',title:'蜀锦官织',category:'经济',tier:2,cost:30,days:55,requires:['tech-yantie-guanying'],source:'《太平御览·布帛部》引《诸葛亮集》',
  text:'蜀中机工织锦，号为蜀锦，蜀汉因置锦官以董之，岁出充军资，时人谓决敌之资，唯仰锦耳。',
  effects:[{kind:'treasury',coin:250,corvee:0,manpower:0}]},
 {id:'tech-jinguan-cheng',title:'锦官城',category:'经济',tier:3,cost:45,days:75,requires:['tech-shujin-guanzhi'],source:'《华阳国志·蜀志》',
  text:'成都城南锦官之城，机房相望，机杼之声比户相闻，织工数万计；蜀锦行于吴魏，巴蜀之富，于此为盛。',
  effects:[{kind:'treasury',coin:400,corvee:0,manpower:0},{kind:'prestige',delta:3}]},
 {id:'tech-yoye-tianfu',title:'沃野天府',category:'经济',tier:3,cost:50,days:80,requires:['tech-dujiangyan-suixiu'],source:'《三国志·蜀书·诸葛亮传》',
  text:'堰成之后，成都平原沃野千里，霖不溢潦、旱不涸泽，时号天府；高祖因之以成帝业，蜀汉之粟亦于此取给。',
  effects:[{kind:'city-food',cityId:'chengdu',deltaKg:25000},{kind:'city-food',cityId:'hanzhong',deltaKg:10000},{kind:'approval',faction:'commoner',delta:2}]},

 // ── 科技 ────────────────────────────────────────────────
 {id:'tech-mianfei-san',title:'麻沸散',category:'科技',tier:1,cost:25,days:45,requires:[],source:'《三国志·魏书·方技传》',
  text:'沛国华佗善医，若疾发结于内，针药所不能及，乃先以酒服麻沸散，既醉无所觉，因刳破腹背，抽割积聚。',
  effects:[{kind:'prestige',delta:2},{kind:'approval',faction:'commoner',delta:2}]},
 {id:'tech-qianxiang-li',title:'乾象历',category:'科技',tier:1,cost:25,days:45,requires:[],source:'《三国志·吴书·吴主传》',
  text:'泰山刘洪以月行有迟疾求推交食，作《乾象历》，以浑天说推步七曜；孙吴既定江东，黄武元年改用其法，历事为之一精。',
  effects:[{kind:'prestige',delta:3},{kind:'approval',faction:'literati',delta:2}]},
 {id:'tech-wuqin-xi',title:'五禽戏',category:'科技',tier:2,cost:30,days:50,requires:['tech-mianfei-san'],source:'《三国志·魏书·方技传》',
  text:'佗谓人体欲得劳动，但当使少劳，血脉流通，乃效鹿、虎、熊、猿、鸟之态，名五禽之戏；体中不快，起作一禽之戏，沾濡汗出。',
  effects:[{kind:'army-morale',armyId:'army-wei-yan',delta:3}]},
 {id:'tech-yuexing-chiji',title:'月行迟疾',category:'科技',tier:2,cost:30,days:55,requires:['tech-qianxiang-li'],source:'《晋书·律历志》',
  text:'刘洪知月行本有迟疾，因别立推步之法，转度既审，则晦朔交食可坐而致；自古历家未发之秘，自此乃见。',
  effects:[{kind:'approval',faction:'literati',delta:2},{kind:'prestige',delta:2}]},
 {id:'tech-shanghan-zabing',title:'伤寒杂病',category:'科技',tier:3,cost:45,days:70,requires:['tech-wuqin-xi'],source:'《伤寒论·自序》',
  text:'南阳张机字仲景，建安中宗族死亡者什七，伤寒居其六七，乃勤求古训、博采众方，著《伤寒杂病论》十六卷，后世宗之。',
  effects:[{kind:'prestige',delta:4},{kind:'approval',faction:'commoner',delta:2},{kind:'army-morale',armyId:'army-wei-yan',delta:3}]},
 {id:'tech-jingchu-li',title:'景初历',category:'科技',tier:3,cost:50,days:80,requires:['tech-yuexing-chiji'],source:'《晋书·律历志》',
  text:'魏明帝景初中，杨伟受诏更造新历，较前历之疏密，推日食月食皆得其中，号曰《景初历》；自是正朔可考，官民奉焉。',
  effects:[{kind:'prestige',delta:3},{kind:'approval',faction:'literati',delta:2},{kind:'note',text:'颁正朔于州郡，授时以劝农。'}]},
];
