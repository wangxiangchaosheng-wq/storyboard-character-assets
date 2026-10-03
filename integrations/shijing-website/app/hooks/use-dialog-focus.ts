'use client';
import {useEffect,useRef,type RefObject} from 'react';

/**
 * 浮层（role="dialog"）焦点管理 hook v1——第 11 轮清单 #B。
 *
 * 此前四个模态浮层（启动器续局、选局面板、存档面板、史官导出）只挂了 role/aria-modal，
 * 键盘用户体验是坏的：打开时焦点还留在背后的触发按钮上（读屏软件不认为浮层已打开）、
 * Tab 可以直接走出浮层点到背后的页面、Esc 关不掉、关掉之后焦点坠回 document.body。
 * StrategyScreen 里有一份能用的实现（存 before → 锁 body overflow → 听 Esc → 卸载还焦），
 * 但四家各自复制一遍必然漂移——收成这一个 hook，四边共用同一套纪律。
 *
 * 选择器口径（与 StrategyScreen 内联版本的关键差异）：那条只列了 button/[tabindex="0"]，
 * 会把 a[href]/input/select/textarea 漏在圈外——廷议会话里的 play-court-link 就这么
 * 逃出去过。Tab 圈闭统一走 DIALOG_FOCUSABLE_SELECTOR。
 */

/** Tab 圈闭用的「可聚焦元素」选择器；四边共用，别再各自抄一份。 */
export const DIALOG_FOCUSABLE_SELECTOR='button:not(:disabled),a[href],input:not(:disabled),select:not(:disabled),textarea:not(:disabled),[tabindex]:not([tabindex="-1"])';

export interface DialogFocusOptions{
 /** Esc 按下时调用（一般是「关掉这个浮层」）；不传则 Esc 不关、只把焦点留在圈内。 */
 onClose?:()=>void;
 /** 是否模态：锁 body 滚动 + Tab 圈闭。/play 侧栏抽屉那种非阻塞场景传 false。默认 true。 */
 modal?:boolean;
 /** 显式开关，默认 true。浮层条件渲染时不用传；常驻挂载、靠条件显示隐藏的浮层才传。 */
 open?:boolean;
}

/** 浮层内可聚焦元素，DOM 序（Tab 圈闭与「首个可聚焦元素」都按它走）。 */
export function focusableNodes(container:HTMLElement):HTMLElement[]{
 return Array.from(container.querySelectorAll<HTMLElement>(DIALOG_FOCUSABLE_SELECTOR));
}

/**
 * 效果本体。刻意抽成自由函数而不是全焊在 useEffect 里：Node 下的单测没有 jsdom，
 * 喂一个最小 DOM 替身就能直接驱动「挂载移焦 → Esc 关闭 → Tab 圈闭 → 卸载还焦」
 * 整条生命周期（见 app/lib/use-dialog-focus.test.mjs）；hook 只是把它挂到 ref 上，
 * 行为等价。返回卸载函数（还焦 + 解锁滚动 + 摘监听）。
 */
export function attachDialogFocus(container:HTMLElement|null,options:DialogFocusOptions={}):()=>void{
 const {onClose,modal=true,open=true}=options;
 if(!open||!container)return()=>{};
 const before=document.activeElement as HTMLElement|null;
 const prevOverflow=document.body.style.overflow;
 if(modal)document.body.style.overflow='hidden';
 const nodes=focusableNodes(container);
 // 打开即移焦：首个可聚焦子元素；整个浮层一个可聚焦的都没有时容器自己接焦点
 // （临时 tabindex=-1，卸载时摘掉），否则焦点仍留在背后的页面上，
 // 读屏软件不知道浮层已经打开。
 const hadTabIndex=container.hasAttribute('tabindex');
 if(!nodes.length){container.tabIndex=-1;container.focus({preventScroll:true});}
 else nodes[0].focus({preventScroll:true});
 const key=(e:KeyboardEvent)=>{
  if(e.key==='Escape'){onClose?.();return;}
  if(e.key!=='Tab'||!modal)return;
  const list=focusableNodes(container);
  if(!list.length)return;
  const first=list[0],last=list[list.length-1],active=document.activeElement;
  // 焦点若已漂出浮层（或还停在 body 上），Tab 一律拉回圈内，不给逃逸
  const loose=active===container||active===null||!container.contains(active);
  if(e.shiftKey&&(loose||active===first)){e.preventDefault();last.focus();}
  else if(!e.shiftKey&&(loose||active===last)){e.preventDefault();first.focus();}
 };
 addEventListener('keydown',key);
 return()=>{
  removeEventListener('keydown',key);
  if(!hadTabIndex)container.removeAttribute('tabindex');
  document.body.style.overflow=prevOverflow;
  // 卸载还焦：开浮层之前焦点在哪儿就还回哪儿（触发按钮的常见情形）；触发元素
  // 已经不在 DOM 里时就地作罢——focus() 对离节点本来就是 no-op。
  if(before&&before.isConnected&&!container.contains(before))before.focus();
 };
}

/**
 * 组件用法：
 *   const dialogRef=useDialogFocus<HTMLElement>({onClose:...,modal:...});
 *   return <section ref={dialogRef} role="dialog" aria-modal="true" ...>…</section>;
 */
export function useDialogFocus<T extends HTMLElement=HTMLElement>(options:DialogFocusOptions={}):RefObject<T|null>{
 const ref=useRef<T>(null);
 const {onClose,modal=true,open=true}=options;
 // onClose 走 ref 不进 deps：调用方多半每次渲染传新的箭头函数，进 deps 会让效果
 // 反复「卸载还焦 → 重新移焦」，把玩家已经 Tab 过去的位置抢回来。
 const closeRef=useRef(onClose);closeRef.current=onClose;
 useEffect(()=>attachDialogFocus(ref.current,{modal,open,onClose:()=>closeRef.current?.()}),[modal,open]);
 return ref;
}
