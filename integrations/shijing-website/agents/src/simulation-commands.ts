import {assert,AgentError} from './contracts.js';
import type {WorldSnapshot} from './world-contracts.js';
import type {SimulationCommand,AdvanceCommand,OrderKind} from './simulation-types.js';
/**
 * BUG-101：解析失败时回给玩家的**确定性**帮助文案（语法层与模型兜底层共用一份口径）。
 * 模型译不出时说过什么只能进日志——把幻觉叙事当 400 错误喂给玩家，玩家会读到一场
 * 没发生过的假仗；所以错误通道里只许出现这份文案，一个字都不来自模型。
 */
export const LOCAL_COMMAND_HELP='本地指令无法识别。当前支持的军令语法：魏延 行军 长安；魏延 急行军 长安；魏延 进攻 长安；魏延 围困 长安；魏延 撤退 汉中；魏延 休整；魏延 补给 汉中 10000；推进 1 天。也可整句托付方略，如「先取长安，三年不出斜谷」。讨论或假设不会执行。';

/**
 * UX-111：语法层的**确定性拒绝**与「没听懂」必须分开。
 * 「舆图上没有「X」这座城」「每次推进1—2160小时」是听懂了、这件事不合理——第 4 轮
 * 专做的友好文案却被 command-understanding 的无差别 catch 吞掉，再花 7-25 秒问模型、
 * 最后回一句通用帮助，玩家永远见不到专属文案。这类拒绝原样抛给玩家，不落模型路径；
 * 只有「没听懂」（LOCAL_COMMAND_HELP）才许问模型。
 * 必须是 AgentError 的子类：否则 server 的兜底 mapping 会把它当系统故障回 500，
 * 「魏延 进攻 潼关」就又变成一个装作内部错误的吓人故障。
 */
export class GrammarRejection extends AgentError {constructor(message:string){super(message,400);this.name='GrammarRejection';}}
/** 语法层确定性拒绝的识别通道：understandLocalCommand 只放行这一类直接到玩家眼前。 */
export const isGrammarRejection=(e:unknown):e is GrammarRejection=>e instanceof GrammarRejection;
/** 语法层的确定性拒绝（友好文案直达玩家，不问模型）。 */
const reject=(message:string):never=>{throw new GrammarRejection(message);};

/**
 * 第四轮自然语普查（playtest-20260927-agent-rounds.md 第三节）的动词归一词表：
 * 90 条口语只有 8.9% 能过窄语法，其中攻击/行军/围困/撤退同义换词 34 条全部 400——
 * 玩家最高频的说法先在语法层收编（零延迟零花费、可离线、可单测），LLM 兜底只管长尾。
 * 规范动词自己也以恒等键占位：否则「撤退」里的「退」会被单字键改写成「撤撤退」。
 */
 const VERB_SYNONYMS:Record<string,string>={
 // 规范动词恒等键（长词优先消费，防内字误改写）
 '进攻':'进攻','行军':'行军','急行军':'急行军','围困':'围困','撤退':'撤退','驻守':'驻守','休整':'休整','补给':'补给','探索':'探索',
 // → 进攻（应支持#1/#2：「打/攻打/去打」是普查中最高频的攻击说法）
 '去打':'进攻','攻打':'进攻','攻击':'进攻','攻取':'进攻','攻占':'进攻','夺取':'进攻','收复':'进攻','袭取':'进攻','直取':'进攻','拿下':'进攻','出击':'进攻','袭击':'进攻','偷袭':'进攻','打':'进攻','袭':'进攻','击':'进攻',
 // → 急行军（可支持：奔袭=快速行军，疲劳门槛沿用既有校验）
 '奔袭':'急行军','急进':'急行军',
 // → 行军（可支持顺手做：移师/进驻/开拔/挺进/调往）
 '移师':'行军','进驻':'行军','开拔':'行军','挺进':'行军','开往':'行军','调往':'行军','调去':'行军','去往':'行军','进发':'行军',
 // → 围困（应支持#4：围了/围住/包围/围攻，「围X了」语序由同词表吸收）
 '围了':'围困','围住':'围困','包围':'围困','围攻':'围困','围':'围困',
 // → 撤退（应支持#3：退守/撤回/回撤/退往/撤往/回师；「撤吧」的语气词在缀词层剥）
 '撤回':'撤退','退守':'撤退','回撤':'撤退','退往':'撤退','撤往':'撤退','回师':'撤退','撤离':'撤退','撤军':'撤退','退军':'撤退','撤':'撤退','退':'撤退',
 // → 补给（应支持#5：补粮/送粮/运粮/押送/拨粮）
 '补粮':'补给','送粮':'补给','运粮':'补给','押送':'补给','拨粮':'补给','补':'补给',
 // → 驻守/休整（应支持#4：原地待命/按兵不动/停下休整/就地驻防）
 '原地待命':'休整','按兵不动':'休整','停下休整':'休整','就地驻防':'驻守','就地驻扎':'驻守','待命':'休整','驻防':'驻守','驻扎':'驻守',
 // → 探索（BUG-121 新词表：派细作/探查/侦察/巡边 归入探索）
 '派细作':'探索','细作':'探索','探查':'探索','侦察':'探索','搜索':'探索','探一探':'探索','巡边':'探索','探明':'探索','摸清':'探索','窥探':'探索',
 };
/** 单字动词常被吸进双字词里（「撤退」「奔袭」），替换必须长词优先。 */
const VERB_RE=new RegExp(`(${Object.keys(VERB_SYNONYMS).sort((a,b)=>b.length-a.length).join('|')})`,'g');

/** 中文数字 → 阿拉伯数字（普查#5/#6：五千/一万/三十 一律 400）。支持到万段；非数字返回 0。 */
function cnNum(text:string):number{
 const D:Record<string,number>={'零':0,'〇':0,'一':1,'二':2,'两':2,'三':3,'四':4,'五':5,'六':6,'七':7,'八':8,'九':9};
 const U:Record<string,number>={'十':10,'百':100,'千':1000,'万':10000};
 let result=0,section=0,digit=-1;
 for(const ch of text){
  if(ch in D)digit=digit<0?D[ch]:digit*10+D[ch];
  else if(ch in U){
   const u=U[ch];
   if(u===10000){section=(section+Math.max(digit,0))*u;result+=section;section=0;digit=-1;}
   else{section+=(digit<0?1:digit)*u;digit=-1;}
  }else return 0;
 }
 return result+section+Math.max(digit,0);
}

/** 普查归一：中文数字→阿拉伯数字；斤→公斤（×0.5 取整，普查#5 明确要求换算）；动词同义词→规范动词。 */
function normalize(raw:string):string{
 let line=raw.trim().replace(/[。！!]+$/,'').replace(/[ \t\u3000]+/g,' ');
 line=line.replace(/[零〇一二两三四五六七八九十百千万]+/g,m=>{const n=cnNum(m);return n>0?String(n):m;});
 line=line.replace(/(\d+(?:\.\d+)?)\s*斤/g,(_,n:string)=>`${Math.round(Number(n)*.5)}公斤`);
 return line.replace(VERB_RE,m=>VERB_SYNONYMS[m]);
}

/**
 * 第 7 轮粜粮语法：「成都 粜粮 五万」「粜粮 50000」「粜粮济民」——城粮出口的口语入口。
 * 粜粮是内政动作不是军令（不需要 armyId），所以不走 parseLocalCommand 的军令语法，
 * 单独一套匹配；返回 null 表示这不是粜粮句（调用方继续走模型/方针路径）。
 */
export function parseSellGrain(w:WorldSnapshot,text:string):{cityId:string;amountKg:number}|null{
 const line=normalize(text);
 if(!/粜|卖粮|开仓/.test(line))return null;
 const own=Object.values(w.cities).filter(c=>c.ownerFactionId===w.simulation!.playerFactionId);
 if(!own.length)return null;
 // 城名：句中点到的己方城；缺省取库存最大的一座（与军令补给 defaultSource 同思路）。
 const named=own.filter(c=>line.includes(c.name)).sort((a,b)=>b.foodKg-a.foodKg)[0];
 const city=named??own.sort((a,b)=>b.foodKg-a.foodKg)[0];
 // 数量：normalize 已把中文数字归一；「5万」这种阿拉伯+万再乘一次；缺省 5 万公斤。
 let amount=50000;
 const wan=line.match(/(\d+(?:\.\d+)?)\s*万/);
 const plain=line.match(/(\d+(?:\.\d+)?)(?!\s*万)/);
 if(wan)amount=Number(wan[1])*10000;
 else if(plain)amount=Number(plain[1]);
 return {cityId:city.id,amountKg:Math.min(1000000,Math.max(10000,Math.round(amount)))};
}

/** Deliberately bounded grammar: free discussion never becomes a numerical settlement. */
export function parseLocalCommand(w:WorldSnapshot,text:string,commandId:string):{kind:'order';input:SimulationCommand}|{kind:'advance';input:AdvanceCommand}{
 const s=w.simulation;assert(s,'当前议题没有可用的本地战役');const help=LOCAL_COMMAND_HELP;
 const line=normalize(text);
 const mine=Object.values(w.armies).filter(a=>a.factionId===s.playerFactionId&&s.activeArmyIds.includes(a.id));
 // 时间变体（应支持#6）：单位扩到 旬=10日、月=30日、周=7日；「休整五日」这类无主语说法也归推进。
 // 边界在本层就拦：过/等 一类口语动词此前只在模型路径有 1—2160 门槛，语法收编后必须同门槛。
 const time=line.match(/^(?:推进|继续推演|推演|前进|休整|等待|等|过了?|再过)\s*(\d+)\s*(?:个)?(小时|天|日|旬|月|周|星期)(?:\s|$)/);
 if(time){const hours=Number(time[1])*(time[2]==='小时'?1:time[2]==='旬'?240:time[2]==='月'?720:time[2]==='周'||time[2]=='星期'?168:24);
  // UX-111：限额是**确定性拒绝**（听懂了、这件事不合理），直接抛给玩家——
  // 从前它被 understandLocalCommand 的无差别 catch 吞掉去问模型，玩家永远看不到这句。
  if(hours<1||hours>2160)reject('每次推进1—2160小时（90天）');
  return{kind:'advance',input:{commandId,expectedRevision:w.revision,hours}};}
 const armyAlt=Array.from(new Set(mine.flatMap(a=>[a.name,a.commander.name]))).sort((a,b)=>b.length-a.length).join('|');
 const cityAlt=Object.values(w.cities).map(c=>c.name).sort((a,b)=>b.length-a.length).join('|');
 const resupply=(armyId:string,sourceCityId:string,foodKg?:number)=>({kind:'order' as const,input:{commandId,expectedRevision:w.revision,armyId,kind:'resupply' as const,sourceCityId,...(foodKg?{foodKg}:{})}});
 // 发粮城缺省：部队在路上/围在敌城下时，先取「与驻地可通的那条路」己方端有粮的城——
 // 一律按最大粮仓选（成都）时，补给令会因「没有可执行的运输路线」被打回：实测满仓
 // 12 万公斤就在后方躺着，在途/围城部队却收不到一粒（第 5 轮卡点 1）。其余照旧：
 // 驻地己方城优先，否则同阵营库存最大的城——supply() 会再做路线/库存全量校验。
 const defaultSource=(armyId:string)=>{const m0=s.armies[armyId],factionId=w.armies[armyId].factionId;
  const anchor=m0?.roadId??(m0?.atCityId&&w.cities[m0.atCityId].ownerFactionId!==factionId
   ?Object.values(s.roads).find(r=>r.open&&(r.from===m0.atCityId||r.to===m0.atCityId))?.id:undefined);
  if(anchor){
   const rd=s.roads[anchor],ends=[rd.from,rd.to].filter(id=>w.cities[id]?.ownerFactionId===factionId&&w.cities[id].foodKg>0);
   if(ends.length)return ends.sort((x,y)=>w.cities[y].foodKg-w.cities[x].foodKg)[0];
  }
  const at=m0?.atCityId;
  if(at&&w.cities[at]?.ownerFactionId===factionId)return at;
  return Object.values(w.cities).filter(c=>c.ownerFactionId===factionId).sort((x,y)=>y.foodKg-x.foodKg)[0]?.id;};
 // 应支持#5 的口语语序（普查原文）：「拨粮一万给魏延部」量在前对象在后；
 // 「汉中 送 5000 粮到魏延部」「汉中 补给 魏延部 5000」「粮草送到魏延军中」城在句首。
 const amtFirst=line.match(new RegExp(`^(?:补给|拨|调|送|运)?\\s*(\\d+(?:\\.\\d+)?)\\s*(?:公斤)?(?:的)?(?:粮|粮草)?\\s*(?:给|到|送)(?:给)?(${armyAlt})(?:部|军|军中)?$`));
 const cityFirst=line.match(new RegExp(`^(${cityAlt})?\\s*(?:的)?(?:粮草|粮|军粮)?\\s*(?:补给|送|运|拨|押送)\\s*(?:(\\d+(?:\\.\\d+)?)\\s*(?:公斤)?\\s*(?:的)?(?:粮|粮草)?)?\\s*(?:到|给|往|去)?\\s*(${armyAlt})(?:部|军|军中)?\\s*(?:(\\d+(?:\\.\\d+)?)\\s*(?:公斤)?)?$`));
 if(amtFirst&&mine.length){const army0=mine.find(a=>a.name===amtFirst[2]||a.commander.name===amtFirst[2])??mine[0];const src=defaultSource(army0.id);assert(src,help);return resupply(army0.id,src,amtFirst[1]?Number(amtFirst[1]):undefined);}
 // 有军队对象即认（「粮草送到魏延军中」三者皆缺省也要接住）；armyAlt 为空串时不得误吞。
 if(cityFirst&&cityFirst[3]&&mine.length){const army0=mine.find(a=>a.name===cityFirst[3]||a.commander.name===cityFirst[3])??mine[0];
  const srcCity=cityFirst[1]?Object.values(w.cities).find(c=>c.name===cityFirst[1]):undefined;
  const src=srcCity?.id??defaultSource(army0.id);assert(src&&w.cities[src],help);const kg=Number(cityFirst[2]||cityFirst[4])||undefined;return resupply(army0.id,src,kg);}
 // 应支持#9（前缀剥离）：「命令魏延进攻长安」「让魏延打洛阳」「把魏延调去洛阳」——剥掉敬语/使役
 // 前缀就是窄语法。无主语但句首是动词（「攻取洛阳」「休整」「撤军」）或点名「全军」时，
 // 默认第一支本方军队——与模型兜底层的 pickArmy 同口径（应支持#2/#4）。
 const stripped=line.replace(/^(?:请|让|令|命令|叫|派|使|着|给|把|和|与)\s*/,'');
 const named=mine.find(a=>stripped.startsWith(a.name)||stripped.startsWith(a.commander.name));
 const army=named??((stripped.startsWith('全军')||/^(?:行军|急行军|进攻|围困|撤退|驻守|休整|补给|探索)/.test(stripped))?mine[0]:undefined);
 assert(army,help);
 const prefix=named?(stripped.startsWith(named.name)?named.name:named.commander.name):stripped.startsWith('全军')?'全军':'';
 let rest=(prefix?stripped.slice(prefix.length):stripped).trim();
 // 口语衬字与尾缀：「魏延去打洛阳」的「去」、「魏延他们撤吧」的「他们/吧」、行军尾缀时长
 //（行军速度由道路/粮草决定，时长本就不入令，普查#9 尾缀容错）。
 rest=rest.replace(/^(?:去|来|给我|与我|马上|立即|即刻|现在)\s*/,'').replace(/^(?:他们|部队|们|部|军|营)+/,'')
  .replace(/[吧了呢啊呀哦嘛]+$/,'').replace(/\s*\d+\s*(?:个)?(?:小时|天|日|旬|月|周|星期)\s*$/,'')
  .replace(/[,，]\s*(?:目标|方向|往|向)\s*/,'').trim();
 // 「补粮五千公斤」「补给 2500 公斤粮」：量直接跟在动词后、不给城名——发粮城缺省按驻地/最大粮仓。
 const amtOnly=rest.match(/^补给\s*(\d+(?:\.\d+)?)?\s*(?:公斤)?\s*(?:的)?(?:粮|粮草)?$/);
 if(amtOnly){const src=defaultSource(army.id);assert(src,help);return resupply(army.id,src,amtOnly[1]?Number(amtOnly[1]):undefined);}
 const found=rest.match(/^(行军|急行军|进攻|围困|撤退|驻守|休整|补给|探索)\s*([^\s]*)\s*(\d+(?:\.\d+)?)?$/);assert(found,help);
 const map:Record<string,OrderKind>={行军:'march',急行军:'forced-march',进攻:'attack',围困:'besiege',撤退:'retreat',驻守:'garrison',休整:'garrison',补给:'resupply',探索:'explore'};
 // 目标名剥掉指路衬字：「撤退到长安去」「进攻向洛阳」的名词部分才是城名。剥完还带标点
 // 或过长的不是地名而是半句话（「长安城，勿伤百姓」）——那属于「没听懂」，该落模型，
 // 而不是甩一句「舆图上没有「长安城，勿伤百姓」这座城」。
 // BUG-121 探索口语兜底：「探查长安虚实」「侦察子午谷动向」类说法 strip 掉「虚实/动向/底细」等尾缀，
 // 提取前面的城名再匹配——否则「长安虚实」会被当成错城名直接 reject。
 const rawSpot=(found[2]||'').replace(/^(?:到|往|向|入|去|回)/,'').replace(/(?:去|来|了|吧|呢)$/,'');
 const spot=rawSpot.replace(/(?:的)?(?:虚实|动向|底细|兵力|布防|详情|状况|情况|情形)$/,'');
 const looksLikePlace=spot.length>0&&spot.length<=6&&!/[，。！？、；：,.;:!?\s]/.test(spot);
 const kind=map[found[1]],city=Object.values(w.cities).find(c=>c.name===spot);
 if(kind==='garrison')assert(!found[2]&&!found[3],help);
 else if(kind==='resupply'&&(!found[2]||/^\d+(?:\.\d+)?$/.test(found[2]))){
  // 「补给 5000」「补给」：数量（或缺省）直接跟在动词后——发粮城缺省按驻地/最大粮仓（普查#5）。
  const src=defaultSource(army.id);assert(src,help);
  return resupply(army.id,src,found[2]?Number(found[2]):Number(found[3])||undefined);
 }
 // 撤退不点目的地是合法口语（下方默认最近己方城），其余动词必须给一座舆图上的城；
 // 给了名字却查不到就明说「没有这座城」（可支持档：潼关一类地名不再混进「无法识别」）。
 // BUG-122：探索必须指明目标城——「巡边」「魏延巡边」无目标时若落模型要白等 8-63 秒
 // （实测），且模型也答不出一座没名字的城。这里确定性拒绝并给出正确句式。
 else if(kind==='explore'&&!spot){
  reject(`探索需指明目标城池，如「魏延 探索 长安」或「探查长安虚实」；可用城名：${Object.values(w.cities).map(c=>c.name).join('、')}`);
 }
 else if(!(kind==='retreat'&&!found[2])){
  // UX-111/BUG-120：给了地名却查不到城 = 听懂了、这件事不合理（确定性拒绝，不问模型直达玩家）。
  if(spot&&!city&&looksLikePlace)reject(`舆图上没有「${spot}」这座城；可用城名：${Object.values(w.cities).map(c=>c.name).join('、')}`);
  // 动词配了目标但目标不存在也不点城市——确定性拒绝，不走模型白等。
  if(spot&&!city)reject(`舆图上没有「${spot}」这座城；可用城名：${Object.values(w.cities).map(c=>c.name).join('、')}`);
  assert(city,help);
 }
 if(kind!=='resupply')assert(!found[3],help);
 // 「撤军」「魏延他们撤吧」：不点目的地=退往最近的己方城池（应支持#3）；无路可退才回帮助文案。
 let retreatTarget:string|undefined;
 if(kind==='retreat'&&!city){
  const m0=s.armies[army.id];let bestDays=Infinity;
  for(const x of Object.values(s.roads)){
   if(!x.open)continue;
   const startsHere=m0.roadId?x.id===m0.roadId:(m0.atCityId!==null&&(x.from===m0.atCityId||x.to===m0.atCityId));
   if(!startsHere)continue;
   const candidates=m0.roadId?[x.to,x.from]:(x.from===m0.atCityId?[x.to]:[x.from]);
   for(const id of candidates){
    if(!id||w.cities[id]?.ownerFactionId!==army.factionId)continue;
    if(x.distanceKm<bestDays){bestDays=x.distanceKm;retreatTarget=id;}
   }
  }
  // 撤退听懂了，只是四顾无路——确定性拒绝。问模型问不出一条不存在的退路。
  if(!retreatTarget)reject('找不到走得通的己方城池，无路可退；可直接写「魏延 撤退 汉中」指明去处');
 }
 const target=city?.id??retreatTarget;
 return{kind:'order',input:{commandId,expectedRevision:w.revision,armyId:army.id,kind,...(kind==='resupply'?{sourceCityId:city!.id,...(found[3]?{foodKg:Number(found[3])}:{})}:target?{targetCityId:target}:{})}};
}
