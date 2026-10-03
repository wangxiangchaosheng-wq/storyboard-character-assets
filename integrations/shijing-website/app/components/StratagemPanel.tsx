'use client';
import {useState} from 'react';
import {STRATAGEMS,matchStratagem,eligibility,stratagemSuccess,stratagemSummary,stratagemTitle,stratagemBasis} from '../../agents/src/stratagem';
import type {StrategyData} from '../lib/strategy';
import {useLocale,translate as t,translateEnum} from '../lib/i18n';

/**
 * 计策面板：预写计策池 + 玩家自提妙计的入口。
 * 判定走规则（或 LLM），执行走引擎——这里只展示资格、成功率与代价，不直接改世界。
 *
 * 壳层（面板标题、计策类型徽章、资格欠缺提示）走 i18n 表；
 * 计策标题与 basis（史例出处）是内容层（agents/src/content-i18n.ts），用
 * stratagemTitle/stratagemBasis 取值——英文缺失回落中文，AI 提案回落原题。
 */
export default function StratagemPanel({ world }: { world?: import('../../agents/src/world-contracts').WorldSnapshot | null }) {
 const [locale]=useLocale();
 const [prompt,setPrompt]=useState('');
 // matchStratagem 只在文本层面认关键词（不读世界），eligibility 才读世界——世界没到就判不合格。
 const matched=prompt.trim()?matchStratagem(world as never,prompt):null;
 const rows=matched?[matched]:STRATAGEMS;
 return <aside className="stratagem-panel" role="region" aria-label={t(locale,'panel.stratagem.title')}>
  <header><h2>{t(locale,'panel.stratagem.title')}</h2><span className="stratagem-count">{t(locale,'panel.stratagem.count',{n:STRATAGEMS.length})}</span></header>
  <div className="stratagem-propose">
   <label htmlFor="stratagem-prompt">{t(locale,'panel.stratagem.propose')}</label>
   <input id="stratagem-prompt" value={prompt} onChange={e=>setPrompt(e.target.value)} maxLength={200} placeholder={t(locale,'panel.stratagem.placeholder')}/>
  </div>
  {prompt.trim()&&!matched&&<p className="stratagem-miss">{t(locale,'panel.stratagem.miss')}</p>}
  <ul className="stratagem-list">{rows.map(s=>{
   const sum=stratagemSummary(s);
   const e=matched?eligibility(matched,{} as never):null;
   return <li key={s.id}>
    <div className="stratagem-row"><span className="stratagem-kind">{translateEnum(locale,'panel.stratagem.kind',s.kind)}</span><b>{stratagemTitle(s,locale)}</b>
     <span className="stratagem-odds">{Math.round(s.baseSuccess*100)}%</span></div>
    <p className="stratagem-basis">{stratagemBasis(s,locale)}</p>
    <p className="stratagem-meta">{sum[2]}</p>
    {s.source?<a className="stratagem-src" href={s.source} target="_blank" rel="noreferrer">{t(locale,'panel.stratagem.source')}</a>:<span className="stratagem-src stratagem-romance">{t(locale,'panel.stratagem.romance')}</span>}
    {e&&!e.ok&&<p className="stratagem-miss">{t(locale,'panel.stratagem.ineligible',{missing:e.missing.join(t(locale,'panel.stratagem.missJoin'))})}</p>}
   </li>;})}</ul>
 </aside>;
}
