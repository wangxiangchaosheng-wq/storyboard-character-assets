import {test} from 'node:test';
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {HISTORIAN_RULES,bandTroops,buildChronicle,renderChronicleMarkdown,validateChronicle,decisionKindLabel} from '../dist/historian.js';

const world={schemaVersion:'world-state/v1',worldId:'w1',scenarioId:'s1',mapId:'m1',revision:5,
 clock:{startLabel:'建兴六年 · 公元228年 · 春',elapsedDays:120},
 simulation:{version:1,mode:'local',playerFactionId:'shu',activeArmyIds:[],armies:{},cities:{},roads:{},shipments:{},intelligence:[],pauseReason:null,ledger:{initialFoodKg:0,consumedKg:0,spoiledKg:0,initialPeople:0,transportCaptured:0}},
 factions:{shu:{id:'shu',name:'蜀汉',color:'#0a0'},wei:{id:'wei',name:'曹魏',color:'#333'}},
 armies:{'army-wei-yan':{id:'army-wei-yan',name:'魏延',factionId:'shu',commander:{id:'c1',name:'魏延'},troops:4700,foodKg:1700,morale:80,location:{kind:'city',cityId:'hanzhong'},status:'marching'}},
 cities:{hanzhong:{id:'hanzhong',name:'汉中',kind:'city',point:{x:.3,y:.4},ownerFactionId:'shu',governor:null,foodKg:29500,defense:60},changan:{id:'changan',name:'长安',kind:'city',point:{x:.2,y:.3},ownerFactionId:'wei',governor:null,foodKg:10000,defense:70}},
 provinces:{'prov-hanzhong':{id:'prov-hanzhong',name:'汉中',seatCityId:'hanzhong',memberCityIds:[],ownerFactionId:'shu',governor:null,mode:'colonize',policy:null,agriculture:2100000,commerce:900000,manpower:6000,specialties:['铁'],source:'模拟设定'}},
 actions:{},decisions:{'decision-ziwu':{id:'decision-ziwu',title:'子午谷奇谋',orderText:'批准魏延率部经子午谷向长安进军。',issuedDay:0,issuerId:'player',status:'executing',related:[]}}};
const ev=(o)=>({id:o.id,worldId:'w1',settlementId:o.id,decisionId:o.decisionId??null,revision:o.revision,fromDay:o.day-1,toDay:o.day,source:o.source??'rules',title:o.title,summary:o.summary,related:[],changes:o.changes??[]});
const ch=(entity,field,before,after,reason,unit)=>({entity,field,before,after,unit,reason});
const army=(id)=>ch({type:'army',id},'troops',4700,12000,'战后点券');
const city=(id)=>ch({type:'city',id},'foodKg',29500,30000,'转输','kg');
const base=()=>({events:[ev({id:'e1',revision:1,day:5,decisionId:'decision-ziwu',source:'referee',title:'子午谷奇谋',summary:'魏延所部出子午谷\n已抵谷口',changes:[army('army-wei-yan')]}),
 ev({id:'e2',revision:2,day:100,decisionId:'decision-local',source:'rules',title:'本地守军调整',summary:'长安守军固守待援',changes:[city('changan'),ch({type:'clock',id:'w1'},'elapsedDays',99,100,'时间推进','日')]})],
 world,cast:[{id:'c1',name:'魏延',role:'镇北将军'}],openingPrompt:'联吴抗曹，先取荆南养民，不争中原',ending:{title:'建兴十四年：据有荆南四郡',summary:'玩家以联吴养民为纲，避开正面决战。',verdict:'victory'}});
/* 本地局 fixture：所有事件 source 都是 'rules'（本地裁判）——QA B2 实测的病态输入：
 * 玩家亲手裁卡、亲手下令，导出稿里却零原话、性质还分不清。军令事件带 decisionId，决策簿
 * （world.decisions）里 issuerId 为 player；AI 大臣（太尉）代决在 jump/advance 里落库，
 * decisionId 为 null，只能靠【已行】回执与决策簿里的 ai-marshal 条目认领。 */
const localWorld={...world,decisions:{...world.decisions,
 'decision-attack':{id:'decision-attack',title:'魏延：进攻长安',orderText:'魏延执行进攻，目标长安',issuedDay:95,issuerId:'player',status:'executing',related:[]},
 'decision-ai-supply':{id:'decision-ai-supply',title:'调拨补给',orderText:'成都向长安守军调拨 12000 公斤粮草。',issuedDay:186,issuerId:'ai-marshal',status:'completed',related:[]}}};
const localBase=()=>({events:[
 ev({id:'c1',revision:1,day:1,title:'本地推演',summary:'【决策】子午谷奇谋：从魏延策，出兵子午。主上准魏延子午谷之策，简精锐五千，负粮五千，衔枚入谷。',changes:[army('army-wei-yan')]}),
 ev({id:'c2',revision:2,day:95,decisionId:'decision-attack',title:'命令已登记',summary:'魏延：进攻长安，命令已记录；尚未推进时间。',changes:[army('army-wei-yan'),ch({type:'decision',id:'decision-attack'},'status',null,'executing','立案')]}),
 ev({id:'c3',revision:3,day:186,title:'本地推演',summary:'【已行】太尉：长安粮道被断，急调成都仓粮——成都向长安守军调拨12000公斤粮草。',changes:[ch({type:'decision',id:'decision-ai-supply'},'status',null,'completed','代决补粮')]})],
 world:localWorld,cast:[{id:'c1',name:'魏延',role:'镇北将军'}],openingPrompt:'联吴抗曹，先取荆南养民，不争中原',ending:{title:'建兴十四年：据有荆南四郡',summary:'玩家以联吴养民为纲，避开正面决战。',verdict:'victory'}});

test('HISTORIAN_RULES is exactly the seven iron rules',()=>{
 assert.equal(HISTORIAN_RULES.length,7,'铁律必须恰好七条');
 assert.equal(new Set(HISTORIAN_RULES).size,7,'七条铁律不许重复');
 for(const r of HISTORIAN_RULES)assert.ok(r.length>0,'铁律不许有空条');
 assert.ok(HISTORIAN_RULES.some(r=>r.includes('兵力段位化')),'段位化铁律必须在列');
 assert.ok(HISTORIAN_RULES.some(r=>r.includes('玩家决策')&&r.includes('AI 代决')),'区分玩家与代决的铁律必须在列');
 assert.ok(HISTORIAN_RULES.some(r=>r.includes('原话')),'保留玩家原话的铁律必须在列');
});

test('bandTroops bands at every prescribed boundary',()=>{
 const expect=[[0,'数百'],[499,'数百'],[500,'千余'],[1999,'千余'],[2000,'数千'],[9999,'数千'],[10000,'数万'],[49999,'数万'],[50000,'十数万'],[199999,'十数万'],[200000,'数十万众'],[12345678,'数十万众']];
 for(const [n,label] of expect)assert.equal(bandTroops(n),label,`${n} 应报 ${label}`);
 assert.throws(()=>bandTroops(-1),/非负/);
 assert.throws(()=>bandTroops(Number.NaN),/非负/);
 assert.throws(()=>bandTroops(Infinity),/非负/);
});

test('buildChronicle distills the opening and judges decision kinds',()=>{
 const r=buildChronicle(base());
 assert.equal(r.opening.era,'建兴六年 · 公元228年 · 春');
 assert.equal(r.opening.faction,'蜀汉','势力取玩家势力名');
 assert.equal(r.opening.prompt,'联吴抗曹，先取荆南养民，不争中原');
 assert.equal(r.totalDays,120);
 assert.deepEqual(r.opening.initial,[{label:'兵力',value:'数千'},{label:'粮草',value:'31 千斤'},{label:'城池',value:'1 座'}],'国力按本方省汇总：兵 4700 段位化，粮 29500+1700=31200kg，城池只数归属');
 assert.equal(r.decisions.length,2);
 const [d1,d2]=r.decisions;
 assert.equal(d1.day,5);assert.equal(d1.title,'子午谷奇谋');
 assert.equal(d1.kind,'player','裁判源、带 decisionId：玩家拍板');
 assert.equal(d1.prompt,'批准魏延率部经子午谷向长安进军。','玩家原话取决策簿旨意原文');
 assert.deepEqual(d1.aiActions,['魏延·兵力 数千 → 数万'],'兵力只报段位，不泄露精确数字');
 assert.deepEqual(d1.results,['魏延所部出子午谷','已抵谷口'],'结果按行拆');
 assert.equal(d1.id,'decision-ziwu','原样引用决策 id');
 assert.equal(d2.kind,'ai-delegated','decisionId 在决策簿里查不到（代决被淘汰/旧存档）：保守记 AI 代决');
 assert.equal(d2.prompt,undefined,'簿上无据不挂玩家原话，也不编');
 assert.equal(d2.id,'decision-local');
 assert.ok(d2.aiActions.includes('长安·粮草 29,500 kg → 30,000 kg'),'非兵力字段保留数值');
 assert.ok(d2.aiActions.some(a=>a.startsWith('时轮·天数')),'时钟变更也要入档');
 // 无 decisionId 的自然事件与 demo 源都算玩家侧：只有代决痕迹（【已行】回执/簿上代决条目）才记 ai-delegated
 const natural=buildChronicle({...base(),events:[ev({id:'e9',revision:9,day:30,title:'秋雨伤稼',summary:'阴雨四十日'})]});
 assert.equal(natural.decisions[0].kind,'player');
 assert.equal(natural.decisions[0].id,'rev-9');
 const demo=buildChronicle({...base(),events:[ev({id:'e8',revision:8,day:30,decisionId:'decision-ziwu',source:'demo',title:'演示',summary:'演示结算'})]});
 assert.equal(demo.decisions[0].kind,'player');
});

test('same-revision events merge into one decision',()=>{
 const r=buildChronicle({...base(),events:[
  ev({id:'m1',revision:3,day:40,decisionId:'decision-ziwu',source:'referee',title:'魏延前锋受挫',summary:'前锋遇伏\n折兵二百',changes:[army('army-wei-yan')]}),
  ev({id:'m2',revision:3,day:40,decisionId:'decision-ziwu',source:'referee',title:'粮道转运',summary:'汉中转输粮秣',changes:[city('hanzhong')]})]});
 assert.equal(r.decisions.length,1,'同一 revision 只算一次拍板');
 assert.equal(r.decisions[0].title,'魏延前锋受挫','合并后以首条事件为题');
 assert.deepEqual(r.decisions[0].aiActions,['魏延·兵力 数千 → 数万','汉中·粮草 29,500 kg → 30,000 kg']);
 assert.deepEqual(r.decisions[0].results,['前锋遇伏','折兵二百','汉中转输粮秣']);
 assert.equal(r.decisions[0].prompt,'批准魏延率部经子午谷向长安进军。');
});

test('over 60 decisions truncate by weight and stay chronological',()=>{
 const events=Array.from({length:65},(_,i)=>ev({id:'t'+i,revision:i+1,day:i+1,title:'琐务 '+(i+1),summary:'例行结算',changes:Array.from({length:i+1},()=>army('army-wei-yan'))}));
 const r=buildChronicle({...base(),events});
 assert.equal(r.decisions.length,60);
 assert.equal(r.omitted,5);
 assert.equal(r.decisions[0].title,'琐务 6','按 changes 条数降序取前 60');
 assert.equal(r.decisions[0].day,6,'截断后恢复编年顺序');
 assert.equal(r.decisions.at(-1).day,65);
 assert.ok(renderChronicleMarkdown(r).includes('另有 5 条琐务从略'),'截断必须在稿末注明');
 const small=buildChronicle({...base(),events:events.slice(0,3)});
 assert.equal(small.omitted,undefined,'未截断不写 omitted');
});

test('appendImperialQuery is gone: no dead code, kinds are exactly player / ai-delegated',()=>{
 // 请旨后重申这条 mechanic 在全库没有任何生产者（没有事件类型、没有界面、没有任何事件文案
 // 含「请旨」），它的唯一调用方是自己的测试——死代码。本用例守住「删就删干净」：
 // 性质标记恰好两态，导出稿里不许再出现第三种口径。
 assert.equal(decisionKindLabel('player'),'玩家拍板');
 assert.equal(decisionKindLabel('ai-delegated'),'AI 代决');
 const src=readFileSync(new URL('../src/historian.ts',import.meta.url),'utf8');
 assert.ok(!/appendImperialQuery|imperial-query|请旨/.test(src),'historian.ts 不许残留请旨死代码');
});

test('renderChronicleMarkdown carries all four mandatory fields',()=>{
 const r=buildChronicle(localBase());
 const md=renderChronicleMarkdown(r);
 assert.match(md,/^# 史境·三国 一局记录\n/);
 assert.match(md,/## 开局\n- 年代：建兴六年 · 公元228年 · 春\n- 势力：蜀汉\n- 玩家战略原话：「联吴抗曹，先取荆南养民，不争中原」\n- 初始国力：兵力 数千 \/ 粮草 31 千斤 \/ 城池 1 座/,'开局四行齐备');
 assert.match(md,/## 决策链/);
 assert.match(md,/### D01 · 228年春（玩家拍板）\n- 情境：本地推演\n- AI 执行：魏延·兵力 数千 → 数万\n- 结果：【决策】子午谷奇谋/,'裁决卡记玩家拍板，四字段齐备');
 assert.match(md,/### D02 · 228年夏（玩家拍板）\n- 情境：命令已登记\n- 玩家决策：「魏延执行进攻，目标长安」\n- AI 执行：魏延·兵力 数千 → 数万\n- 结果：魏延：进攻长安，命令已记录；尚未推进时间。/,'本地军令：玩家原话逐字入档');
 assert.match(md,/### D03 · 228年秋（AI 代决）\n- 情境：本地推演\n- 依据：玩家战略「联吴抗曹，先取荆南养民，不争中原」\n- 结果：【已行】太尉/,'代决条目标 AI 代决、只引玩家战略不挂原话');
 assert.match(md,/玩家战略原话/,'必填一：玩家原话');
 assert.match(md,/AI 执行/,'必填二：AI 执行序列');
 assert.match(md,/(玩家拍板|AI 代决)/,'必填四：性质标记');
 assert.match(md,/- 结果：/,'必填三：结果与因果');
 assert.match(md,/## 终局\n- 建兴十四年：据有荆南四郡\n- 史官总评：玩家以联吴养民为纲，避开正面决战。（此局为胜）\n\n---\n本记录由史官依事件流水生成，未经玩家修饰。\n$/,'终局与史官署名为稿尾');
 assert.ok(!md.includes('47300'),'精确兵力不许出现在稿里');
 assert.ok(!md.includes('decision-attack')&&!md.includes('issuerId')&&!md.includes('orderText'),'决策簿登记的字段噪声不许挤进 AI 执行序列');
});

test('validateChronicle rejects a broken causal chain above all',()=>{
 const good=buildChronicle(base());
 validateChronicle(good);
 const broken=structuredClone(good);
 broken.decisions[0].aiActions=[];broken.decisions[0].results=[];
 assert.throws(()=>validateChronicle(broken),/因果链断裂/,'无执行亦无结果的决策必须被拒：这是游戏没做好，不是文案没做好');
 const noPrompt=structuredClone(good);noPrompt.opening.prompt='  ';
 assert.throws(()=>validateChronicle(noPrompt),/玩家战略原话/);
 const noDecisions=structuredClone(good);noDecisions.decisions=[];
 assert.throws(()=>validateChronicle(noDecisions),/至少要有一条决策/);
 const badVerdict=structuredClone(good);badVerdict.ending.verdict='draw';
 assert.throws(()=>validateChronicle(badVerdict),/终局判定/);
 const badKind=structuredClone(good);badKind.decisions[1].kind='cheating';
 assert.throws(()=>validateChronicle(badKind),/性质标记/);
});

test('end to end: events → chronicle → render → validate',()=>{
 const r=buildChronicle(localBase());
 const md=renderChronicleMarkdown(r);
 validateChronicle(r);
 assert.equal(r.decisions.length,3);
 assert.ok(md.includes('玩家战略原话')&&md.includes('玩家决策')&&md.includes('AI 代决')&&md.includes('AI 执行')&&md.includes('结果'));
 assert.ok(md.split('\n').every(l=>!/英明|圣断|神机妙算|大胜|惨败|天命/.test(l)),'史官笔下不许出现褒贬判词');
});

/* ---- QA B2 缺陷 1：本地局的「玩家原话」与「AI 代决」分不清 ---- */
test('local game: the player\'s own orders carry the verbatim edict, AI delegation is marked apart',()=>{
 const r=buildChronicle(localBase());
 const [decided,order,delegated]=r.decisions;
 // 验收①：本地局（source 全 'rules'）军令事件从决策簿取回玩家原话，逐字入档
 assert.equal(order.kind,'player','玩家亲下的军令记玩家拍板，不因 source=rules 被抹掉');
 assert.equal(order.prompt,'魏延执行进攻，目标长安','原话取决策簿 orderText，逐字不改写');
 assert.equal(order.id,'decision-attack','原样引用决策 id');
 // 验收②：AI 大臣代决（jump/advance 落库、decisionId 为 null）靠【已行】回执认领
 assert.equal(delegated.kind,'ai-delegated');
 assert.equal(delegated.prompt,undefined,'代决不挂玩家原话');
 assert.ok(delegated.results.some(x=>x.startsWith('【已行】太尉')),'代决事实留在结果里，可追溯');
 // 裁决卡（decide 落库、decisionId 为 null、无代决痕迹）算玩家侧
 assert.equal(decided.kind,'player','玩家亲手裁的卡记玩家拍板');
 assert.equal(decided.prompt,undefined,'裁决卡没有决策簿原话可引：宁缺勿造');
 const md=renderChronicleMarkdown(r);
 assert.ok(md.includes('- 玩家决策：「魏延执行进攻，目标长安」'),'导出稿里必须看得到玩家的原话');
 assert.ok(md.includes('（AI 代决）')&&md.includes('（玩家拍板）'),'两种性质在稿里分得开');
});

test('delegated orders via decisionId and pruned decisions never masquerade as player edicts',()=>{
 // 带 decisionId 的代决：决策簿 issuerId 是 ai-marshal/local-defender → 代决、不挂原话
 const viaId=buildChronicle({...localBase(),events:[
  ev({id:'d1',revision:1,day:50,decisionId:'decision-ai-supply',title:'本地推演',summary:'成都向长安守军调拨粮草。',changes:[ch({type:'decision',id:'decision-ai-supply'},'status',null,'completed','代决补粮')]})]});
 assert.equal(viaId.decisions[0].kind,'ai-delegated');
 assert.equal(viaId.decisions[0].prompt,undefined,'代决的 orderText 是 AI 的执行记录，不是玩家原话');
 // 决策簿里查不到（旧存档、例行代决被淘汰）：保守记代决不抢功，也不编原话
 const pruned=buildChronicle({...localBase(),events:[
  ev({id:'d2',revision:1,day:50,decisionId:'decision-gone',title:'本地推演',summary:'魏延所部拔营。',changes:[]})]});
 assert.equal(pruned.decisions[0].kind,'ai-delegated','簿上无据时不抢功');
 assert.equal(pruned.decisions[0].prompt,undefined,'取不到原话就留空，不编一句');
});

test('blank orderText yields no prompt: nothing is invented when the ledger has nothing',()=>{
 const blankWorld={...localWorld,decisions:{...localWorld.decisions,
  'decision-blank':{id:'decision-blank',title:'驻守休整',orderText:'   ',issuedDay:20,issuerId:'player',status:'completed',related:[]}}};
 const r=buildChronicle({...localBase(),world:blankWorld,events:[
  ev({id:'b1',revision:1,day:20,decisionId:'decision-blank',title:'命令已登记',summary:'魏延驻守休整。',changes:[]})]});
 assert.equal(r.decisions[0].kind,'player','簿记 player 仍是玩家拍板');
 assert.equal(r.decisions[0].prompt,undefined,'orderText 空白：原话行整条不出现');
 const md=renderChronicleMarkdown(r);
 assert.ok(!md.includes('玩家决策：「'),'没有原话就不印「玩家决策」行');
});
