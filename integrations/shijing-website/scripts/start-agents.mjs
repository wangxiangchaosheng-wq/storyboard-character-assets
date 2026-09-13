import {createConnection} from 'node:net';
import {spawn,spawnSync} from 'node:child_process';
import {existsSync,copyFileSync,chmodSync} from 'node:fs';
import {fileURLToPath} from 'node:url';
const root=fileURLToPath(new URL('..',import.meta.url));process.chdir(root);
const npm=process.env.npm_execpath;
if(!npm)throw new Error('请通过 npm run dev:agents 启动');
const required=['typescript/bin/tsc','vinext/package.json','vite/package.json','react/package.json','sharp/package.json'];
if(required.some(p=>!existsSync('node_modules/'+p))){
 console.log('正在补齐启动依赖，首次运行需要联网，请稍候…');
 const install=spawnSync(process.execPath,[npm,'ci','--include=dev'],{stdio:'inherit'});
 if(install.status!==0){console.error('依赖安装未完成，请检查网络后重新双击启动。');process.exit(install.status||1);}
}
if(!existsSync('.env')){copyFileSync('.env.example','.env');chmodSync('.env',0o600);}
// Check before starting the backend: its startup recovery must not touch a live session.
process.loadEnvFile('.env');
const agentPort=Number(process.env.AGENT_PORT||4318),webPort=Number(process.env.WEB_PORT||3002);
const occupied=(port,host)=>new Promise(resolve=>{const socket=createConnection({port,host});const finish=value=>{socket.destroy();resolve(value);};socket.once('connect',()=>finish(true));socket.once('error',()=>finish(false));socket.setTimeout(800,()=>finish(false));});
const agentBusy=await occupied(agentPort,'127.0.0.1');
const webBusy=(await occupied(webPort,'127.0.0.1'))||(await occupied(webPort,'::1'));
if(agentBusy||webBusy){
 console.log(`史境服务端口已被占用（${[agentBusy?agentPort:null,webBusy?webPort:null].filter(Boolean).join('、')}），本次不会重复启动。`);
 console.log('如果已有史境窗口，请继续使用；需要加载更新时，先在原启动窗口按 Control+C，再重新启动。');
 process.exit(0);
}
const build=spawnSync(process.execPath,['node_modules/typescript/bin/tsc','-p','agents/tsconfig.json'],{stdio:'inherit'});
if(build.status!==0)process.exit(build.status||1);

const children=[spawn(process.execPath,['--env-file-if-exists=.env','agents/dist/main.js'],{stdio:'inherit'}),spawn(process.execPath,[npm,'run','dev','--','--port',process.env.WEB_PORT||'3002'],{stdio:'inherit'})];
let stopping=false;function stop(){if(stopping)return;stopping=true;for(const c of children)c.kill('SIGTERM');}
for(const c of children){c.on('exit',code=>{if(!stopping){process.exitCode=code||0;stop();}});c.on('error',()=>{process.exitCode=1;stop();});}
process.on('SIGINT',stop);process.on('SIGTERM',stop);
