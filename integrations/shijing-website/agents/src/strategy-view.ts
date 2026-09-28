import type {WorldSnapshot,WorldEvent,JsonValue,Point as NormalPoint} from './world-contracts.js';
import {worldVerdict,type VerdictReason} from './world-state.js';
import {provinceTotals,modeLabel} from './province.js';
import {provinceOutput} from './economy.js';
import {angryFactions,politicsSummary} from './politics.js';
import {STANCE_LABELS,TREATY_LABELS,acceptanceOdds} from './diplomacy.js';
import {focusProgress,focusTree} from './focuses.js';
import {techTree} from './techs.js';
import {fiscalSummary} from './treasury.js';
import {assessUpheaval,UPHEAVAL_LABELS} from './upheaval.js';
import {fogReport} from './fog.js';
import {HISTORY_ANCHORS} from './anchors.js';
import {DECISION_EVENTS,lookupNews} from './decisions.js';
import {ANCHOR_ART,NEWS_ART,CARD_ART,pickEventArt} from './anchor-art.js';
import {nextReportInDays} from './courier.js';
export type Point={x:number;y:number};
/** 省投影：聚合层视图，不在省上存冗余的战斗数据。 */
export interface ProvinceView{id:string;name:string;seatCityId:string;memberCityIds:string[];owner:string;ownerColor?:string;governor?:string;mode:string;policy:string|null;specialties:string[];foodKg:number;troops:number;defense:number;cityCount:number;agriculture:number;commerce:number;manpower:number;source:string;position:Point;output:{year:{food:number;coin:number;corvee:number;manpower:number};factors:{label:string;factor:number}[]};census?:{households:number;population:number;source:string};levyRate?:number}
export type Army={id:string;name:string;faction?:string;color?:string;commander?:string;troops?:number;food?:number;morale?:number;fatigue?:number;wounded?:number;dead?:number;transportPeople?:number;position:Point;mapPosition?:Point;location?:string;status?:string};
export type City={id:string;name:string;position:Point;controller?:string;color?:string;governor?:string;food?:number;defense?:number;garrison?:number};
export type Action={id:string;decisionId:string;armyId:string;from:string;target:string;route:Point[];progress?:number;time?:string;status?:string;phase?:string;kind?:string};
export type Decision={id:string;title:string;command:string;time?:string;status?:string;objects:string[]};
export type Change={id?:string;entityId?:string;entityName?:string;decisionId:string;time:string;objects:string[];before:string;after:string;reason:string;title?:string;summary?:string;field?:string;revision?:number};
export type StrategyData={armies:Army[];cities:City[];actions:Action[];decisions:Decision[];changes:Change[];worldTime:{startYear?:number;startLabel?:string;elapsedDays:number};demo?:boolean;ready?:boolean;focusDecisionId?:string;localSimulation?:boolean;basisNote?:string;revision?:number;title?:string;runId?:string;verdict?:{over:boolean;outcome:'victory'|'defeat'|null;summary:string;reason:VerdictReason};provinces?:ProvinceView[];politics?:{factions:{key:string;name:string;clout:number;approval:number;loyalty:number;stance:string;angry:boolean}[];absenceDays:number;prestige:number;summary:string[]};diplomacy?:{playerFactionId:string;hegemony:number;relations:{toFactionId:string;toFactionName:string;toFactionColor?:string;attitude:number;trust:number;stance:string;stanceLabel:string;odds:number;treaties:{id:string;label:string;breached:boolean;sinceDay:number}[]}[]};fiscal?:{treasury:{coin:number;corvee:number;manpower:number};taxRate:number;corruption:number;arrearsDays:number;summary:string[]};alarms?:{kind:string;label:string;subjectName:string;risk:number;reason:string;tier:string}[];
/** 史实时间轴。tier：world 天下 / nation 本国 / local 本地；certainty=fixed 史书明载，likely 系推定。 */
history?:{past:{id:string;title:string;summary:string;year:number;season?:string;tier:string;places:string[];factions:string[];source:string;certainty:string}[];upcoming:{id:string;title:string;summary:string;year:number;season?:string;tier:string;places:string[];factions:string[];source:string;certainty:string;interseasonDays:number}[];next:{id:string;title:string;seasonsLeft:number}|null};
/** 待主上决策/御览的历史事件卡（decisions.ts）。kind=news 时没有选项，只一个「知道了」。 */
pendingDecision?:{id:string;kind:'decision'|'news';title:string;text:string;image:string;artKind?:'exclusive'|'category'|'fallback'|null;source:string;certainty:string;choices:{id:string;label:string;detail?:string;summary:string}[];resolved?:string}|null;
/** 国策层：政治点 + 可点的国家议程 + 进行中进度。没有这一层（旧存档）时为 undefined。
 *  list 里**不剔除**进行中与已办的——序号必须稳定，玩家第二次敲 `focus 3` 要还是第三条。
 *  状态由每项自己的 state 表示（idle/active/done）。 */
  startYear?:number;
  /** 时间线来源：preset=预设 228 北伐锚点，derived=按本局年份从议题派生。 */
  timelineSource?:'preset'|'derived'|'none';
/** 国策树：四支（军政/民政/人事/邦交）× 三层，每项带 state 与缺的前置。 */
  focuses?:{points:number;pointsPerDay:number;pointsCap:number;
    tree:{category:string;tiers:{tier:number;items:{id:string;title:string;text:string;cost:number;days:number;column:number;derived?:boolean;source?:string;state:'idle'|'blocked'|'active'|'done';progress:number;remainingDays:number;missing:string[]}[]}[]}[];
    completed:string[];active:{id:string;title:string;progress:number;remainingDays:number}[]}|null;
  /** 科技树：四枝（政治/军事/经济/科技）× 三层。 */
  techs?:{points:number;pointsPerDay:number;pointsCap:number;
    tree:{category:string;tiers:{tier:number;items:{id:string;title:string;text:string;source:string;cost:number;days:number;tier:number;state:'idle'|'blocked'|'active'|'done';progress:number;remainingDays:number;missing:string[]}[]}[]}[];
    completed:string[]}|null;
  /** 在途：驿报（还没送到御前的军情）与诏令（还没到军中的旨意）。古代没有电报——
   *  这两栏让玩家看得见「迟」，也答得上「我的令到底动了没有」。 */
  inTransit?:{reports:{eventId:string;happenedDay:number;arrivalDay:number;title?:string}[];edicts:{id:string;note:string;issuedDay:number;arrivalDay:number}[];nextReportInDays:number|null};
  /** 脑洞决策卡：军议从当前局势读出的「如果…」岔路（玩家不懂这段史时替他出题）。 */
  whatIfs?:{id:string;title:string;text:string;choices:{id:string;label:string;detail?:string;summary:string}[]}[]|null;
  reachable?:{id:string;from:string;to:string;distanceKm:number;fromName:string;toName:string}[];goal?:{years:number;premise:string;need:number;want:string;held:number;total:number;met:boolean;summary:string}|null;fog?:{observerFactionId:string;asOfDay:number;courierDays:number;armies:{id:string;name:string;factionName:string;tier:string;troops?:number;troopsBand?:string;location?:string;seenDay:number;stale:boolean}[];cities:{id:string;name:string;tier:string;controller?:string;garrisonBand?:string;seenDay:number;stale:boolean}[];summary:string[]}};
const states:Record<string,string>={stationed:'驻扎',marching:'行军中',besieging:'围城中',fighting:'交战中',resting:'休整',destroyed:'覆灭',planned:'计划中',active:'执行中',completed:'已完成',failed:'未达成',cancelled:'已撤销',issued:'已下达',executing:'执行中',march:'调动',attack:'进攻',retreat:'撤退',resupply:'补给'};
/** 待决事项的三分类（用户给的口径）：cost=花政治点的国策，event=突发事件决策，news=只告知的新闻。 */
export type PendingKind='cost'|'event'|'news';
const fields:Record<string,string>={troops:'兵力',foodKg:'粮草',morale:'士气',defense:'城防',ownerFactionId:'控制方',status:'状态',location:'位置',progress:'行动进度',elapsedDays:'经过天数',fatigue:'疲劳',wounded:'伤员',dead:'阵亡',captured:'被俘',deserted:'逃散'};
export const projectPoint=(p:NormalPoint):Point=>({x:436+p.x*1172,y:143+p.y*662});
export function pointOnRoute(route:NormalPoint[],progress:number):NormalPoint {
  const lengths=route.slice(1).map((p,i)=>Math.hypot(p.x-route[i].x,p.y-route[i].y));const total=lengths.reduce((a,b)=>a+b,0);let d=total*progress;
  for(let i=0;i<lengths.length;i++){const len=lengths[i];if(d<=len&&len>0){const t=d/len;return{x:route[i].x+(route[i+1].x-route[i].x)*t,y:route[i].y+(route[i+1].y-route[i].y)*t};}d-=len;}return route.at(-1)!;
}
export function projectStrategy(w:WorldSnapshot|null,events:WorldEvent[],meta:{title:string;runId:string;demo?:boolean;basisNote?:string}):StrategyData {
  if(!w)return {...meta,ready:false,armies:[],cities:[],actions:[],decisions:[],changes:[],worldTime:{elapsedDays:0}};
  const name=(id:string)=>w.armies[id]?.name||w.cities[id]?.name||w.decisions[id]?.title||w.factions[id]?.name||id;
  const value=(v:JsonValue,field:string,unit?:string):string=>{
    if(v===null)return '未设定';
    if(field==='progress'&&typeof v==='number')return Math.round(v*100)+'%';
    // ≥1000 的量（粮草 kg、天数）一律取整：千分位中间再夹三位小数，「7,680.817」的
    // 小数点在衬线字体里极易看丢成「7,680,817」，量级直接错 1000 倍（实测 BUG-006）。
    if(typeof v==='number')return (Math.abs(v)>=1000?Math.round(v):Math.round(v*10)/10).toLocaleString('zh-CN')+(unit?' '+unit:'');
    if(typeof v==='string')return states[v]||name(v);
    if(typeof v==='object'&&!Array.isArray(v)){if(v.kind==='city')return name(String(v.cityId));if(v.kind==='route')return '行军途中';if(v.kind==='field')return String(v.label);}
    return '已更新';
  };
  const armies=Object.values(w.armies).filter(a=>!w.simulation||w.simulation.activeArmyIds.includes(a.id)).map(a=>{
    let p:NormalPoint,location:string;
    if(a.location.kind==='city'){const c=w.cities[a.location.cityId];p=c.point;location=c.name;}
    else if(a.location.kind==='route'){const t=w.actions[a.location.actionId];p=pointOnRoute(t.route,t.progress);location=t.origin.label+' → '+t.target.label;}
    else{p=a.location.point;location=a.location.label;}
    // Offset is presentation-only so a stationed flag does not hide its city click target.
    const mapPosition=projectPoint(p),pos={...mapPosition};if(a.location.kind==='city'){const cityId=a.location.cityId;const peers=Object.values(w.armies).filter(b=>b.location.kind==='city'&&b.location.cityId===cityId).sort((a,b)=>a.id.localeCompare(b.id));pos.x+=30+peers.findIndex(b=>b.id===a.id)*28;pos.y-=40;}else{const near=Object.values(w.cities).map(c=>projectPoint(c.point)).find(c=>Math.hypot(c.x-pos.x,c.y-pos.y)<90);if(near){pos.x=near.x-90;pos.y=near.y+50;}}
    return{id:a.id,name:a.name,faction:w.factions[a.factionId].name,color:w.factions[a.factionId].color,commander:a.commander.name,troops:a.troops,food:a.foodKg,morale:Math.round(a.morale*100)/100,fatigue:w.simulation?Math.round(w.simulation.armies[a.id].fatigue*100)/100:undefined,wounded:w.simulation?.armies[a.id].wounded,dead:w.simulation?.armies[a.id].dead,transportPeople:w.simulation?.armies[a.id].transportPeople,position:pos,mapPosition,location,status:states[a.status]};
  });
  return {...meta,ready:true,localSimulation:!!w.simulation,revision:w.revision,verdict:worldVerdict(w),worldTime:{startLabel:w.clock.startLabel,startYear:Number(w.clock.startLabel.match(/公元\s*(\d+)\s*年/)?.[1])||undefined,elapsedDays:w.clock.elapsedDays},armies,
    cities:Object.values(w.cities).map(c=>({id:c.id,name:c.name,position:projectPoint(c.point),controller:w.factions[c.ownerFactionId].name,color:w.factions[c.ownerFactionId].color,governor:c.governor?.name,food:c.foodKg,defense:c.defense,garrison:Object.values(w.armies).filter(a=>a.location.kind==='city'&&a.location.cityId===c.id).reduce((n,a)=>n+a.troops,0)})),
    actions:Object.values(w.actions).map(a=>({id:a.id,decisionId:a.decisionId,armyId:a.armyId,from:a.origin.cityId||a.origin.label,target:a.target.cityId||a.target.label,route:a.route.map(projectPoint),progress:Math.round(a.progress*100),time:`${a.startedDay===null?'尚未出发':'第'+(Math.floor(a.startedDay)+1)+'日出发'} · ${a.estimatedArrivalDay===null?'抵达时间待定':'预计第'+(Math.floor(a.estimatedArrivalDay)+1)+'日抵达'}${a.endedDay===null?'':' · 第'+(Math.floor(a.endedDay)+1)+'日结束'}`,status:states[a.status],phase:a.status,kind:a.kind})),
    diplomacy:w.diplomacy&&w.simulation?(()=>{const me=w.simulation.playerFactionId;return{playerFactionId:me,hegemony:w.diplomacy!.hegemony,relations:Object.values(w.diplomacy!.relations).filter(r=>r.fromFactionId===me).map(r=>({toFactionId:r.toFactionId,toFactionName:w.factions[r.toFactionId]?.name||r.toFactionId,toFactionColor:w.factions[r.toFactionId]?.color,attitude:r.attitude,trust:r.trust,stance:r.stance,stanceLabel:STANCE_LABELS[r.stance],odds:acceptanceOdds(w.diplomacy!,me,r.toFactionId),treaties:r.treaties.map(t=>({id:t.id,label:TREATY_LABELS[t.kind],breached:t.breached,sinceDay:t.sinceDay}))}))};})():undefined,
    fiscal:w.fiscal?(()=>{const f=w.fiscal!;return{treasury:{coin:f.treasury.coin,corvee:f.treasury.corvee,manpower:f.treasury.manpower},taxRate:f.taxRate,corruption:f.corruption,arrearsDays:f.arrearsDays,summary:fiscalSummary(f)};})():undefined,
    fog:(()=>{const f=fogReport(w);return{observerFactionId:f.observerFactionId,asOfDay:f.asOfDay,courierDays:f.courierDays,armies:f.armies.map(a=>({id:a.id,name:a.name,factionName:a.factionName,tier:a.tier,troops:a.troops,troopsBand:a.troopsBand,location:a.location,seenDay:a.seenDay,stale:a.stale})),cities:f.cities.map(c=>({id:c.id,name:c.name,tier:c.tier,controller:c.controller,garrisonBand:c.garrisonBand,seenDay:c.seenDay,stale:c.stale})),summary:f.summary};})(),
    alarms:(()=>{const r=assessUpheaval(w,w.fiscal?.arrearsDays||0);return r.risks.filter(x=>x.tier!=='notable').map(x=>({kind:x.kind,label:UPHEAVAL_LABELS[x.kind],subjectName:x.subjectName,risk:x.risk,reason:x.reason,tier:x.tier}));})(),
    // 史实时间轴：天下/本国/本地三档。锚点是只读的既成事实，玩家改不了，但该看得见——
    // 「现在天下正在发生什么」是沉浸感的一半，另一半是到日子就进汇报（见 simulation-engine）。
    history:(()=>{const d=w.simulation?w.simulation.timeHours/24:0;
      // 本局时间线：开局年份不是 228 时，bootstrap 已换成另一套（或清空）。旧存档回落预设。
      const timeline=w.anchors??HISTORY_ANCHORS;
      const shape=(a:typeof HISTORY_ANCHORS[number])=>({id:a.id,title:a.title,summary:a.summary,year:a.year,season:a.season,tier:a.tier,places:a.places,factions:a.factions,source:a.source,certainty:a.certainty});
      const upcoming=timeline.filter(a=>a.day>d);
      return {past:timeline.filter(a=>a.day<=d).map(shape),
        upcoming:upcoming.slice(0,6).map(a=>({...shape(a),interseasonDays:Math.round(a.day-d)})),
        next:upcoming[0]?{id:upcoming[0].id,title:upcoming[0].title,seasonsLeft:Math.ceil((upcoming[0].day-d)/91)}:null};})(),
    politics:w.politics?(()=>{const angry=new Set(angryFactions(w.politics!));return{factions:Object.values(w.politics!.factions).map(f=>({key:f.key,name:f.name,clout:f.clout,approval:f.approval,loyalty:f.loyalty,stance:f.stance,angry:angry.has(f.key)})),absenceDays:w.politics!.absenceDays,prestige:w.politics!.prestige,summary:politicsSummary(w.politics!)};})():undefined,
    provinces:w.provinces?Object.values(w.provinces).map(p=>{const seat=w.cities[p.seatCityId];const t=provinceTotals(w,p);return{id:p.id,name:p.name,seatCityId:p.seatCityId,memberCityIds:[...p.memberCityIds],owner:w.factions[p.ownerFactionId].name,ownerColor:w.factions[p.ownerFactionId].color,governor:p.governor?.name,mode:modeLabel(p.mode),policy:p.policy,specialties:[...p.specialties],foodKg:t.foodKg,troops:t.troops,defense:t.defense,cityCount:t.cityCount,agriculture:p.agriculture,commerce:p.commerce,manpower:p.manpower,source:p.source,position:projectPoint(seat.point),...(p.census?{census:p.census,levyRate:p.levyRate}:{}),output:(()=>{const o=provinceOutput(w,p);return{year:o.year,factors:o.factors};})()};}):undefined,
    whatIfs:(w.whatIfs||[]).map(c=>({id:c.id,title:c.title,text:c.text,
      choices:c.choices.map(ch=>({id:ch.id,label:ch.label,detail:ch.detail,summary:ch.summary}))})),
    startYear:w.startYear,
    /** 时间线是预设（228 北伐）还是按本局年份派生的——起居注与界面要能说清「这事的出处」。 */
    // none = 本局既没有预设锚点也没派生成功（异年代 + 读不出），跟 derived 要分清——
    // 实测把空时间线标成 derived，看着像「有派生时间线」，其实是空的。
    timelineSource:w.anchors&&w.anchors.length?((w.anchors[0].id.startsWith('northern-')||w.anchors[0].id==='sanqun-rebel')?'preset':'derived'):'none',
    // 国策与科技都按「树」给：四支 × 三层，每项带 state（idle/blocked/active/done）与缺的前置。
    // 界面画树、CLI 列树，两处同一个形状——不许各写一套。
    focuses:w.focuses?(():NonNullable<StrategyData['focuses']>=>({
      points:Math.floor(w.focuses!.points),pointsPerDay:w.focuses!.pointsPerDay,pointsCap:w.focuses!.pointsCap,
      tree:focusTree(w.focuses,w.clock.elapsedDays),
      completed:[...w.focuses!.completed],
      active:focusProgress(w.focuses,w.clock.elapsedDays).map(p=>({id:p.focus.id,title:p.focus.title,progress:Math.round(p.progress*100),remainingDays:p.remainingDays})),
    }))():undefined,
    techs:w.techs?(()=>({
      points:Math.floor(w.techs!.points),pointsPerDay:w.techs!.pointsPerDay,pointsCap:w.techs!.pointsCap,
      tree:techTree(w.techs,w.clock.elapsedDays),completed:[...w.techs!.completed],
    }))():undefined,
    inTransit:{
      // BUG-113：驿报带标题——跳转笔记要能预告「〔卡名〕在途」，玩家才知道这次为何没被拦停。
      reports:(w.incomingEvents||[]).map(e=>({eventId:e.eventId,happenedDay:e.happenedDay,arrivalDay:e.arrivalDay,title:DECISION_EVENTS.find(x=>x.id===e.eventId)?.title??lookupNews(e.eventId)?.title??'军情'})),
      edicts:(w.pendingEdicts||[]).map(e=>({id:e.id,note:e.note,issuedDay:e.issuedDay,arrivalDay:e.arrivalDay})),
      nextReportInDays:nextReportInDays(w,w.clock.elapsedDays),
    },
    pendingDecision:(()=>{const id=w.pendingDecision?.eventId;if(!id)return null;
      // 兜底：已裁过的卡绝不允许再上御案（正常链路 applyDecision 会清 pendingDecision，
      // 这里挡的是旧快照/异常路径——「裁完还挂着」比少显示一张卡严重得多）。
      if((w.resolvedDecisions||{})[id])return null;
      const d=DECISION_EVENTS.find(x=>x.id===id);
      const kind=d?'decision':(lookupNews(id)?'news':null);
      if(!kind)return null;
      const e=d??lookupNews(id)!;
      // 出图三步：事件专属图 → 类别图 → 兜底图。玩家架空出来的事也能按类别沾到图，
      // 不必为每一种可能先画一张。
      const art=pickEventArt(id,kind==='news'?NEWS_ART:{...ANCHOR_ART,...CARD_ART},e.title,e.text);
      return {id:e.id,kind,title:e.title,text:e.text,image:art?art.file:'',artKind:art?art.kind:null,source:e.source,certainty:e.certainty,
        choices:d?d.choices.map(c=>({id:c.id,label:c.label,detail:c.detail,summary:c.summary})):[],
        resolved:(w.resolvedDecisions||{})[e.id]};})(),
    // 路网与胜利条件：没有这两样，玩家只能靠猜——试玩原话是「打下一座城后剩下的全是白给，
    // 而白给完走廊就到头了」，其实路网有七条、覆盖八城，只是**没有任何地方告诉过他**。
    // 只报本方军队当前所在城可直达的路（未探明的敌境道路属于情报，先不给）。
    reachable:(()=>{const w2=w;const me=w2.simulation?.playerFactionId;if(!me||!w2.simulation)return undefined;
      const seen=new Set<string>();
      for(const a of Object.values(w2.armies)){const m=w2.simulation.armies[a.id];if(a.factionId===me&&m?.atCityId)seen.add(m.atCityId);}
      return Object.values(w2.simulation.roads).filter(r=>r.open&&(seen.has(r.from)||seen.has(r.to)))
        .map(r=>({id:r.id,from:r.from,to:r.to,distanceKm:r.distanceKm,
          fromName:w2.cities[r.from]?.name||r.from,toName:w2.cities[r.to]?.name||r.to}));
    })(),
    goal:(()=>{const g=w.scenarioGoal;if(!g)return null;const total=Object.keys(w.cities).length;
      const me=w.simulation?.playerFactionId;
      const mine=me?Object.values(w.cities).filter(c=>c.ownerFactionId===me).length:0;
      const need=Math.ceil(total/2);
      return {years:g.years,premise:g.premise,need,want:`占 ${need} 城`,held:mine,total,met:mine>=need,
        summary:`剧本为期 ${g.years} 年（${g.years*365} 日）。占城过半（${mine}/${total}，需 ${need}）即胜；尽失州郡即败；期满不足半数则师老无功。`};})(),
    decisions:Object.values(w.decisions).reverse().map(d=>({id:d.id,title:d.title,command:d.orderText,time:`${w.clock.startLabel} · 第${Math.floor(d.issuedDay)+1}日`,status:states[d.status],objects:d.related.map(r=>r.id)})),
    changes:events.flatMap(e=>{
      const rows=e.changes.filter(c=>fields[c.field]&&c.before!==null);
      return (rows.length?rows:[null]).map((c,i)=>({id:e.id+'-'+i,entityId:c?.entity.id,entityName:c&&c.entity.type!=='clock'?name(c.entity.id):undefined,revision:e.revision,decisionId:e.decisionId||'',time:`推演第${Math.floor(e.toDay)+1} · ${Math.round((e.toDay%1)*24)}时日`,objects:[...new Set([...e.related.map(r=>r.id),...(c&&c.entity.type!=='clock'?[c.entity.id]:[])])],title:e.title,summary:e.summary,field:c?fields[c.field]:undefined,before:c?value(c.before,c.field,c.unit):'待执行',after:c?value(c.after,c.field,c.unit):'已确认',reason:c?.reason||e.summary}));
    }),
  };
}
