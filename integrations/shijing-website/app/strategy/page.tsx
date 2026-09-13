'use client';
import {useEffect,useState} from 'react';
import StrategyScreen from '../components/StrategyScreen';
import type {StrategyData} from '../lib/strategy';
type StrategyEntry={id:string;title:string;status:string;keywords?:string[]};
type MapRecord={id:string;topicId:string;topicTitle:string;title:string;year:number;place:string;keywords?:string[];mapUrl?:string;data?:StrategyData;revision?:number;status?:string;strategies?:StrategyEntry[];legacy?:boolean};
type Selection={unitId:string;decisionId?:string};
type Filter={topic:string;time:string;place:string;keyword:string};
const emptyData:StrategyData={ready:true,armies:[],cities:[],actions:[],decisions:[],changes:[],worldTime:{elapsedDays:0}};
const statuses:Record<string,string>={active:'进行中',ended:'当前战略已结束',ready:'待决策',uninitialized:'待初始化',issued:'已下达',executing:'进行中',completed:'已完成',failed:'未达成',cancelled:'已撤销'};
async function request<T>(url:string,signal:AbortSignal):Promise<T>{const response=await fetch(url,{cache:'no-store',signal});const payload=await response.json() as T&{error?:string};if(!response.ok)throw Error(payload.error||'策略地图读取失败');return payload as T;}
async function readUnits(signal:AbortSignal){const maps:MapRecord[]=[];let cursor='';do{const page=await request<{maps:MapRecord[];nextCursor:string|null}>('/api/agents/strategy-library?limit=100&cursor='+encodeURIComponent(cursor),signal);if(!Array.isArray(page.maps))throw Error('策略地图目录格式错误');maps.push(...page.maps);if(page.nextCursor===null)break;if(typeof page.nextCursor!=='string'||!page.nextCursor||(cursor!==''&&page.nextCursor>=cursor))throw Error('策略地图分页状态错误');cursor=page.nextCursor;}while(true);return maps;}
function matches(r:MapRecord,q:Filter){const years=q.time.match(/\d+/g)?.map(Number)||[];return(!q.topic||r.topicId===q.topic)&&(!years.length||(r.year>=Math.min(...years)&&r.year<=Math.max(...years)))&&r.place.includes(q.place.trim())&&[r.title,r.topicTitle,...(r.keywords||[])].join(' ').includes(q.keyword.trim());}
export default function StrategyGallery(){
 const [records,setRecords]=useState<MapRecord[]>([]),[selection,setSelection]=useState<Selection>(),[map,setMap]=useState<{key:string;data:StrategyData;historical:boolean}>();
 const [topic,setTopic]=useState(''),[time,setTime]=useState(''),[place,setPlace]=useState(''),[keyword,setKeyword]=useState(''),[filter,setFilter]=useState<Filter|null>(null),[all,setAll]=useState(false),[error,setError]=useState(''),[mapError,setMapError]=useState(''),[loaded,setLoaded]=useState(false);
 useEffect(()=>{const controller=new AbortController();let timer:ReturnType<typeof setTimeout>;let alive=true;let legacy:MapRecord[]=[];
  const legacyReady=request<{maps:MapRecord[]}>('/strategy/library.json',controller.signal).then(v=>{legacy=(v.maps||[]).filter(r=>r.id&&r.data&&typeof r.year==='number').map(r=>({...r,id:'legacy:'+r.id,legacy:true}));}).catch(()=>{});
  async function refresh(){try{await legacyReady;const units=await readUnits(controller.signal);if(!alive)return;const merged=[...units,...legacy];setRecords(merged);setSelection(old=>old&&merged.some(r=>r.id===old.unitId)?old:merged.length?{unitId:(merged.find(r=>r.status!=='uninitialized')||merged[0]).id}:undefined);setError('');}catch(e){if(alive){setError('总战略库连接失败：'+(e as Error).message);if(legacy.length)setRecords(legacy);}}finally{if(alive){setLoaded(true);timer=setTimeout(refresh,5000);}}}
  void refresh();return()=>{alive=false;controller.abort();clearTimeout(timer);};
 },[]);
 const current=records.find(r=>r.id===selection?.unitId);const selectedDecision=current?.strategies?.find(d=>d.id===selection?.decisionId);
 const selectionKey=selection?selection.unitId+':'+(selection.decisionId||'latest'):'empty';
 useEffect(()=>{if(!current)return;const controller=new AbortController();setMapError('');
  if(current.status==='uninitialized'){setMap({key:selectionKey,data:{...emptyData,worldTime:{elapsedDays:0,startYear:current.year||undefined}},historical:false});return;}
  if(current.legacy&&current.data){setMap({key:selectionKey,data:current.data,historical:true});return;}
  void request<{data:StrategyData;historical:boolean}>('/api/agents/runs/'+encodeURIComponent(current.id)+'/strategy-map'+(selection?.decisionId?'?decisionId='+encodeURIComponent(selection.decisionId):''),controller.signal).then(v=>setMap({key:selectionKey,...v})).catch(e=>{if(!controller.signal.aborted)setMapError((e as Error).message);});
  return()=>controller.abort();
 },[current?.id,current?.revision,current?.status,selection?.decisionId,selectionKey]);
 function search(e:React.FormEvent){e.preventDefault();setAll(false);setFilter({topic,time,place,keyword});}
 const results=filter?records.filter(r=>matches(r,filter)):null;
 const visibleMap=map?.key===selectionKey?map:undefined;
 const stateLabel=selectedDecision?statuses[selectedDecision.status]:statuses[current?.status||''];
 const status=error||mapError||(!loaded?'正在读取总战略库…':current?`${current.topicTitle}${selectedDecision?' · '+selectedDecision.title:''} · ${stateLabel||'已收录'} · 公元${current.year}年${visibleMap?.historical?' · 历史快照':''}${!visibleMap?' · 正在读取地图…':''}`:'暂无已初始化的议题战略数据');
 return <div className="strategy-gallery"><StrategyScreen key={selectionKey} data={visibleMap?.data||emptyData} artwork={current?.legacy?current.mapUrl||'/strategy/map.svg':'/strategy/map-live-state.svg'} onClose={()=>location.assign('/')} toolbar={close=><><form className="strategy-search" onSubmit={search}><button type="button" onClick={close}>返回地图</button><label>议题<select value={topic} onChange={e=>setTopic(e.target.value)}><option value="">全部议题</option>{Array.from(new Map(records.map(r=>[r.topicId,r.topicTitle])).entries()).map(([id,title])=><option key={id} value={id}>{title}</option>)}</select></label><label>时间<input value={time} onChange={e=>setTime(e.target.value)} placeholder="228年或228—234"/></label><label>地点<input value={place} onChange={e=>setPlace(e.target.value)} placeholder="如：汉中"/></label><label>策略<input value={keyword} onChange={e=>setKeyword(e.target.value)} placeholder="策略名称或统帅"/></label><button>检索</button><button type="button" onClick={()=>{setAll(true);setFilter({topic,time:'',place:'',keyword:''});}}>全部策略地图</button></form><div className="strategy-gallery-status" role="status">{status}</div></>}/>{results&&<div className="strategy-picker-shade"><section role="dialog" aria-modal="true" aria-label={all?'全部策略地图':'策略检索结果'} className="strategy-picker"><header><h2>{all?'全部策略地图':'检索结果'}（{results.length} 个议题）</h2><button autoFocus onClick={()=>setFilter(null)}>关闭</button></header><nav>{results.length?results.map(r=><div key={r.id}><button onClick={()=>{setSelection({unitId:r.id});setFilter(null);}}>{r.year}年 · {r.topicTitle} · {statuses[r.status||'']||'已收录'} · 最新状态</button>{r.strategies?.filter(d=>!filter?.keyword||[d.title,...(d.keywords||[])].join(' ').includes(filter.keyword.trim())).map(d=><button key={d.id} onClick={()=>{setSelection({unitId:r.id,decisionId:d.id});setFilter(null);}}>　↳ {d.title} · {statuses[d.status]||d.status}</button>)}</div>):<p>暂无符合条件的策略地图</p>}</nav></section></div>}</div>;
}
