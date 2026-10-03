'use client';
import StrategyArchiveScreen from './StrategyArchiveScreen';
import DecisionCard from './DecisionCard';
import FocusPanel from './FocusPanel';
import TechPanel from './TechPanel';
import WhatIfCard from './WhatIfCard';
import {useCallback,useEffect,useRef,useState,type ReactNode} from 'react';
import {linkedObjects,type StrategyData} from '../lib/strategy';
function arrowShape(from:{x:number;y:number},to:{x:number;y:number}){
 const dx=to.x-from.x,dy=to.y-from.y,d=Math.hypot(dx,dy)||1,ux=dx/d,uy=dy/d;
 const a={x:from.x+ux*22,y:from.y+uy*22},b={x:to.x-ux*26,y:to.y-uy*26};
 const bend=Math.min(70,d*.18),c={x:(a.x+b.x)/2-uy*bend,y:(a.y+b.y)/2+ux*bend};
 const point=(t:number)=>({x:(1-t)**2*a.x+2*(1-t)*t*c.x+t*t*b.x,y:(1-t)**2*a.y+2*(1-t)*t*c.y+t*t*b.y});
 const side=(t:number,w:number)=>{const q=point(t),vx=2*((1-t)*(c.x-a.x)+t*(b.x-c.x)),vy=2*((1-t)*(c.y-a.y)+t*(b.y-c.y)),n=Math.hypot(vx,vy)||1;return `${q.x-vy/n*w},${q.y+vx/n*w}`};
 const headT=Math.max(.55,1-24/d),tail=Math.min(13,d*.075),points=[];
 for(let i=0;i<=24;i++){const t=headT*i/24;points.push(side(t,4+(tail-4)*(1-t/headT)**2));}
 points.push(side(headT,15),`${b.x},${b.y}`,side(headT,-15));
 for(let i=24;i>=0;i--){const t=headT*i/24;points.push(side(t,-4-(tail-4)*(1-t/headT)**2));}
 return 'M'+points.join(' L')+' Z';
}
function MarkerStrategyScreen({data,onClose,toolbar,artwork="/strategy/map-world.svg",onDecide,busy,onAdoptFocus,onAdoptTech,onDecideWhatIf,onProvinceUpdate,inline}:{data:StrategyData;onClose:()=>void;toolbar?:(close:()=>void)=>ReactNode;artwork?:string;onDecide?:(choiceId:string)=>void;busy?:boolean;onAdoptFocus?:(focusId:string)=>void;onAdoptTech?:(techId:string)=>void;onDecideWhatIf?:(cardId:string,choiceId:string)=>void;onProvinceUpdate?:(provinceId:string,patch:{governorName?:string;mode?:string;policy?:string})=>void;inline?:boolean}){
 /**
  * 主底图用**预合成的整幅 map-canvas.png**（1725×863：纸色底 + 地形窗口一次烤平），
  * 不用 map-world.svg，也不用世界地形 PNG + CSS 偏移。
  *
  * 踩过的坑（本轮逐个实测）：
  * ① map-world.svg 直接用 —— SVG 作为 <img> 被缩放时，内部那张外链 terrain 只画出中间
  *    一条窄带，整幅其余部分是空白（引擎对「缩放 SVG 内嵌外链图」的处理缺陷）；
  * ② terrain PNG 内联成 data URI —— 1.5MB data URI 直接加载失败；
  * ③ terrain PNG + CSS inset 偏移到舆图窗口 —— 盒子几何完全正确，但带 left/top 偏移的
  *    大图在这个渲染器里同样只画一条（GPU 合成怪癖）。
  * 所以把纸色与地形按 SVG 注释里的同一套坐标（窗口 x∈[436,1608]、y∈[143,805]）
  * 预合成一张整幅 PNG，<img> 回到 0,0 满幅——以上三条全部绕开，城池点位分毫不差。
  * 生成方式见 scripts/make-map-canvas.mjs（改底图或换坐标必须重跑）。
  */
 /**
  * 底图：**一张预合成的整幅 2D PNG**（map-canvas.png，1725×863：纸色底 + 地形窗口一次烤平），
  * 当普通 <img> 用，不加任何合成层技巧。
  *
  * 踩过的坑（本轮逐个实测，全在本机渲染器复现，详见 fix-report-20260929-map-first-play.md）：
  * ① <img src="map-world.svg"> 缩放后只画中间一条窄带（引擎对「img 里的缩放 SVG 内嵌外链图」
  *    处理有缺陷；导航到 SVG 本身却完全正常）；
  * ② SVG 内外链图改 data URI 内联 → 1.5MB data URI 直接加载失败；
  * ③ 内联 SVG（rect + image）→ rect 都只画一条；
  * ④ 换 JPEG / CSS background-image / 带 left-top 偏移 → 同样只画一条；
  * ⑤ translateZ(0) / will-change 这类 GPU 提升是**加重**因素而不是解药（已从 CSS 移除）。
  * 而任何一次事后样式变动都会让它重画对——所以那是「首屏那次绘制」的缺陷，不是素材问题。
  *
  * 这一版回到最朴素的形态：整幅平面 PNG + 普通 img + 零技巧。素材本身是维多利亚3 那种
  * 纸面舆图（无 3D），窗口坐标与 map-world.svg 注释、城池点位归一化三者一致。
  * 生成脚本见 scripts/make-map-canvas.mjs（改底图或坐标必须重跑）。
  */
 const [ready,setReady]=useState(false);
 const artRef=useRef<HTMLImageElement>(null);
 const paperRef=useRef<HTMLDivElement>(null);
 /**
  * 强制重绘舆图纸张（补本机 IAB WebView 的首绘缺陷）。
  *
  * 缺陷（本轮反复实测）：底图与对象层在**首屏那次绘制**里都不出图——只余中间一条窄带，
  * 而布局测量全部正常（无 clip、opacity 1、盒子尺寸分毫不差），且页面上任何一次真实的
  * 样式失效（改 clipPath / appendChild / 改属性）都会让它立刻整幅上场。所以那是绘制缺陷，
  * 不是 CSS 或素材问题（完整证据链见 fix-report-20260929-map-first-play.md）。
  *
  * 做法：对 paper（img 与 svg 的共同父级）设一次 clipPath 再撤回——值没变，但浏览器必须
  * 重新合成这一层，子层随之重画。坏画出现的时刻不稳定，所以在若干时间点各推一掌，
  * 总有一掌落在它之后；推掌本身无副作用（clipPath 终态与 React 管的一样）。
  */
 const kickPaint=useCallback(()=>{
   const el=paperRef.current;if(!el)return;
   el.style.clipPath='none';
   requestAnimationFrame(()=>{el.style.clipPath='';});
 },[]);
 useEffect(()=>{const ids=[60,200,500,1000,2000,3500].map(ms=>setTimeout(kickPaint,ms));return()=>ids.forEach(clearTimeout);},[kickPaint]);
 const progress=useRef(0);
 const [p,setP]=useState(inline?1:0),[closing,setClosing]=useState(false),[selected,setSelected]=useState(''),[decision,setDecision]=useState(data.focusDecisionId||'');const close=useRef(onClose);close.current=onClose;
 useEffect(()=>{if(!ready&&!closing)return;let frame=0,start:number|undefined;const initial=progress.current;const duration=inline||matchMedia('(prefers-reduced-motion: reduce)').matches?1:closing?1100:3000;function tick(t:number){start??=t;const elapsed=t-start;const v=Math.min(1,Math.max(0,elapsed-(closing?0:300))/duration),ease=v*v*(3-2*v);const next=closing?initial*(1-ease):initial+(1-initial)*ease;progress.current=next;setP(next);if(v<1)frame=requestAnimationFrame(tick);else if(closing)close.current();}frame=requestAnimationFrame(tick);return()=>cancelAnimationFrame(frame);},[closing,ready,inline]);
 // inline（地图主页）不是弹层：没有「确认并收卷」，Esc 也不该关掉整个世界
 useEffect(()=>{if(inline)return;const before=document.activeElement as HTMLElement;const old=document.body.style.overflow;document.body.style.overflow='hidden';const key=(e:KeyboardEvent)=>{if(e.key==='Escape')setClosing(true);};addEventListener('keydown',key);return()=>{document.body.style.overflow=old;removeEventListener('keydown',key);before?.focus();};},[inline]);
 useEffect(()=>{setDecision(data.focusDecisionId||'');setSelected('');},[data.focusDecisionId]);
 const high=linkedObjects(data,decision);const army=data.armies.find(a=>a.id===selected),city=data.cities.find(a=>a.id===selected),action=data.actions.find(a=>a.id===selected),order=data.decisions.find(a=>a.id===(action?.decisionId||selected));const activeArmy=army||data.armies.find(a=>a.id===action?.armyId);const name=(id:string)=>data.cities.find(c=>c.id===id)?.name||data.armies.find(a=>a.id===id)?.name||id;
 /**
  * 舆图窗口 → 满幅画布的坐标换算。
  *
  * 引擎给的点位是「舆图窗口」归一坐标（世界坐标落到 x∈[436,1608]、y∈[143,805] 的
  * 1725×863 画布，见 world-bootstrap 的 projectPoint 与 map-world.svg 注释）。
  * 底图现在是**满幅**的 world-terrain.png（合成图 map-canvas.png 在本机渲染器里
  * 只画一条窄带，实测；满幅原图每次都画得完整），所以叠加层要同步换算：
  * 窗口里的同一个 (u,v) 在满幅画布上应落在 (u*1725, v*863)。
  */
 const px=(x:number)=>(x-436)/1172*1725,py=(y:number)=>(y-143)/662*863;
 const pt=(p:{x:number;y:number})=>({x:px(p.x),y:py(p.y)});
 // UX-005：详情面板不再给玩家看内部编号（ID: army-wei-yan 这类是调试字段）；数据来源说明
 // 整段折叠进「？」按钮，不再整段糊在面板首行。
 const fields:Record<string,unknown>=army?{名称:army.name,阵营:army.faction,统帅:army.commander,兵力:army.troops,'粮草(kg)':army.food,士气:army.morale,疲劳:army.fatigue,伤员:army.wounded,阵亡:army.dead,运输人员:army.transportPeople,位置:army.location||`${army.position.x}, ${army.position.y}`,状态:army.status}:city?{名称:city.name,坐标:`${city.position.x}, ${city.position.y}`,控制方:city.controller,守将:city.governor,'库存粮草(kg)':city.food,防御:city.defense,驻军:city.garrison}:action?{所属决策:order?.title,军队:activeArmy?.name,兵力:activeArmy?.troops,'粮草(kg)':activeArmy?.food,起点:name(action.from),目标:name(action.target),路线:action.route.map(p=>`${p.x},${p.y}`).join(' → '),进度:action.progress===undefined?undefined:`${action.progress}%`,时间:action.time,执行状态:action.status,具体决策:order?.command}:order?{标题:order.title,命令内容:order.command,下达时间:order.time,执行状态:order.status,相关对象:order.objects.map(name).join('、')}:{};
 const basisNote=data.basisNote&&Object.keys(fields).length?data.basisNote:'';
 const focusedDecision=data.decisions.find(d=>d.id===data.focusDecisionId);
 const cardArmy=data.armies.find(a=>focusedDecision?.objects.includes(a.id))||data.armies.find(a=>a.id==='army-wei-yan')||data.armies[0];
 const cardDecision=focusedDecision||data.decisions.find(d=>d.objects.includes(cardArmy?.id||''));
 const cardChanges=data.changes.filter(c=>c.entityId===cardArmy?.id);
 const latestRevision=Math.max(0,...cardChanges.map(c=>c.revision||0));
 const cardValue=(field:string,value:number|undefined)=>{const c=cardChanges.filter(c=>c.revision===latestRevision&&c.field===field).at(-1);return c?`${c.before.replace(/[,，]| kg| 人/g,'')} → ${c.after.replace(/[,，]| kg| 人/g,'')}`:value===undefined?'—':Math.round(value).toString();};
 const cardSummary=cardChanges.filter(c=>c.revision===latestRevision).at(-1)?.summary||cardDecision?.command||(cardArmy?'军队尚未出发，等待下达决策。':'等待该议题的世界状态数据。');
 const cardLines=Array.from(cardSummary.replace(/\s+/g,' ')).slice(0,36).join('').match(/.{1,18}/g)||[];
 const cardTime=data.worldTime.startYear?`公元${data.worldTime.startYear}年 · 第${Math.floor(data.worldTime.elapsedDays)+1}日`:'时间待提供';
 const anchor=army?.position||city?.position||(action?{x:(action.route[0].x+action.route[action.route.length-1].x)/2,y:(action.route[0].y+action.route[action.route.length-1].y)/2}:{x:420,y:370});
 const popupLeft=anchor.x>1150?anchor.x/1725*100-29:anchor.x/1725*100+2;
 const popupTop=Math.max(3,Math.min(48,(anchor.y-40)/863*100-5));
 const history=data.changes.filter(c=>selected&&((army||city)&&data.ready?c.entityId===selected:(c.objects.includes(selected)||c.decisionId===(action?.decisionId||selected))));
 const pending=data.pendingDecision;
   return <div className={inline?"strategy-overlay strategy-inline":toolbar?"strategy-overlay strategy-gallery-overlay":"strategy-overlay"} role={inline?undefined:"dialog"} aria-modal={inline?undefined:"true"} aria-label="议题战略地图" onKeyDown={e=>{if(e.key!=='Tab'||inline)return;const nodes=Array.from(e.currentTarget.querySelectorAll<HTMLElement>('button:not(:disabled),[tabindex="0"]'));const first=nodes[0],last=nodes.at(-1);if(e.shiftKey&&document.activeElement===first){e.preventDefault();last?.focus();}else if(!e.shiftKey&&document.activeElement===last){e.preventDefault();first?.focus();}}}>{inline?null:toolbar?toolbar(()=>setClosing(true)):<button className="strategy-close-original" onClick={()=>setClosing(true)} aria-label="确认并收卷">×</button>}<div className="strategy-scroll">{/* paper 的 clip-path 只在展开动画进行中挂；**静止态必须摘掉**——本机渲染器里
    带着 clip-path 的 <img> 只画中间一条窄带（整幅地图「缩成一条线」，实测去掉即恢复），
    而地图主页这一态是常驻的，绝不能让底图带病上场。 */}
{/* paper 的 clip-path 只在展开动画进行中挂；静止态摘掉（带着 clip-path 的首绘在这个
    渲染器里会坏画）。底图就是一张普通 img——零技巧，见上方注释的踩坑记录。 */}
<div ref={paperRef} className="strategy-paper" style={{clipPath:p===1?undefined:`inset(0 ${(1-p)*50}%)`,pointerEvents:p===1?'auto':'none'}}><img ref={artRef} className="strategy-art" src="/strategy/world-terrain.png" alt="三国战略地图" onLoad={()=>{setReady(true);kickPaint();}} onError={()=>setReady(true)}/><button className="strategy-original-decision" aria-label="查看决策并高亮相关对象" onClick={()=>{const d=cardDecision;if(d){setDecision(d.id);setSelected(d.id);}}}/>
<svg className="strategy-objects" viewBox="0 0 1725 863">
<g style={{pointerEvents:'none',fontFamily:'Songti SC,serif',fill:'#30291c'}} aria-label="当前决策与资源">
<text x="128" y="274" fontSize="18">{(cardDecision?.title||'初始部署').slice(0,10)}</text>
<text x="300" y="273" fontSize="14">{cardTime}</text>
<text x="298" y="339" fontSize="12">粮草 {cardValue('粮草',cardArmy?.food)} kg</text>
<text x="298" y="385" fontSize="12">兵力 {cardValue('兵力',cardArmy?.troops)}</text>
<text x="298" y="404" fontSize="13">{data.cities.find(c=>c.id==='changan')?.controller==='蜀'?'长安已由我方控制':data.cities.find(c=>c.id==='changan')?.controller?'长安仍由敌方控制':'长安归属待接入'}</text>
{cardLines.map((line,i)=><text key={i} x="135" y={441+i*23} fontSize="15" fill="#fff4dd">{line}</text>)}
</g><g transform="translate(0 -40)">
   {data.actions.filter(a=>!a.phase||['planned','active'].includes(a.phase)||selected===a.id||high.has(a.id)).map(a=><g key={a.id} role="button" tabIndex={0} aria-label={`行动：${name(a.from)}到${name(a.target)}`} onClick={()=>setSelected(a.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(a.id);}}} className={high.has(a.id)||selected===a.id?'lit':''}><defs><linearGradient id={'arrow-opacity-'+a.id} gradientUnits="userSpaceOnUse" x1={pt(data.cities.find(c=>c.id===a.from)?.position||a.route[0]).x} y1={pt(data.cities.find(c=>c.id===a.from)?.position||a.route[0]).y} x2={pt(data.cities.find(c=>c.id===a.target)?.position||a.route[a.route.length-1]).x} y2={pt(data.cities.find(c=>c.id===a.target)?.position||a.route[a.route.length-1]).y}><stop offset="0%" stopColor="white"/><stop offset="18%" stopColor="white"/><stop offset="48%" stopColor="white" stopOpacity=".18"/><stop offset="58%" stopColor="white" stopOpacity=".18"/><stop offset="85%" stopColor="white"/><stop offset="100%" stopColor="white"/></linearGradient><mask id={'arrow-fade-'+a.id} maskUnits="userSpaceOnUse" x="0" y="0" width="1725" height="941"><rect width="1725" height="941" fill={'url(#arrow-opacity-'+a.id+')'}/></mask></defs><path className="strategy-action-arrow" mask={'url(#arrow-fade-'+a.id+')'} d={arrowShape(pt(data.cities.find(c=>c.id===a.from)?.position||a.route[0]),pt(data.cities.find(c=>c.id===a.target)?.position||a.route[a.route.length-1]))} fill="#b52c1e" stroke="#f5dfb4" strokeWidth="2" strokeLinejoin="round"/></g>)}
{data.cities.map(c=><g key={c.id} role="button" tabIndex={0} aria-label={c.name} transform={`translate(${px(c.position.x)},${py(c.position.y)})`} className={high.has(c.id)?'lit':''} onClick={()=>setSelected(c.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(c.id);}}}><rect x="-30" y="-32" width="60" height="64" fill="transparent"/>{c.color&&<circle cx="26" cy="-20" r="7" fill={c.color} stroke="#f5e6c5" strokeWidth="2"/>}<g className="strategy-icon-light">{/* 十二城同一座城门楼：旧代码只给长安与汉中摆图标，其余十城是从底图上剪出来的一块
       剪影——底图换成水墨地形后那十座城就只剩一个色点，看着像没做。城楼外的色点报实时控制方。 */}<image href="/strategy/icon-9.png" x="-34" y="-35" width="68" height="68"/></g></g>)}
{data.armies.map(a=><g key={a.id} role="button" tabIndex={0} aria-label={a.name} transform={`translate(${px(a.position.x)},${py(a.position.y)})`} className={high.has(a.id)?'lit':''} onClick={()=>setSelected(a.id)} onKeyDown={e=>{if(e.key==='Enter'||e.key===' '){e.preventDefault();setSelected(a.id);}}}>{a.mapPosition&&<g style={{pointerEvents:'none'}}><line x1="12" y1="16" x2={px(a.mapPosition.x)-px(a.position.x)} y2={py(a.mapPosition.y)-py(a.position.y)} stroke={a.color||'#20573f'} strokeWidth="1.5" strokeDasharray="3 3"/><circle cx={px(a.mapPosition.x)-px(a.position.x)} cy={py(a.mapPosition.y)-py(a.position.y)} r="4" fill={a.color||'#20573f'} stroke="#fff2d5"/></g>}<rect x="-24" y="-54" width="76" height="76" fill="transparent"/><image href="/strategy/icon-5.png" x="-24" y="-54" width="76" height="76" style={{filter:a.faction==='魏'?'sepia(1) saturate(3) hue-rotate(320deg)':a.faction==='吴'?'sepia(1) saturate(2) hue-rotate(160deg)':undefined}}/><circle cx="12" cy="16" r="5" fill={a.color||'#20573f'} stroke="#f5e6c5"/>{data.ready&&<text x="14" y="35" textAnchor="middle" style={{fontFamily:'Songti SC,serif',fontSize:15,fill:'#302515',paintOrder:'stroke',stroke:'#edddba',strokeWidth:3,pointerEvents:'none'}}>{a.name}</text>}</g>)}
</g></svg><div className="strategy-side">{/* 三类待决：突发事件、天下新闻与脑洞由决策卡呈现；国策（花政治点）与科技（花科技点）常驻成树垫底。
      这些面板是 HTML 组件，必须挂在 SVG 外面——HTML 直接放进 <g> 没有 foreignObject 包裹时浏览器不做布局，
      全部塌成 0×0（实测试玩 BUG-002：决策按钮在 DOM 里却看不见点不到，玩家被「尚有决策未定」永久卡死）。
      待决卡必须排在列首：两棵树都有几百像素高，压在后面时玩家不滚动就看不到拦路的决策（实测踩过）。
      容器 pointer-events 关掉、面板自己打开，空隙处点击照落到底图。grep 组件名就能找到挂载点。 */}
   {pending?<DecisionCard card={pending} busy={busy} onDecide={c=>onDecide&&onDecide(c)}/>:null}
   {/* 脑洞决策：军议从当前局势读出的「如果…」。玩家不懂这段史时，替他问出下一步能怎么走。
      这是**可选**的岔路不是史实——定下了照付代价，起居注里明写「非常之谋」。 */}
   {data.whatIfs?.map(card=><WhatIfCard key={card.id} card={card} busy={busy} onDecide={(choiceId)=>onDecideWhatIf&&onDecideWhatIf(card.id,choiceId)}/>)}
   {/* inline（地图主页）把两棵树交给侧轨抽屉：地图右侧只留真正拦路的待决卡与脑洞岔路，
       否则两张几百像素高的树常驻在图右，图上可点的城与军被挤到边缘（P 社那套是
       树从图标轨进，不从地图上进）。弹层模式（廷议页的虎符）维持原样。 */}
   {!inline&&data.focuses?<FocusPanel focuses={data.focuses} busy={busy} onAdopt={id=>onAdoptFocus&&onAdoptFocus(id)}/>:null}
   {!inline&&data.techs?<TechPanel techs={data.techs} busy={busy} onAdopt={id=>onAdoptTech&&onAdoptTech(id)}/>:null}
  </div>{selected&&<section className="strategy-details" style={{left:`${popupLeft}%`,top:`${popupTop}%`,right:'auto'}} role="region" aria-label="对象详情"><button aria-label="关闭详情" onClick={()=>setSelected('')}>×</button><h3>{army?'军队':city?'城池':action?'行动':'决策'}详情</h3><dl>{Object.entries(fields).map(([k,v])=><div key={k}><dt>{k}</dt><dd>{v===undefined||v===null||v===''?'待接入':String(v)}</dd></div>)}</dl>{basisNote&&<details className="strategy-basis"><summary aria-label="数据来源说明">？</summary><p>{basisNote}</p></details>}<h4>状态变化历史</h4>{history.length?history.map((h,i)=><article key={i}><p>{h.time} · 决策 {h.decisionId}</p><p>对象：{h.objects.map(name).join('、')}</p><p>{h.before} → {h.after}</p><p>原因：{h.reason}</p></article>):<p>暂无变化记录</p>}</section>}</div>{['left','right'].map(side=><svg key={side} className={'strategy-roller '+side} style={{[side]:`${(1-p)*(50-75/1725*100)}%`,opacity:p===1?0:1}} viewBox={side==='left'?'0 0 75 863':'1650 0 75 863'} aria-hidden="true"><image href={artwork} width="1725" height="863"/></svg>)}</div></div>;
}

export default function StrategyScreen(props:{data:StrategyData;onClose:() =>void;toolbar?:(close:()=>void)=>ReactNode;artwork?:string;onDecide?:(choiceId:string)=>void;busy?:boolean;onAdoptFocus?:(focusId:string)=>void;onAdoptTech?:(techId:string)=>void;onDecideWhatIf?:(cardId:string,choiceId:string)=>void;onProvinceUpdate?:(provinceId:string,patch:{governorName?:string;mode?:string;policy?:string})=>void;inline?:boolean}){return !props.inline&&props.toolbar&&!props.data.ready?<StrategyArchiveScreen {...props}/>:<MarkerStrategyScreen {...props}/>;}
