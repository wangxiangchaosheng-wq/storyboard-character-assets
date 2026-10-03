import {test} from 'node:test';
import assert from 'node:assert/strict';
import {mkdtempSync,rmSync,readFileSync,readdirSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {createRequire} from 'node:module';
import {ACHIEVEMENTS,evaluateAchievements,achievementSummary} from './achievements.ts';
import {createCloudSave,exportRunToSave,importRunFromSave} from './cloud-save.ts';
import {initSteam,unlockAchievement,setStat,getStat,isSteamAvailable,shutdownSteam} from './steam.ts';
import {buildInitialWorld} from '../agents/dist/world-bootstrap.js';

const HERE=fileURLToPath(new URL('.',import.meta.url));

const spec={id:'steam-test',title:'诸葛亮北伐：子午谷奇谋',scenario:{background:'公元228年春。汉中向长安进军。'},cast:[{id:'wei-yan',name:'魏延',role:'蜀汉将领',description:'测试'}],metrics:[]};
const run={id:'g1',spec,world:{version:0,day:0,metrics:{},cities:{}},mode:'standalone',engineTurn:0,messages:[],createdAt:new Date().toISOString()};

/** 造一个已初始化的本地世界：12 城、蜀执汉中与成都、魏延部 5000 人在汉中。 */
function world(){
  return buildInitialWorld({id:'w1',spec,mode:'standalone',world:{version:0,day:0,metrics:{},cities:{}},engineTurn:0}).snapshot;
}

/** 本地局 fixture：source 一律 'rules'（本地裁判）；决策簿里玩家的军令记 issuerId 'player'，
 *  太尉代决记 'ai-marshal'。first_edict 的判定就落在「能不能在事件里认出是玩家拍的」上。 */
function localWorld(){
  return {schemaVersion:'world-state/v1',worldId:'w1',scenarioId:'ziwu',mapId:'event-map-v1',revision:10,
    simulation:{version:1,mode:'local',playerFactionId:'shu',activeArmyIds:[],armies:{},cities:{},roads:{},shipments:{},intelligence:[],pauseReason:null,ledger:{initialFoodKg:0,consumedKg:0,spoiledKg:0,initialPeople:0,transportCaptured:0}},
    clock:{startLabel:'建兴六年 · 公元228年 · 春',elapsedDays:120},
    factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'}},
    armies:{},cities:{},actions:{},
    decisions:{
      'decision-order':{id:'decision-order',title:'魏延：进攻长安',orderText:'魏延执行进攻，目标长安',issuedDay:95,issuerId:'player',status:'executing',related:[]},
      'decision-ai':{id:'decision-ai',title:'调拨补给',orderText:'成都向长安守军调拨 12000 公斤粮草。',issuedDay:100,issuerId:'ai-marshal',status:'completed',related:[]}}};
}
const localEv=(id,revision,day,o={})=>({id,worldId:'w1',settlementId:id,decisionId:o.decisionId??null,revision,fromDay:day-1,toDay:day,source:'rules',title:o.title??'本地推演',summary:o.summary,related:[],changes:o.changes??[]});


test('achievements: at least twenty, unique ids, steam-legal names, valid tiers',()=>{
  assert.ok(ACHIEVEMENTS.length>=20,'成就至少 20 条');
  const ids=ACHIEVEMENTS.map(a=>a.id);
  assert.equal(new Set(ids).size,ids.length,'成就 id 不得重复');
  for(const a of ACHIEVEMENTS){
    assert.match(a.id,/^[a-z0-9_]{1,64}$/,`${a.id} 不是合法的 Steam API 名`);
    assert.ok(['bronze','silver','gold'].includes(a.tier),`${a.id} 的 tier 非法`);
    assert.ok(a.name.length>0&&a.description.length>0,`${a.id} 缺少名称或描述`);
  }
});

test('achievements.json matches the code ids exactly',()=>{
  const json=JSON.parse(readFileSync(join(fileURLToPath(new URL('.',import.meta.url)),'achievements.json'),'utf8'));
  const jsonIds=json.map(x=>x.name).sort();
  const codeIds=ACHIEVEMENTS.map(a=>a.id).sort();
  assert.deepEqual(jsonIds,codeIds,'achievements.json 与 ACHIEVEMENTS 的 id 集合必须一致');
});

test('evaluateAchievements derives unlocks from the world and event stream',()=>{
  const w=world();
  // 造一条「攻克长安」的事件：蜀夺魏城
  const events=[{id:'e1',worldId:'w1',settlementId:'s1',decisionId:'d1',revision:1,fromDay:0,toDay:10,
    source:'rules',title:'长安易主',summary:'魏延部进入长安',related:[{type:'city',id:'changan'}],
    changes:[{entity:{type:'city',id:'changan'},field:'ownerFactionId',before:'wei',after:'shu',reason:'测试'}],
    simulationReport:{commandId:'s1',kind:'advance',advancedHours:240,pauseReason:null,rulesVersion:'t',traces:[],summaries:[]}}];
  const progress=evaluateAchievements({world:w,events});
  const unlocked=progress.filter(p=>p.unlocked).map(p=>p.id);
  assert.ok(unlocked.includes('capture_first_city'),'攻克首城应解锁：'+unlocked.join(','));
  // 蜀吴开局有同盟条约 → 缔结同盟应解锁
  assert.ok(unlocked.includes('alliance_formed'),'开局蜀吴同盟应解锁');
  // 不变式：unlocked ⟺ progress===1
  for(const p of progress)assert.equal(p.unlocked,p.progress===1,`${p.id} 的 unlocked 与 progress 不一致`);
  // unlockedAt 记推演日号不记墙钟
  const first=progress.find(p=>p.id==='capture_first_city');
  assert.equal(first.unlockedAt,10,'unlockedAt 应为事件发生日');
});

test('evaluateAchievements is deterministic and does not mutate its input',()=>{
  const w=world(),before=JSON.stringify(w);
  const a=evaluateAchievements({world:w,events:[]});
  const b=evaluateAchievements({world:w,events:[]});
  assert.deepEqual(a,b,'两次评估必须一致');
  assert.equal(JSON.stringify(w),before,'不得修改入参');
});

test('first_edict unlocks on the player\'s first hand-made decision in a local game',()=>{
  const w=localWorld();
  // ① QA B2 实测缺口：本地局玩家亲手裁决策卡——事件 source='rules'、decisionId 为 null，
  //    回执以【决策】起头（world-agent.decide 的固定格式），必须认得出这是玩家拍的
  const decided=evaluateAchievements({world:w,events:[
    localEv('c1',1,12,{summary:'【决策】子午谷奇谋：从魏延策，出兵子午。主上准魏延子午谷之策，简精锐五千，衔枚入谷。'})]});
  const d=decided.find(p=>p.id==='first_edict');
  assert.equal(d.unlocked,true,'本地局首次亲手裁决应解锁 first_edict');
  assert.equal(d.progress,1);
  assert.equal(d.unlockedAt,12,'解锁日记推演日号，不记墙钟');
  // ② 本地局玩家亲下的军令：事件带 decisionId，决策簿 issuerId 为 player
  const ordered=evaluateAchievements({world:w,events:[
    localEv('c2',1,95,{decisionId:'decision-order',title:'命令已登记',summary:'魏延：进攻长安，命令已记录；尚未推进时间。'})]});
  assert.equal(ordered.find(p=>p.id==='first_edict').unlocked,true,'军令同样算「亲手拍板/下达」');
  // ③ 旧口径不倒退：referee 结算、带 decisionId、簿上查无此记录（外部裁判转述的玩家决策）
  const referee=evaluateAchievements({world:w,events:[
    {...localEv('e1',1,0,{summary:'陛下请旨：北伐长安。'}),source:'referee',decisionId:'d-legacy'}]});
  assert.equal(referee.find(p=>p.id==='first_edict').unlocked,true,'referee+decisionId 的旧路径照旧算');
  // ④ 簿上认得代决身份时不冒领：同一条军令若决策簿记 ai-marshal，不是玩家拍的
  const marshal=evaluateAchievements({world:w,events:[
    localEv('c3',1,95,{decisionId:'decision-ai',title:'本地推演',summary:'成都向长安守军调拨粮草。'})]});
  assert.equal(marshal.find(p=>p.id==='first_edict').unlocked,false,'决策簿 issuerId=ai-marshal 的代决不解锁');
});

test('first_edict never fires for AI-delegated rounds or natural events',()=>{
  const w=localWorld();
  const cases={
   '太尉代决（jump 合并落库：decisionId 为 null、【已行】回执）':[localEv('a1',1,30,{summary:'【已行】太尉：长安粮道被断，急调成都仓粮——成都向长安守军调拨12000公斤粮草。'})],
   '本地守军代决（簿上 local-defender）':[localEv('a2',1,40,{decisionId:'decision-ai',title:'本地推演',summary:'长安守军根据已获情报调整行动。'})],
   '太尉未行（【未行】回执）':[localEv('a5',1,35,{summary:'【未行】丞相：粮运不继，未可举兵。'})],
   '自然事件（rules 源、无 decisionId、无回执）':[localEv('a3',1,50,{title:'秋雨伤稼',summary:'阴雨四十日。'})],
   '例行推进（rules 源）':[localEv('a4',1,60,{title:'本地推演',summary:'军中照例点券。'})],
  };
  for(const [name,events] of Object.entries(cases)){
    const p=evaluateAchievements({world:w,events}).find(x=>x.id==='first_edict');
    assert.equal(p.unlocked,false,`${name} 不许解锁 first_edict`);
    assert.equal(p.progress,0,`${name} 不许有进度`);
  }
  // 玩家亲手裁决与太尉代决同局：认领的是玩家的那条，解锁日取玩家那次
  const mixed=evaluateAchievements({world:w,events:[
    localEv('m1',1,30,{summary:'【已行】太尉：长安粮道被断，急调成都仓粮。'}),
    localEv('m2',2,41,{summary:'【决策】三郡叛魏：分兵守三郡。主上分兵守天水、南安、安定三郡。'})]});
  const first=mixed.find(p=>p.id==='first_edict');
  assert.equal(first.unlocked,true);
  assert.equal(first.unlockedAt,41,'代决不顶替玩家的第一次');
});

test('cloud save round-trips through the filesystem provider',async()=>{
  const dir=mkdtempSync(join(tmpdir(),'steam-cloud-'));
  try{
    const p=createCloudSave(dir);
    assert.equal(p.available,true);
    const w=world();
    const entry=exportRunToSave(run,w,[]);
    assert.equal(entry.gameId,'g1');
    // write → read 往返
    const list0=await p.list();
    assert.equal(list0.length,0,'初始应为空');
    await p.write(entry);
    const back=await p.read('g1');
    assert.ok(back,'写后应能读回');
    assert.equal(back.revision,entry.revision);
    // importRunFromSave 还原的世界与原世界一致
    const restored=importRunFromSave(entry);
    assert.equal(restored.world.cities.hanzhong.ownerFactionId,'shu');
    assert.equal(restored.world.armies['army-wei-yan'].troops,5000);
    const list1=await p.list();
    assert.equal(list1.length,1,'列出一条');
    await p.remove('g1');
    assert.equal((await p.list()).length,0,'删除后为空');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('importRunFromSave rejects a corrupted payload with a Chinese error',()=>{
  const bad={gameId:'x',title:'t',savedAt:new Date().toISOString(),revision:1,elapsedDays:0,payload:'{"format":"shijing-run/v1","run":{"id":"x"}}'};
  assert.throws(()=>importRunFromSave(bad),/世界|剧本|事件/,'坏 payload 必须抛中文错');
  const wrongFormat={...bad,payload:'{"format":"other/v9"}'};
  assert.throws(()=>importRunFromSave(wrongFormat),/格式/);
});

test('initSteam degrades safely when it cannot reach Steam',()=>{
  // 这条用例的本意是「探测链上任何一环拿不到东西就安全降级」。装上 steamworks.js 之后
  // 它仍然过，但失败点已经从「模块没装」前移到「探测不到 appid」——所以这里必须断言
  // 到具体原因，否则哪天探测链真断了，测试会因为别的理由绿着而掩盖问题。
  const st=initSteam();
  assert.equal(st.available,false,'探测不到 Steam 时必须 available=false');
  assert.ok((st.reason||'').length>0,'必须说明为什么不可用：实际得到「'+st.reason+'」');
  assert.match(st.reason,/appid|steamworks/i,'原因必须落在 appid 探测或模块加载上');
  assert.equal(isSteamAvailable(),false);
  // 全部 API 是安全 no-op：一个都不抛
  assert.doesNotThrow(()=>{
    assert.equal(unlockAchievement('first_run_complete'),false);
    assert.equal(setStat('x',1),false);
    assert.equal(getStat('x'),null);
    shutdownSteam();
  });
});

test('detectAppId finds steam_appid.txt next to the exe even when cwd is elsewhere',()=>{
  // Steam 客户端按官方约定把 steam_appid.txt 写在 exe 旁边，而 cwd 由启动者给、代码不控制。
  // 旧版只从 cwd 逐级向上找——cwd 不是安装目录时这条链就断了，而那是本机没有 Steam
  // 客户端、无法实测的一环。改从 dirname(process.execPath) 起找，三种启动形态都确定成立。
  // 这里的证据是「代码里两个搜索起点都在，且 exe 目录排在 cwd 之前」。
  const src=readFileSync(join(HERE,'steam.ts'),'utf8');
  const exeIdx=src.indexOf('dirname(process.execPath)');
  const cwdIdx=src.indexOf('process.cwd');
  assert.ok(exeIdx>0,'必须从 exe 所在目录起找');
  assert.ok(cwdIdx>0,'cwd 仍要作为第二起点');
  assert.ok(exeIdx<cwdIdx,'exe 目录必须排在 cwd 之前——那才是最可靠的那个');
  assert.ok(/for\(const start of starts\)/.test(src),'两个起点都要逐级向上走完');
  // 落地产物也要跟上（打包态 require 的是 .mjs）
  const compiled=readFileSync(join(HERE,'steam.mjs'),'utf8');
  assert.ok(/dirname\(process\.execPath\)/.test(compiled),'编译产物里也要有 exe 目录起点');
});

test('steam.mjs uses the namespaced->flat adapter steamworks.js@0.4.0 requires',()=>{
  // 0.4.0 只导出 init/restartAppIfNecessary/electronEnableSteamOverlay/SteamCallback，
  // 完整 API 是 init() 的返回值且是 namespaced 的。照早期「模块扁平导出」的写法装上包
  // 只会得到 available:true 而成就/统计全部静默 false——那是比不可用更难查的故障。
  // 断言源码（.ts）而不是编译产物：空格/换行不该让这条守不变量的测试假红。
  const src=readFileSync(join(HERE,'steam.ts'),'utf8');
  assert.ok(/toFlatClient/.test(src),'必须有 namespaced → 扁平适配器');
  assert.ok(/raw\.achievement\.activate/.test(src),'成就要走 raw.achievement.*，不是 client.activateAchievement');
  assert.ok(/raw\.stats\.getInt/.test(src)&&/raw\.stats\.setInt/.test(src)&&/raw\.stats\.store/.test(src),
    '统计要走 raw.stats.*，不是 client.setStat/getStat');
  // init() 的返回值必须真的校验，不能像老版那样只当布尔看
  assert.ok(/!raw\s*\|\|\s*!raw\.achievement\s*\|\|\s*!raw\.stats/.test(src),
    'init() 返回的 namespaced 对象要真的校验，不能只当布尔');
  // 适配器必须进了编译产物（打包态 require 的是 .mjs）
  const compiled=readFileSync(join(HERE,'steam.mjs'),'utf8');
  assert.ok(/toFlatClient/.test(compiled),'编译产物 steam.mjs 里也要有适配器');
});

test('achievementSummary reports progress and recent unlocks',()=>{
  const w=world();
  const s=achievementSummary(evaluateAchievements({world:w,events:[]}));
  // 开局就有「缔结同盟」「无人愤怒」等已解锁项，故每行都应带百分比进度或解锁日
  assert.ok(s.length>=2,'至少两行');
  for(const line of s){
    assert.match(line,/^【(铜|银|金)】.+·.+（(\d+%|第 \d+ 日解锁)）$/,'每行须带进度或解锁日：'+line);
  }
});

test('no usable credential literals anywhere in steam/',()=>{
  const dir=fileURLToPath(new URL('.',import.meta.url));
  const files=readdirSync(dir).filter(f=>/\.(ts|mjs|json)$/.test(f)&&f!=='package-lock.json');
  for(const f of files){
    const text=readFileSync(join(dir,f));
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text),`${f} 含疑似 OpenAI key`);
    assert.ok(!/AKIA[0-9A-Z]{16}/.test(text),`${f} 含疑似 AWS key`);
    assert.ok(!/ghp_[A-Za-z0-9]{30,}/.test(text),`${f} 含疑似 GitHub PAT`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text),`${f} 含私钥`);
  }
});
