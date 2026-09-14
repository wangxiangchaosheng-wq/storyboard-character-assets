import {spawn} from 'node:child_process';
import {readFileSync,existsSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
import {parseEnv} from 'node:util';
import {createConnection} from 'node:net';
const root=fileURLToPath(new URL('../',import.meta.url));
const site=root+'integrations/shijing-website/';
for(const p of [root+'.env',site+'.env',root+'node_modules',site+'node_modules']) {
 if(!existsSync(p)) throw new Error('缺少配置或依赖：'+p);
}
const backend=parseEnv(readFileSync(root+'.env','utf8'));
const frontend=parseEnv(readFileSync(site+'.env','utf8'));
const ports=[Number(backend.PORT||8787),Number(frontend.AGENT_PORT||4318),Number(frontend.WEB_PORT||3002)];
const expected='http://127.0.0.1:'+ports[0];
if(frontend.SIM_ENGINE_URL?.replace(/\/$/,'')!==expected) throw new Error('网页 .env 的 SIM_ENGINE_URL 应为 '+expected);
const busy=(port,host)=>new Promise(resolve=>{const s=createConnection({port,host});const done=v=>{s.destroy();resolve(v)};s.once('connect',()=>done(true));s.once('error',()=>done(false));s.setTimeout(800,()=>done(false));});
for(const port of ports) if(await busy(port,'127.0.0.1')||await busy(port,'::1')) throw new Error('端口 '+port+' 已在使用，请先关闭原启动窗口中的服务。');
const children=[];let stopping=false;
function stop(){if(stopping)return;stopping=true;for(const p of children){try{if(process.platform==='win32')p.kill('SIGTERM');else process.kill(-p.pid,'SIGTERM')}catch{}}}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
function start(bin,args,cwd){const p=spawn(bin,args,{cwd,stdio:'inherit',detached:process.platform!=='win32'});children.push(p);p.on('error',e=>{console.error(e.message);process.exitCode=1;stop()});p.on('exit',code=>{if(!stopping){process.exitCode=code||1;stop()}});return p;}
start(process.execPath,['--env-file='+root+'.env','--experimental-strip-types','src/index.ts'],root+'packages/serve');
let ready=false;
for(let n=0;n<30&&!stopping;n++){
 try{const r=await fetch(expected+'/healthz',{signal:AbortSignal.timeout(1000)});if(r.ok&&(await r.json()).ok){ready=true;break}}catch{}
 await new Promise(r=>setTimeout(r,500));
}
if(!ready){console.error('队友后端启动失败，请查看上方提示。');process.exitCode=1;stop()}
else {start(process.platform==='win32'?'npm.cmd':'npm',['run','dev:agents'],site);console.log('正在启动史境完整服务，网页地址：http://localhost:'+ports[2]);}
