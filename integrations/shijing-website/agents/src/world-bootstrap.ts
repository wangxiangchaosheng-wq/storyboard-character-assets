import {seedSimulation} from './simulation-state.js';
import type {Run} from './contracts.js';
import type {InitialWorldInput,WorldSnapshot} from './world-contracts.js';
import {validateWorld} from './world-state.js';

export const initialBasis = '北伐本地推演 v1（实验性模拟）：兵力、库存、居民、路程及所有系数为可追溯的模拟设定，尚未完成历史案例校准；史料仅约束场景解释。粮草单位为公斤粮食当量；详情与事件记录以当前结算为准。初始场景没有已发生的战果。';
/** A scoped, explicit scenario preset, not a historical inference or an engine snapshot. */
export function buildInitialWorld(run:Run):InitialWorldInput|null {
 const topic=run.spec.title+' '+run.spec.scenario.background;
 const year=Number(run.spec.scenario.background.match(/公元\s*(\d+)\s*年/)?.[1]);
 if(run.mode!=='standalone'||run.world.version!==0||run.world.day!==0||run.engineTurn!==0||run.spec.metrics.length||Object.keys(run.world.metrics).length)return null;
 if(!Number.isInteger(year)||year<228||year>234||!(/北伐|子午谷/.test(topic)&&/诸葛亮|魏延|蜀|汉中|子午谷/.test(topic)))return null;
 // Non-canonical old spec ids are left for explicit upstream initialization.
 if(!/^[\w-]{1,120}$/.test(run.spec.id))return null;
 const point=(x:number,y:number)=>({x:(x-436)/1172,y:(y-143)/662});
 const places:[string,string,number,number,string][]=[['hanzhong','汉中',810,438,'shu'],['changan','长安',952,338,'wei'],['chengdu','成都',700,547,'shu'],['luoyang','洛阳',1074,378,'wei'],['liangzhou','凉州',726,269,'wei'],['bingzhou','并州',975,199,'wei'],['youzhou','幽州',1245,160,'wei'],['xuzhou','徐州',1335,360,'wei'],['jianye','建业',1390,483,'wu'],['jingzhou','荆州',1100,548,'wu'],['kuaiji','会稽',1435,581,'wu'],['jiaozhou','交州',1011,703,'wu']];
 const owners:Record<string,string>={'蜀':'shu','蜀汉':'shu','魏':'wei','曹魏':'wei','吴':'wu','孙吴':'wu'};
 if(Object.entries(run.world.cities).some(([name,owner])=>!places.some(p=>p[1]===name)||!owners[owner]))return null;
 const w:WorldSnapshot={schemaVersion:'world-state/v1',worldId:run.id,scenarioId:run.spec.id,mapId:'event-map-v1',revision:0,clock:{startLabel:`公元${year}年${run.spec.scenario.background.match(/年\s*([春夏秋冬])/)?.[1]||''}`,elapsedDays:0},factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'},wu:{id:'wu',name:'吴',color:'#3b638f'}},cities:{},armies:{},actions:{},decisions:{}};
 for(const [id,name,x,y,faction] of places){const ownerFactionId=owners[run.world.cities[name]]||faction;w.cities[id]={id,name,kind:'city',point:point(x,y),ownerFactionId,governor:{id:'governor-'+id,name:name+'守将（模拟）'},foodKg:id==='hanzhong'?30000:id==='changan'?50000:20000,defense:id==='changan'?80:70};
  const isHanzhong=id==='hanzhong';const armyId=isHanzhong?'army-wei-yan':'army-'+id;
  w.armies[armyId]={id:armyId,name:isHanzhong?'魏延部':name+'守军',factionId:ownerFactionId,commander:isHanzhong?{id:'wei-yan',name:'魏延'}:{id:'governor-'+id,name:name+'守将（模拟）'},troops:isHanzhong?5000:3000,foodKg:isHanzhong?60000:12000,morale:isHanzhong?80:70,location:{kind:'city',cityId:id},status:'stationed'};
 }
 // Conflicting existing ownership must not silently place Wei Yan into an enemy faction.
 if(w.cities.hanzhong.ownerFactionId!=='shu')return null;
 w.simulation=seedSimulation(w);
 validateWorld(w);
 return {initializationId:'northern-expedition-local-v2',snapshot:w,basis:{kind:'mixed',note:initialBasis}};
}
