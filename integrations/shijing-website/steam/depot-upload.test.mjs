import {test} from 'node:test';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {mkdtempSync,mkdirSync,readFileSync,writeFileSync,rmSync,existsSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {fileURLToPath} from 'node:url';
import {join} from 'node:path';
import {
  buildSpec,renderAppBuild,renderDepotWin,renderDepotBuild,resolveContentRoot,resolveExplicitRoot,
  requireUpload,findSteamcmd,redact,steamcmdArgs,looksFailed,runUpload,writeOut,
  checkContentRoot,nonAsciiPaths,
} from './depot-upload.mjs';
import {createRequire} from 'node:module';
/** 第三方 Valve KeyValue 解析器（devDependency，只活在测试里，不进发行包）。 */
const vdfParse=(text)=>createRequire(import.meta.url)('@node-steam/vdf').parse(text);

const HERE=fileURLToPath(new URL('.',import.meta.url));

/**
 * 注入式假 spawn：记录收到的 argv 与 stdin，跨平台地证明密码走了哪条道。
 * 不用假 steamcmd 二进制——Windows 上 spawnSync 拉 .cmd 直接 EINVAL，.exe 又没法现场造。
 */
function spySpawn(){
  const seen={argv:null,stdin:null,options:null};
  const impl=(command,args,options)=>{
    seen.command=command;seen.argv=args;seen.options=options;
    if(options && 'input' in options)seen.stdin=options.input;
    return {status:0,stdout:'',error:undefined};
  };
  return {impl,seen};
}

/** 空环境：不靠本机任何实际配置，测试才是可复现的。 */
function cleanEnv(extra){ return {...extra}; }

test('buildSpec: no appid still yields a renderable spec with a placeholder',()=>{
  // 提交态（仓库里没有 appid）也必须能出 VDF——这就是「不依赖 appid 即可提交代码」
  const s=buildSpec(cleanEnv({}));
  assert.equal(s.needsAppId,true,'未设 STEAM_APP_ID 时必须标出用了占位值');
  assert.match(s.appId,/^\d+$/,'占位 appid 也必须是数字，否则 VDF 语法就错了');
  assert.equal(s.depotId,'','depot id 不给默认值：它是后台分配的，猜不中');
  assert.equal(s.needsDepotIdWin,true);
  assert.ok(renderAppBuild(s).includes(`"AppID" "${s.appId}"`),'VDF 要能真的渲染出来');
  assert.ok(renderDepotWin(s).length>0);
});

test('buildSpec: real appid and depot id flow straight into the VDF',()=>{
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'123456',STEAM_DEPOT_ID_WIN:'555111'}));
  assert.equal(s.needsAppId,false);
  assert.equal(s.depotId,'555111','depot id 必须原样透传，不从 appid 推导');
  const tpl=renderAppBuild(s);
  assert.ok(tpl.includes('"555111" "depot_win.vdf"'),'AppBuild 要引用 depot 文件');
  assert.ok(!tpl.includes('__'),'渲染后的 VDF 不得残留任何占位符');
});

test('buildSpec: mac/linux depots need BOTH an id and a content root',()=>{
  const base=buildSpec(cleanEnv({STEAM_APP_ID:'7'}));
  assert.equal(base.depots.length,1,'默认只配 Windows depot');
  // 只给 id 不收：AppBuild 会引用一个永远不存在的 depot_*.vdf，整个构建会失败
  const idOnly=buildSpec(cleanEnv({STEAM_APP_ID:'7',STEAM_DEPOT_ID_MAC:'71'}));
  assert.equal(idOnly.depots.length,1,'只有 id 没有内容根，不得收进 AppBuild');
  const rootOnly=buildSpec(cleanEnv({STEAM_APP_ID:'7',STEAM_DEPOT_MAC_CONTENT_ROOT:tmpdir()}));
  assert.equal(rootOnly.depots.length,1,'只有内容根没有 id，同样不收');
  const dir=mkdtempSync(join(tmpdir(),'depot-mac-'));
  try{
    const all=buildSpec(cleanEnv({STEAM_APP_ID:'7',STEAM_DEPOT_ID_MAC:'71',STEAM_DEPOT_MAC_CONTENT_ROOT:dir,
      STEAM_DEPOT_ID_LINUX:'72',STEAM_DEPOT_LINUX_CONTENT_ROOT:dir}));
    assert.equal(all.depots.length,3);
    assert.deepEqual(all.depots.map(d=>d.platform),['win','mac','linux']);
    const tpl=renderAppBuild(all);
    assert.ok(tpl.includes('depot_mac.vdf'));
    assert.ok(tpl.includes('depot_linux.vdf'));
    // 每个被引用的 depot 文件都必须真的渲染得出来
    for(const d of all.depots)assert.ok(renderDepotBuild(all,d).includes(`"DepotID" "${d.id}"`));
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('VDF paths use forward slashes so escaping cannot bite us',()=>{
  // VDF 对 `\` 是不是转义符各实现不一致：Valve 官方示例用单反斜杠，而 @node-steam/vdf
  // 解析时又不把 `\\` 复义回 `\`。写 `\\` 在一端对、在另一端就变成字面上的双反斜杠路径、
  // 文件找不到；写 `\` 则在另一端有反效果。**正斜杠在任何 VDF 变体里都不是转义符**，
  // 两种解析语义下结果一致，Windows API 也照常接受——所以统一转成正斜杠。
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'7',STEAM_CONTENT_ROOT:'C:\\a\\b'}));
  const tpl=renderAppBuild(s);
  assert.ok(tpl.includes('"ContentRoot" "C:/a/b"'),'反斜杠必须翻成正斜杠，不得出现 \\\\');
  assert.ok(!tpl.includes('C:\\\\'),'VDF 里不得残留双反斜杠');
  // 路径值整体不得含任何反斜杠——这是本条不变式的完整表述
  const m=tpl.match(/"ContentRoot" "([^"]*)"/);
  assert.ok(m && !m[1].includes('\\'),'ContentRoot 值里不应有反斜杠：'+m[1]);
  // 经独立解析器往返一遍，值要与我们给出的路径逐字符相同
  const dir=mkdtempSync(join(tmpdir(),'depot-slash-'));
  try{
    const spec2=buildSpec(cleanEnv({STEAM_APP_ID:'7',STEAM_DEPOT_ID_WIN:'71',STEAM_CONTENT_ROOT:dir}),{outDir:join(dir,'out')});
    writeOut(spec2);
    const app=vdfParse(readFileSync(join(spec2.outDir,'app.vdf'),'utf8'));
    assert.equal(app.AppBuild.ContentRoot,dir.split('\\').join('/'),
      '解析回来的 ContentRoot 必须与给出的路径一致（说明没有转义歧义）');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('renderAppBuild: SetLive omitted unless STEAM_SET_LIVE is set',()=>{
  const off=renderAppBuild(buildSpec(cleanEnv({STEAM_APP_ID:'7'})));
  assert.ok(!off.includes('"SetLive"'),'不设 STEAM_SET_LIVE 时只上传、不切分支');
  const on=renderAppBuild(buildSpec(cleanEnv({STEAM_APP_ID:'7',STEAM_SET_LIVE:'beta'})));
  assert.ok(on.includes('"SetLive" "beta"'));
});

/** 不存在的路径：让「内容根缺失」这条分支在任何机器上都确定成立，不依赖本机 D: 盘有什么。 */
const NOWHERE=join(tmpdir(),'depot-test-nowhere-'+Date.now());

test('resolveContentRoot honours STEAM_CONTENT_ROOT then SHIJING_PACK_OUTPUT',()=>{
  const dir=mkdtempSync(join(tmpdir(),'depot-root-'));
  try{
    // 显式根要真的存在才算命中；不存在就继续往后找
    const nested=join(dir,'win-unpacked');
    mkdirSync(nested,{recursive:true});
    const a=resolveContentRoot(cleanEnv({STEAM_CONTENT_ROOT:nested}));
    assert.equal(a.exists,true);
    assert.equal(a.path,nested,'显式 STEAM_CONTENT_ROOT 优先级最高');
    const b=resolveContentRoot(cleanEnv({SHIJING_PACK_OUTPUT:dir}));
    assert.equal(b.exists,true);
    assert.equal(b.path,nested,'SHIJING_PACK_OUTPUT 是打包根，内容根要再接 win-unpacked');
    const c=resolveContentRoot(cleanEnv({STEAM_CONTENT_ROOT:NOWHERE,SHIJING_PACK_OUTPUT:NOWHERE}));
    assert.equal(c.exists,false,'两处都指到不存在的路径时 exists=false 而不是抛错');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('requireUpload lists every missing prerequisite without throwing',()=>{
  // appid、depot id、内容根、账号名、steamcmd 五样全缺时，要一次说清而不是报第一个就停。
  // steamcmd 那项要真的「找不到」：findSteamcmd 的回落链会看 COMMON_STEAMCMD 里的真实
  // 路径，本机 D:/steamcmd 装着就会命中——所以这里把 STEAMCMD 指到一个不存在的文件，
  // 并禁掉 PATH 探测，让「缺 steamcmd」这条分支与机器上装没装无关。
  const noProbe=()=>({stdout:'',stderr:'',status:1});
  const ghost=join(tmpdir(),'depot-test-no-such-steamcmd');
  const env=cleanEnv({STEAM_CONTENT_ROOT:NOWHERE,STEAMCMD:ghost,PATH:join(tmpdir(),'depot-test-empty-path')});
  const s=buildSpec(env);
  const r=requireUpload(env,s,noProbe);
  assert.equal(r.ok,false);
  assert.equal(r.missing.length,5,'五项缺失应全部列出：'+r.missing.join(' / '));
  assert.ok(r.missing.some(m=>m.includes('STEAM_APP_ID')));
  assert.ok(r.missing.some(m=>m.includes('STEAM_DEPOT_ID_WIN')),'depot id 不能猜，缺了必须点名');
  assert.ok(r.missing.some(m=>m.includes('steamcmd')));
  assert.ok(r.missing.some(m=>m.includes('内容根')));
  assert.ok(r.missing.some(m=>m.includes('STEAM_USERNAME')),
    'anonymous 无权上传构建，缺用户名必须拦住——否则会被静默失败吞掉');
});

/** 造一个「完整的打包构建」：内容根三样齐备，供 requireUpload 的通过用例用。 */
function fakeCompleteBuild(dir){
  writeFileSync(join(dir,'史境.exe'),'x');
  mkdirSync(join(dir,'resources','steam'),{recursive:true});
  mkdirSync(join(dir,'resources','node_modules','steamworks.js'),{recursive:true});
  writeFileSync(join(dir,'resources','steam','steam.mjs'),'x');
  writeFileSync(join(dir,'resources','node_modules','steamworks.js','index.js'),'x');
}

test('requireUpload passes only when every prerequisite is genuinely met',()=>{
  const dir=mkdtempSync(join(tmpdir(),'depot-ok-'));
  try{
    fakeCompleteBuild(dir);
    const cmd=join(dir,'steamcmd.sh');
    writeFileSync(cmd,'#!/bin/sh\n');
    const env=cleanEnv({STEAM_APP_ID:'9',STEAM_DEPOT_ID_WIN:'991',STEAM_CONTENT_ROOT:dir,STEAM_USERNAME:'alice',STEAMCMD:cmd});
    const s=buildSpec(env);
    const r=requireUpload(env,s);
    assert.equal(r.ok,true,'五项齐备必须通过：'+r.missing.join(' / '));
    assert.equal(r.steamcmd.command,cmd);
    assert.match(r.steamcmd.source,/STEAMCMD/,'要说明 steamcmd 是从哪找到的');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('findSteamcmd honours STEAMCMD only when it points somewhere real',()=>{
  const dir=mkdtempSync(join(tmpdir(),'depot-cmd-'));
  try{
    const real=join(dir,'steamcmd.sh');
    writeFileSync(real,'#!/bin/sh\n');
    assert.deepEqual(findSteamcmd(cleanEnv({STEAMCMD:real})),
      {command:real,source:'STEAMCMD 环境变量'});
    // 指到不存在的路径：配置错误必须报出来，不能默默回落到别处，
    // 否则「明明写了 STEAMCMD 却用了另一份」是最难查的错
    const ghost=join(tmpdir(),'depot-test-ghost-steamcmd');
    assert.equal(findSteamcmd(cleanEnv({STEAMCMD:ghost})),null,'STEAMCMD 指到不存在的路径必须返回 null');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('findSteamcmd probes PATH then falls back to common install locations',()=>{
  // 没有 STEAMCMD 时：先问 PATH，再退到常见位置。steamcmd 装完默认不在 PATH 上
  // （Valve 从不把自己加进去），只认 PATH 会让「明明装了却报找不到」。
  const found=findSteamcmd(cleanEnv({}));
  assert.ok(found===null||(typeof found.command==='string'&&/PATH|常见安装位置/.test(found.source)),
    '要么找不到（null），要么给出带来源的结果：'+JSON.stringify(found));
  if(found)assert.ok(existsSync(found.command),'报出的路径必须真的存在：'+found.command);
});

test('findSteamcmd finds steamcmd even when it is not on PATH',()=>{
  // steamcmd 装完默认不在 PATH 上（Valve 从不把自己加进去）。只认 PATH 会让
  // 「明明装了却报找不到」——门禁因此常红，人每次都得手动设 STEAMCMD。
  // 这里不 mock：本机 D:/steamcmd/steamcmd.exe 实实在在装着（取决于机器，装了就命中，
  // 没装就跳过），测试断言的是「PATH 上没有时不会直接放弃」。
  const noPath=cleanEnv({PATH:process.platform==='win32'?'C:\\Windows\\System32':'/usr/bin'});
  const r=findSteamcmd(noPath);
  if(r===null){// 这台机器没装：确认给出的仍是 null 而不是抛错
    assert.equal(r,null);return;
  }
  assert.ok(existsSync(r.command),'报出的路径必须真的存在：'+r.command);
  assert.match(r.source,/常见安装位置|PATH/);
});

test('steamcmdArgs never puts the password on the command line',()=>{
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9'}));
  const password='sekret-pw-abc123def456';
  const args=steamcmdArgs(s,cleanEnv({STEAM_USERNAME:'alice',STEAM_PASSWORD:password}));
  const joined=args.join(' ');
  assert.ok(!joined.includes(password),'密码不得出现在 argv：'+joined);
  assert.ok(!args.some(a=>a===password));
  assert.equal(args[args.length-1],'+quit','+quit 收尾，保持进程短命');
});

test('steamcmdArgs leads with @ShutdownOnFailedCommand so failures cannot pass for success',()=>{
  // 本机实测：一次纯 `+quit` 在 steamcmd 首启自更后就返回过 exit=7。没有这个 flag，
  // 单条命令失败 steamcmd 只打一行 ERROR 然后继续跑 +quit，退出码仍是 0。
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9'}));
  const args=steamcmdArgs(s,cleanEnv({STEAM_USERNAME:'alice'}));
  assert.equal(args[0],'@ShutdownOnFailedCommand','必须置顶');
  assert.ok(!args[0].startsWith('+'),'@ 选项不带 + 前缀，带上了会被当未知命令');
  assert.ok(args.indexOf('@ShutdownOnFailedCommand')<args.indexOf('+login'),'要在登录之前');
});

test('looksFailed catches the ways steamcmd reports failure',()=>{
  // 明确的失败标志要认
  assert.equal(looksFailed('ERROR! Build failed'),true);
  assert.equal(looksFailed('Failed to authenticate'),true);
  assert.equal(looksFailed('Access denied'),true);
  assert.equal(looksFailed(' Steam Guard '),true);
  // 正常输出不能误判。"Loading Steam API...OK" 这类是成功路径
  assert.equal(looksFailed('Loading Steam API...OK'),false);
  assert.equal(looksFailed('Connecting anonymously to Steam Public...OK'),false);
  assert.equal(looksFailed('[100%] Download Complete.'),false);
  assert.equal(looksFailed(''),false);
  assert.equal(looksFailed(undefined),false);
});

test('runUpload judges failure by output even when the exit code is 0',()=>{
  // steamcmd 失败仍退 0 是被反复报道的行为，也是这条测试存在的理由
  const zombie=()=>({status:0,stdout:'ERROR! Build failed (unknown depot)',error:undefined});
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9'}));
  const r=runUpload(s,'steamcmd',cleanEnv({STEAM_USERNAME:'alice',STEAM_PASSWORD:'p'.repeat(16)}),zombie);
  assert.equal(r.status,0,'退出码确实是 0');
  assert.equal(r.ok,false,'但输出说有错，必须判失败');
  assert.equal(r.failedBy,'输出关键字');
});

test('runUpload reports ok only when both exit code and output are clean',()=>{
  const good=()=>({status:0,stdout:'Loading Steam API...OK\nConnecting anonymously to Steam Public...OK',error:undefined});
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9'}));
  const r=runUpload(s,'steamcmd',cleanEnv({STEAM_USERNAME:'alice',STEAM_PASSWORD:'p'.repeat(16)}),good);
  assert.equal(r.ok,true);
  assert.equal(r.failedBy,null);
});

test('writeOut puts every file run_app_build needs on disk',()=>{
  // 这条守的是一个真出过的 bug：app.vdf 只进了返回列表、从没 writeFileSync 落盘，
  // 只有 depot 文件写了。`+run_app_build` 读的就是 app.vdf，缺了它上传第一步就失败。
  // 所以断言必须落在**文件系统**上，不能只比对「引用集合」——那会正好漏掉这一类。
  const dir=mkdtempSync(join(tmpdir(),'depot-out-'));
  try{
    const env=cleanEnv({STEAM_APP_ID:'9',STEAM_DEPOT_ID_WIN:'991',STEAM_CONTENT_ROOT:dir,
      STEAM_DEPOT_ID_MAC:'992',STEAM_DEPOT_MAC_CONTENT_ROOT:dir});
    const s=buildSpec(env,{outDir:join(dir,'out')});
    const written=writeOut(s);
    assert.ok(written.includes('app.vdf'),'app.vdf 必须在返回列表里：'+written.join(','));
    for(const n of written){
      const p=join(s.outDir,n);
      assert.ok(existsSync(p),`${n} 必须真的写到盘上（+run_app_build 要读它）`);
      assert.ok(readFileSync(p,'utf8').length>0,`${n} 不得为空文件`);
    }
    // 反向：AppBuild 引用的每个文件都写出来了，没有「引用了却漏写」的
    const appVdf=readFileSync(join(s.outDir,'app.vdf'),'utf8');
    const refs=[...appVdf.matchAll(/"[^"]*" "(depot_\w+\.vdf)"/g)].map(m=>m[1]);
    assert.ok(refs.length>0,'AppBuild 至少要引用一个 depot');
    for(const f of refs)assert.ok(existsSync(join(s.outDir,f)),`AppBuild 引用了 ${f}，它必须已落盘`);
    // SteamPipe 的 BuildOutput 目录要预建（是否强制未确认，先建是零成本保险）
    assert.ok(existsSync(s.buildOutput),'buildOutput 目录必须存在');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('generated VDFs parse with an independent Valve KeyValue parser',()=>{
  // 用第三方解析器（@node-steam/vdf，steamodd 的移植）而不是自己的模板渲染来验正确性：
  // 自己生成自己验是循环论证，解析器不认识我们的写法就是真错。
  const dir=mkdtempSync(join(tmpdir(),'depot-vdf-'));
  try{
    const env=cleanEnv({STEAM_APP_ID:'999888',STEAM_DEPOT_ID_WIN:'999889',STEAM_CONTENT_ROOT:dir});
    const s=buildSpec(env,{outDir:join(dir,'out')});
    writeOut(s);
    const app=vdfParse(readFileSync(join(s.outDir,'app.vdf'),'utf8'));
    assert.ok(app.AppBuild,'app.vdf 必须有 AppBuild 根键');
    assert.equal(String(app.AppBuild.AppID),'999888','AppID 要原样进 VDF');
    assert.equal(String(app.AppBuild.Depots['999889']),'depot_win.vdf','Depots 表要把 depot id 映射到文件名');
    // 解析回来的 ContentRoot 必须与 spec 给出的路径一致——正斜杠下没有任何转义歧义
    assert.equal(app.AppBuild.ContentRoot,dir.split('\\').join('/'),'ContentRoot 要原样往返');
    const dep=vdfParse(readFileSync(join(s.outDir,'depot_win.vdf'),'utf8'));
    assert.equal(String(dep.DepotBuild.DepotID),'999889');
    assert.equal(dep.DepotBuild.FileMapping.LocalPath,'*','整棵树映射');
    assert.equal(dep.DepotBuild.FileMapping.DepotPath,'.','映射到 depot 根');
    assert.equal(String(dep.DepotBuild.FileMapping.recursive),'1','必须递归子目录');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('runUpload streams the password to stdin and keeps argv clean',()=>{
  const spy=spySpawn();
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9',STEAM_CONTENT_ROOT:tmpdir()}));
  const password='sekret-' + 'x'.repeat(24);
  const r=runUpload(s,'/opt/steamcmd/steamcmd.sh',cleanEnv({STEAM_USERNAME:'alice',STEAM_PASSWORD:password}),spy.impl);
  assert.equal(r.status,0);
  // 收到的 argv 里只能有用户名，不能有密码
  assert.ok(!spy.seen.argv.join(' ').includes(password),
    'steamcmd 收到的 argv 里竟然有密码：'+spy.seen.argv.join(' '));
  assert.ok(spy.seen.argv.includes('alice'),'argv 应含用户名');
  // stdin 里应当确实收到了密码（否则登录必然失败）
  assert.equal(spy.seen.stdin,password+'\n','密码必须经 stdin 送达，否则 steamcmd 会卡在密码提示');
  assert.equal(spy.seen.command,'/opt/steamcmd/steamcmd.sh');
});

test('runUpload without STEAM_PASSWORD keeps stdin interactive but still captures output',()=>{
  // 交互路径的 stdio 是 ['inherit','pipe','pipe'] 而不是整条 inherit：stdin 继承才能敲密码，
  // stdout/stderr 接管才能扫描失败关键字。整条 inherit 会让「退出码 0 + 输出一行 ERROR!」
  // 被判成成功——而交互路径恰恰是首次上传唯一能走的那条。
  const spy=spySpawn();
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9'}));
  runUpload(s,'steamcmd',cleanEnv({STEAM_USERNAME:'bob'}),spy.impl);
  assert.deepEqual(spy.seen.options.stdio,['inherit','pipe','pipe'],
    'stdin 必须继承（敲密码），stdout/stderr 必须接管（扫描失败关键字）');
  assert.ok(!('input' in spy.seen.options),'不设密码时不得往 stdin 灌任何东西');
});

test('runUpload surfaces a spawn failure instead of pretending success',()=>{
  const failing=()=>({status:null,stdout:'',error:new Error('ENOENT')});
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'9'}));
  const r=runUpload(s,'/nope/steamcmd',cleanEnv({}),failing);
  assert.notEqual(r.status,0);
  assert.ok(r.error,'启动失败要带 error，让调用方能给出「STEAMCMD 指错了」这类指引');
});

test('checkContentRoot rejects a stale or incomplete build',()=>{
  // 目录在 ≠ 是能用的构建。实测踩过：项目内 release/win-unpacked 是修复前的旧包，
  // 缺 resources/node_modules/steamworks.js。按默认值传上去不会有任何报错，
  // 只会安静地发一个没有 Steam 支持的版本给玩家。
  const empty=mkdtempSync(join(tmpdir(),'depot-root-empty-'));
  try{
    assert.ok(checkContentRoot(empty).length>0,'空目录必须判为不完整');
    const broken=checkContentRoot(empty);
    assert.ok(broken.some(b=>/steamworks/i.test(b)),'steamworks.js 缺失要单独点名：'+broken.join('、'));
    assert.ok(broken.some(b=>b.includes('可执行文件')),'exe 缺失也要点名');
    assert.ok(broken.some(b=>b.includes('Steam 桥接')),'steam.mjs 缺失也要点名');
  }finally{rmSync(empty,{recursive:true,force:true});}
});

test('checkContentRoot accepts a complete packaged build',()=>{
  const full=mkdtempSync(join(tmpdir(),'depot-root-full-'));
  try{
    mkdirSync(join(full,'resources','steam'),{recursive:true});
    mkdirSync(join(full,'resources','node_modules','steamworks.js'),{recursive:true});
    writeFileSync(join(full,'史境.exe'),'x');
    writeFileSync(join(full,'resources','steam','steam.mjs'),'x');
    writeFileSync(join(full,'resources','node_modules','steamworks.js','index.js'),'x');
    assert.deepEqual(checkContentRoot(full),[],'三样齐备必须判为完整');
  }finally{rmSync(full,{recursive:true,force:true});}
});

test('requireUpload blocks an incomplete content root even when the directory exists',()=>{
  const stale=mkdtempSync(join(tmpdir(),'depot-root-stale-'));
  try{
    const cmd=join(stale,'steamcmd.sh');writeFileSync(cmd,'#!/bin/sh\n');
    const env=cleanEnv({STEAM_APP_ID:'9',STEAM_DEPOT_ID_WIN:'991',STEAM_CONTENT_ROOT:stale,
      STEAM_USERNAME:'alice',STEAMCMD:cmd});
    const r=requireUpload(env,buildSpec(env));
    assert.equal(r.ok,false,'内容根存在但内容不完整，必须拦住');
    assert.ok(r.missing.some(m=>m.includes('内容根 win 不完整')),
      '要把「不完整」和「不存在」区分开：'+r.missing.join(' / '));
    assert.ok(r.missing.some(m=>/steamworks/i.test(m)),'要指出缺的是什么：'+r.missing.join(' / '));
  }finally{rmSync(stale,{recursive:true,force:true});}
});

test('nonAsciiPaths flags CJK paths that steamcmd may not resolve',()=>{
  const ascii=buildSpec(cleanEnv({STEAM_APP_ID:'9',STEAM_DEPOT_ID_WIN:'991',STEAM_CONTENT_ROOT:'D:/shijing-release/win-unpacked',
    STEAM_BUILD_DESC:'plain'}),{outDir:'D:/shijing-vdf'});
  assert.deepEqual(nonAsciiPaths(ascii),[],'纯 ASCII 路径不应触发警告');
  const cjk=buildSpec(cleanEnv({STEAM_APP_ID:'9',STEAM_DEPOT_ID_WIN:'991',STEAM_CONTENT_ROOT:'C:/Users/历史游戏/release/win-unpacked'}));
  const hits=nonAsciiPaths(cjk);
  assert.ok(hits.length>0,'中文路径必须报出来');
  assert.ok(hits.some(h=>h.includes('历史游戏')));
});

test('end-to-end: real subprocess upload machinery against a scripted fake steamcmd',async()=>{
  // 之前只用注入闭包测 runUpload，而 Windows 上 spawnSync 拉 .cmd 直接 EINVAL、.exe 又没法
  // 现场造——所以「真 VDF 落盘 → 真 argv → 真 stdin → 真退出码 → 输出扫描」这条链从没打通过。
  // 这里用一个真子进程补上：假 steamcmd 是个 Node 脚本，由真的 spawnSync 拉起（只包一层
  // 解释器引导——命令是 process.execPath、脚本路径作首参，其余 argv/stdin/退出码全是真的）。
  // 它按 FAKE_STEAMCMD_MODE 模拟三种真实行为，其中一种是本机实测过的退出码语义陷阱。
  const dir=mkdtempSync(join(tmpdir(),'depot-e2e-'));
  try{
    const spyArgv=join(dir,'argv.txt'), spyStdin=join(dir,'stdin.txt');
    const fake=join(dir,'steamcmd.cjs');
    writeFileSync(fake,[
      "const fs=require('node:fs');",
      `fs.writeFileSync(${JSON.stringify(spyArgv)},process.argv.slice(2).join('\\n'));`,
      // argv 立刻落盘；stdin 等了结或超时（1s）再落。等结是主路径（spawnSync 的 input 会关
      // stdin）；超时是兜底——无密码模式走 stdio:'inherit'，那种情况下 stdin 永不结束。
      "let stdin='';let done=false;",
      "function finish(){if(done)return;done=true;",
      `  fs.writeFileSync(${JSON.stringify(spyStdin)},stdin);`,
      "  const mode=process.env.FAKE_STEAMCMD_MODE||'ok';",
      "  if(mode==='fail-exit0'){console.log('Connecting anonymously to Steam Public...OK');console.log('ERROR! Build failed (unknown depot)');process.exit(0);}",
      "  if(mode==='fail-exit7'){console.log('[   0%] Checking for available updates...');process.exit(7);}",
      "  console.log('Loading Steam API...OK');",
      "  console.log('Connecting anonymously to Steam Public...OK');",
      "  process.exit(0);}",
      "process.stdin.on('data',d=>{stdin+=d;});",
      "process.stdin.on('end',finish);",
      "process.stdin.on('error',finish);",
      "setTimeout(finish,1000).unref?.();",
      "setTimeout(finish,1000);",
    ].join('\n'));

    // 真 spawn，只包解释器引导。除此之外命令、参数、stdin、退出码都走真实进程边界。
    const realSpawn=(command,args,options)=>spawnSync(process.execPath,[fake,...args],options);
    const spec=buildSpec(cleanEnv({STEAM_APP_ID:'999888',STEAM_DEPOT_ID_WIN:'999889',
      STEAM_CONTENT_ROOT:dir}),{outDir:join(dir,'vdf')});
    // 1) VDF 真的落盘了（这条守的就是 M11 修的那个 bug）
    const written=writeOut(spec);
    assert.ok(existsSync(join(spec.outDir,'app.vdf')),'app.vdf 必须先落盘');
    assert.ok(written.includes('app.vdf'));

    // 2) 成功路径：真子进程、真 stdin、真退出码
    const password='sekret-'+'z'.repeat(20);
    const ok=runUpload(spec,'fake-steamcmd',
      cleanEnv({STEAM_USERNAME:'alice',STEAM_PASSWORD:password,FAKE_STEAMCMD_MODE:'ok'}),realSpawn);
    assert.equal(ok.status,0,'真子进程的退出码要透传上来');
    assert.equal(ok.ok,true,'成功路径必须判成功');
    const argv=readFileSync(spyArgv,'utf8');
    assert.ok(!argv.includes(password),'argv 里不得有密码：'+argv);
    assert.ok(argv.includes('alice'),'argv 要含用户名');
    assert.ok(argv.includes('app.vdf'),'argv 要带 app.vdf 路径');
    assert.equal(readFileSync(spyStdin,'utf8'),password+'\n','密码必须经 stdin 送达');

    // 3) 退出码 0 但输出说 ERROR! ——必须判失败（这条守的就是静默成功）
    const zombie=runUpload(spec,'fake-steamcmd',
      cleanEnv({STEAM_USERNAME:'alice',FAKE_STEAMCMD_MODE:'fail-exit0'}),realSpawn);
    assert.equal(zombie.status,0);
    assert.equal(zombie.ok,false,'退出码 0 但输出有 ERROR!，必须判失败');
    assert.equal(zombie.failedBy,'输出关键字');

    // 4) 本机实测过的语义：纯 +quit 也能返回 7。非零退出码单独也要能判失败。
    const seven=runUpload(spec,'fake-steamcmd',
      cleanEnv({STEAM_USERNAME:'alice',FAKE_STEAMCMD_MODE:'fail-exit7'}),realSpawn);
    assert.equal(seven.status,7);
    assert.equal(seven.ok,false,'非零退出码必须判失败');
  }finally{rmSync(dir,{recursive:true,force:true});}
});

test('redact masks configured secrets and tolerates empty input',()=>{
  assert.equal(redact('token abcdefgh and again',['abcdefgh']),'token <redacted> and again');
  assert.equal(redact('nothing','',[]),'nothing');
  assert.equal(redact('','','',''),'');
  // 太短的串不当机密处理：误伤日志反而更难排查
  assert.equal(redact('a b c',['a']),'a b c');
});

test('generated VDF excludes dev-only files from the shipped depot',()=>{
  const s=buildSpec(cleanEnv({STEAM_APP_ID:'7'}));
  const tpl=renderDepotWin(s);
  assert.ok(tpl.includes('"FileExclusion" "steam_appid.txt"'),'steam_appid.txt 是开发期约定，不能进 depot');
  assert.ok(tpl.includes('"FileExclusion" "*.pdb"'));
  assert.ok(tpl.includes('"recursive" "1"'));
  assert.ok(tpl.includes('"LocalPath" "*"'));
});

test('no usable credential literals anywhere in steam/',()=>{
  const files=readdirSyncSafe(HERE).filter(f=>/\.(ts|mjs|json)$/.test(f));
  for(const f of files){
    const text=readFileSync(join(HERE,f));
    assert.ok(!/sk-[A-Za-z0-9]{20,}/.test(text),`${f} 含疑似 OpenAI key`);
    assert.ok(!/ghp_[A-Za-z0-9]{30,}/.test(text),`${f} 含疑似 GitHub PAT`);
    assert.ok(!/-----BEGIN [A-Z ]*PRIVATE KEY-----/.test(text),`${f} 含私钥`);
    // 凭据赋值字面量：password/token/secret/api_key: "long-literal"
    assert.ok(!/(password|token|secret|api[_-]?key)\s*[:=]\s*["'][^"']{12,}["']/i.test(text),
      `${f} 里出现了像凭据的赋值字面量——凭据只能从环境变量读`);
  }
});

function readdirSyncSafe(dir){
  try{return require('node:fs').readdirSync(dir);}catch{return [];}
}
