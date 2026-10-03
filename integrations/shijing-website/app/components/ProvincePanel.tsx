'use client';
import {useState} from 'react';
import type {ProvinceView} from '../lib/strategy';
import {useLocale,translate as t,translateEnum} from '../lib/i18n';

/**
 * 省面板：玩家对一省只能做四件事——任太守、设治政模式、写年度方针、看省报表。
 * 城建、募兵、运粮一律不在此处；那是太守 AI 的活。
 *
 * 壳层（统计表头、治政模式枚举、按钮与提示）走 i18n 表。
 * p.mode 是引擎写回的模式值，MODES 用它当 select 的 value——展示名单独映射，两不相混。
 */
const MODES=['未定','屯田','募兵','马政','工坊','商榷'] as const;

export default function ProvincePanel({provinces,onUpdate,busy}:{provinces:ProvinceView[];onUpdate?:(provinceId:string,patch:{governorName?:string;mode?:string;policy?:string})=>void;busy?:boolean}){
 const [locale]=useLocale();
 const [openId,setOpenId]=useState(provinces.find(p=>p.owner==='蜀')?.id||provinces[0]?.id||'');
 const current=provinces.find(p=>p.id===openId)||provinces[0];
 // 三个 useState 必须在任何 early return **之前**：函数组件不允许条件 Hook。
 // 曾经的写法把这三个放在 if(!current)return null 之后，省列表由空变非空时
 //（开局/换一局/刷新刚拿到 provinces）会直接抛「Rendered fewer hooks than expected」整页崩掉。
 const [draftMode,setDraftMode]=useState(current?.mode||MODES[0]);
 const [draftPolicy,setDraftPolicy]=useState(current?.policy||'');
 const [draftGovernor,setDraftGovernor]=useState(current?.governor||'');
 if(!current)return null;
 const select=(id:string)=>{const p=provinces.find(x=>x.id===id);setOpenId(id);if(p){setDraftMode(p.mode);setDraftPolicy(p.policy||'');setDraftGovernor(p.governor||'');}};
 const dirty=draftMode!==current.mode||draftPolicy!==(current.policy||'')||draftGovernor!==(current.governor||'');
 return <aside className="province-panel" role="region" aria-label={t(locale,'panel.province.title')}>
  <header><h2>{t(locale,'panel.province.title')}</h2><span className="province-count">{t(locale,'panel.province.count',{n:provinces.length})}</span></header>
  <nav className="province-tabs" aria-label={t(locale,'panel.province.title')}>{provinces.map(p=><button key={p.id} className={p.id===openId?'selected':''} onClick={()=>select(p.id)} aria-pressed={p.id===openId}>
   <b style={{color:p.ownerColor}}>{p.name}</b><small>{p.owner} · {translateEnum(locale,'panel.province.mode',p.mode)}</small></button>)}</nav>
  <section className="province-body">
   <h3>{current.name}<small>{t(locale,'panel.province.seat',{city:current.seatCityId==='hanzhong'?'汉中':current.name})}</small></h3>
   <dl className="province-stats">
    <div><dt>{t(locale,'panel.province.troops')}</dt><dd>{current.troops.toLocaleString('zh-CN')} {t(locale,'common.men')}</dd></div>
    <div><dt>{t(locale,'panel.province.food')}</dt><dd>{current.foodKg.toLocaleString('zh-CN')} {t(locale,'common.kg')}</dd></div>
    <div><dt>{t(locale,'panel.province.defense')}</dt><dd>{t(locale,'panel.province.defenseValue',{n:current.defense})}</dd></div>
    <div><dt>{t(locale,'panel.province.cities')}</dt><dd>{t(locale,'panel.province.cityCount',{n:current.cityCount})}</dd></div>
    {current.census?<div><dt>{t(locale,'panel.province.households')}</dt><dd>{current.census.households.toLocaleString('zh-CN')} {t(locale,'panel.province.householdsUnit')}</dd></div>:null}
    {current.census?<div><dt>{t(locale,'panel.province.population')}</dt><dd>{current.census.population.toLocaleString('zh-CN')} {t(locale,'common.men')}</dd></div>:null}
    {current.census&&current.levyRate!==undefined?<div><dt>{t(locale,'panel.province.levyRate')}</dt><dd>{(current.levyRate*100).toFixed(2)}%</dd></div>:null}
   </dl>
   {current.census?<p className="province-census">{t(locale,'panel.province.censusNote',{source:current.census.source})}</p>:<p className="province-census province-census-missing">{t(locale,'panel.province.censusUnknown')}</p>}
   <p className="province-source">{t(locale,'panel.province.source',{agri:current.agriculture.toLocaleString('zh-CN'),commerce:current.commerce.toLocaleString('zh-CN'),manpower:current.manpower.toLocaleString('zh-CN'),specialties:current.specialties.length?t(locale,'panel.province.specialties',{list:current.specialties.join(t(locale,'common.joiner'))}):''})}</p>
   <div className="province-output"><h4>{t(locale,'panel.province.output')}</h4>
    <dl><div><dt>{t(locale,'panel.province.grain')}</dt><dd>{Math.round(current.output.year.food).toLocaleString('zh-CN')}</dd></div>
     <div><dt>{t(locale,'panel.province.coin')}</dt><dd>{Math.round(current.output.year.coin).toLocaleString('zh-CN')}</dd></div>
     <div><dt>{t(locale,'panel.province.corvee')}</dt><dd>{Math.round(current.output.year.corvee).toLocaleString('zh-CN')}</dd></div>
     <div><dt>{t(locale,'panel.province.manpower')}</dt><dd>{Math.round(current.output.year.manpower).toLocaleString('zh-CN')}</dd></div></dl>
    {current.output.factors.length?<p className="province-factors">{t(locale,'panel.province.factors',{list:current.output.factors.map(f=>`${f.label} ×${f.factor}`).join(t(locale,'common.joiner'))})}</p>:<p className="province-factors">{t(locale,'panel.province.factorsNone')}</p>}
   </div>
   <div className="province-field"><label htmlFor="p-governor">{t(locale,'panel.province.governor')}</label>
    <input id="p-governor" value={draftGovernor} onChange={e=>setDraftGovernor(e.target.value)} disabled={busy} maxLength={100} placeholder={t(locale,'panel.province.governorVacant')}/></div>
   <div className="province-field"><label htmlFor="p-mode">{t(locale,'panel.province.mode')}</label>
    <select id="p-mode" value={draftMode} onChange={e=>setDraftMode(e.target.value)} disabled={busy}>{MODES.map(m=><option key={m} value={m}>{translateEnum(locale,'panel.province.mode',m)}</option>)}</select></div>
   <div className="province-field"><label htmlFor="p-policy">{t(locale,'panel.province.policy')}</label>
    <textarea id="p-policy" rows={3} value={draftPolicy} onChange={e=>setDraftPolicy(e.target.value)} disabled={busy} maxLength={2000} placeholder={t(locale,'panel.province.policyHint')}/></div>
   <button type="button" className="province-save" disabled={busy||!dirty||!onUpdate} onClick={()=>onUpdate?.(current.id,{governorName:draftGovernor||undefined,mode:draftMode,policy:draftPolicy||undefined})}>
    {onUpdate?(dirty?t(locale,'panel.province.commit'):t(locale,'panel.province.noChange')):t(locale,'panel.province.readOnly')}</button>
   <p className="province-hint">{t(locale,'panel.province.hint')}</p>
  </section>
 </aside>;
}
