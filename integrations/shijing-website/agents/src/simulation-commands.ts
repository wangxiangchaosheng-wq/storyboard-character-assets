import {assert} from './contracts.js';
import type {WorldSnapshot} from './world-contracts.js';
import type {SimulationCommand,AdvanceCommand,OrderKind} from './simulation-types.js';
/** Deliberately bounded grammar: free discussion never becomes a numerical settlement. */
export function parseLocalCommand(w:WorldSnapshot,text:string,commandId:string):{kind:'order';input:SimulationCommand}|{kind:'advance';input:AdvanceCommand}{
 const s=w.simulation;assert(s,'当前议题没有可用的本地战役');const line=text.trim().replace(/[。！!]+$/,'');
 const time=line.match(/^(?:推进|继续推演|推演)\s*(\d+)\s*(小时|天|日)$/);
 if(time)return{kind:'advance',input:{commandId,expectedRevision:w.revision,hours:Number(time[1])*(time[2]==='小时'?1:24)}};
 const help='本地指令示例：魏延 行军 长安；魏延 急行军 长安；魏延 进攻 长安；魏延 围困 长安；魏延 撤退 汉中；魏延 休整；魏延 补给 汉中 10000；推进 1 天。讨论或假设不会执行。';
 const army=Object.values(w.armies).filter(a=>a.factionId===s.playerFactionId&&s.activeArmyIds.includes(a.id)).find(a=>line.startsWith(a.name+' ')||line.startsWith(a.commander.name+' ')||line.startsWith(a.name)||line.startsWith(a.commander.name));assert(army,help);
 const prefix=line.startsWith(army.name)?army.name:army.commander.name;
 const rest=line.slice(prefix.length).trim();const found=rest.match(/^(行军|急行军|进攻|围困|撤退|驻守|休整|补给)\s*([^\s]*)\s*(\d+(?:\.\d+)?)?$/);assert(found,help);
 const map:Record<string,OrderKind>={行军:'march',急行军:'forced-march',进攻:'attack',围困:'besiege',撤退:'retreat',驻守:'garrison',休整:'garrison',补给:'resupply'};
 const kind=map[found[1]],city=Object.values(w.cities).find(c=>c.name===found[2]);
 if(kind==='garrison')assert(!found[2]&&!found[3],help);else assert(city,help);
 if(kind!=='resupply')assert(!found[3],help);
 return{kind:'order',input:{commandId,expectedRevision:w.revision,armyId:army.id,kind,...(kind==='resupply'?{sourceCityId:city!.id,...(found[3]?{foodKg:Number(found[3])}:{})}:city?{targetCityId:city.id}:{})}};
}
