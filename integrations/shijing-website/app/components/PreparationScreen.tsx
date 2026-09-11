'use client';
import {useEffect,useState} from 'react';
import {preparationReady} from '../../agents/src/preparation';
import type {Job,Persona} from '../../agents/src/contracts';
export default function PreparationScreen({people,jobs,paused,error,onRetry,loadingStatus}:{loadingStatus?:string;people:Persona[];jobs:Job[];paused:boolean;error:string;onRetry:(job:Job)=>void}){
 const [loaded,setLoaded]=useState<string[]>([]),[broken,setBroken]=useState<string[]>([]),[released,setReleased]=useState('');
 const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{if(people.length||error)return;const start=Date.now();const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-start)/1000)),1000);return()=>clearInterval(timer);},[people.length,error]);
 const portraits=people.map(p=>jobs.filter(j=>j.kind==='portrait'&&j.subjectId===p.id).at(-1));
 const story=jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate).at(-1);
 const required=[...portraits,story];
 const paths=required.filter(j=>j?.status==='succeeded'&&j.asset).map(j=>'/api/agents/assets/'+j!.asset).join('|');
 const signature=required.map(j=>j?.id+':'+j?.asset).join('|');
 useEffect(()=>{let live=true;for(const src of paths.split('|').filter(Boolean)){const image=new Image();image.onload=()=>{void image.decode().then(()=>{if(live){setLoaded(old=>old.includes(src)?old:[...old,src]);setBroken(old=>old.filter(p=>p!==src));}}).catch(()=>{if(live)setBroken(old=>[...old,src]);});};image.onerror=()=>{if(live)setBroken(old=>[...old,src]);};image.src=src;}return()=>{live=false;};},[paths]);
 const isReady=(j:Job|undefined)=>!!j?.asset&&j.status==='succeeded'&&loaded.includes('/api/agents/assets/'+j.asset);
 const ready=portraits.filter(isReady).length,storyReady=isReady(story);
 const complete=preparationReady(people.map(p=>p.id),jobs,loaded,error);
 const failed=required.filter((j):j is Job=>!!j&&['failed','interrupted'].includes(j.status));
 const imageError=broken.some(p=>paths.split('|').includes(p));
 const stages:Record<string,number>={queued:0,planning:.15,generating:.35,checking:.8,succeeded:.95};
 const progress=complete?100:Math.min(99,Math.floor(100*required.reduce((sum,j)=>sum+(isReady(j)?1:stages[j?.status||'queued']||0),0)/required.length));
 useEffect(()=>{if(!complete)return;const timer=setTimeout(()=>setReleased(signature),1000);return()=>clearTimeout(timer);},[complete,signature]);
 if(complete&&released===signature)return null;
 const labels:Record<string,string>={queued:'等待生成',planning:'正在设计画面',generating:'正在绘制',checking:'正在检查画面',succeeded:'正在加载图片',failed:'生成失败',interrupted:'生成中断'};
 return <section className="topic-transition" role="dialog" aria-modal="true" aria-label="正在准备议题"><div className="transition-canvas"><img className="transition-art" src="/transitions/topic-transition.svg" alt="青山依旧在，几度夕阳红。两位谋士临江远望。"/><div className="transition-loading"><div role="progressbar" aria-label="人物与故事板准备进度（按任务阶段）" aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="transition-track"><span style={{width:progress+'%'}}/></div><p role="status">{error||(imageError?'图片读取失败，请重新连接':complete?'人物和故事板已就绪，即将进入':failed.length?'生成未完成，请重试失败任务':paused?'在线生成尚未开启，正在等待所需素材':people.length?`人物 ${ready} / ${people.length} 已就绪 · 故事板${storyReady?'已就绪':labels[story?.status||'queued']}`:(loadingStatus||'正在读取议题与人物名单…'))}</p>{!people.length&&!error&&elapsed>0&&<small>已等待 {elapsed} 秒{elapsed>=30?' · 正在等待服务返回名单，尚未开始绘图':''}</small>}{!complete&&<small>进度按实际任务阶段更新；绘制完成并加载成功后进入。</small>}{failed.map(j=><p key={j.id}>{j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate?'故事板':people.find(p=>p.id===j.subjectId)?.name}：{j.error||'任务未完成'}</p>)}<div className="transition-actions"><a href="/">返回主页</a>{(error||imageError||paused)&&<button onClick={()=>location.reload()}>重新连接</button>}{!paused&&failed.map(j=><button key={j.id} onClick={()=>onRetry(j)}>重试{j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate?'故事板':people.find(p=>p.id===j.subjectId)?.name}</button>)}</div></div></div></section>;
}
