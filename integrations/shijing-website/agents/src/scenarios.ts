import type {Metric,Spec} from './contracts.js';
import type {Locale} from './content-i18n.js';
import {contentText} from './content-i18n.js';

/**
 * 剧本预设 v1：纯数据，将来可由 MOD 供给。
 *
 * 与 mods.ts 的 scenario 载荷兼容：toRunSpec 的输出就是 validateScenario 认可的形状
 * （{id,title,scenario:{background},cast:[{id,name,role,description}]}，编号同为
 * 小写连字符风格），差异只在 ScenarioPreset 多出的 premise/targetYears/metrics
 * 三字段——MOD 侧不校验未知键，多带不拒、少带则由 toRunSpec 补默认。
 *
 * 史料纪律：人物只取《三国志》可查者，职务取当时可考的称呼；立场、台词与胜负是推演设定，
 * 文案不冒充史实。world-bootstrap 只按「公元 100–300 年 + 三国人物/地名」引导本地十二城世界，
 * 因此每个 background 都必须带足可识别的三国人物与地名——这是能开本地局的技术前提，不是叙事偏好。
 */

export interface ScenarioPreset {
  id:string; title:string; year:number; season:string; faction:string;
  background:string; cast:{id:string;name:string;role:string}[]; metrics:Metric[];
  /** 开局提示：这一局的核心张力是什么 */
  premise:string;
  /** 建议年数 */
  targetYears:number;
}

export const SCENARIOS:ScenarioPreset[]=[
 {
  id:'ziwugu-228',title:'子午谷之议',year:228,season:'春',faction:'蜀汉',
  background:'诸葛亮北伐，魏延请率精兵五千直出子午谷奇袭长安；诸葛亮以为悬危，不如安从坦道，平取陇右。陇西三郡响应，关中震动。汉中粮道千里：兵少不足以守长安，兵多无以供——这一局争的是粮，不是勇。',
  cast:[{id:'zhuge-liang',name:'诸葛亮',role:'蜀汉丞相'},{id:'wei-yan',name:'魏延',role:'蜀汉将领'},{id:'yang-yi',name:'杨仪',role:'蜀汉幕僚'},{id:'jiang-wei',name:'姜维',role:'蜀汉将领'},{id:'fei-yi',name:'费祎',role:'蜀汉文臣'}],
  metrics:[{key:'troops',label:'兵力',start:5000,min:0,max:200000,unit:'人'},{key:'foodKg',label:'粮草',start:60000,min:0,max:2000000,unit:'kg'}],
  premise:'五千奇兵换长安，还是三郡渐收：险与稳，赌的是粮道而不是勇力。',
  targetYears:30,
 },
 {
  id:'guandu-200',title:'官渡拉锯',year:200,season:'preseason',faction:'曹操或袁绍',
  background:'曹操与袁绍相持于官渡，彼众我寡，粮且尽，操书与荀彧议还许。袁绍粮车相望，淳于琼屯乌巢；许攸奔曹，乌巢之火是这一局的枢纽。本地推演沿用十二城样板舆图、蜀执政位不变——本剧本定的是廷议情境与粮草账，史事只约束解释。',
  cast:[{id:'cao-cao',name:'曹操',role:'汉司空'},{id:'yuan-shao',name:'袁绍',role:'冀州之主'},{id:'xun-yu',name:'荀彧',role:'汉尚书令'},{id:'xu-you',name:'许攸',role:'袁绍谋士'},{id:'chun-yu-qiong',name:'淳于琼',role:'乌巢守将'}],
  metrics:[{key:'troops',label:'兵力',start:20000,min:0,max:400000,unit:'人'},{key:'foodKg',label:'粮草',start:30000,min:0,max:2000000,unit:'kg'},{key:'supplyLine',label:'粮道',start:1,min:0,max:3,unit:'条'}],
  premise:'粮尽之前先乱：守住粮道的人活着走出官渡，勇战在此只是账目。',
  targetYears:10,
 },
 {
  id:'chibi-208',title:'赤壁前夕',year:208,season:'冬',faction:'孙权或刘备',
  background:'曹操大军南下，据江陵，顺流东下；刘备新败于当阳，进退未决；孙权拥兵江东，群臣咸言迎曹。孙刘结盟则生，各自为战则亡。赤壁在望，风与火皆不在人算之中。',
  cast:[{id:'liu-bei',name:'刘备',role:'汉左将军'},{id:'zhuge-liang',name:'诸葛亮',role:'刘备军师'},{id:'sun-quan',name:'孙权',role:'江东之主'},{id:'zhou-yu',name:'周瑜',role:'吴军左都督'},{id:'lu-su',name:'鲁肃',role:'赞军校尉'}],
  metrics:[{key:'troops',label:'兵力',start:10000,min:0,max:300000,unit:'人'},{key:'foodKg',label:'粮草',start:20000,min:0,max:2000000,unit:'kg'},{key:'allianceTrust',label:'联盟信任',start:40,min:0,max:100,unit:'分'}],
  premise:'联盟谈得成，仗才打得起来：这一局先定外交，再定水火。',
  targetYears:10,
 },
 {
  id:'baidi-223',title:'白帝托孤',year:223,season:'春',faction:'蜀汉',
  background:'刘备病笃于白帝，召诸葛亮与尚书令李严属以后事，嗣君刘禅冲幼。南中未平，孙吴之好新结，蜀汉的内政与军府俱托于丞相一人。成都方定，而国库空虚。',
  cast:[{id:'liu-bei',name:'刘备',role:'蜀汉先主'},{id:'zhuge-liang',name:'诸葛亮',role:'蜀汉丞相'},{id:'liu-shan',name:'刘禅',role:'蜀汉嗣君'},{id:'li-yan',name:'李严',role:'蜀汉尚书令'},{id:'zhao-yun',name:'赵云',role:'蜀汉宿将'}],
  metrics:[{key:'troops',label:'兵力',start:30000,min:0,max:200000,unit:'人'},{key:'foodKg',label:'粮草',start:40000,min:0,max:2000000,unit:'kg'},{key:'regency',label:'摄政权重',start:50,min:0,max:100,unit:'分'}],
  premise:'受托之后先安内还是先攘外：冲幼的嗣君、未平的南中、初结的吴盟。',
  targetYears:20,
 },
];

export function scenario(id:string):ScenarioPreset|null{return SCENARIOS.find(s=>s.id===id)||null;}
/** 这一局**实际**会跑到第几年。剧本卡面写 30 年、引擎单局上限只到 10 年（day 3650，
 *  见 world-bootstrap 的 goalYears 与 jump 的 MAX_JUMP_DAYS）时，卡面必须显示夹紧后的值，
 *  否则玩家看着「30 年」开局、终局却宣布「10 年之期已满」，自相矛盾（QA 实测 B5）。
 *  口径与 world-bootstrap.goalYears 逐字一致：min(targetYears, floor(3650/365))。 */
export function effectiveYears(s:ScenarioPreset):number{
 const years=Number.isFinite(s.targetYears)&&s.targetYears>0?s.targetYears:10;
 return Math.min(years,10);
}
export function scenarioSummary(s:ScenarioPreset):string[]{return [`年代：公元${s.year}年${s.season}`,`阵营：${s.faction}`,`人物：${s.cast.map(c=>c.name).join('、')}`,`建议年数：${effectiveYears(s)} 年`,s.premise];}

/**
 * 转成 contracts.ts 的 Spec。metrics 置空是硬约束：buildInitialWorld 拒绝带指标的 spec
 * （world.metrics 已非空即视为「上游已初始化世界」），而本地十二城世界自带粮草兵力账——
 * 预设指标只供选局界面预览与将来接入引擎时作初值，塞进 Spec 反而会让本地局开不起来。
 */
export function toRunSpec(s:ScenarioPreset):Spec{
 // season 只有是四季之一才进 background：clock.startLabel 靠它拼「公元某年春」，preseason 之类不进正文
 const season=['春','夏','秋','冬'].includes(s.season)?s.season+'。':'。';
 return {id:s.id,title:s.title,scenario:{background:`公元${s.year}年${season}${s.background}\n开局张力：${s.premise}`},cast:s.cast.map(c=>({id:c.id,name:c.name,role:c.role,description:`${s.title}中的${c.role}。立场与行动尚未推演。`})),metrics:[]};
}

/**
 * 内容层双语取值入口（v1）：走 content-i18n 表，英文缺失回落中文，未知 id（MOD 剧本）
 * 回落数据原值——玩家永远看不到 key 或空串。上面 toRunSpec 等内部用法保持中文不变。
 */
export function scenarioTitle(s:ScenarioPreset,locale:Locale):string{return contentText(`scenario.${s.id}.title`,locale,s.title);}
export function scenarioBackground(s:ScenarioPreset,locale:Locale):string{return contentText(`scenario.${s.id}.background`,locale,s.background);}
export function scenarioPremise(s:ScenarioPreset,locale:Locale):string{return contentText(`scenario.${s.id}.premise`,locale,s.premise);}

/**
 * 这个 spec 能不能挂上**本地战役推演**（buildInitialWorld 的最终准入判据）。
 *
 * 为什么放在这个零依赖的叶子模块里、而不是让 UI 去 import world-bootstrap：
 * ① 单一事实来源——选局面板要在卡面上标「可战役推演 / 问对与阅览」，和引擎必须是同一份判据，
 *    否则引擎哪天收紧门槛，标注就会骗人；
 * ② world-bootstrap 拉着一整张服务端图（省/政治/外交/国库/锚点……），客户端 import 它会把
 *    打包体撑大数倍、甚至把 SSR 拖崩（实测 chunk 从几十 KB 涨到 700KB+）。
 * 判据本身不依赖任何运行时：年份 + 题目正则。
 *
 * 注意这是**最终**判据；buildInitialWorld 在此之前还有几道门（100—300 年、三国口径与地名、
 * spec.id 形状、世界未被上游初始化）。对随包剧本预设而言前面几道恒过，所以 UI 直接用它即可；
 * 真要逐字复刻全部门，请跑 buildInitialWorld 本身。
 */
export function specSupportsSimulation(spec:{title:string;scenario:{background:string}}):boolean{
 const topic=spec.title+' '+spec.scenario.background;
 const year=Number(spec.scenario.background.match(/公元\s*(\d+)\s*年/)?.[1]);
 // 227—235：锚点库（228—234）的容差，同史事期内跨年开局仍成立。
 // 蜀汉/北伐口径：世界摆位、玩家恒执蜀都按建兴六年校准，别把魏延塞进官渡或赤壁。
 return year>=227&&year<=235&&/蜀|汉|北伐|祁山|子午谷|五丈原|诸葛亮|魏延|姜维|蒋琬|费祎|杨仪|赵云|马岱|王平/.test(topic);
}

/** 剧本预设版的同一判据（拿 toRunSpec 的真实 spec 问，年份/口径都在组合后的正文里）。 */
export function scenarioHasSimulation(s:ScenarioPreset):boolean{return specSupportsSimulation(toRunSpec(s));}
