'use client';
import {ACHIEVEMENTS,type AchievementProgress} from '../../steam/achievements';
import {useLocale,translate as t,translateEnum} from '../lib/i18n';

/**
 * 存档与成就面板 v1：八个存档槽 + 成就一览，共用「这一局进行到哪儿了」的上下文。
 * 为什么并成一个面板：两者看的是同一局（标题、天数、朝政），分成两个界面玩家要在同一条
 * 动线上来回切；数据全部由 AgentDiscussion 持有（跳转/下令之后照样刷新），本组件只呈现与回调。
 *
 * 壳层双语（app/lib/i18n.ts 的 save.* 键）：按钮、页签、表头、aria-label、提示语全部走表；
 * 成就 name/description 与 slot.title 属内容层，留中文原值；朝政三态与成就档位
 * （bronze/silver/gold）是引擎枚举，走 translateEnum——引擎新增值回落原值，不白屏。
 */
export interface SaveSlotView{slot:number;gameId:string;title:string;savedAt:string;revision:number;elapsedDays:number;court:string;auto:boolean}
export interface AchievementsView{progress:AchievementProgress[];summary:string[];steamAvailable:boolean}
const savedAtText=(v:string)=>{try{return new Date(v).toLocaleString('zh-CN',{hour12:false});}catch{return v;}};
export default function SaveSlotsPanel({tab,onTab,slots,achv,busy,note,onSaveSlot,onLoadSlot,onClearSlot,onRefresh,onClose}:{
 tab:'saves'|'achv';onTab:(t:'saves'|'achv')=>void;slots:SaveSlotView[];achv:AchievementsView|null;busy:boolean;note:string;
 onSaveSlot:(slot:number)=>void;onLoadSlot:(slot:number)=>void;onClearSlot:(slot:number)=>void;onRefresh:()=>void;onClose:()=>void;
}){
 const [locale]=useLocale();
 const unlocked=achv?achv.progress.filter(p=>p.unlocked).length:0;
 return <aside className="saves-panel" role="dialog" aria-modal="true" aria-label={t(locale,'save.panelAria')}>
  <header><h2>{t(locale,'save.panelTitle')}</h2><span className="saves-count">{t(locale,'save.unlockedCount',{n:unlocked,total:ACHIEVEMENTS.length})}</span><button className="saves-close" onClick={onClose} aria-label={t(locale,'save.closeAria')}>×</button></header>
  <nav className="saves-tabs" aria-label={t(locale,'save.tabsAria')}>
   <button className={tab==='saves'?'saves-tab active':'saves-tab'} aria-pressed={tab==='saves'} onClick={()=>onTab('saves')}>{t(locale,'save.tabSaves')}</button>
   <button className={tab==='achv'?'saves-tab active':'saves-tab'} aria-pressed={tab==='achv'} onClick={()=>onTab('achv')}>{t(locale,'save.achievements')}</button>
  </nav>
  {tab==='saves'?<div className="saves-grid">{slots.map(s=><article key={s.slot} className={s.gameId?'saves-card':'saves-card saves-card-empty'}>
   <header className="saves-card-head"><b className="saves-slot">{t(locale,'save.slot',{n:s.slot})}</b>{s.auto&&<span className="saves-badge saves-badge-auto">{t(locale,'save.auto')}</span>}{s.court&&<span className="saves-badge">{translateEnum(locale,'court',s.court)}</span>}</header>
   {s.gameId?<>
    <p className="saves-title">{s.title}</p>
    <dl className="saves-meta">
     <div><dt>{t(locale,'save.savedAt')}</dt><dd>{savedAtText(s.savedAt)}</dd></div>
     <div><dt>{t(locale,'save.worldRevision')}</dt><dd>{s.revision}</dd></div>
     {/* 推演日按「第 N 日 = floor+1」口径取整：485.967… 直出会是 14 位小数（实测 UX-016） */}
     <div><dt>{t(locale,'save.simulation')}</dt><dd>{t(locale,'play.day',{day:Math.floor(s.elapsedDays)+1})}</dd></div>
    </dl>
    <div className="saves-actions">
     <button onClick={()=>onSaveSlot(s.slot)} disabled={busy}>{busy?t(locale,'save.busy'):t(locale,'save.saveHere')}</button>
     <button onClick={()=>onLoadSlot(s.slot)} disabled={busy}>{t(locale,'save.load')}</button>
     <button className="saves-danger" onClick={()=>onClearSlot(s.slot)} disabled={busy}>{t(locale,'save.clear')}</button>
    </div>
   </>:<div className="saves-actions"><button onClick={()=>onSaveSlot(s.slot)} disabled={busy}>{busy?t(locale,'save.busy'):t(locale,'save.saveHere')}</button><span className="saves-empty-hint">{t(locale,'save.emptySlot')}</span></div>}
  </article>)}</div>
  :<div className="achv-body">
   <div className="achv-head">
    <span className="achv-progress">{t(locale,'save.progressSummary',{n:unlocked,total:ACHIEVEMENTS.length,steam:achv?.steamAvailable?t(locale,'save.steamOn'):t(locale,'save.steamOff')})}</span>
    <button className="achv-refresh" onClick={onRefresh} disabled={busy}>{busy?t(locale,'save.loading'):t(locale,'save.refresh')}</button>
   </div>
   {achv&&achv.progress.length>0?<ul className="achv-grid">
     {ACHIEVEMENTS.map(a=>{const p=achv.progress.find(x=>x.id===a.id);
       return <li key={a.id} className={`achv-item achv-${a.tier}${p?.unlocked?' unlocked':''}${a.hidden&&!p?.unlocked?' hidden':''}`}>
        {/* 没配生图密钥的用户：预置徽记缺失时退到「名首字」字章，不留空框 */}
        <span className="achv-art">{a.name.slice(0,1)}</span>
        <img className="achv-art-img" src={`/achievements/${a.id}.png`} alt="" loading="lazy" decoding="async" onLoad={e=>{const span=e.currentTarget.previousElementSibling;if(span instanceof HTMLElement)span.style.display='none';}} onError={e=>{e.currentTarget.style.display='none';}}/>
        <div className="achv-meta">
         <b>{p?.unlocked||!a.hidden?a.name:t(locale,'save.hiddenName')}</b>
         <em>{a.hidden?t(locale,'save.hiddenTier'):translateEnum(locale,'save.tier',a.tier)}</em>
         <span className="achv-bar"><i style={{width:`${Math.round(Math.min(1,Math.max(0,p?.progress??0))*100)}%`}}/></span>
         <small>{p?.unlocked?t(locale,'save.unlockedAtDay',{n:Math.floor(p.unlockedAt??0)}):t(locale,'save.progress',{n:Math.round(Math.min(1,Math.max(0,p?.progress??0))*100)})}</small>
        </div>
       </li>;})}
    </ul>:<p className="achv-empty">{busy?t(locale,'save.achvComputing'):t(locale,'save.achvEmpty')}</p>}
   <p className="achv-note">{t(locale,'save.achvNote')}</p>
  </div>}
  {note&&<p className="saves-note" role="status">{note}</p>}
 </aside>;
}
