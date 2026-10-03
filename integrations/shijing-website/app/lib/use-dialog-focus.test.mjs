import {test} from 'node:test';
import assert from 'node:assert/strict';
// Node 下没有 jsdom（依赖里也没有），喂一个最小 DOM 替身直接驱动 hook 的效果本体
// attachDialogFocus——它就是从 useEffect 里抽出来的自由函数，挂载/键盘/卸载三条
// 路径与组件内真实行为完全一致（useDialogFocus 只是把它包在 ref 生命周期上）。
import {attachDialogFocus,focusableNodes,useDialogFocus,DIALOG_FOCUSABLE_SELECTOR} from '../hooks/use-dialog-focus.ts';

/** 迷你 compound 选择器匹配：tag + :not(:disabled) + [attr]/[attr="v"]，够跑本测试用的选择器。 */
function attrMatch(inner,el){
 const m=/^([a-zA-Z-]+)(?:=(?:"([^"]*)"|'([^']*)'))?$/.exec(inner);
 assert.ok(m,`测试替身不认识的属性选择器：${inner}`);
 if(!(m[1] in el.attrs))return false;
 const want=m[2]??m[3];
 return want===undefined||String(el.attrs[m[1]])===want;
}
function simpleMatch(inner,el){
 if(inner===':disabled')return !!el.disabled;
 if(inner.startsWith('['))return attrMatch(inner.slice(1,-1),el);
 assert.fail(`测试替身不认识的简单选择器：${inner}`);
}
function matchCompound(sel,el){
 let i=0;
 const tag=/^[a-zA-Z]+/.exec(sel);
 if(tag){if(el.tagName!==tag[0].toUpperCase())return false;i=tag[0].length;}
 while(i<sel.length){
  if(sel.startsWith(':not(',i)){
   const end=sel.indexOf(')',i);
   if(simpleMatch(sel.slice(i+5,end),el))return false;
   i=end+1;
  }else if(sel[i]==='['){
   const end=sel.indexOf(']',i);
   if(!attrMatch(sel.slice(i+1,end),el))return false;
   i=end+1;
  }else assert.fail(`测试替身不认识的选择器片段：${sel}`);
 }
 return true;
}

function makeEl(tag,attrs={},id=tag){
 const el={
  id,tagName:tag.toUpperCase(),attrs:{...attrs},disabled:!!attrs.disabled,
  children:[],parent:null,focused:false,listeners:{},isConnected:true,
  focus(){el.focused=true;doc.activeElement=el;},
  contains(x){for(let n=x;n;n=n.parent)if(n===el)return true;return false;},
  addEventListener(t,f){(el.listeners[t]||=[]).push(f);},
  removeEventListener(t,f){const a=el.listeners[t];if(a)el.listeners[t]=a.filter(g=>g!==f);},
  hasAttribute(n){return n in el.attrs;},
  removeAttribute(n){delete el.attrs[n];},
  matches(s){return s.split(',').map(x=>x.trim()).some(g=>matchCompound(g,el));},
  querySelectorAll(s){const out=[];const walk=e=>{for(const c of e.children){if(c.matches(s))out.push(c);walk(c);}};walk(el);return out;},
 };
 // tabIndex 走 attribute：真实 DOM 里 tabIndex=-1 会写出 tabindex="-1"，选择器按属性命中
 Object.defineProperty(el,'tabIndex',{get(){return el.attrs.tabindex!==undefined?Number(el.attrs.tabindex):undefined;},set(v){el.attrs.tabindex=String(v);}});
 return el;
}
function append(parent,...kids){for(const k of kids){k.parent=parent;parent.children.push(k);}return parent;}

const doc={activeElement:null,body:{style:{overflow:''}},listeners:{},
 addEventListener(t,f){(doc.listeners[t]||=[]).push(f);},
 removeEventListener(t,f){const a=doc.listeners[t];if(a)doc.listeners[t]=a.filter(g=>g!==f);},
};
globalThis.document=doc;
globalThis.addEventListener=doc.addEventListener;
globalThis.removeEventListener=doc.removeEventListener;
/** 派发一次 keydown，返回事件对象（defaultPrevented 记录是否被圈闭拦下）。 */
function press(key,{shift=false}={}){
 const ev={key,shiftKey:shift,defaultPrevented:false,preventDefault(){ev.defaultPrevented=true;}};
 for(const f of [...(doc.listeners.keydown||[])])f(ev);
 return ev;
}

/** 一棵典型浮层树：关闭钮 / 对局链接 / 输入框 / 普通 div / 禁用钮 / 无 href 的 a / tabbable div。 */
function makeDialog(){
 const box=makeEl('section',{},'box');
 const close=makeEl('button',{},'close');
 const link=makeEl('a',{href:'/play?run=x'},'link');
 const input=makeEl('input',{},'input');
 const div=makeEl('div',{},'div');
 const disabledBtn=makeEl('button',{disabled:true},'disabledBtn');
 const bareAnchor=makeEl('a',{},'bareAnchor');
 const tabbable=makeEl('div',{tabindex:'0'},'tabbable');
 append(box,close,link,input,div,disabledBtn,bareAnchor,tabbable);
 return {box,close,link,input,div,disabledBtn,bareAnchor,tabbable};
}

test('可聚焦选择器：只收 button/a[href]/input/select/textarea/[tabindex≠-1]，禁用与裸 a 排除',()=>{
 const {box,close,link,input,disabledBtn,bareAnchor,tabbable}=makeDialog();
 assert.deepEqual(focusableNodes(box).map(e=>e.id),['close','link','input','tabbable']);
 assert.ok(!focusableNodes(box).includes(disabledBtn));
 assert.ok(!focusableNodes(box).includes(bareAnchor));
 // [tabindex="-1"]（程序性可聚焦但不出现在 Tab 序里）同样排除
 const negative=makeEl('div',{tabindex:'-1'},'negative');
 append(box,negative);
 assert.ok(!focusableNodes(box).includes(negative));
 assert.ok(DIALOG_FOCUSABLE_SELECTOR.includes('a[href]')&&DIALOG_FOCUSABLE_SELECTOR.includes('textarea'));
});

test('挂载：焦点移入首个可聚焦元素，模态默认锁 body 滚动',()=>{
 const {box,close}=makeDialog();
 const trigger=makeEl('button',{},'trigger');
 doc.activeElement=trigger;doc.body.style.overflow='';
 const detach=attachDialogFocus(box);
 assert.equal(doc.activeElement,close,'打开即移焦，焦点不能还留在背后的触发按钮上');
 assert.equal(doc.body.style.overflow,'hidden');
 detach();
});

test('Esc 触发 onClose',()=>{
 const {box}=makeDialog();
 let closed=0;
 const detach=attachDialogFocus(box,{onClose:()=>{closed++;}});
 press('Escape');
 assert.equal(closed,1);
 press('Escape');
 assert.equal(closed,2);
 detach();
});

test('Tab 圈闭：末尾向前归位、首项向后归位、Shift 反向、中间元素不拦',()=>{
 const {box,close,link,tabbable}=makeDialog();
 const detach=attachDialogFocus(box);
 doc.activeElement=tabbable;
 const fwd=press('Tab');
 assert.equal(fwd.defaultPrevented,true);
 assert.equal(doc.activeElement,close,'Tab 不能逃逸到浮层背后的页面');
 doc.activeElement=close;
 const back=press('Tab',{shift:true});
 assert.equal(back.defaultPrevented,true);
 assert.equal(doc.activeElement,tabbable);
 doc.activeElement=link;
 const mid=press('Tab');
 assert.equal(mid.defaultPrevented,false,'圈内正常移动不拦');
 detach();
});

test('焦点漂到浮层外或 body 上时，Tab 一律拉回圈内',()=>{
 const {box,close,tabbable}=makeDialog();
 const detach=attachDialogFocus(box);
 doc.activeElement=null;
 const ev=press('Tab');
 assert.equal(ev.defaultPrevented,true);
 assert.equal(doc.activeElement,close);
 detach();
});

test('卸载：还原 body 滚动、焦点还回打开前的触发按钮、监听摘净、Esc 失效',()=>{
 const {box}=makeDialog();
 const trigger=makeEl('button',{},'trigger');
 doc.activeElement=trigger;doc.body.style.overflow='';
 let closed=0;
 const detach=attachDialogFocus(box,{onClose:()=>{closed++;}});
 assert.equal(doc.activeElement.id,'close');
 detach();
 assert.equal(doc.body.style.overflow,'');
 assert.equal(doc.activeElement,trigger,'关掉浮层焦点要还回触发按钮，不能坠回 body');
 assert.equal((doc.listeners.keydown||[]).length,0);
 press('Escape');
 assert.equal(closed,0,'卸载后 Esc 不再触发关闭');
});

test('浮层内一个可聚焦元素都没有：容器自身接焦点，卸载时摘掉临时 tabindex',()=>{
 const box=makeEl('section',{},'emptyBox');
 assert.equal(box.hasAttribute('tabindex'),false);
 const detach=attachDialogFocus(box);
 assert.equal(doc.activeElement,box);
 assert.equal(box.attrs.tabindex,'-1');
 detach();
 assert.equal(box.hasAttribute('tabindex'),false,'tabindex=-1 是临时的，不能留在 DOM 里');
});

test('modal=false（/play 抽屉）：不锁滚动、不圈 Tab，但 Esc 与焦点移入/还焦仍在',()=>{
 const {box,tabbable}=makeDialog();
 const trigger=makeEl('button',{},'trigger');
 doc.activeElement=trigger;doc.body.style.overflow='';
 let closed=0;
 const detach=attachDialogFocus(box,{modal:false,onClose:()=>{closed++;}});
 assert.equal(doc.activeElement.id,'close','非模态也要移焦，否则读屏软件不知道抽屉开了');
 assert.equal(doc.body.style.overflow,'','抽屉不锁背景滚动');
 doc.activeElement=tabbable;
 const ev=press('Tab');
 assert.equal(ev.defaultPrevented,false,'非模态不圈 Tab——抽屉自带的 × 在面板之前，圈死了键盘到不了');
 press('Escape');
 assert.equal(closed,1,'Esc 关抽屉照旧');
 detach();
 assert.equal(doc.activeElement,trigger,'关闭照样还焦');
 assert.equal(doc.body.style.overflow,'');
});

test('open=false / 无容器：整套效果不挂，不动焦点不监听',()=>{
 const {box,close}=makeDialog();
 const trigger=makeEl('button',{},'trigger');
 doc.activeElement=trigger;doc.body.style.overflow='';
 const detachA=attachDialogFocus(box,{open:false});
 assert.equal(doc.activeElement,trigger);
 assert.equal(doc.body.style.overflow,'');
 const detachB=attachDialogFocus(null);
 assert.equal(doc.activeElement,trigger);
 assert.equal((doc.listeners.keydown||[]).length,0);
 detachA();detachB();
 assert.equal(doc.activeElement,trigger,'no-op 路径的卸载也不能抢焦点');
});

test('触发元素在浮层内部时不还焦（那是要被卸载的节点）',()=>{
 const {box,link,close}=makeDialog();
 doc.activeElement=link;
 const detach=attachDialogFocus(box);
 assert.equal(doc.activeElement,close);
 detach();
 assert.equal(doc.activeElement,close,'before 在容器内就跳过还焦，不把焦点塞进正在卸载的节点');
});

test('useDialogFocus 导出了可用的 hook（真实渲染由组件接入处覆盖）',()=>{
 assert.equal(typeof useDialogFocus,'function');
 assert.equal(typeof attachDialogFocus,'function');
});
