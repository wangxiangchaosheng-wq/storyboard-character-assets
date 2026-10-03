import {StoryLibrary} from './story-library.js';
import {AssetLibrary} from './asset-library.js';
import {configureNetwork} from './network.js';
import {resolve} from 'node:path';
import {Store} from './store.js';import {Worker} from './worker.js';import {OpenAIArt} from './provider.js';import {makeServer} from './server.js';import {WorldAgent} from './world-agent.js';
const network=configureNetwork();
console.log(`生成服务网络：${network}`);
const store=new Store(resolve(process.env.AGENT_DATA_DIR||'.agent-data'));store.recover();
// 启动兜底淘汰过期的战略快照（只在库体积超阈值时才扫）——既有大库不会因为「从今天起才淘汰」
// 而继续膨胀，重启一次就把历史欠账清掉。小库直接跳过，不为省几 MB 拖慢启动。
new WorldAgent(store).sweepSnapshots();
const worker=new Worker(store,new OpenAIArt(),new AssetLibrary(resolve(process.env.CHARACTER_LIBRARY_DIR||'人物素材库')),new StoryLibrary(resolve('故事板素材库'),resolve(process.env.AGENT_DATA_DIR||'.agent-data','story-cache')));const server=makeServer(store,worker);
const port=Number(process.env.AGENT_PORT||4318);
server.listen(port,'127.0.0.1',()=>{console.log(`史境 Agent 服务：http://127.0.0.1:${port}；OpenAI ${process.env.OPENAI_API_KEY?'已配置':'待配置'}`);});
process.on('SIGTERM',()=>{worker.stopping=true;server.close();});
process.on('SIGINT',()=>{worker.stopping=true;server.close();});
