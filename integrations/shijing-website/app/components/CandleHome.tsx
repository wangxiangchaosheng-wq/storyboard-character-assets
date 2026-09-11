'use client';
import {useState} from 'react';
export default function CandleHome({onEvents}:{onEvents?:()=>void}={}) {
  const [scrollOpen,setScrollOpen]=useState(false);
  return (
    <>
    <a className="candle-home" href="/" aria-label="点击烛火，返回战略地图主页" title="返回主页">
      <span className="candle-home-glow" aria-hidden="true" />
      <img className="candle-home-image" src="/art/candle-home-hover.png" width={2488} height={2488} alt="" draggable={false} />
    </a>
    <a className="tiger-strategy" href="/?view=strategy" aria-label="点击虎符，返回开始页战略界面" title="战略地图">
      <img src="/art/tiger-strategy-hover.png" alt="" draggable={false} />
    </a>
    <button type="button" className={'bamboo-scroll'+(scrollOpen?' is-open':'')} aria-label={scrollOpen?'收起竹简上的卷轴':'展开竹简上的卷轴'} aria-pressed={scrollOpen} title={scrollOpen?'收起卷轴':'展开卷轴'} onClick={()=>{if(onEvents)onEvents();else setScrollOpen(open=>!open);}}>
      <span className="bamboo-scroll-glow" aria-hidden="true" />
      <img src="/art/bamboo-scroll-gold.png" alt="" draggable={false} />
    </button>
    </>
  );
}
