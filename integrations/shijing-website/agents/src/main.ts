import {StoryLibrary} from './story-library.js';
import {AssetLibrary} from './asset-library.js';
import {configureNetwork} from './network.js';
import {resolve} from 'node:path';
import {Store} from './store.js';import {Worker} from './worker.js';import {OpenAIArt} from './provider.js';import {makeServer} from './server.js';import {WorldAgent} from './world-agent.js';
const network=configureNetwork();
console.log(`生成服务网络：${network}`);
const store=new Store(resolve(process.env.AGENT_DATA_DIR||'.agent-data'));store.recover();
const worker=new Worker(store,new OpenAIArt(),new AssetLibrary(resolve(process.env.CHARACTER_LIBRARY_DIR||'人物素材库')),new StoryLibrary(resolve('故事板素材库'),resolve(process.env.AGENT_DATA_DIR||'.agent-data','story-cache')));const server=makeServer(store,worker);
const port=Number(process.env.AGENT_PORT||4318);
server.listen(port,'127.0.0.1',()=>{
  // 启动兜底淘汰过期的战略快照（只在库体积超阈值时才扫，且**在监听之后**跑）：
  // 439 个对局的大库扫一遍要几十秒，放在 listen 前会把开服时间拖长一倍——先能玩，再收拾。
  setTimeout(()=>{try{new WorldAgent(store).sweepSnapshots();}catch(e){console.warn('[snapshots] 启动淘汰失败：',e instanceof Error?e.message:String(e));}},0);
  console.log(`史境 Agent 服务：http://127.0.0.1:${port}；OpenAI ${process.env.OPENAI_API_KEY?'已配置':'待配置'}`);
});
process.on('SIGTERM',()=>{worker.stopping=true;server.close();});
process.on('SIGINT',()=>{worker.stopping=true;server.close();});
