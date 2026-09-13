import type {WorldSnapshot,WorldEvent,JsonValue,Point as NormalPoint} from './world-contracts.js';
export type Point={x:number;y:number};
export type Army={id:string;name:string;faction?:string;color?:string;commander?:string;troops?:number;food?:number;morale?:number;fatigue?:number;wounded?:number;dead?:number;transportPeople?:number;position:Point;mapPosition?:Point;location?:string;status?:string};
export type City={id:string;name:string;position:Point;controller?:string;color?:string;governor?:string;food?:number;defense?:number;garrison?:number};
export type Action={id:string;decisionId:string;armyId:string;from:string;target:string;route:Point[];progress?:number;time?:string;status?:string;phase?:string;kind?:string};
export type Decision={id:string;title:string;command:string;time?:string;status?:string;objects:string[]};
export type Change={id?:string;entityId?:string;entityName?:string;decisionId:string;time:string;objects:string[];before:string;after:string;reason:string;title?:string;summary?:string;field?:string;revision?:number};
export type StrategyData={armies:Army[];cities:City[];actions:Action[];decisions:Decision[];changes:Change[];worldTime:{startYear?:number;startLabel?:string;elapsedDays:number};demo?:boolean;ready?:boolean;focusDecisionId?:string;localSimulation?:boolean;basisNote?:string;revision?:number;title?:string;runId?:string};
const states:Record<string,string>={stationed:'驻扎',marching:'行军中',besieging:'围城中',fighting:'交战中',resting:'休整',destroyed:'覆灭',planned:'计划中',active:'执行中',completed:'已完成',failed:'未达成',cancelled:'已撤销',issued:'已下达',executing:'执行中',march:'调动',attack:'进攻',retreat:'撤退',resupply:'补给'};
const fields:Record<string,string>={troops:'兵力',foodKg:'粮草',morale:'士气',defense:'城防',ownerFactionId:'控制方',status:'状态',location:'位置',progress:'行动进度',elapsedDays:'经过天数',fatigue:'疲劳',wounded:'伤员',dead:'阵亡',captured:'被俘',deserted:'逃散'};
export const projectPoint=(p:NormalPoint):Point=>({x:436+p.x*1172,y:143+p.y*662});
export function pointOnRoute(route:NormalPoint[],progress:number):NormalPoint {
  const lengths=route.slice(1).map((p,i)=>Math.hypot(p.x-route[i].x,p.y-route[i].y));const total=lengths.reduce((a,b)=>a+b,0);let d=total*progress;
  for(let i=0;i<lengths.length;i++){const len=lengths[i];if(d<=len&&len>0){const t=d/len;return{x:route[i].x+(route[i+1].x-route[i].x)*t,y:route[i].y+(route[i+1].y-route[i].y)*t};}d-=len;}return route.at(-1)!;
}
export function projectStrategy(w:WorldSnapshot|null,events:WorldEvent[],meta:{title:string;runId:string;demo?:boolean;basisNote?:string}):StrategyData {
  if(!w)return {...meta,ready:false,armies:[],cities:[],actions:[],decisions:[],changes:[],worldTime:{elapsedDays:0}};
  const name=(id:string)=>w.armies[id]?.name||w.cities[id]?.name||w.decisions[id]?.title||w.factions[id]?.name||id;
  const value=(v:JsonValue,field:string,unit?:string):string=>{
    if(v===null)return '未设定';
    if(field==='progress'&&typeof v==='number')return Math.round(v*100)+'%';
    if(typeof v==='number')return v.toLocaleString('zh-CN')+(unit?' '+unit:'');
    if(typeof v==='string')return states[v]||name(v);
    if(typeof v==='object'&&!Array.isArray(v)){if(v.kind==='city')return name(String(v.cityId));if(v.kind==='route')return '行军途中';if(v.kind==='field')return String(v.label);}
    return '已更新';
  };
  const armies=Object.values(w.armies).filter(a=>!w.simulation||w.simulation.activeArmyIds.includes(a.id)).map(a=>{
    let p:NormalPoint,location:string;
    if(a.location.kind==='city'){const c=w.cities[a.location.cityId];p=c.point;location=c.name;}
    else if(a.location.kind==='route'){const t=w.actions[a.location.actionId];p=pointOnRoute(t.route,t.progress);location=t.origin.label+' → '+t.target.label;}
    else{p=a.location.point;location=a.location.label;}
    // Offset is presentation-only so a stationed flag does not hide its city click target.
    const mapPosition=projectPoint(p),pos={...mapPosition};if(a.location.kind==='city'){const cityId=a.location.cityId;const peers=Object.values(w.armies).filter(b=>b.location.kind==='city'&&b.location.cityId===cityId).sort((a,b)=>a.id.localeCompare(b.id));pos.x+=30+peers.findIndex(b=>b.id===a.id)*28;pos.y-=40;}else{const near=Object.values(w.cities).map(c=>projectPoint(c.point)).find(c=>Math.hypot(c.x-pos.x,c.y-pos.y)<90);if(near){pos.x=near.x-90;pos.y=near.y+50;}}
    return{id:a.id,name:a.name,faction:w.factions[a.factionId].name,color:w.factions[a.factionId].color,commander:a.commander.name,troops:a.troops,food:a.foodKg,morale:Math.round(a.morale*100)/100,fatigue:w.simulation?Math.round(w.simulation.armies[a.id].fatigue*100)/100:undefined,wounded:w.simulation?.armies[a.id].wounded,dead:w.simulation?.armies[a.id].dead,transportPeople:w.simulation?.armies[a.id].transportPeople,position:pos,mapPosition,location,status:states[a.status]};
  });
  return {...meta,ready:true,localSimulation:!!w.simulation,revision:w.revision,worldTime:{startLabel:w.clock.startLabel,startYear:Number(w.clock.startLabel.match(/公元\s*(\d+)\s*年/)?.[1])||undefined,elapsedDays:w.clock.elapsedDays},armies,
    cities:Object.values(w.cities).map(c=>({id:c.id,name:c.name,position:projectPoint(c.point),controller:w.factions[c.ownerFactionId].name,color:w.factions[c.ownerFactionId].color,governor:c.governor?.name,food:c.foodKg,defense:c.defense,garrison:Object.values(w.armies).filter(a=>a.location.kind==='city'&&a.location.cityId===c.id).reduce((n,a)=>n+a.troops,0)})),
    actions:Object.values(w.actions).map(a=>({id:a.id,decisionId:a.decisionId,armyId:a.armyId,from:a.origin.cityId||a.origin.label,target:a.target.cityId||a.target.label,route:a.route.map(projectPoint),progress:Math.round(a.progress*100),time:`${a.startedDay===null?'尚未出发':'第'+(Math.floor(a.startedDay)+1)+'日出发'} · ${a.estimatedArrivalDay===null?'抵达时间待定':'预计第'+(Math.floor(a.estimatedArrivalDay)+1)+'日抵达'}${a.endedDay===null?'':' · 第'+(Math.floor(a.endedDay)+1)+'日结束'}`,status:states[a.status],phase:a.status,kind:a.kind})),
    decisions:Object.values(w.decisions).reverse().map(d=>({id:d.id,title:d.title,command:d.orderText,time:`${w.clock.startLabel} · 第${Math.floor(d.issuedDay)+1}日`,status:states[d.status],objects:d.related.map(r=>r.id)})),
    changes:events.flatMap(e=>{
      const rows=e.changes.filter(c=>fields[c.field]&&c.before!==null);
      return (rows.length?rows:[null]).map((c,i)=>({id:e.id+'-'+i,entityId:c?.entity.id,entityName:c&&c.entity.type!=='clock'?name(c.entity.id):undefined,revision:e.revision,decisionId:e.decisionId||'',time:`推演第${Math.floor(e.toDay)+1} · ${Math.round((e.toDay%1)*24)}时日`,objects:[...new Set([...e.related.map(r=>r.id),...(c&&c.entity.type!=='clock'?[c.entity.id]:[])])],title:e.title,summary:e.summary,field:c?fields[c.field]:undefined,before:c?value(c.before,c.field,c.unit):'待执行',after:c?value(c.after,c.field,c.unit):'已确认',reason:c?.reason||e.summary}));
    }),
  };
}
