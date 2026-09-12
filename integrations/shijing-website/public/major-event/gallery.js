import {searchEvents} from './search.mjs';
const $=s=>document.querySelector(s),form=$('#search'),canvas=$('#canvas'),art=$('#art'),empty=$('#empty'),status=$('#status'),results=$('#results');
const picker=$('#event-picker');
$('#close-picker').onclick=()=>picker.close();
picker.addEventListener('click',e=>{if(e.target===picker){const r=picker.getBoundingClientRect();if(e.clientX<r.left||e.clientX>r.right||e.clientY<r.top||e.clientY>r.bottom)picker.close();}});
const query=new URLSearchParams(location.search),run=query.get('run'),embedded=query.get('embedded')==='1';
let historical=[],collected=[],current=null,closed=false;
let entries=[],ticket=0,progress=0,raf=0,finishMotion=()=>{};
const paper=$('#paper'),left=$('.roller.left'),right=$('.roller.right');
function paint(p){progress=p;paper.style.clipPath=`inset(0 ${(1-p)*50}%)`;left.style.left=`${(1-p)*48.0433}%`;right.style.right=`${(1-p)*48.0433}%`;}
function animateTo(target,duration){cancelAnimationFrame(raf);finishMotion(false);const from=progress;return new Promise(resolve=>{finishMotion=resolve;if(matchMedia('(prefers-reduced-motion:reduce)').matches){paint(target);resolve(true);return;}const start=performance.now();function tick(now){const t=Math.min(1,(now-start)/duration),ease=t*t*(3-2*t);paint(from+(target-from)*ease);if(t<1)raf=requestAnimationFrame(tick);else resolve(true);}raf=requestAnimationFrame(tick);});}
function fit(){const controls=form.getBoundingClientRect().height+status.getBoundingClientRect().height;const room=Math.max(160,innerHeight-controls-(embedded?88:44));document.documentElement.style.setProperty('--scroll-width',Math.min(innerWidth*(embedded?.86:.92),room*1672/697)+'px');}
const resize=new ResizeObserver(fit);[form,status].forEach(n=>resize.observe(n));addEventListener('resize',fit);fit();paint(0);
const baseReady=Promise.all(['layer-11.png','layer-12.png'].map(src=>{const im=new Image();im.src=src;return im.decode();}));
async function show(entry){current=entry||null;const mine=++ticket;status.textContent=entry?'正在展开：'+entry.title:'没有找到对应事件';if(progress>0)await animateTo(0,1100);if(mine!==ticket)return;let loaded=false;try{await baseReady;}catch{status.textContent='卷轴素材读取失败，请刷新重试';return;}if(entry?.image){const img=new Image();img.src=entry.image;try{await img.decode();loaded=true;}catch{}}if(mine!==ticket)return;
 art.hidden=!loaded;empty.hidden=loaded;if(loaded){art.src=entry.image;art.alt=`${entry.title} · ${entry.time}`;}else{art.removeAttribute('src');empty.textContent=entry?'这件事件的图片尚未就绪':(run?'':'暂无匹配事件，请调整时间、地点或名称');}for(const b of results.children)b.setAttribute('aria-current',String(b.dataset.id===entry?.id));status.textContent=entry?`${entry.title} · ${entry.time} · ${(entry.places||[]).join('、')}${loaded?'':' · 图片待补充'}`:(run?'本议题尚无重大事件':'暂无匹配事件');fit();await animateTo(1,2500);}
function search(openPicker=false,all=false){const values=all?{}:Object.fromEntries(new FormData(form));const found=searchEvents(entries,values);results.replaceChildren();$('#picker-title').textContent=`${all?'全部事件':'检索结果'}（${found.length}）`;for(const entry of found){const b=document.createElement('button');b.textContent=`${entry.time} · ${entry.title}`;b.dataset.id=entry.id;b.onclick=()=>{picker.close();void show(entry);};results.append(b);}if(!found.length){const message=document.createElement('p');message.textContent=(run?'':'暂无匹配事件，请调整时间、地点或名称');results.append(message);}if(openPicker){if(!picker.open)picker.showModal();results.scrollTop=0;}else void show(found[0]);}
form.onsubmit=e=>{e.preventDefault();search(false);};$('#all-events').onclick=()=>{for(const name of ['time','place','event'])form.elements[name].value='';search(true,true);};
async function closeScroll(){const button=$('#confirm-event');button.disabled=true;closed=true;try{if(current?.runId){const response=await fetch('/api/agents/major-events/'+encodeURIComponent(current.id)+'/confirm',{method:'POST',headers:{'Content-Type':'application/json'},body:'{}'});if(!response.ok)throw Error('事件收录失败，请重试');}await animateTo(0,1100);parent.postMessage({type:'major-events-close',confirmed:current?.runId?[current.id]:[]},location.origin);}catch(e){status.textContent=e.message;button.disabled=false;closed=false;}}
$('#confirm-event').onclick=()=>void closeScroll();
$('#confirm-event').hidden=!embedded;$('#back-map').hidden=embedded;$('#topic-filter').hidden=!!run;
form.elements.topic.onchange=()=>{entries=form.elements.topic.value?collected.filter(e=>e.runId===form.elements.topic.value):historical;search(false);};
async function initialize(){
 const opening=embedded?baseReady.then(async()=>{if(closed)return;await new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)));if(!closed)await animateTo(1,2500);}):Promise.resolve();
 try{
 if(!run){const res=await fetch('library/index.json');if(!res.ok)throw Error('历史事件读取失败');historical=await res.json();}
 try{
 const response=await fetch('/api/agents/major-events'+(run?'?run='+encodeURIComponent(run):''),{signal:AbortSignal.timeout(12000)});
 let data;
 if(!response.ok&&run){
 // Existing discussion service can supply the current run even before the archive endpoint is available.
 const fallback=await fetch('/api/agents/runs/'+encodeURIComponent(run),{signal:AbortSignal.timeout(12000)});if(!fallback.ok)throw Error();const view=await fallback.json();
 data={topics:[],events:view.jobs.filter(j=>j.majorEvent&&j.status==='succeeded'&&j.asset).map(j=>({id:j.id,runId:run,topic:view.spec.title,title:j.plan?.summary||'重大事件',year:0,time:'时间未记载',places:[],aliases:[],image:'/api/agents/assets/'+j.asset}))};
 }else{if(!response.ok)throw Error();data=await response.json();}
 collected=data.events;for(const topic of data.topics){const option=document.createElement('option');option.value=topic.id;option.textContent=topic.title;form.elements.topic.append(option);}
 }catch{if(run)throw Error('议题事件暂时读取失败，请收卷后重试');}
 await opening;if(closed)return;
 entries=run?collected:historical;for(const name of ['time','place','event'])if(query.has(name))form.elements[name].value=query.get(name);
 const selected=entries.find(e=>e.id===query.get('selected'))||searchEvents(entries,Object.fromEntries(new FormData(form)))[0];
 if(embedded&&!selected){status.textContent='本议题尚无重大事件';empty.hidden=true;art.hidden=true;}else void show(selected);
 }catch(e){try{await opening;}catch{}if(!closed)status.textContent=e.message||'事件库读取失败，请刷新重试';}
}
void initialize();
