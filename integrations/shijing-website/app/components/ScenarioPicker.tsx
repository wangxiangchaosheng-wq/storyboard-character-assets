'use client';
import {useState} from 'react';
import {recommendDifficulty,type Difficulty} from '../../agents/src/onboarding';
import {scenarioTitle,scenarioPremise,scenarioHasSimulation,effectiveYears,type ScenarioPreset} from '../../agents/src/scenarios';
import {useLocale,translate as t,translateEnum} from '../lib/i18n';
import {useDialogFocus} from '../hooks/use-dialog-focus';

/**
 * 选局面板 v1：左侧剧本、右侧难度，底部开局。
 *
 * 难度档位把「你会少看到什么」写在卡面上（朝政状态、跳转粒度、代决明细、预警），
 * 玩家事先知情再选——与 onboarding.ts 的 difficulty description 同一承诺。
 * 开局时把难度写入 shijing-difficulty-v1：讨论页据此落默认朝政与跳转建议，
 * 这是两页之间唯一的隐式契约（选局面板本身不创建对局，创建交给调用方）。
 *
 * 壳层（面板标题、难度字段、朝政三态、卡片元信息）走 i18n 表；
 * 剧本标题与 premise 是内容层（agents/src/content-i18n.ts），用 scenarioTitle/scenarioPremise
 * 取值——英文缺失回落中文。background 正史叙述、人物名单、难度 description 仍为中文原值。
 */
export default function ScenarioPicker({scenarios,difficulties,onStart,onCancel}:{scenarios:ScenarioPreset[];difficulties:Difficulty[];onStart:(scenarioId:string,difficultyId:string)=>void;onCancel:()=>void}){
 const [locale]=useLocale();
 // 有存档即老玩家：扫本机既有的对局/引导记录，扫不到就按新玩家推荐「循循」
 const [saved]=useState(()=>{try{return Object.keys(localStorage).some(k=>k.startsWith('shijing-agent-run')||k.startsWith('shijing-research-run')||k==='shijing-onboard-v1');}catch{return false;}});
 const [scenarioId,setScenarioId]=useState(scenarios[0]?.id||'');
 const [difficultyId,setDifficultyId]=useState(()=>recommendDifficulty(saved).id);
 // 清单 #B：选局面板是模态浮层，焦点归 useDialogFocus 管（Esc=取消、Tab 圈闭、关闭还焦）
 const dialog=useDialogFocus<HTMLElement>({onClose:onCancel});
 const start=()=>{try{localStorage.setItem('shijing-difficulty-v1',difficultyId);}catch{/* 存储不可用只影响下次默认值，不挡开局 */}onStart(scenarioId,difficultyId);};
 return <section ref={dialog} className="scenario-picker" role="dialog" aria-modal="true" aria-label={t(locale,'scenario.title')}>
  <header className="scenario-picker-header"><h2>{t(locale,'scenario.title')}</h2><p>{t(locale,'scenario.subtitle')}</p><button type="button" onClick={onCancel} aria-label={t(locale,'scenario.close')}>×</button></header>
  <div className="scenario-picker-body">
   <ul className="scenario-picker-list" aria-label={t(locale,'scenario.list')}>{scenarios.map(s=><li key={s.id}>
    <button type="button" className={`scenario-picker-scenario ${s.id===scenarioId?'selected':''}`} aria-pressed={s.id===scenarioId} onClick={()=>setScenarioId(s.id)}>
     <b>{scenarioTitle(s,locale)}</b>
     {/* 诚实标注：这一局开出来是带本地战役推演，还是只有问对与阅览。判据走引擎自己的
         scenarioHasSimulation（buildInitialWorld 的准入门槛），不在这里复制年份表。 */}
     <span className={`scenario-picker-mode ${scenarioHasSimulation(s)?'can-sim':''}`}>{t(locale,scenarioHasSimulation(s)?'scenario.mode.sim':'scenario.mode.reading')}</span>
     <small>{t(locale,'scenario.meta',{year:s.year,season:s.season,faction:s.faction,years:effectiveYears(s)})}</small>
     <p>{scenarioPremise(s,locale)}</p>
     <em>{s.cast.map(c=>c.name).join(t(locale,'scenario.joiner'))}</em>
    </button></li>)}</ul>
   <ul className="scenario-picker-difficulties" aria-label={t(locale,'scenario.difficulties')}>{difficulties.map(d=><li key={d.id}>
    <button type="button" className={`scenario-picker-difficulty ${d.id===difficultyId?'selected':''}`} aria-pressed={d.id===difficultyId} onClick={()=>setDifficultyId(d.id)}>
     <b>{t(locale,`difficulty.${d.id}.name`)}</b>
     <p>{d.description}</p>
     <dl>
      <div><dt>{t(locale,'difficulty.field.court')}</dt><dd>{translateEnum(locale,'court',d.court)}</dd></div>
      <div><dt>{t(locale,'difficulty.field.granularity')}</dt><dd>{t(locale,'difficulty.field.granularityValue',{n:d.jumpGranularityDays})}</dd></div>
      <div><dt>{t(locale,'difficulty.field.length')}</dt><dd>{t(locale,'difficulty.field.lengthValue',{n:d.targetYears})}</dd></div>
      <div><dt>{t(locale,'difficulty.field.detail')}</dt><dd>{d.showDelegatedDetail?t(locale,'difficulty.field.detailAll'):t(locale,'difficulty.field.detailBrief')}</dd></div>
      <div><dt>{t(locale,'difficulty.field.alarms')}</dt><dd>{d.alarmsEnabled?t(locale,'common.on'):t(locale,'common.off')}</dd></div>
     </dl>
    </button></li>)}</ul>
  </div>
  <footer className="scenario-picker-footer"><button type="button" className="scenario-picker-cancel" onClick={onCancel}>{t(locale,'scenario.cancel')}</button><button type="button" className="scenario-picker-start" disabled={!scenarioId||!difficultyId} onClick={start}>{t(locale,'scenario.start')}</button></footer>
 </section>;
}
