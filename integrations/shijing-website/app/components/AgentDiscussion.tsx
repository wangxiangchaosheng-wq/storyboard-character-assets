'use client';
import {useEffect,useRef,useState} from 'react';

import {localTopicSpec} from '../../agents/src/local-topic';
import MajorEventScreen from './MajorEventScreen';
import PreparationScreen from './PreparationScreen';
import OriginalScene from './OriginalScene';import CandleHome from './CandleHome';
import {slotIds,type TopicPlan,defaultTopic,parseTopic} from '../lib/topic';
import type {SceneAssets} from '../lib/scene-assets';
import type {Run,Job} from '../../agents/src/contracts';
type View=Run&{generationEnabled?:boolean;jobs:Job[];history:{event:{id:string;summary:string};before:Run['world'];after:Run['world']}[]};
async function api<T>(path:string,body?:unknown):Promise<T>{const res=await fetch('/api/agents/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(body===undefined?20000:270000)});const data=await res.json() as T&{error?:string};if(!res.ok)throw new Error(data.error||'任务暂未完成');return data;}
const statusText:Record<Job['status'],string>={queued:'等待绘制',planning:'准备画面',generating:'正在绘制',checking:'检查画面',succeeded:'已保存',failed:'待重试',interrupted:'任务中断'};
export default function AgentDiscussion(){
  const [eventsOpen,setEventsOpen]=useState(false);
  const [view,setView]=useState<View|null>(null),[error,setError]=useState(''),[status,setStatus]=useState('正在读取议题…'),[selected,setSelected]=useState(''),[text,setText]=useState(''),[act,setAct]=useState(false),[sending,setSending]=useState(false),[scale,setScale]=useState(1),[showWorld,setShowWorld]=useState(false);
  const viewport=useRef<HTMLDivElement>(null);const runId=useRef('');const boot=useRef<Promise<string>|null>(null);const log=useRef<HTMLDivElement>(null);
  useEffect(()=>{let alive=true;let timer:ReturnType<typeof setTimeout>;
    async function start(){const query=new URLSearchParams(location.search);const id=query.get('run');if(id){
        const old=await api<View>('runs/'+id);
        if(old.mode==='standalone'&&old.spec.cast.some(p=>p.role==='本地讨论人物')){
          const topic=query.get('topic')?parseTopic(JSON.parse(query.get('topic')!)):{...defaultTopic,title:old.spec.title,description:old.spec.scenario.background.split('当前使用本地预设')[0]};
          const updated=await api<View>('runs',{reuseKey:'local-cast-v2:'+id,spec:localTopicSpec(topic)});return updated.id;
        }
        return id;
      }
      const health=await api<{configured:boolean;engineConfigured:boolean;generationEnabled:boolean}>('health');
      const topic=query.get('topic')?parseTopic(JSON.parse(query.get('topic')!)):defaultTopic;
      const key='shijing-agent-run-v2:'+JSON.stringify(topic);let previous='';try{previous=localStorage.getItem(key)||'';}catch{}
      if(previous){try{await api('runs/'+previous);return previous;}catch{}}
      
      if(health.generationEnabled!==false&&!health.engineConfigured&&!health.configured)throw new Error('请先在本机配置 OpenAI API Key，再重新进入此议题。');
      setStatus('正在确定本次议题的人物名单…');let next:View;
      if(health.generationEnabled===false)next=await api<View>('runs',{reuseKey:key,spec:localTopicSpec(topic)});
      else if(health.engineConfigured)next=await api<View>('runs',{reuseKey:key,topic:`${topic.title}\n${topic.description}\n公元${topic.year}年${topic.season}`,player:'主上'});
      else{
        // Standalone art mode reuses the existing director once; every subsequent asset uses the saved cast IDs.
        const res=await fetch('/api/agents/topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic}),signal:AbortSignal.timeout(260000)});const plan=await res.json() as TopicPlan&{error?:string};if(!res.ok)throw new Error(plan.error||'人物设定生成失败');
        setStatus('人物名单已就绪，正在建立绘画任务…');
        next=await api<View>('runs',{reuseKey:key,spec:{id:crypto.randomUUID(),title:topic.title,scenario:{background:`公元${topic.year}年${topic.season}。${topic.description}`},cast:plan.characters.map(p=>({id:p.id,name:p.name,role:p.role,description:JSON.stringify(p),stance:p.personality})),metrics:[]}});
      }
      try{localStorage.setItem(key,next.id);}catch{}return next.id;
    }
    async function refresh(){try{const data=await api<View>('runs/'+runId.current);if(alive){setView(data);setSelected(old=>old&&data.spec.cast.some(p=>p.id===old)?old:data.spec.cast[0].id);setStatus('');}}catch(e){if(alive)setError((e as Error).message);}finally{if(alive)timer=setTimeout(refresh,2500);}}
    boot.current??=start();void boot.current.then(id=>{if(!alive)return;runId.current=id;void api('runs/'+id+'/prepare',{}).catch(e=>{if(alive)setError(e.message);});const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);void refresh();}).catch(e=>{if(alive){setError(e.name==='TimeoutError'?'读取议题或人物名单超时，请重新连接后再试。':e.message);setStatus('');}});
    return()=>{alive=false;clearTimeout(timer);};
  },[]);
  useEffect(()=>{const node=viewport.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setScale(entry.contentRect.width/1672));observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'smooth'});},[view?.messages.length]);
  async function submit(){if(!view||!text.trim()||sending)return;setSending(true);setError('');const message=text;setText('');try{setView(await api<View>(`runs/${view.id}/messages`,{commandId:crypto.randomUUID(),text:message,to:selected,act}));}catch(e){setError((e as Error).message+'。请先同步状态后再决定是否重新发送。');}finally{setSending(false);}}
  async function sync(){if(!view)return;try{setView(await api<View>(`runs/${view.id}/sync`,{}));setError('');}catch(e){setError((e as Error).message);}}
  async function retry(job:Job){try{await api(`jobs/${job.id}/retry`,{});setView(await api<View>('runs/'+job.runId));setError('');}catch(e){setError((e as Error).message);}}
  const people=view?.spec.cast??[];const selectedIndex=Math.max(0,people.findIndex(p=>p.id===selected));const group=Math.floor(selectedIndex/5);const visible=people.slice(group*5,group*5+5);
  const latest=(kind:Job['kind'],subject?:string)=>view?.jobs.filter(j=>j.kind===kind&&(!subject||j.subjectId===subject)&&j.status==='succeeded').at(-1);
  const storyTask=view?.jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate).at(-1);const story=storyTask?.status==='succeeded'?storyTask:undefined;const storyProgress=view?.generationEnabled===false?'暂无匹配当前话题与阶段的故事板，在线生成已关闭。':storyTask?({queued:'等待人物任务完成后绘制',planning:'正在准备故事画面',generating:'正在绘制故事图，请耐心等待',checking:'正在检查故事画面与文字',failed:'故事图生成未完成，可展开左下角查看原因',interrupted:'任务已中断，可展开左下角重试',succeeded:'故事图已保存'}[storyTask.status]):'等待完成配置与议题准备';const assetUrl=(j?:Job)=>j?.asset?'/api/agents/assets/'+j.asset:'';
  const assets:SceneAssets={characters:slotIds.map((slot,i)=>{const p=visible[i];const url=p?assetUrl(latest('portrait',p.id)):'';return{id:slot,name:p?.name||'—',role:p?.role||'',card:url,avatar:url,hero:url};}),storyboard:{image:assetUrl(story),sceneKey:story?.subjectId||'',title:story?.plan?.summary||'',caption:story?.plan?.summary||'',location:''}};
  const activeSlot=slotIds[selectedIndex%5];const done=view?.jobs.filter(j=>j.status==='succeeded').length??0;const failed=view?.jobs.filter(j=>['failed','interrupted'].includes(j.status))??[];
  return <main className="scene-viewport discussion-fullwidth" ref={viewport}>
    {view&&<MajorEventScreen runId={view.id} jobs={view.jobs} onRetry={retry} open={eventsOpen} onClose={()=>setEventsOpen(false)}/>}
    <PreparationScreen loadingStatus={status} people={people} jobs={view?.jobs??[]} paused={view?.generationEnabled===false} error={error} onRetry={retry}/>

    <div className="artboard" style={{top:`max(0px, calc((100svh - ${941*scale}px) / 2))`,transform:`translateX(-50%) scale(${scale})`,transformOrigin:"top center"}}><OriginalScene assets={assets} activeId={activeSlot} pristine={false} editingInput={true}/><CandleHome onEvents={()=>setEventsOpen(true)}/>
      <aside className="character-rail" aria-label="对话人物"><div className="character-list">{visible.map((p,i)=><button key={p.id} className={`character-card ${selected===p.id?'selected':''}`} aria-label={`${p.name} · ${p.role}`} aria-pressed={selected===p.id} onClick={()=>setSelected(p.id)}>{!assets.characters[i].card&&<span className="asset-pending">{view?.generationEnabled===false?'等待补充素材':statusText[view?.jobs.filter(j=>j.kind==='portrait'&&j.subjectId===p.id).at(-1)?.status||'queued']}</span>}</button>)}</div></aside>
      <section className="dialogue-panel" aria-label="廷议"><div className="conversation" role="log" aria-live="polite" ref={log}>{view?.messages.length?view.messages.map(m=><article className={`message ${m.kind==='player'?'user':'assistant'}`} key={m.id}><span className="user-mark">{(m.name||'史官').slice(0,1)}</span><div className="message-content"><b>{m.name||'史官'}</b><p>{m.text}</p></div></article>):<article className="message assistant"><div className="message-content"><b>史官</b><p>{view?.spec.scenario.background||'正在准备本次议题…'}</p><p>{view?.mode==='standalone'?'已有的人物图会从素材库载入。新图生成取决于服务设置；角色讨论与行动裁决需连接队友推演引擎后开启。':''}</p></div></article>}</div></section>
      <form className="composer" onSubmit={e=>{e.preventDefault();void submit();}}><label className="sr-only" htmlFor="agent-message">输入讨论或行动</label><textarea id="agent-message" rows={1} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={sending||view?.mode!=='engine'}/><button type="submit" className="art-button send-button" aria-label="发送" disabled={sending||!text.trim()||view?.mode!=='engine'}/></form>
      {!assets.storyboard.image&&<div className="story-pending"><strong>故事板</strong><p>{storyProgress}</p></div>}
    </div>
    {view?.mode==='engine'&&<label className="agent-action"><input type="checkbox" checked={act} onChange={e=>setAct(e.target.checked)}/>下达行动（由裁判结算并更新世界）；不勾选时只讨论</label>}
    {people.length>5&&<nav className="agent-pages" aria-label="人物分组">{Array.from({length:Math.ceil(people.length/5)},(_,i)=><button key={i} onClick={()=>setSelected(people[i*5].id)}>人物 {i*5+1}–{Math.min(people.length,i*5+5)}</button>)}</nav>}
    {error&&<div className="agent-error" role="alert">{error}<button onClick={()=>location.reload()}>重新连接</button></div>}
    {failed.length>0&&<details className="agent-jobs"><summary>{failed.length} 个画面需要重试</summary>{failed.map(j=><p key={j.id}>{people.find(p=>p.id===j.subjectId)?.name||'故事板'}：{j.error}<button onClick={()=>void retry(j)}>重试此项</button></p>)}</details>}
    {showWorld&&<aside className="agent-world"><button onClick={()=>setShowWorld(false)}>关闭</button><h2>世界状态</h2><p>版本 {view?.world.version??0} · {view?.mode==='engine'?'时间进度以推演服务提供的指标为准':`已确认经过 ${view?.world.day??0} 天`}</p>{!view?.spec.metrics.length&&<p>上游尚未提供初始兵力、粮草等数据；这里不会猜测填写。</p>}{view?.spec.metrics.map(m=><p key={m.key}>{m.label}：<strong>{view.world.metrics[m.key]}</strong> {m.unit}</p>)}{Object.entries(view?.world.cities??{}).map(([city,owner])=><p key={city}>{city}：{owner}</p>)}<h3>已确认事件</h3>{view?.history.map(h=><p key={h.event.id}>{h.event.summary}</p>)}</aside>}
  </main>;
}
