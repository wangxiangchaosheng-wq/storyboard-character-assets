import type {WorldSnapshot,WorldEvent} from '../agents/src/world-contracts.js';

/**
 * 成就系统 v1：从世界快照与事件流水**推导**，不另记一套成就账本。
 *
 * 为什么这样设计：一局发生了什么都在 world_events 流水里（史官七条铁律第一条就是
 * 「只许引用流水里真实发生的事」）。成就若单开一本账，就会出现「账上解锁了、流水里
 * 查无此事」的纠纷，也没法回放复盘。所以本模块是纯函数：同一份（world, events）
 * 输入，任何时候、任何机器上跑出来的解锁集合都一致——可单测、可复现、可回放。
 *
 * 阈值全部收敛为文件顶部的显式常量：它们是模拟设定而非史实，改阈值必须连注释一起改，
 * 免得半年后没人记得 500 是怎么来的。判定规则逐条写在 RULES 表里，规则与成就一一对应，
 * 测试保证没有「写了成就忘了写规则」的漏网之鱼。
 */

/** 档位：铜=入门几乎必然，银=需要认真经营，金=一局难得。隐藏项只放「做坏了也算成就」的趣味成就。 */
export type AchievementTier='bronze'|'silver'|'gold';
export interface Achievement{id:string;name:string;description:string;tier:AchievementTier;hidden?:boolean}
export interface AchievementProgress{id:string;unlocked:boolean;progress:number;unlockedAt?:number}

/* ---- 阈值：模拟设定，非史实。改这里必须连注释一起改。 ---- */
const SUPPLY_LINE_KG=500;     // 断粮线：兵丁日食 1 kg（treasury.ts 同口径），500 kg 即 500 人日口粮，跌破此线部队事实上已断粮
const SURPLUS_KG=500000;      // 一省结余线：省农业底数约 210 万 kg/年（province.ts 种子），50 万 kg 约合三个月净积余
const TUNTIAN_KG=300000;      // 屯田见效线：屯田省治所积粮三十万斤才说得上「见效」，否则只是挂了个模式槽
const TREASURY_LINE=10000;    // 国库过万线：军饷 0.02 币/人/日，一万币约合 50 万军饷日，是小有积蓄的门槛
const LOYAL_LINE=90;          // 忠诚满：忠诚向 50 均衡回归（politics.ts），90 是「满」的实用口径；取 100 等于不可能
const EUNUCH_LINE=40;         // 宦官坐大：开局 15，零和搬到 40 即近半话语权，朝堂失衡
const HEGEMONY_LINE=99;       // 霸名满百：霸名夹紧在 100（diplomacy.ts），99 容忍 JSON 往返的浮点尾差
const ABSENCE_YEAR=365;       // 后宫游猎满一年：一年 365 天，与 economy.ts DAYS_PER_YEAR 同口径
const CHRONICLE_LINES=100;    // 史官记满：流水 100 条即「国史盈室」
const THIRTY_YEARS_DAYS=10950;// 一局三十年：30×365，与 onboarding 的 targetYears:30 呼应
const VETERAN_RUNS=5;         // 五局老将：跨局累计只能由宿主经 stats 传入，成就模块自己不另记账

/**
 * 成就清单：Steam 后台 API 名（id）与 achievements.json 必须一一对应，测试守着这条不变式。
 * id 遵守 Steam 命名规范 `^[a-z0-9_]{1,64}$`——小写字母、数字、下划线，别的字符 Steamworks 不收。
 */
export const ACHIEVEMENTS:Achievement[]=[
 /* 首局类：每个「第一次」都值得记——新手第一步跨过去，才算真正开局 */
 {id:'first_run_complete',name:'完成一局',description:'城池归一，打完第一局推演',tier:'bronze'},
 /* 终局类：第 4 轮试玩实测「剧本胜利（城池过半）零成就」——胜利本身值得一枚金章。
  * 与 world-state.ts worldVerdict 的 scenario-complete 判据同口径，不另立终局标准 */
 {id:'campaign_victory',name:'北伐功成',description:'城池过半，北伐之势已成',tier:'gold'},
 {id:'first_year_jump',name:'一年之跳',description:'第一次一次性跳转满一年',tier:'bronze'},
 {id:'first_edict',name:'初次请旨',description:'第一次亲自拍板一项决策',tier:'bronze'},
 /* 军事类 */
 {id:'capture_first_city',name:'攻克一城',description:'第一次从敌手手中夺下一座城',tier:'bronze'},
 {id:'cut_enemy_supply',name:'断敌粮道',description:'把一支敌军的粮草削到断粮线以下',tier:'silver'},
 {id:'outnumbered_victory',name:'以少胜多',description:'以更少的兵力歼灭一支敌军',tier:'gold'},
 {id:'bloodless_capture',name:'不损一兵',description:'一兵不损地夺下一座城',tier:'gold'},
 {id:'annihilate_army',name:'覆没一军',description:'成建制歼灭一支敌军',tier:'silver'},
 /* 经济类 */
 {id:'treasury_10k',name:'国库过万',description:'国库积钱超过一万',tier:'silver'},
 {id:'province_surplus',name:'一省结余',description:'一省治所积粮达到结余线',tier:'silver'},
 {id:'tuntian_effective',name:'屯田见效',description:'屯田之省治所积粮达到见效线',tier:'bronze'},
 /* 政治类 */
 {id:'all_factions_loyal',name:'六派归心',description:'六派忠诚全部达到满格线',tier:'gold'},
 {id:'no_one_angry',name:'无人愤怒',description:'六派无一派的认可跌到愤怒线',tier:'silver'},
 {id:'eunuch_dominance',name:'宦官坐大',description:'宦官势力膨胀到失衡——做坏了也算成就',tier:'bronze',hidden:true},
 /* 外交类 */
 {id:'alliance_formed',name:'缔结同盟',description:'与任一势力结成同盟',tier:'bronze'},
 {id:'treaty_breached',name:'撕毁条约',description:'背弃一条已签的条约——霸名也是名',tier:'bronze'},
 {id:'hegemony_100',name:'霸名满百',description:'霸名积到顶格',tier:'gold'},
 /* 计策类 */
 {id:'fire_attack',name:'火攻得手',description:'火攻之计当真烧到了敌军',tier:'silver'},
 {id:'empty_fort',name:'空城退敌',description:'空城计成，敌军疑而不进，一兵未损',tier:'gold'},
 {id:'sow_discord',name:'离间成功',description:'离间之计当真乱了敌军',tier:'silver'},
 /* 趣味类 */
 {id:'harem_year',name:'后宫之年',description:'后宫游猎满一年而国未亡',tier:'gold',hidden:true},
 {id:'historian_100',name:'国史盈室',description:'一局的事件流水记满一百条',tier:'bronze'},
 /* 耐力类 */
 {id:'thirty_years',name:'三十之年',description:'一局推演推进三十年',tier:'gold'},
 /* 跨局累计：数字由宿主经 stats 传入 */
 {id:'veteran_five_runs',name:'五局老将',description:'累计完成五局推演',tier:'silver'},
];

/* ---- 一次扫描，全部规则共用：同一份流水只走一遍，24 条规则读同一份结论 ---- */
interface Capture{day:number;settlementId:string}
interface Destroy{day:number;settlementId:string;troopsBefore:number}
interface Scan{
  playerId:string;world:WorldSnapshot;day:number;
  captures:Capture[];destroys:Destroy[];
  /** 每个结算内己方兵力净损失：同一次结算的多条事件合计，防「拆成两条就查不出损失」 */
  lossBySettlement:Map<string,number>;
  /** 每个结算内敌军是否遭实创（兵力下降/粮草被夺/士气受挫/成建制覆没） */
  pressureBySettlement:Set<string>;
  supplyCutDay:number|null;fireDay:number|null;emptyFortDay:number|null;discordDay:number|null;
  jumpDays:number;jumpDay:number|null;edictDay:number|null;
  unified:boolean;playerWon:boolean;
  /** 第 4 轮：剧本终局（城池过半）胜利——worldVerdict scenario-complete 同口径 */
  campaignWon:boolean;campaignDay:number;
  /** 己方兵力下限：取流水里所有己方兵力前值与现况的最小值——「以少」的少，保守才不漏判 */
  playerMinTroops:number|null;
  coin:number;seatFood:number;tuntianFood:number;
  minLoyalty:number;eunuchClout:number;
  hegemony:number;absenceDays:number;eventCount:number;runs:number;chronicle100Day:number|null;
}
function scan(input:{world:WorldSnapshot;events:WorldEvent[];stats?:Record<string,number>}):Scan{
  const world=input.world;
  // 排序只排副本：入参一个字节都不动；按 revision+id 定序保证与调用方传入顺序无关
  const events=[...(input.events??[])].sort((a,b)=>a.revision-b.revision||(a.id<b.id?-1:a.id>b.id?1:0));
  const playerId=world.simulation?.playerFactionId??Object.keys(world.factions)[0]??'';
  const day=world.clock?.elapsedDays??0;
  const lossBySettlement=new Map<string,number>(),pressureBySettlement=new Set<string>();
  const captures:Capture[]=[],destroys:Destroy[]=[];
  let supplyCutDay:number|null=null,fireDay:number|null=null,emptyFortDay:number|null=null,discordDay:number|null=null;
  let jumpDays=0,jumpDay:number|null=null,edictDay:number|null=null;
  // 「玩家亲手拍板/下达」的判定（first_edict 用）：只认能在事件里认出是玩家拍的 decision，
  // 不认任何事件。三条腿，按证据强度排：
  //  ① 事件挂了 decisionId：查**决策簿**里这道令的 issuerId——簿记 player 才是玩家亲决
  //     （本地局每道军令都落 decisions[]，玩家的令记 'player'，AI 大臣代决记 'ai-marshal'/
  //     'local-defender'，后者不算）。簿里查不到时（旧存档、例行代决被淘汰）按来源兜底：
  //     外部裁判（referee/demo）转述的带 decisionId 事件是玩家决策；本地 rules 源的不认领
  //     ——本地局连自然事件的 source 都是 'rules'，认了就等于「任何事件」，成就就贬值了。
  //  ② 事件没挂 decisionId（commitLocal 只给 order 挂）：本地局玩家裁决决策卡的回执
  //     summary 以【决策】起头（world-agent.decide 的固定格式），这是「亲手裁决」的凭据。
  //  ③ AI 代决天然进不来：jump/advance 里太尉代决的事件 decisionId 为 null、回执是
  //     【已行】/【未行】，①②两条正面条件一条都不匹配，无需另设黑名单。
  const isPlayerEdict=(e:WorldEvent):boolean=>{
   if(e.decisionId){
    const issuer=world.decisions[e.decisionId]?.issuerId;
    if(issuer!==undefined)return issuer==='player';
    return e.source==='referee'||e.source==='demo';
   }
   return /(^|\n)【决策】/.test(`${e.title}\n${e.summary}`);
  };
  const addLoss=(sid:string,n:number)=>lossBySettlement.set(sid,(lossBySettlement.get(sid)??0)+n);
  for(const e of events){
    const sid=e.settlementId||e.id,text=`${e.title}\n${e.summary}`;
    if(e.toDay-e.fromDay>jumpDays){jumpDays=e.toDay-e.fromDay;jumpDay=e.toDay;}
    if(edictDay===null&&isPlayerEdict(e))edictDay=e.toDay;
    let enemyHit=false;
    for(const c of e.changes){
      const type=c.entity.type,id=c.entity.id;
      const before=typeof c.before==='number'?c.before:null,after=typeof c.after==='number'?c.after:null;
      const army=type==='army'?world.armies[id]:undefined,faction=army?.factionId;
      if(type==='city'&&c.field==='ownerFactionId'&&c.after===playerId&&c.before!==c.after)captures.push({day:e.toDay,settlementId:sid});
      if(army&&c.field==='troops'&&before!==null&&after!==null&&after<before){if(faction===playerId)addLoss(sid,before-after);else enemyHit=true;}
      if(army&&c.field==='foodKg'&&faction!==playerId&&before!==null&&after!==null&&after<before){
        enemyHit=true;
        // 断敌粮道的代理指标：EntityRef 没有 shipment 类型，战役层「粮队被截」进不了 FieldChange，
        // 而「敌军粮草跌破断粮线」在账目上与断粮道等价且可复现，故以此为准
        if(after<SUPPLY_LINE_KG&&supplyCutDay===null)supplyCutDay=e.toDay;
      }
      if(army&&c.field==='morale'&&faction!==playerId&&before!==null&&after!==null&&after<before)enemyHit=true;
      if(army&&c.field==='status'&&c.after==='destroyed'&&c.before!=='destroyed'&&faction!==playerId){
        enemyHit=true;
        const tb=e.changes.find(x=>x.entity.id===id&&x.field==='troops');
        const troopsBefore=tb&&typeof tb.before==='number'?tb.before:world.armies[id]?.troops??0;
        destroys.push({day:e.toDay,settlementId:sid,troopsBefore});
      }
    }
    if(enemyHit)pressureBySettlement.add(sid);
    const noLoss=(lossBySettlement.get(sid)??0)<=0;
    // 计策类成就靠事件标题关键词：计策由 AI 提议、以决策形式执行，流水里只有标题摘要承载计策名，
    // 故「关键词 + 同结算敌军受创/己方零损」双条件，防止标题党白拿成就
    if(/火攻|火烧|火计/.test(text)&&pressureBySettlement.has(sid)&&fireDay===null)fireDay=e.toDay;
    if(/空城/.test(text)&&noLoss&&emptyFortDay===null)emptyFortDay=e.toDay;
    if(/离间|反间/.test(text)&&pressureBySettlement.has(sid)&&discordDay===null)discordDay=e.toDay;
  }
  const cities=Object.values(world.cities);
  const owners=[...new Set(cities.map(c=>c.ownerFactionId))];
  const unified=cities.length>0&&owners.length===1;
  const pol=world.politics,dip=world.diplomacy,factions=pol?Object.values(pol.factions):[];
  const ownProvinces=Object.values(world.provinces??{}).filter(p=>p.ownerFactionId===playerId);
  const seatFoodKg=(mode:string|null)=>Math.max(0,...ownProvinces.filter(p=>!mode||p.mode===mode).map(p=>world.cities[p.seatCityId]?.foodKg??0));
  const playerTroops=[...Object.values(world.armies).filter(a=>a.factionId===playerId&&a.troops>0).map(a=>a.troops)];
  return {
    playerId,world,day,captures,destroys,lossBySettlement,pressureBySettlement,
    supplyCutDay,fireDay,emptyFortDay,discordDay,jumpDays,jumpDay,edictDay,
    unified,playerWon:unified&&owners[0]===playerId,
    campaignWon:!!world.scenarioGoal&&cities.length>0&&owners.length>1&&cities.filter(c=>c.ownerFactionId===playerId).length*2>=cities.length,
    campaignDay:captures.length?captures[captures.length-1].day:day,
    playerMinTroops:playerTroops.length?Math.min(...playerTroops):null,
    coin:world.fiscal?.treasury?.coin??0,
    seatFood:seatFoodKg(null),tuntianFood:seatFoodKg('colonize'),
    minLoyalty:factions.length?Math.min(...factions.map(f=>f.loyalty)):0,
    eunuchClout:pol?.factions?.eunuch?.clout??0,
    hegemony:dip?.hegemony??0,absenceDays:pol?.absenceDays??0,
    eventCount:events.length,runs:input.stats?.runs_completed??0,
    chronicle100Day:events.length>=CHRONICLE_LINES?events[CHRONICLE_LINES-1].toDay:null,
  };
}

interface Verdict{unlocked:boolean;progress:number;unlockedAt?:number}
/** unlockedAt 记**推演日号**不记墙钟：纯函数没有时钟，同一份流水必须复现同一个解锁时刻。 */
const V=(unlocked:boolean,progress:number,unlockedAt?:number):Verdict=>({unlocked,progress:Math.round(Math.max(0,Math.min(1,progress))*1e6)/1e6,...(unlocked&&unlockedAt!==undefined?{unlockedAt}:{})});
/** 布尔型判定：解锁即 100%。不变式「unlocked ⟺ progress===1」由测试把守，复合条件差一口气时进度封顶 99%。 */
const B=(unlocked:boolean,unlockedAt?:number):Verdict=>V(unlocked,unlocked?1:0,unlockedAt);
const pct=(n:number,d:number)=>d>0?Math.max(0,Math.min(1,n/d)):0;
type Rule=(s:Scan)=>Verdict;

const RULES:Record<string,Rule>={
 /* 城池归一即一局终局：与 world-state.ts worldVerdict 的 v0 判据同口径，不另立终局标准 */
 first_run_complete:s=>B(s.unified,s.day),
 /* 北伐功成：城池过半即剧本胜利（worldVerdict「scenario-complete」同口径）；解锁日取最后一次夺城之日 */
 campaign_victory:s=>B(s.campaignWon,s.campaignDay),
 /* 单次跳转满 365 天：取流水里最大的单次跳跃；跳两次半年不算，要的是一口气一年 */
 first_year_jump:s=>V(s.jumpDays>=365,pct(s.jumpDays,365),s.jumpDay??undefined),
 first_edict:s=>B(s.edictDay!==null,s.edictDay??undefined),
 /* 攻克一城：城池 ownerFactionId 变为己方即夺城（world-state.ts 的 city.capture 落点） */
 capture_first_city:s=>V(s.captures.length>0,pct(s.captures.length,1),s.captures[0]?.day),
 cut_enemy_supply:s=>B(s.supplyCutDay!==null,s.supplyCutDay??undefined),
 /* 以少胜多：同结算内敌军成建制覆没，且己方兵力下限仍低于敌军战前兵力——兵力取该结算
  * 变更记录的前值，无记录则取世界现况（同输入必然同结果，仍是纯函数）。已歼敌但兵力不占优
  * 算半个进度：仗是赢了，赢得不漂亮 */
 outnumbered_victory:s=>{
  const mine=s.playerMinTroops;
  const hit=s.destroys.find(d=>mine!==null&&mine<d.troopsBefore);
  return V(!!hit,hit?1:s.destroys.length?0.5:0,hit?.day);
 },
 /* 不损一兵取城：夺城结算内己方兵力零损失；围城久战伤亡惨重的不算 */
 bloodless_capture:s=>{
  const hit=s.captures.find(c=>(s.lossBySettlement.get(c.settlementId)??0)<=0);
  return V(!!hit,hit?1:s.captures.length?0.5:0,hit?.day);
 },
 annihilate_army:s=>V(s.destroys.length>0,pct(s.destroys.length,1),s.destroys[0]?.day),
 treasury_10k:s=>V(s.coin>=TREASURY_LINE,pct(s.coin,TREASURY_LINE),s.day),
 /* 一省结余以治所库存衡量：粮食直接结余到治所 foodKg（economy.ts accrueProvinceFood），
  * 库存厚即结余实；此处不复制经济层产出公式，避免两处账本对不上 */
 province_surplus:s=>V(s.seatFood>=SURPLUS_KG,pct(s.seatFood,SURPLUS_KG),s.day),
 tuntian_effective:s=>V(s.tuntianFood>=TUNTIAN_KG,pct(s.tuntianFood,TUNTIAN_KG),s.day),
 all_factions_loyal:s=>V(s.minLoyalty>=LOYAL_LINE,pct(s.minLoyalty,LOYAL_LINE),s.day),
 /* 无人愤怒：认可 <= -10 即愤怒（politics.ts ANGRY_AT）；进度按「几派人没翻脸」折算——
  * 六派里一派愤怒就锁着，玩家一眼看出还差谁 */
 no_one_angry:s=>{
  const list=s.world.politics?Object.values(s.world.politics.factions):[];
  const calm=list.filter(f=>f.approval>-10).length;
  return V(list.length>0&&calm===list.length,pct(calm,Math.max(1,list.length)),s.day);
 },
 eunuch_dominance:s=>V(s.eunuchClout>=EUNUCH_LINE,pct(s.eunuchClout,EUNUCH_LINE),s.day),
 /* 同盟：立场为同盟，或存在未撕毁的同盟条约——签了又撕的不算数 */
 alliance_formed:s=>B(!!s.world.diplomacy?.relations.some(r=>r.stance==='allied'||r.treaties.some(t=>t.kind==='alliance'&&!t.breached)),s.day),
 treaty_breached:s=>B(!!s.world.diplomacy?.relations.some(r=>r.treaties.some(t=>t.breached)),s.day),
 hegemony_100:s=>V(s.hegemony>=HEGEMONY_LINE,pct(s.hegemony,HEGEMONY_LINE),s.day),
 fire_attack:s=>B(s.fireDay!==null,s.fireDay??undefined),
 empty_fort:s=>B(s.emptyFortDay!==null,s.emptyFortDay??undefined),
 sow_discord:s=>B(s.discordDay!==null,s.discordDay??undefined),
 /* 后宫之年：缺席天数只在「后宫游猎」状态累加（politics.ts applyAbsence），满 365 日即游猎
  * 满一年；「还不亡国」按终局判定的反面理解——未归一，或归一者正是陛下。差这口气时进度
  * 封顶 99%：满一年的进度是满的，卡住的是「国还没亡」 */
 harem_year:s=>{const ok=s.absenceDays>=ABSENCE_YEAR&&(!s.unified||s.playerWon);return V(ok,ok?1:Math.min(0.99,pct(s.absenceDays,ABSENCE_YEAR)),s.day);},
 historian_100:s=>V(s.eventCount>=CHRONICLE_LINES,pct(s.eventCount,CHRONICLE_LINES),s.chronicle100Day??s.day),
 thirty_years:s=>V(s.day>=THIRTY_YEARS_DAYS,pct(s.day,THIRTY_YEARS_DAYS),s.day),
 veteran_five_runs:s=>V(s.runs>=VETERAN_RUNS,pct(s.runs,VETERAN_RUNS),s.day),
};

/** 纯函数：给定世界快照与事件流水算出全部成就进度。不修改入参、不抛随机、无时钟依赖。 */
export function evaluateAchievements(input:{world:WorldSnapshot;events:WorldEvent[];stats?:Record<string,number>}):AchievementProgress[]{
  const s=scan(input);
  return ACHIEVEMENTS.map(a=>{
    const rule=RULES[a.id];
    if(!rule)throw new Error(`成就 ${a.id} 缺少判定规则：新增成就必须同时补齐 RULES`);
    const v=rule(s);
    return {id:a.id,unlocked:v.unlocked,progress:v.progress,...(v.unlockedAt!==undefined?{unlockedAt:v.unlockedAt}:{})};
  });
}

const TIER_LABEL:Record<AchievementTier,string>={bronze:'铜',silver:'银',gold:'金'};
/** 一行一式：已解锁的报「第几日解锁」，有进度的报百分比，隐藏成就未解锁时不剧透描述。 */
export function achievementSummary(progress:AchievementProgress[]):string[]{
  const byId=new Map(ACHIEVEMENTS.map(a=>[a.id,a]));
  return progress.filter(p=>p.unlocked||p.progress>0).map(p=>{
    const a=byId.get(p.id);
    if(!a)return `${p.id}（未知成就）`;
    const head=`【${TIER_LABEL[a.tier]}】${a.name}`;
    // UX-103：unlockedAt 是浮点推演日，照抄进 summary 就会出现「第 1197.0015… 日解锁」。
    // 全站「第 N 日」的口径是 floor+1（SaveSlotsPanel、诏令到军同此），这里同口径取整。
    if(p.unlocked)return `${head} · ${a.description}（第 ${p.unlockedAt===undefined||p.unlockedAt===null?'?':Math.floor(p.unlockedAt)+1} 日解锁）`;
    return a.hidden?`${head} · 隐藏成就（${Math.round(p.progress*100)}%）`:`${head} · ${a.description}（${Math.round(p.progress*100)}%）`;
  });
}
