 'use client';
import {useEffect,useState} from 'react';
import type {Job} from '../../agents/src/contracts';
export default function MajorEventScreen({runId,jobs,open=false,onClose}:{runId:string;jobs:Job[];onRetry:(job:Job)=>void;open?:boolean;onClose:()=>void}){
 const [seen,setSeen]=useState<string[]|null>(null);
 const key='shijing-major-seen:'+runId;
 useEffect(()=>{try{setSeen(JSON.parse(localStorage.getItem(key)||'[]'));}catch{setSeen([]);}},[key]);
 const next=seen===null?undefined:jobs.find(j=>j.majorEvent&&j.status==='succeeded'&&j.asset&&!seen.includes(j.id));
 const visible=open||!!next;
 useEffect(()=>{if(!visible)return;function receive(e:MessageEvent){const frame=document.getElementById('topic-events-frame') as HTMLIFrameElement|null;if(e.origin!==location.origin||e.source!==frame?.contentWindow||e.data?.type!=='major-events-close')return;const ids=Array.isArray(e.data.confirmed)?e.data.confirmed.filter((id:unknown)=>typeof id==='string'):[];setSeen(old=>{const value=[...new Set([...(old||[]),...ids])];try{localStorage.setItem(key,JSON.stringify(value));}catch{}return value;});onClose();}addEventListener('message',receive);return()=>removeEventListener('message',receive);},[visible,key,onClose]);
 if(!visible)return null;
 return <div role="dialog" aria-modal="true" aria-label="议题重大事件" style={{position:'fixed',inset:0,zIndex:1200,background:'rgba(0,0,0,.58)'}}><iframe id="topic-events-frame" title="议题重大事件卷轴" src={'/major-event/index.html?embedded=1&run='+encodeURIComponent(runId)+(next?'&selected='+encodeURIComponent(next.id):'')} style={{width:'100%',height:'100%',border:0}}/></div>;
}
