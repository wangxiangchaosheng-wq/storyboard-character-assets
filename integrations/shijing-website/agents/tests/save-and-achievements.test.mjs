import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {existsSync,mkdirSync,mkdtempSync,readdirSync,readFileSync,rmSync,writeFileSync} from 'node:fs';
import {join} from 'node:path';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {evaluateForRun,loadUnlocked,saveUnlocked,commitUnlocks} from '../dist/achievement-runtime.js';
import {MAX_SLOTS,listSlots,writeSlot,readSlot,clearSlot,nextFreeSlot} from '../dist/save-slots.js';
import {ACHIEVEMENTS} from '../../steam/achievements.ts';
import {exportRunToSave,importRunFromSave} from '../../steam/cloud-save.ts';
const HERE=fileURLToPath(new URL('.',import.meta.url));

/* ---------------- fixture：全部手写 plain object，与 steam.test.mjs 同口径，不依赖 agents 运行时 ---------------- */
const army=(id,factionId,troops,status='stationed')=>({id,name:id+'部',factionId,commander:{id:'c-'+id,name:'主将'},troops,foodKg:8000,morale:70,location:{kind:'city',cityId:'seat'},status});
const city=(id,ownerFactionId,foodKg=20000)=>({id,name:id,kind:'city',point:{x:0.5,y:0.5},ownerFactionId,governor:null,foodKg,defense:70});
const ev=(id,revision,settlementId,source,title,summary,fromDay,toDay,changes,decisionId=null)=>({id,worldId:'run-test-1',settlementId,decisionId,revision,fromDay,toDay,source,title,summary,related:[],changes});
const chg=(type,id,field,before,after,unit)=>({entity:{type,id},field,before,after,...(unit?{unit}:{}),reason:'测试'});
/** 世界 A：shu 为主公势力；两城皆归 shu（归一）、国库过万、凉州屯田见效、魏军成建制覆没。 */
function worldFixture(){
  return {schemaVersion:'world-state/v1',worldId:'run-test-1',scenarioId:'ziwu',mapId:'event-map-v1',revision:104,
    simulation:{version:1,mode:'local',profile:{id:'hanzhong-local-v1',version:1,status:'experimental',parameters:{},sources:[]},timeHours:0,playerFactionId:'shu',activeArmyIds:['army-shu'],armies:{},cities:{},roads:{},shipments:{},intelligence:[],pauseReason:null,ledger:{initialFoodKg:0,consumedKg:0,spoiledKg:0,initialPeople:0,transportCaptured:0}},
    clock:{startLabel:'建兴六年 · 公元228年 · 春',elapsedDays:400},
    factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'}},
    armies:{'army-shu':army('army-shu','shu',4000,'resting'),'army-wei':army('army-wei','wei',0,'destroyed')},
    cities:{hanzhong:city('hanzhong','shu'),changan:city('changan','shu',600000)},
    provinces:{liangzhou:{id:'liangzhou',name:'凉州',seatCityId:'changan',memberCityIds:['changan'],ownerFactionId:'shu',governor:null,mode:'colonize',policy:null,agriculture:100,commerce:10,manpower:10,specialties:[],source:'测试'}},
    fiscal:{version:1,treasury:{coin:20000,food:0,corvee:0,manpower:0},taxRate:0.1,corruption:0,arrearsDays:0,lastSettlement:[]},
    actions:{},decisions:{}};
}
/** 流水 A：请旨 → 跳满一年 → 火攻断粮 → 夺长安歼守军 → 100 条屯田流水（国史盈室）。共 104 条。 */
function eventFixture(){
  const events=[
    ev('e-edict',1,'s-edict','referee','请旨定策','陛下请旨：北伐长安。',0,0,[chg('decision','d1','status',null,'issued')],'d1'),
    ev('e-jump',2,'s-jump','rules','推进一年','朝议既定，一口气推进满一年。',0,400,[]),
    ev('e-supply',3,'s-supply','rules','劫粮','火攻魏军粮台，粮道断绝。',400,410,[chg('army','army-wei','foodKg',20000,100,'kg')]),
    ev('e-capture',4,'s-capture','referee','围攻长安','魏延部围城，守军覆没，长安易主。',410,420,[
      chg('city','changan','ownerFactionId','wei','shu'),
      chg('army','army-wei','troops',9000,0,'人'),
      chg('army','army-wei','status','fighting','destroyed')]),
  ];
  for(let i=1;i<=100;i++)events.push(ev('h-'+i,4+i,'s-h-'+i,'rules','屯田 '+i,'凉州屯田第 '+i+' 季有收。',420+i,421+i,[]));
  return events;
}
const EXPECTED=['first_run_complete','first_year_jump','first_edict','capture_first_city','cut_enemy_supply','annihilate_army','bloodless_capture','outnumbered_victory','fire_attack','historian_100','treasury_10k','province_surplus','tuntian_effective'];
const runFixture=()=>({id:'run-test-1',spec:{id:'ziwu',title:'测试局',scenario:{background:'公元228年春。'},cast:[{id:'zhuge',name:'诸葛亮',role:'丞相',description:'测试'}],metrics:[]},world:{version:104,day:400,metrics:{},cities:{}},mode:'standalone',engineTurn:0,messages:[],createdAt:'2026-09-20T10:00:00.000Z'});
/** 机制用例的占位正文：这些用例只查槽位簿记，正文往返由「importRunFromSave 原样读回」专门把守 */
const stub=(o={})=>({gameId:'run-stub',title:'占位',savedAt:'2026-09-20T10:00:00.000Z',revision:1,elapsedDays:1,court:'delegated',payload:'{}',...o});
function freshDir(t){const dir=mkdtempSync(join(tmpdir(),'shijing-saves-'));t.after(()=>rmSync(dir,{recursive:true,force:true}));return dir;}

test('evaluateForRun 推出预期成就；newlyUnlocked 只含本次新增，落盘后差集为空',(t)=>{
  const dir=freshDir(t);
  const r=evaluateForRun({runId:'run-test-1',world:worldFixture(),events:eventFixture(),dir});
  assert.equal(r.progress.length,ACHIEVEMENTS.length,'进度表必须覆盖全部成就');
  assert.equal(r.progress.length,25);
  const unlocked=r.progress.filter(p=>p.unlocked).map(p=>p.id).sort();
  assert.deepEqual(unlocked,[...EXPECTED].sort());
  assert.deepEqual(r.newlyUnlocked.map(a=>a.id).sort(),[...EXPECTED].sort(),'空簿下所有已解锁项都是本次新增');
  for(const a of r.newlyUnlocked){
    const meta=ACHIEVEMENTS.find(x=>x.id===a.id);
    assert.equal(a.name,meta.name);assert.equal(a.description,meta.description);assert.equal(a.tier,meta.tier);
    assert.ok(Number.isFinite(a.unlockedAt)&&a.unlockedAt>=0,'解锁时刻记推演日号');
  }
  assert.ok(r.summary.some(l=>l.includes('完成一局')),'summary 供界面直接展示');
  // 落盘后再求差：进度一个不少，新增一个没有
  commitUnlocks(dir,r.newlyUnlocked);
  const again=evaluateForRun({runId:'run-test-1',world:worldFixture(),events:eventFixture(),dir});
  assert.equal(again.newlyUnlocked.length,0,'已落盘的成就不该再次报新增');
  assert.deepEqual(again.progress.filter(p=>p.unlocked).map(p=>p.id).sort(),unlocked,'求差不改动进度本身');
});

test('本地局 first_edict：首次亲手裁决/下达即解锁，AI 代决不冒领',(t)=>{
 // QA B2 缺陷 2 的实链路复现：本地局所有事件 source 都是 'rules'，旧判定只认 referee/「请旨」，
 // 于是玩家亲手裁决十余次，first_edict 始终 unlocked:false, progress:0。
 const dir=freshDir(t);
 const world=worldFixture();
 world.decisions={
  'decision-order':{id:'decision-order',title:'魏延：进攻长安',orderText:'魏延执行进攻，目标长安',issuedDay:95,issuerId:'player',status:'executing',related:[]},
  'decision-ai':{id:'decision-ai',title:'调拨补给',orderText:'成都向长安守军调拨 12000 公斤粮草。',issuedDay:100,issuerId:'ai-marshal',status:'completed',related:[]}};
 const advance=ev('l-advance',5,'s-l','rules','本地推演','【已行】太尉：长安粮道被断，急调成都仓粮。',100,101,[]);
 const decide=ev('l-decide',6,'s-l','rules','本地推演','【决策】子午谷奇谋：从魏延策，出兵子午谷。主上准魏延子午谷之策，简精锐五千。',12,12,[]);
 const order=ev('l-order',7,'s-l','rules','命令已登记','魏延：进攻长安，命令已记录；尚未推进时间。',95,95,[],'decision-order');
 const r=evaluateForRun({runId:'run-test-1',world,events:[advance,decide,order],dir});
 const first=r.progress.find(p=>p.id==='first_edict');
 assert.equal(first.unlocked,true,'本地局首次亲手裁决应解锁 first_edict');
 assert.equal(first.progress,1,'解锁即 100%');
 assert.equal(first.unlockedAt,12,'解锁日记玩家第一次裁决之日（代决不顶替）');
 assert.ok(r.newlyUnlocked.some(a=>a.id==='first_edict'),'新增里要报 first_edict');
 // 只有代决与例行推进时：一条都不认领
 const aiOnly=evaluateForRun({runId:'run-test-1',world,events:[advance],dir});
 assert.equal(aiOnly.progress.find(p=>p.id==='first_edict').unlocked,false,'太尉代决不冒领 first_edict');
 // 同一份输入两次评估：纯函数，解锁集合一致
 const again=evaluateForRun({runId:'run-test-1',world,events:[advance,decide,order],dir});
 assert.deepEqual(again.progress,r.progress,'同输入同输出');
});

test('跨局累计由宿主经 stats 供给：runs_completed 达线才解锁五局老将',(t)=>{
  const dir=freshDir(t);
  const bare=evaluateForRun({runId:'run-test-1',world:worldFixture(),events:eventFixture(),dir});
  assert.equal(bare.progress.find(p=>p.id==='veteran_five_runs').unlocked,false);
  const veteran=evaluateForRun({runId:'run-test-1',world:worldFixture(),events:eventFixture(),stats:{runs_completed:5},dir});
  assert.equal(veteran.progress.find(p=>p.id==='veteran_five_runs').unlocked,true);
  assert.ok(veteran.newlyUnlocked.some(a=>a.id==='veteran_five_runs'));
});

test('成就簿：往返、首次解锁日号即终值、重复 commit 不重复记、损坏按空簿开局',(t)=>{
  const dir=freshDir(t);
  assert.deepEqual(loadUnlocked(dir),{},'缺文件是空簿不是错');
  saveUnlocked(dir,{first_edict:0,treasury_10k:400});
  assert.deepEqual(loadUnlocked(dir),{first_edict:0,treasury_10k:400});
  const u2={id:'fire_attack',name:'火攻得手',description:'火攻之计当真烧到了敌军',tier:'silver',unlockedAt:410};
  assert.deepEqual(commitUnlocks(dir,[{id:'first_edict',name:'初次请旨',description:'第一次亲自拍板一项决策',tier:'bronze',unlockedAt:0}]),[],'簿里已有的条目不重复记');
  assert.deepEqual(commitUnlocks(dir,[u2,u2]),[u2],'同一批里重复的也只记一次');
  assert.deepEqual(loadUnlocked(dir),{first_edict:0,treasury_10k:400,fire_attack:410});
  assert.deepEqual(commitUnlocks(dir,[{...u2,unlockedAt:999}]),[],'第一次解锁的日号是终值：后来的 commit 不覆写');
  assert.equal(loadUnlocked(dir).fire_attack,410);
  // 坏条目逐个丢，不牵连整本簿
  saveUnlocked(dir,{fire_attack:410,bad:'x',negative:-1,frac:1.5});
  assert.deepEqual(loadUnlocked(dir),{fire_attack:410,frac:1.5});
  // 文件损坏：按空簿开局、留痕，且不赖掉后续 commit
  writeFileSync(join(dir,'achievements.json'),'{oops','utf8');
  const origin=console.warn;const notes=[];console.warn=(...a)=>notes.push(a.join(' '));
  try{assert.deepEqual(loadUnlocked(dir),{});}finally{console.warn=origin;}
  assert.ok(notes.some(n=>n.includes('achievements.json')),'损坏要记一条 note');
  assert.deepEqual(commitUnlocks(dir,[u2]),[{...u2,unlockedAt:410}],'空簿开局后照常记新解锁');
  assert.equal(existsSync(join(dir,'achievements.json.tmp')),false,'落盘后不留 .tmp');
});

test('槽位：空目录返回 8 个空槽，写/读/清与 nextFreeSlot 往返',(t)=>{
  const dir=freshDir(t);
  const empty=listSlots(dir);
  assert.equal(empty.length,8);assert.equal(MAX_SLOTS,8);
  assert.deepEqual(empty.map(s=>s.slot),[1,2,3,4,5,6,7,8]);
  assert.ok(empty.every(s=>s.gameId===''&&s.title===''&&s.savedAt===''&&s.revision===0&&s.elapsedDays===0&&s.court===''&&!s.auto),'空槽是占位不是 undefined');
  assert.equal(nextFreeSlot(dir),1,'空目录从 1 号槽开始');
  const written=writeSlot(dir,1,stub({gameId:'run-1',title:'一局',revision:6,elapsedDays:30,court:'attending'}));
  assert.equal(written.slot,1);assert.equal(written.gameId,'run-1');assert.equal(written.court,'attending');assert.equal(written.auto,false);
  assert.equal('payload' in written,false,'列举型返回刻意不带 payload');
  const read=readSlot(dir,1);
  assert.equal(read.gameId,'run-1');assert.equal(read.court,'attending');assert.equal(read.revision,6);assert.equal(read.elapsedDays,30);
  assert.equal(readSlot(dir,2),null,'没写过的槽是空的');
  assert.equal(nextFreeSlot(dir),2,'写过一个就顺延');
  assert.equal(listSlots(dir).filter(s=>s.gameId).length,1);
  clearSlot(dir,1);
  assert.equal(readSlot(dir,1),null);assert.equal(nextFreeSlot(dir),1,'清空后回到空槽');
  clearSlot(dir,1);assert.equal(readSlot(dir,1),null,'清槽幂等：重复清同一个槽不报错');
  assert.throws(()=>writeSlot(dir,9,stub()),/1—8/,'超范围槽位直接拒');
  assert.throws(()=>writeSlot(dir,2,stub({gameId:''})),/条目不完整/,'空对局编号直接拒');
});

test('nextFreeSlot：全满时优先最早的自动槽，没有自动槽返回 0',(t)=>{
  const dir=freshDir(t);
  for(let i=1;i<=8;i++)writeSlot(dir,i,stub({gameId:'run-'+i,title:'局'+i,savedAt:`2026-09-2${i}T10:00:00.000Z`,revision:i,elapsedDays:i}));
  assert.equal(nextFreeSlot(dir),0,'全满且无自动槽：交给玩家决定，不擅自覆盖');
  assert.equal(nextFreeSlot(dir,false),0,'明确不 preferAuto 时同样不擅自覆盖');
  writeSlot(dir,6,stub({gameId:'run-auto-new',title:'自动2',savedAt:'2026-09-25T10:00:00.000Z',auto:true}));
  writeSlot(dir,3,stub({gameId:'run-auto-old',title:'自动1',savedAt:'2026-09-01T10:00:00.000Z',auto:true}));
  assert.equal(nextFreeSlot(dir),3,'最早的自动槽先被覆盖');
  assert.equal(listSlots(dir)[2].auto,true,'自动标记如实落盘');
});

test('槽文件就是云存档条目：importRunFromSave 原样读回这个世界',(t)=>{
  const dir=freshDir(t);
  const run=runFixture(),world=worldFixture(),events=eventFixture();
  const entry=exportRunToSave(run,world,events);
  const written=writeSlot(dir,2,{...entry,court:'indulging',auto:true});
  assert.equal(written.slot,2);assert.equal(written.title,run.spec.title);assert.equal(written.revision,world.revision);assert.equal(written.elapsedDays,400);
  assert.equal(readdirSync(join(dir,'slots')).filter(f=>!f.endsWith('.json')).length,0,'原子写后不留 .tmp');
  const raw=JSON.parse(readFileSync(join(dir,'slots','slot-2.json'),'utf8'));
  assert.equal(raw.slot,2);assert.equal(raw.court,'indulging');assert.equal(raw.auto,true);
  assert.equal(raw.gameId,run.id);assert.equal(raw.payload,entry.payload,'槽里的 payload 就是 exportRunToSave 的原文');
  const back=importRunFromSave(raw);
  assert.equal(back.run.id,run.id);assert.equal(back.run.spec.title,run.spec.title);
  assert.equal(back.world.revision,world.revision);assert.equal(back.world.clock.elapsedDays,400);
  assert.deepEqual(back.world.cities,world.cities);assert.deepEqual(back.world.armies,world.armies);
  assert.equal(back.events.length,events.length);
  assert.deepEqual(back.events.map(e=>e.id),events.map(e=>e.id));
});

test('原子写：只有 .tmp 的半截文件不进列举，坏槽列举按空槽、真读要报错',(t)=>{
  const dir=freshDir(t);
  writeSlot(dir,4,stub({gameId:'run-4',title:'半局',revision:2,elapsedDays:9,court:'attending'}));
  mkdirSync(join(dir,'slots'),{recursive:true});
  writeFileSync(join(dir,'slots','slot-5.json.tmp'),'{"half":tr','utf8');
  writeFileSync(join(dir,'slots','slot-9.json'),'{"槽号超范围":true}','utf8');
  writeFileSync(join(dir,'slots','readme.txt'),'not a slot','utf8');
  writeFileSync(join(dir,'achievements.json.tmp'),'{"broken":','utf8');
  const slots=listSlots(dir);
  assert.equal(slots[3].gameId,'run-4','完整槽照常列出');
  assert.equal(slots[4].gameId,'','半截 .tmp 当空槽');
  assert.equal(slots[5].gameId,'','超范围槽号当空槽');
  assert.equal(slots.length,8,'杂名文件不改变槽位数');
  assert.deepEqual(loadUnlocked(dir),{},'成就簿的半截 .tmp 同样不影响读取');
  writeFileSync(join(dir,'slots','slot-6.json'),'not json','utf8');
  assert.equal(listSlots(dir)[5].gameId,'','坏槽在列举里按空槽呈现，列举永远不该 500');
  assert.throws(()=>readSlot(dir,6),/已损坏/,'真去读坏槽要给明确的中文错，而不是半截数据');
});

test('Steam cloud save backend is reachable, not just implemented',async()=>{
  // createSteamCloudSave 早就实现并导出了，但一度没有任何地方调用它——云端存档在 Steam 版
  // 等于没接，玩家存档只落本地，商店页的「Steam Cloud」是空的。这条守住「接线真的存在」：
  // 一路查编译产物里确实调了它，一路查函数本身在真机可用。
  const dist=readFileSync(join(HERE,'..','dist','server.js'),'utf8');
  assert.ok(dist.includes('createSteamCloudSave'),'编译产物里必须调 createSteamCloudSave');
  assert.ok(/cloudProvider/.test(dist),'必须有按可用性选后端的逻辑');
  assert.ok(dist.includes("'steam':'local'")||dist.includes('cloud:'),'响应要能区分云端与本地');
  // 真机那段必须在**子进程**里跑：steamworks.js 的 init() 内部起了 setInterval(runCallbacks)
  // 且永不清除，在本进程里 init 会让 node --test 挂住不退出（实测整个文件超时 180s）。
  // 子进程自己显式 process.exit，父进程只读它的结论。
  // 路径经环境变量传，不经命令行/-e 拼进去：仓库在 CJK 路径（历史游戏）下，命令行与 -e
  // 源码里的路径转义各实现不一，实测解析不到模块。
  const root=fileURLToPath(new URL('../..',import.meta.url));
  const probe=`
    const {pathToFileURL}=await import('node:url');
    const steam=await import(pathToFileURL(process.env.PROBE_STEAM).href);
    const st=steam.initSteam('480');
    if(!st.available){console.log('NO_STEAM:'+(st.reason||''));process.exit(0);}
    const cs=await import(pathToFileURL(process.env.PROBE_CLOUD).href);
    const p=cs.createSteamCloudSave(st.appId);
    const list=await p.list();
    console.log('AVAILABLE:'+p.available+':LISTED:'+list.length);
    process.exit(0);`;
  const r=spawnSync(process.execPath,['--input-type=module','-e',probe],{
    encoding:'utf8',timeout:90000,windowsHide:true,
    env:{...process.env,PROBE_STEAM:join(root,'steam','steam.mjs'),PROBE_CLOUD:join(root,'steam','cloud-save.mjs')},
  });
  const out=String(r.stdout||'')+String(r.stderr||'');
  const m=out.match(/(NO_STEAM:.+|AVAILABLE:true:LISTED:\d+)/);
  assert.ok(m,'子进程应给出可判定的结论，实际输出：'+out.slice(-300));
  if(m[1].startsWith('NO_STEAM')){
    // 没 Steam 客户端：跳过后端探测（本地路径一行不变），但 reason 必须非空
    assert.ok(m[1].length>'NO_STEAM:'.length,'不可用也要给原因');
    return;
  }
  assert.equal(m[1].split(':')[1],'true','Steam 可用时云端后端必须 available');
});
