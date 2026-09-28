import {seedSimulation} from './simulation-state.js';
import type {Run} from './contracts.js';
import type {InitialWorldInput,WorldSnapshot} from './world-contracts.js';
import type {DecisionEvent} from './decisions.js';
import {validateWorld} from './world-state.js';
import {buildProvinces,PROVINCE_SEEDS} from './province.js';
import {eventsForScenario,DECISION_EVENTS} from './decisions.js';
import {seedPolitics} from './politics.js';
import {seedDiplomacy} from './diplomacy.js';
import {seedFiscal} from './treasury.js';
import {HISTORY_ANCHORS} from './anchors.js';
import {buildFocusState} from './focuses.js';
import {buildTechState} from './techs.js';
import {fallbackFocuses} from './focus-derive.js';
import {scenario} from './scenarios.js';

export const initialBasis = '北伐本地推演 v1（实验性模拟）：兵力、库存、居民、路程及所有系数为可追溯的模拟设定，尚未完成历史案例校准；史料仅约束场景解释。粮草单位为公斤粮食当量；详情与事件记录以当前结算为准。初始场景没有已发生的战果。';
/** BUG-108：无推演独立局的如实 basisNote——本局没有战役推演，别让玩家以为魏延那套世界在跑。 */
export const readingRoomBasis = '独立议题（无本地推演）：本地推演暂只支持随包的三国剧本（蜀汉北伐口径）。本局可看人物、故事板与史实时间线；兵力粮草等战役推演未启用。';
/** 引擎单局可推进的天数上限。与 jump.ts 的 MAX_JUMP_DAYS 同值——targetDay 是**绝对日**，
 *  超过它 jumpToDay 直接拒绝（`目标日应在 1—3650 之间`）。所以终局年数绝不能超过它，
 *  否则门槛永远达不到（原实现直接把剧本 targetYears 当门槛，子午谷 30 年 = 10950 日 > 3650，
 *  于是「一局有终局」实际上仍然到不了终局）。 */
const MAX_GAME_DAYS=3650;
/** 剧本建议年数，但受引擎单局上限约束。非内置剧本退回 10（=3650/365，引擎天花板），
 *  别让自建议题顶着一个永远达不到的年数。 */
function goalYears(run:Run):number{
 const preset=scenario(run.spec.id);
 const years=preset&&Number.isFinite(preset.targetYears)&&preset.targetYears>0?preset.targetYears:10;
 return Math.min(years,Math.floor(MAX_GAME_DAYS/365));
}
/** 这一局的核心张力，收尾时回显。拿不到剧本就用题目兜底，别回显空句。 */
function premiseOf(run:Run):string{
 const preset=scenario(run.spec.id);
 return preset?.premise?.trim()||run.spec.title;
}
/**
 * BUG-108：无推演独立世界（「阅览室」）。年份或阵营口径与随包北伐剧本不合的 spec
 * （官渡、赤壁……）不再硬套魏延那套世界，而是落一个**只有时间与史实时间线**的最小
 * 快照：无军队、无城池、无推演层——军令/跳转/国策等入口全部被「未启用本地规则」诚实
 * 挡下，人物、故事板与按年份派生的史实时间线照常可用。绝不把魏延塞进官渡。
 */
function buildReadingRoomWorld(run:Run,year:number):InitialWorldInput{
 const season=run.spec.scenario.background.match(/年\s*([春夏秋冬])/)?.[1]||'';
 const w:WorldSnapshot={schemaVersion:'world-state/v1',worldId:run.id,scenarioId:run.spec.id,mapId:'event-map-v1',revision:0,
  clock:{startLabel:`公元${year}年${season}`,elapsedDays:0},factions:{},cities:{},armies:{},actions:{},decisions:{}};
 // 锚点先落空数组：projectStrategy 用 w.anchors 判时间线来源，undefined 会回落 228 预设——
 // 那又是在拿北伐的史事冒充别年代；置空则显示「本局不设史实时间线」，LLM 派生随后异步补。
 w.startYear=year;w.anchors=[];
 validateWorld(w);
 return {initializationId:'reading-room-local-v1',snapshot:w,basis:{kind:'mixed',note:readingRoomBasis}};
}

/** A scoped, explicit scenario preset, not a historical inference or an engine snapshot. */
export function buildInitialWorld(run:Run):InitialWorldInput|null {
 const topic=run.spec.title+' '+run.spec.scenario.background;
 const year=Number(run.spec.scenario.background.match(/公元\s*(\d+)\s*年/)?.[1]);
 if(run.mode!=='standalone'||run.world.version!==0||run.world.day!==0||run.engineTurn!==0||run.spec.metrics.length||Object.keys(run.world.metrics).length)return null;
 // 泛化：任何「公元1-3世纪 + 三国人物/势力/地名」组合都可引导本地世界；
 // 预设数值仍以北伐为核心样例，军队与城市按参战名单落位。
 const threeKingdoms=/蜀|汉|魏|吴|晋|诸侯|讨逆|群雄/.test(topic)||/诸葛亮|魏延|杨仪|姜维|费祎|赵云|马谡|王平|马岱|廖化|张嶷|蒋琬|董允|李严|司马懿|曹真|张郃|郭淮|曹叡|曹睿|孙尚香|黄月英|蔡文姬|张春华|刘备|曹操|孙权|周瑜|鲁肃|张昭|吕蒙|陆逊|张辽|李典|乐进|关羽|张飞|吕布|貂蝉|董卓|袁绍|刘表|孙策|太史慈|甘宁|黄盖|程普|韩当|庞统|法正|徐庶|马超|黄忠/.test(topic);
 const knownPlace=/汉中|长安|成都|洛阳|荆州|建业|合肥|赤壁|宛城|襄阳|江陵|街亭|五丈原|祁山|下邳|官渡|樊城|南郡|江州|梓潼/.test(topic);
 if(!Number.isInteger(year)||year<100||year>300||!(threeKingdoms&&(knownPlace||/北伐|子午谷/.test(topic))))return null;
 // Non-canonical old spec ids are left for explicit upstream initialization.
 if(!/^[\w-]{1,120}$/.test(run.spec.id))return null;
 // BUG-108 诚实守门：捆绑的本地推演只有一套「随包的蜀汉北伐剧本」——世界摆位（魏延部
 // 出汉中、十二城蜀魏吴鼎立）、锚点库（228—234）与决策卡全按建兴六年校准，且玩家恒执蜀。
 // spec 只有在**起始年份**与**阵营口径**都与这套设定相容时才附加 simulation：
 // ① 年份落在 227—235（锚点窗口的容差，同史事期内跨年开局仍成立）；
 // ② 题目以蜀汉/北伐为玩家方（诸葛亮、魏延、北伐、祁山……）。
 // 官渡（200 年曹袁相争）、赤壁（208 年孙刘对曹）这类议题硬挂上去，玩家会看到魏延替
 // 曹操打仗——它们走无推演的独立模式：人物/故事板/时间线照常，战役推演诚实缺席。
 const compatible=year>=227&&year<=235&&/蜀|汉|北伐|祁山|子午谷|五丈原|诸葛亮|魏延|姜维|蒋琬|费祎|杨仪|赵云|马岱|王平/.test(topic);
 if(!compatible)return buildReadingRoomWorld(run,year);
 const point=(x:number,y:number)=>({x:(x-436)/1172,y:(y-143)/662});
 // 城池坐标就是舆图区（x∈[436,1608]、y∈[143,805]）的像素位，与 public/strategy/map-world.svg
 // 的 world-terrain.png 逐点对齐——底稿换成别的图时这两个数必须一起改，否则城池会浮在水上。
 // 落点按真实地物校对过：长安在渭水河谷（秦岭北麓）、汉中在秦岭与大巴山之间的盆地、
 // 成都在四川盆地中心、洛阳在黄河折弯东侧太行以西、建业在长江下游近湖、交州在最南。
 const places:[string,string,number,number,string][]=[['hanzhong','汉中',764,507,'shu'],['changan','长安',846,415,'wei'],['chengdu','成都',635,673,'shu'],['luoyang','洛阳',1081,395,'wei'],['liangzhou','凉州',553,262,'wei'],['bingzhou','并州',1045,262,'wei'],['youzhou','幽州',1280,222,'wei'],['xuzhou','徐州',1303,421,'wei'],['jianye','建业',1352,527,'wu'],['jingzhou','荆州',1081,620,'wu'],['kuaiji','会稽',1467,620,'wu'],['jiaozhou','交州',1139,752,'wu']];
 const owners:Record<string,string>={'蜀':'shu','蜀汉':'shu','魏':'wei','曹魏':'wei','吴':'wu','孙吴':'wu'};
 if(Object.entries(run.world.cities).some(([name,owner])=>!places.some(p=>p[1]===name)||!owners[owner]))return null;
 const w:WorldSnapshot={schemaVersion:'world-state/v1',worldId:run.id,scenarioId:run.spec.id,mapId:'event-map-v1',revision:0,clock:{startLabel:`公元${year}年${run.spec.scenario.background.match(/年\s*([春夏秋冬])/)?.[1]||''}`,elapsedDays:0},factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'},wu:{id:'wu',name:'吴',color:'#3b638f'}},cities:{},armies:{},actions:{},decisions:{}};
 for(const [id,name,x,y,faction] of places){const ownerFactionId=owners[run.world.cities[name]]||faction;w.cities[id]={id,name,kind:'city',point:point(x,y),ownerFactionId,governor:{id:'governor-'+id,name:name+'守将（模拟）'},foodKg:id==='hanzhong'?60000:id==='changan'?50000:20000,defense:id==='changan'?80:70};
 // 汉中 60000 而不是 30000：携粮上限提到 120t 后，出发载重 = min(上限, 兵携 60000 + 城存)。
 // 城存 30000 时载重仍被压在 90000 —— 半路上就得断粮。60000 让「带足粮出发」真成立。
 // 配合省产 6041kg/日、城内日耗 2800kg，汉中仍是净流出方，没有因此变舒服。
  const isHanzhong=id==='hanzhong';const armyId=isHanzhong?'army-wei-yan':'army-'+id;
  // 魏延部出发携粮 120000 = 新的携粮上限（simulation-state 的 capacityKg）。旧值 60000
  // 只够 10 天，而 240km 全程需约 14 天——capacityKg 提上去却不在出发时装满，等于白提
  // （实测 d10 粮就归零，卡在 km154）。城内日耗 2800、省产 6041，汉中净流入，撑得住。
  w.armies[armyId]={id:armyId,name:isHanzhong?'魏延部':name+'守军',factionId:ownerFactionId,commander:isHanzhong?{id:'wei-yan',name:'魏延'}:{id:'governor-'+id,name:name+'守将（模拟）'},troops:isHanzhong?5000:3000,foodKg:isHanzhong?120000:12000,morale:isHanzhong?80:70,location:{kind:'city',cityId:id},status:'stationed'};
 }
 // Conflicting existing ownership must not silently place Wei Yan into an enemy faction.
 if(w.cities.hanzhong.ownerFactionId!=='shu')return null;
 // 省层：12 城各自为一省治所。产出底数是模拟设定，加成% 由经济层接入。
 w.provinces=buildProvinces(PROVINCE_SEEDS,()=>'守将（模拟）');
 for(const p of Object.values(w.provinces))p.ownerFactionId=w.cities[p.seatCityId].ownerFactionId;
 w.politics=seedPolitics();
 // 外交种子：蜀吴同盟抗魏，魏与两家交兵。**条约要真落一条**：只把 stance 写成
 // allied 而 treaties 为空，玩家一点「遣使结盟」就会听到「盟约成交」——开局已是盟友，
 // 这话是假的（实测）。formAlliance 的「同盟条约已在身」守卫也因此形同虚设。
 w.diplomacy=seedDiplomacy(Object.keys(w.factions),0,{
  'shu->wu':{attitude:40,trust:20,stance:'allied'},'wu->shu':{attitude:40,trust:20,stance:'allied'},
  'shu->wei':{attitude:-40,trust:-60,stance:'war'},'wei->shu':{attitude:-40,trust:-60,stance:'war'},
  'wu->wei':{attitude:-30,trust:-40,stance:'war'},'wei->wu':{attitude:-30,trust:-40,stance:'war'},
 });
 const openingAlliance:NonNullable<NonNullable<WorldSnapshot['diplomacy']>['relations'][number]['treaties']>=[
  {id:'treaty-alliance-shu-wu-opening',kind:'alliance',sinceDay:0,untilDay:null,breached:false}];
 for(const r of w.diplomacy.relations)if(r.stance==='allied'&&!r.treaties.length)r.treaties=openingAlliance.map(t=>({...t,id:t.id+'-'+r.fromFactionId+'-'+r.toFactionId}));
 w.fiscal=seedFiscal();
 // 国策层：政治点 + 可点的国家议程。先按议题关键词兜底一份，LLM 派生在 bootstrapRunInTransaction
 // 里异步补（那里才拿得到 run 与 provider）。**开局就得有得点**，所以同步先落地。
 w.focuses=buildFocusState(fallbackFocuses(run.spec.title+' '+run.spec.scenario.background));
 // 科技层开局就全开放（24 项通用），前置锁住高层——玩家不必先找齐前置才知道有什么。
 w.techs=buildTechState();
 // 史实时间线跟着剧本年份走：228 年（含）前后那几年才用预设的 36 条北伐锚点；
 // 别的年代（官渡 200、赤壁 208…）预设一条都不适用——先在快照上落成「本局时间线」，
 // LLM 派生在 bootstrapRunInTransaction 里异步补（那里拿得到 run 与 provider）。
 // 派生不出来的局就是没有史实新闻，**绝不拿 228 年的史事冒充别的年代**。
 w.startYear=Number.isFinite(year)?year:undefined;
 const seasonOfStart=run.spec.scenario.background.match(/年\s*([春夏秋冬])/)?.[1]||'春';
 // 只留「开局之后」的：起始季不是春时，同年早季的事是往事，不能当未来新闻报。
 const SEASON_BASE:Record<string,number>={春:0,夏:91,秋:182,冬:273};
 const startDay=Math.max(0,(year-228)*364+(SEASON_BASE[seasonOfStart]||0));
 w.anchors=(()=>{
  if(!Number.isFinite(year))return HISTORY_ANCHORS.filter(a=>a.day>=0);
  const preset=HISTORY_ANCHORS.filter(a=>a.year>=year&&a.year<=year+6&&a.day>=startDay);
  return preset.length?preset:[];
 })();
 w.simulation=seedSimulation(w);
 // 开局归属：城池层会随作战改变，「初始国力」要的是**开局**那几座。史官此前按记事时点的
 // 当前归属数城池（实测打下半壁江山后，起居注写「初始国力：城池 6 座」），所以在这里落档。
 w.openingCities=Object.values(w.cities).filter(c=>c.ownerFactionId===(w.simulation?.playerFactionId||'shu')).map(c=>c.id);
 const opener:DecisionEvent|undefined=eventsForScenario(DECISION_EVENTS,Number.isFinite(year)?year:undefined,seasonOfStart)[0];
 if(opener)w.pendingDecision={eventId:opener.id,day:opener.day};
 // 剧本题目的终局条件：让「一局」有明确边界。没有它，worldVerdict 只剩统一/覆灭两条判据，
 // 本剧本实测三种打法都到不了——玩家玩到「推不动」为止，从未见过收尾。
 w.scenarioGoal={years:goalYears(run),premise:premiseOf(run)};
 // 开局给 run 压一条指路消息。不指路的后果很实在：新玩家点开议题只看到一张地图和
 // 一排面板，不知道桌上有张决策卡等着裁、也不知道能在输入框里直接打字下令——
 // 试玩反馈的原话是「玩不起来」。这条消息是世界的一部分，所以放在引擎侧而不是前端。
 validateWorld(w);
 return {initializationId:'northern-expedition-local-v2',snapshot:w,basis:{kind:'mixed',note:initialBasis}};
}
