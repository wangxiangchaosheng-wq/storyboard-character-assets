import type {WorldSnapshot } from './world-contracts.js';
import {assert} from './contracts.js';
import type {SimulationCommand,AdvanceCommand,OrderKind } from './simulation-types.js';
 import {parseDirective,extractCityTargets,extractFactionTargets,directiveHint,directiveLine,mandatesFrom,directiveDirectionOk,type ParsedDirective,type DirectiveContext} from './directive.js';
import {parseLocalCommand,parseSellGrain,LOCAL_COMMAND_HELP,isGrammarRejection,GrammarRejection} from './simulation-commands.js';
import {OpenAIArt} from './provider.js';

/** 从世界快照取方针上下文：玩家输入的城名/势力名都按这个世界里的真名匹配。 */
function directiveContext(w:WorldSnapshot):DirectiveContext{
 const s=w.simulation;
 return{cities:Object.values(w.cities).map(c=>({id:c.id,name:c.name})),
  factions:Object.values(w.factions).map(f=>({id:f.id,name:f.name})),
  ...(s?{}:{})};
}

/**
 * 玩家口语 → 军令。
 *
 * 为什么要在写死语法之外加一层：本地裁判的指令语法（「魏延 进攻 长安」）是给测试与
 * 快捷操作用的，真实玩家打出来的是「让魏延带五千人走子午谷直取长安」「先不急，等秋收
 * 之后再说」「把汉中的粮运一些到前线」这类话。语法解析不了就抛一串示例文本，玩家只会
 * 觉得这游戏听不懂人话。
 *
 * 策略：**语法优先**（零延迟零花费、可离线、可单测），只有语法解析不了时才问模型。
 * 模型产出的仍是同一套 SimulationCommand/AdvanceCommand，之后照旧过 issueOrder 的
 * 全部校验与版本锁——模型只负责「听懂」，不获得任何额外权限。
 * 没配密钥或模型答非所问时，退回语法并抛原来的帮助文本。
 */

export type LocalCommand={kind:'order';input:SimulationCommand}|{kind:'advance';input:AdvanceCommand}|{kind:'directive';directive:ParsedDirective}|{kind:'sell-grain';cityId:string;amountKg:number};

const ORDER_KINDS:OrderKind[]=['march','forced-march','garrison','resupply','attack','besiege','retreat','explore'];

const DIRECTIVE_ROLES=['marshal','diplomat','steward'] as const;
/** 校验模型给的方针：id 只能来自输入清单，字段形状要对。不过就返回 null（调用方转兜底）。 */
function validateDirective(raw:unknown,ctx:DirectiveContext):ParsedDirective|null{
 const d=raw as Record<string,unknown>;
 if(!d||typeof d!=='object')return null;
 const summary=String(d.summary||'');if(!isPlainCn(summary)||summary.length<4||summary.length>80)return null;
 const cityIds=new Set(ctx.cities.map(c=>c.id)),factionIds=new Set(ctx.factions.map(f=>f.id));
 const role=(x:unknown)=>{const r=x as Record<string,unknown>;if(!r||typeof r!=='object')return null;
  const intent=fixIntent(String(r.intent||''));if(intent===null||intent.length<2||intent.length>200)return null;   // 表外英文=译坏，不收
  const constraints=(Array.isArray(r.constraints)?r.constraints:[]).map(String).filter(c=>c.length>0&&c.length<=60).slice(0,5);
  const targets=(Array.isArray(r.targets)?r.targets:[]).map(String).filter(t=>cityIds.has(t)).slice(0,6);
  const fs=(Array.isArray(r.factionIds)?r.factionIds:[]).map(String).filter(f=>factionIds.has(f)).slice(0,3);
  return{intent,constraints,targets,factionIds:fs};};
 const marshal=role(d.marshal),diplomat=role(d.diplomat),steward=role(d.steward);
 if(!marshal||!diplomat||!steward)return null;
 const horizon=Number(d.horizonDays);
 return{summary,marshal,diplomat,steward,horizonDays:Number.isFinite(horizon)&&horizon>0?Math.min(3650,Math.round(horizon)):0};
}
void DIRECTIVE_ROLES;
const directiveRoleSchema={
 type:'object',additionalProperties:false,required:['intent','constraints','targets','factionIds'],
 properties:{intent:{type:'string'},constraints:{type:'array',maxItems:5,items:{type:'string'}},
  targets:{type:'array',maxItems:6,items:{type:'string'}},factionIds:{type:'array',maxItems:3,items:{type:'string'}}},
};

const orderSchema={
 type:'object',additionalProperties:false,required:['understood'],properties:{
  /** 听懂了没：false 时只回一句回复，不下任何命令 */
  understood:{type:'boolean'},
  /** order=一条军令 / advance=推进时间 / directive=常驻方针 / none=只是议论 */
  intent:{type:'string',enum:['order','advance','directive','none']},
  order:{type:'object',additionalProperties:false,required:['kind'],properties:{
   kind:{type:'string',enum:ORDER_KINDS},
   targetCity:{type:'string'},
   sourceCity:{type:'string'},
   foodKg:{type:'number'}}},
  hours:{type:'number'},
  directive:{type:'object',additionalProperties:false,required:['summary','marshal','diplomat','steward','horizonDays'],properties:{
   summary:{type:'string'},horizonDays:{type:'number'},
   marshal:directiveRoleSchema,diplomat:directiveRoleSchema,steward:directiveRoleSchema}},
  reply:{type:'string'}},
};

const orderInstructions=`你是史境本地裁判的军令通译。玩家的话已勾选「下达行动」，你要把它译成一条命令。
输入里有本方军队（id、名称、主将）、可选城池（id、名称、控制方）、可选势力与当前推演日。
规则：
① 只译玩家明确要做的事，不替玩家发明战略；玩家说「再想」「不急」之类就 understood=false。
② 目标城池必须是输入里列出的城池名；缺目标就 understood=false，不要猜。
③ 军队默认取输入里的第一支本方军队，除非玩家点名了另一支。
④ 推进时间：玩家说「过十天」「等一个月」→ advance，hours 用小时数（一天 24 小时，最多 2160）。
⑤ 补给：玩家说「运多少粮」→ resupply，sourceCity 填出发点，foodKg 填公斤数。
⑥ reply 用一句中文说明你译出了什么，或为什么译不出。`;

/**
 * 「这句话该当方针听吗」的离线判据。没网、没密钥时不能把玩家每句闲聊都硬凑成方针——
 * parseDirective 永远给得出结果，所以必须先问这一句：要同时有**方略语气**
 * （先/而后/三年内/联吴/积粟/固守……）和**可指认的对象**（点到的城或势力，或一个期限）。
 * 两者缺一仍按军令/推进的老路走，让写死语法去报它自己的帮助文本。
 */
function looksLikeDirective(text:string,ctx:DirectiveContext):boolean{
 const hay=text||'';
 // 拉近：第四轮普查#7「跟东吴拉近关系」是外交姿态的高频说法，归入方略语气。
 const strategy=/先|而后|再图|年内|三年|二年|一年|联|修好|通好|结盟|拉近|交好|停战|求和|议和|屯田|垦|积粟|固守|持重|休养|蓄势|勿|不轻|慎|相机|伺机|惠工|通商|考课|荐举/.test(hay);
 const named=extractCityTargets(hay,ctx).length+extractFactionTargets(hay,ctx).length>0;
 const horizon=/\d+\s*年|\d+\s*月|期限|暂|休/.test(hay);
 return strategy&&(named||horizon);
}
/**
 * BUG-102：方针的确定性硬门槛——句中至少含一个战略/政务动词，才许「收编为国策」。
 * 为什么要有第二道门：looksLikeDirective 只在**模型没答上来**时用，模型明说
 * intent='directive' 的分支此前不再过检，于是「今晚吃什么」也能被 parseDirective
 * 编排出一句「相机而动，伺机取地」变成年度方针。这道门全离线、可单测，两个分支都过。
 */
const DIRECTIVE_VERBS=/攻|击|伐|讨|征|袭|围|取|夺|进|退|撤|守|防|拒|御|屯|垦|耕|积粟|练|募|筑|迁|抚|和|联|盟|断|绝|宣战|通商|互市|榷|灭|降|援|救|济|运|补|戍|巡|赈|拉|停战|求和|议和/;
function hasDirectiveVerb(text:string):boolean{return DIRECTIVE_VERBS.test(text||'');}
/**
 * UX-110：模型兜底层常回英文意图词（实测「与东吴结盟」回执写成「太尉：defend｜司徒：govern」）。
 * intent 是玩家可达字段（方针回执/授权簿），英文枚举照抄就是泄漏——在 validateDirective
 * 收编成中文；表内的照常映射。
 * UX-112 ②：**表外英文一律不信任**——模型回 retreat/semiannual_assessment/concessions 时，
 * 过表后仍含英文字母，这类「译坏了」的 intent 宁可不收（整份方针拒收、回落本地确定性
 * 转译），也不原样进玩家可见文本。中文长句（模型真听懂时的正常输出）不含字母，照常保留。
 */
const INTENT_CN:Record<string,string>={attack:'相机进攻',defend:'持重固守',wait:'按兵待机',hold:'固守待援',govern:'治政安民',develop:'劝农发展',expand:'拓地开疆',trade:'通商互市',economy:'劝农通商',military:'整军经武',diplomacy:'遣使四方',ally:'遣使修好',alliance:'遣使修好',war:'绝交宣战',peace:'遣使请和',ceasefire:'罢兵息战',rest:'休整蓄势',build:'营建储粮',recruit:'募兵练军',raid:'扰袭疲敌'};
const fixIntent=(x:string):string|null=>{const mapped=INTENT_CN[x.trim().toLowerCase()]??x;return /[A-Za-z]/.test(mapped)?null:mapped;};
const isPlainCn=(x:string)=>!/[A-Za-z]/.test(x);   // 表外英文同一把尺：summary 也不许漏英文字母
 export async function understandLocalCommand(w:WorldSnapshot,text:string,commandId:string,provider?:OpenAIArt):Promise<LocalCommand>{
 const s=w.simulation;
 assert(s,'当前议题没有可用的本地战役');
 // 语法优先：命中就返回，不花一次调用、不依赖网络。
 // UX-111：语法层的**确定性拒绝**（「舆图上没有「X」这座城」「每次推进1—2160小时」）原样
 // 抛给玩家——它们是「听懂了、这件事不合理」，问模型只会白等 7-25 秒再回通用帮助。
 // 只有「没听懂」（LOCAL_COMMAND_HELP）才落模型路径。
 // BUG-120：catch 里再加一道闸——AgentError（parse 层 assert 抛的）+ 无军队对象 + 有方略关键词 = 确定性拒绝，
 // 直接 throw GrammarRejection，不白等模型一次往返。「全力攻魏」「稳一点别浪」这类短语都走这里。
 // 但「叫魏延带五千人走子午谷直取长安」这种有军队/城池名的仍落模型——模型才听得懂口语长句。
 try{return parseLocalCommand(w,text,commandId);}
 catch(e){
  if(isGrammarRejection(e))throw e;
  // 第 7 轮：粜粮句式在语法层收编（城粮出口）——「成都 粜粮 五万」「粜粮济民」，不落模型。
  const sell=parseSellGrain(w,text);
  if(sell)return{kind:'sell-grain',cityId:sell.cityId,amountKg:sell.amountKg};
  // 只有 parse 层完全找不到军队对象（说明句子不是「X 动词 Y」结构）+ 有方略关键词 = 确定拒。
  // 有军队名/城名/势力名 = 可能是口语长句，让模型去处理；没有 = 纯方略口号，确定性拒绝。
  // 「与魏国停战」「跟东吴拉近关系」含势力名，应落模型/offline 路径；「全力攻魏」「稳一点别浪」无实体，确定性拒。
  const mine=Object.values(w.armies).filter(a=>a.factionId===w.simulation?.playerFactionId&&w.simulation?.activeArmyIds.includes(a.id));
  const hasArmy=text.includes(mine[0]?.name)||text.includes(mine[0]?.commander?.name)||/^(?:全军|本方)/.test(text);
  const hasCity=/长安|汉中|成都|洛阳|建业|荆州|凉州|并州|幽州|徐州|会稽|交州/.test(text);
  // 势力名匹配：单字「魏/蜀/吴/曹」需在前缀「联/对/与/抗/和/向/伐/讨/征/袭」之后才算势力对象（「联吴」「伐魏」）；
  // 「全力攻魏」里的「魏」前是「攻」，不在前缀集里，不算势力名。完整词「东吴/蜀汉/曹魏/孙吴」直接认。
  const hasFaction=/魏国|蜀国|蜀汉|吴国|东吴|曹魏|孙吴|公孙|(?<=[联对与抗和向伐讨征袭])魏|(?<=[联对与抗和向伐讨征袭])蜀|(?<=[联对与抗和向伐讨征袭])吴|(?<=[联对与抗和向伐讨征袭])曹/.test(text);
  // 方略动词扩：稳/谨慎/保守/别浪/慎战 是常见的「稳守类」方针关键词。
  const hasDirectiveVerb=/(?:攻|伐|讨|征|袭|围|取|夺|进|退|撤|守|防|联|盟|修好|停战|求和|议和|固守|持重|休养|蓄势|稳|谨慎|保守|别浪|轻出|慎战)/.test(text);
  if(!hasArmy&&!hasCity&&!hasFaction&&hasDirectiveVerb&&e instanceof Error){
   throw new GrammarRejection(`此话听出了方略意图（${text.slice(0,20)}…）但语法层收编不上；请改用完整句式，如「先取长安，三年不出斜谷」或「稳守汉中，勿轻出战」。`);
  }
  /* 没听懂：落到模型 */
 }

 const ctx=directiveContext(w);
 // 模型只译「听懂」这一步。译不出、没配密钥、答非所问，都退到本地兜底上。
 let parsed:ReturnType<typeof parseResult>=null;
 try{
  const res=await (provider??new OpenAIArt()).request('responses',{model:process.env.OPENAI_CHAT_MODEL||'gpt-5.6-luna',orderInstructions,
   input:JSON.stringify({text,
     armies:Object.values(w.armies).filter(a=>a.factionId===s.playerFactionId&&s.activeArmyIds.includes(a.id)).map(a=>({id:a.id,name:a.name,commander:a.commander.name,troops:a.troops})),
     cities:Object.values(w.cities).map(c=>({id:c.id,name:c.name,owner:w.factions[c.ownerFactionId]?.name||c.ownerFactionId})),
     factions:Object.values(w.factions).map(f=>({id:f.id,name:f.name})),
     day:Math.floor(s.timeHours/24)}),
   max_output_tokens:800,store:false,text:{format:{type:'json_schema',name:'local_command',strict:true,schema:orderSchema}}});
  parsed=parseResult(res);
  // 只在排查「模型又省了字段」时打开：SHIJING_DEBUG_COMMAND=1 会把它原答打在 stderr。
  if(process.env.SHIJING_DEBUG_COMMAND)console.error('[command-understanding] model said:',JSON.stringify(res).slice(0,9000));
 }catch{parsed=null;}

 // 模型给了能用的 advance/order，就照它说的办——它才是听懂原话的那一层。
 if(parsed?.understood&&parsed.intent==='advance'&&parsed.hours){
  const hours=Math.round(parsed.hours);
  assert(Number.isFinite(hours)&&hours>=1&&hours<=2160,'推进时长须在 1—2160 小时之间');
  return{kind:'advance',input:{commandId,expectedRevision:w.revision,hours}};
 }
 if(parsed?.understood&&parsed.intent==='order'&&parsed.order){
  const o=parsed.order;
  const city=(name?:string)=>name?Object.values(w.cities).find(c=>c.name===name||c.id===name):undefined;
  const target=city(o.targetCity),source=city(o.sourceCity);
  if(o.kind!=='resupply'&&!target)assert(false,`听不懂目标城池：${String(o.targetCity||'').slice(0,20)||'（未指定）'}；可直接写「魏延 进攻 长安」`);
  if(o.kind==='resupply'&&!source)assert(false,`听不懂出发点：${String(o.sourceCity||'').slice(0,20)||'（未指定）'}；可直接写「魏延 补给 汉中 10000」`);
  return{kind:'order',input:{commandId,expectedRevision:w.revision,armyId:pickArmy(w,text),kind:o.kind,
   ...(o.kind==='resupply'?{sourceCityId:source!.id,...(o.foodKg?{foodKg:o.foodKg}:{})}:target?{targetCityId:target.id}:{})}};
 }

 // 剩下的按**方针**收：模型明说是方针（哪怕省了明细）、或压根没答上来（没网/答非所问）
 // 而本地话头又听得出方略语气。实测这条链上的模型会把「先取长安，三年不出斜谷」答成
 // `{"understood":true}` 就没了——不问它要明细是对的，但那句话不能因此没人认领。
 // BUG-102：无论模型还是离线判据说的算，都要先过战略动词这道确定性硬门槛——
 // 闲聊（「今晚吃什么」）不许被收编成国策。
 if((parsed?.intent==='directive'||looksLikeDirective(text,ctx))&&hasDirectiveVerb(text)){
  let vd=parsed?.directive?validateDirective(parsed.directive,ctx):null;
  // UX-112 ①：模型译文即使形状合法，阵营方向也不许与玩家原话相反——「联吴抗曹」被译成
  // 「对吴绝交宣战」就是这里放过去的（方针生效后诸卿照此打仗，比 400 更糟）。方向对不上
  // 就整份拒收，回落 parseDirective 的本地确定性转译。
  if(vd&&!directiveDirectionOk(text,ctx,vd))vd=null;
  return{kind:'directive',directive:vd||parseDirective(text,ctx)};
 }

 // BUG-101：解析失败一律回**确定性**帮助文案。模型的 reply（幻觉战报、截断句、markdown
 // 表格、第一人称助手口吻）绝不能当错误提示透传给玩家——世界状态零变更却谎称打过一仗，
 // 比冷冰冰的帮助文本恶劣得多。模型的原话只进日志，供排查用。
 if(parsed?.reply)console.error('[command-understanding] 模型回话未采纳（不透传玩家）：',String(parsed.reply).slice(0,300));
 assert(false,LOCAL_COMMAND_HELP);
}

/** 点名了哪支军队就用哪支，否则第一支本方军队（与写死语法同口径）。 */
function pickArmy(w:WorldSnapshot,text:string):string{
 const s=w.simulation!;
 const mine=Object.values(w.armies).filter(a=>a.factionId===s.playerFactionId&&s.activeArmyIds.includes(a.id));
 const named=mine.find(a=>text.includes(a.name)||text.includes(a.commander.name));
 return (named??mine[0])!.id;
}

/** 从 /responses 的结构化产物里取文本：output_text 优先，退回其它文本块。 */
function extractText(res:{output?:{content?:{type?:string;text?:string}[]}[];output_text?:string}):string{
 if(typeof res.output_text==='string'&&res.output_text.trim())return res.output_text;
 for(const item of res.output??[])for(const c of item.content??[])if(typeof c?.text==='string'&&c.text.trim()&&c.type!=='reasoning_text')return c.text;
 for(const item of res.output??[])for(const c of item.content??[])if(typeof c?.text==='string'&&c.text.trim())return c.text;
 return '';
}
function parseResult(res:unknown):{understood?:boolean;intent?:'order'|'advance'|'directive'|'none';order?:{kind:OrderKind;targetCity?:string;sourceCity?:string;foodKg?:number};hours?:number;directive?:Record<string,unknown>;reply?:string}|null{
 try{return JSON.parse(extractText(res as never)) as never;}catch{return null;}
}
