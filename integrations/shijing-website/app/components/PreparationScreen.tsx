'use client';
import {useEffect,useState} from 'react';
import {preparationReady} from '../../agents/src/preparation';
import type {Job,Persona} from '../../agents/src/contracts';
import {useLocale,translate as t} from '../lib/i18n';
export default function PreparationScreen({people,jobs,paused,error,onRetry,loadingStatus}:{loadingStatus?:string;people:Persona[];jobs:Job[];paused:boolean;error:string;onRetry:(job:Job)=>void}){
 const [locale]=useLocale();
 const [loaded,setLoaded]=useState<string[]>([]),[broken,setBroken]=useState<string[]>([]),[released,setReleased]=useState('');
 const [elapsed,setElapsed]=useState(0);
 useEffect(()=>{if(people.length||error)return;const start=Date.now();const timer=setInterval(()=>setElapsed(Math.floor((Date.now()-start)/1000)),1000);return()=>clearInterval(timer);},[people.length,error]);
 const portraits=people.map(p=>jobs.filter(j=>j.kind==='portrait'&&j.subjectId===p.id).at(-1));
 const story=jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate).at(-1);
 const required=[...portraits,story];
 const paths=required.filter(j=>j?.status==='succeeded'&&j?.asset).map(j=>'/api/agents/assets/'+j!.asset).join('|');
 const signature=required.map(j=>j?.id+':'+j?.asset).join('|');
 useEffect(()=>{let live=true;for(const src of paths.split('|').filter(Boolean)){const image=new Image();image.onload=()=>{void image.decode().then(()=>{if(live){setLoaded(old=>old.includes(src)?old:[...old,src]);setBroken(old=>old.filter(p=>p!==src));}}).catch(()=>{if(live)setBroken(old=>[...old,src]);});};image.onerror=()=>{if(live)setBroken(old=>[...old,src]);};image.src=src;}return()=>{live=false;};},[paths]);
 const isReady=(j:Job|undefined)=>!!j?.asset&&j.status==='succeeded'&&loaded.includes('/api/agents/assets/'+j.asset);
 // UX-006：就绪计数按**持久层**（jobs 表的 succeeded+asset）算，不算本会话是否 decode 过图。
 // 此前计数取会话内存（image.decode 结果），后端重启或图片加载早于页面时显示 0/5，与 DB 事实不符。
 const ready=portraits.filter(j=>j?.status==='succeeded'&&j?.asset).length,storyReady=!!story?.asset&&story.status==='succeeded';
 const complete=preparationReady(people.map(p=>p.id),jobs,loaded,error,paused);
 const failed=required.filter((j):j is Job=>!!j&&['failed','interrupted'].includes(j.status));
 const imageError=broken.some(p=>paths.split('|').includes(p));
 const stages:Record<string,number>={queued:0,planning:.15,generating:.35,checking:.8,succeeded:.95};
 const progress=complete?100:Math.min(99,Math.floor(100*required.reduce((sum,j)=>sum+(isReady(j)?1:stages[j?.status||'queued']||0),0)/required.length));
 useEffect(()=>{if(!complete)return;const timer=setTimeout(()=>setReleased(signature),1000);return()=>clearTimeout(timer);},[complete,signature]);
 // Once the initial scene is entered, later image jobs stay in the background.
 if(released)return null;
 const jobName=(j:Job)=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate?t(locale,'discussion.storyboard'):people.find(p=>p.id===j.subjectId)?.name||t(locale,'prep.taskUnknown');
 return <section className="topic-transition" role="dialog" aria-modal="true" aria-label={t(locale,'prep.aria')}><div className="transition-canvas"><img className="transition-art" src="/transitions/topic-transition.svg" alt={t(locale,'prep.alt')}/><div className="transition-loading"><div role="progressbar" aria-label={t(locale,'prep.progressAria')} aria-valuenow={progress} aria-valuemin={0} aria-valuemax={100} className="transition-track"><span style={{width:progress+'%'}}/></div><p role="status">{error||(imageError?t(locale,'prep.imageFail'):complete?(paused?t(locale,'prep.localReady'):t(locale,'prep.ready')):failed.length?t(locale,'prep.incomplete'):paused?t(locale,'prep.waitOnline'):people.length?t(locale,'prep.people',{ready,total:people.length,status:storyReady?t(locale,'prep.storyReady'):t(locale,`prep.stage.${story?.status||'queued'}`)}):(loadingStatus||t(locale,'prep.reading')))}</p>{!people.length&&!error&&elapsed>0&&<small>{t(locale,'prep.waited',{n:elapsed})}{elapsed>=30?t(locale,'prep.waitLong'):''}</small>}{!complete&&<small>{t(locale,'prep.note')}</small>}{failed.map(j=><p key={j.id}>{t(locale,'prep.taskFailed',{name:jobName(j),reason:j.error||t(locale,'prep.taskUnknown')})}</p>)}<div className="transition-actions"><a href="/">{t(locale,'prep.home')}</a>{(error||imageError||paused)&&<button onClick={()=>location.reload()}>{t(locale,'discussion.reconnect')}</button>}{!paused&&failed.map(j=><button key={j.id} onClick={()=>onRetry(j)}>{t(locale,'prep.retryBtn',{name:jobName(j)})}</button>)}</div></div></div></section>;
}
