'use client';
import {useRef,useState} from 'react';
import type {ChronicleRecord} from '../../agents/src/historian';
import {renderChronicleMarkdown} from '../../agents/src/historian';
import {useLocale,translate as t} from '../lib/i18n';
import {useDialogFocus} from '../hooks/use-dialog-focus';

/**
 * 史官·一键分享 v1：局末把整局记录导出为「给 LLM 读的因果分析材料」。
 * 纯前端，不请求任何数据——史官记录由调用方（StrategyScreen）在局末生成后传入。
 * 剪贴板不可用时（http 环境、权限被拒）降级为选中隐藏文本框，让玩家手动复制，
 * 两条路径都有可见反馈：分享失败比没有分享更糟，玩家必须知道稿子在哪。
 *
 * 壳层（按钮、提示、文件名反馈）走 i18n 表；
 * renderChronicleMarkdown 的正文是内容层（史官笔法），保持中文。
 */
export default function ChronicleExport({record,onClose}:{record:ChronicleRecord;onClose:()=>void}){
 const [locale]=useLocale();
 const md=renderChronicleMarkdown(record);
 const [tip,setTip]=useState('');
 const fallbackRef=useRef<HTMLTextAreaElement>(null);
 // 清单 #B：导出浮层早就有 role=dialog/aria-modal，但焦点没人管——打开即移焦、
 // Esc 关闭、Tab 圈闭（复制/下载/预览框）、关闭后焦点还回触发它的导出按钮。
 const dialog=useDialogFocus<HTMLElement>({onClose});
 const copy=async()=>{
  try{await navigator.clipboard.writeText(md);setTip(t(locale,'export.copied'));}
  catch{const area=fallbackRef.current;if(area){area.focus();area.select();}setTip(t(locale,'export.fallback'));}
 };
 const download=()=>{
  const url=URL.createObjectURL(new Blob([md],{type:'text/markdown;charset=utf-8'}));
  const a=document.createElement('a');a.href=url;a.download=locale==='zh-CN'?'史境一局记录.md':'shijing-game-record.md';a.click();URL.revokeObjectURL(url);
  setTip(t(locale,'export.downloaded'));
 };
 return <aside ref={dialog} className="chronicle-export" role="dialog" aria-modal="true" aria-label={t(locale,'export.aria')}>
  <header><h2>{t(locale,'export.title')}</h2><button onClick={onClose} aria-label={t(locale,'export.close')}>×</button></header>
  <p className="chronicle-export-note">{t(locale,'export.note')}</p>
  <div className="chronicle-export-actions"><button onClick={copy}>{t(locale,'export.copy')}</button><button onClick={download}>{t(locale,'export.download')}</button></div>
  {tip&&<p className="chronicle-export-tip">{tip}</p>}
  <pre className="chronicle-export-preview">{md}</pre>
  <textarea ref={fallbackRef} className="chronicle-export-fallback" readOnly value={md} aria-label={t(locale,'export.copy')}/>
 </aside>;
}
