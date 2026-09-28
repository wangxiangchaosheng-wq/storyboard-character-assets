'use client';
import {useEffect,useRef,useState} from 'react';

import {localTopicSpec} from '../../agents/src/local-topic';
import {ONBOARDING_STEPS,nextStep,onboardingProgress,difficulty,DIFFICULTIES,type OnboardingStepId} from '../../agents/src/onboarding';
import {castProfile} from '../../agents/src/cast';
import OnboardingOverlay from './OnboardingOverlay';
import ScenarioPicker from './ScenarioPicker';
import {SCENARIOS} from '../../agents/src/scenarios';
import StrategyScreen from './StrategyScreen';
import {type StrategyData} from '../lib/strategy';
import MajorEventScreen from './MajorEventScreen';
import PreparationScreen from './PreparationScreen';
import ChroniclePanel from './ChroniclePanel';
import ChronicleExport from './ChronicleExport';
import SaveSlotsPanel,{type SaveSlotView,type AchievementsView} from './SaveSlotsPanel';
import {buildChronicle,type ChronicleRecord} from '../../agents/src/historian';
import OriginalScene from './OriginalScene';import CandleHome from './CandleHome';
import LocaleSwitch from './LocaleSwitch';
import {slotIds,type TopicPlan,defaultTopic,parseTopic} from '../lib/topic';
import type {SceneAssets} from '../lib/scene-assets';
import type {Run,Job} from '../../agents/src/contracts';
import {useLocale,translate as t,translateEnum,detectLocale} from '../lib/i18n';
type View=Run&{strategy?:StrategyData;generationEnabled?:boolean;jobs:Job[];history:{event:{id:string;summary:string};before:Run['world'];after:Run['world']}[]};
async function api<T>(path:string,body?:unknown):Promise<T>{const res=await fetch('/api/agents/'+path,{method:body===undefined?'GET':'POST',headers:{'Content-Type':'application/json'},body:body===undefined?undefined:JSON.stringify(body),signal:AbortSignal.timeout(body===undefined?20000:270000)});const data=await res.json() as T&{error?:string};if(!res.ok)throw new Error(data.error||t(detectLocale(),'error.taskPending'));return data;}
export default function AgentDiscussion(){
  const [locale]=useLocale();
  // 绘制任务状态：随语言重算（zh-CN 下与原表逐字一致）
  const statusText:Record<Job['status'],string>={queued:t(locale,'job.queued'),planning:t(locale,'job.planning'),generating:t(locale,'job.generating'),checking:t(locale,'job.checking'),succeeded:t(locale,'job.succeeded'),failed:t(locale,'job.failed'),interrupted:t(locale,'job.interrupted')};
  const [strategyOpen,setStrategyOpen]=useState(false);
  useEffect(()=>{if(new URLSearchParams(location.search).get('strategy')==='1')openStrategy();},[]);
  const [eventsOpen,setEventsOpen]=useState(false);const [chronicleOpen,setChronicleOpen]=useState(false);const [jumpDay,setJumpDay]=useState('');const [jumpNote,setJumpNote]=useState('');const [jumpLines,setJumpLines]=useState<string[]>([]);
  const [exportOpen,setExportOpen]=useState(false);const [record,setRecord]=useState<ChronicleRecord|null>(null);
  // 存档与成就：面板数据由本组件持有，跳转/下令成功后各刷一次成就——新解锁当场 toast，落盘与推 Steam 都在服务端同一次请求里完成
  const [savePanelOpen,setSavePanelOpen]=useState(false);const [savePanelTab,setSavePanelTab]=useState<'saves'|'achv'>('saves');
  const [slots,setSlots]=useState<SaveSlotView[]>([]);const [achv,setAchv]=useState<AchievementsView|null>(null);const [saveBusy,setSaveBusy]=useState(false);const [saveNote,setSaveNote]=useState('');
  const [toast,setToast]=useState<string[]>([]);const toastTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(()=>()=>clearTimeout(toastTimer.current),[]);
  // 难度档位（选局面板写入 shijing-difficulty-v1）：朝政默认与跳转粒度都跟随它
  const [difficultyId,setDifficultyId]=useState(()=>{try{return localStorage.getItem('shijing-difficulty-v1')||'';}catch{return '';}});
  const [courtTouched,setCourtTouched]=useState(false);
  // 默认朝政优先跟随难度档位，玩家手动改过则以手动值为准
  const [court,setCourt]=useState<'attending'|'delegated'|'indulging'>(()=>{try{const v=localStorage.getItem('shijing-court-v1');if(v==='attending'||v==='indulging')return v;const d=localStorage.getItem('shijing-difficulty-v1');return d?difficulty(d).court:'delegated';}catch{return 'delegated';}});
  // 引导进度存本机：已完成步骤只增不减（乱序完成也被记，nextStep 自行跳过）
  const [onboardDone,setOnboardDone]=useState<OnboardingStepId[]>(()=>{try{const raw:unknown=JSON.parse(localStorage.getItem('shijing-onboard-v1')||'[]');return Array.isArray(raw)?raw.filter((x):x is OnboardingStepId=>ONBOARDING_STEPS.some(s=>s.id===x)):[];}catch{return [];}});
  const [onboardSkipped,setOnboardSkipped]=useState(()=>{try{return localStorage.getItem('shijing-onboard-skip-v1')==='1';}catch{return false;}});
  const [onboardHidden,setOnboardHidden]=useState(false);const [onboardFlash,setOnboardFlash]=useState(false);
  const onboardComplete=onboardingProgress(onboardDone).complete;const wasComplete=useRef(onboardComplete);
  // 收尾语只在「本局刚走完七步」时亮一次：刷新后不再闪，免得每次进场都道贺
  useEffect(()=>{if(onboardComplete&&!wasComplete.current)setOnboardFlash(true);wasComplete.current=onboardComplete;},[onboardComplete]);
  function markOnboard(id:OnboardingStepId){if(onboardDone.includes(id))return;const next=[...onboardDone,id];setOnboardDone(next);try{localStorage.setItem('shijing-onboard-v1',JSON.stringify(next));}catch{}}
  // 开舆图即引导第一步：在事件处理器里标记而非 effect——set-state-in-effect 会引发连锁渲染
  function openStrategy(){setStrategyOpen(true);markOnboard('open-map');}
  // 看国力没有「读完」的可观测信号，用驻足时长兜底——引导只提示，不该考试
  useEffect(()=>{if(!strategyOpen||onboardDone.includes('read-report'))return;const t=setTimeout(()=>markOnboard('read-report'),5000);return()=>clearTimeout(t);},[strategyOpen,onboardDone]);
  // 跳转建议粒度跟随难度档位；没选过难度就维持旧口径（+31 日）
  const suggestedJump=difficultyId?difficulty(difficultyId).jumpGranularityDays:31;
  // 选局面板：只有从没开过局的玩家会被挡在首页前；有对局存档或已选过局的直接进场
  const [scenarioChosen,setScenarioChosen]=useState(()=>{try{return !!localStorage.getItem('shijing-scenario-v1')||Object.keys(localStorage).some(k=>k.startsWith('shijing-agent-run')||k.startsWith('shijing-research-run'));}catch{return false;}});
  // 开局回调：难度与剧本落本机，朝政/跳转粒度即时生效；建对局仍走原 boot 流程，不在此处创建
  function startScenario(scenarioId:string,picked:string){try{localStorage.setItem('shijing-scenario-v1',scenarioId);}catch{}setDifficultyId(picked);if(!courtTouched)setCourt(difficulty(picked).court);setScenarioChosen(true);}
  const [displayStory,setDisplayStory]=useState<Job>();
  const [view,setView]=useState<View|null>(null),[error,setError]=useState(''),[status,setStatus]=useState(()=>t(locale,'discussion.statusReading')),[selected,setSelected]=useState(''),[text,setText]=useState(''),[act,setAct]=useState(false),[sending,setSending]=useState(false),[scale,setScale]=useState(1),[showWorld,setShowWorld]=useState(false);
  // UX-015：人物档案浮层（点左侧人物卡弹出）；UX-009：快选点击后发送键短高亮，提示「点这里发送」
  const [profileOpen,setProfileOpen]=useState(false);
  const [sendFlash,setSendFlash]=useState(false);const flashTimer=useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(()=>()=>clearTimeout(flashTimer.current),[]);
  function flashSend(){clearTimeout(flashTimer.current);setSendFlash(true);flashTimer.current=setTimeout(()=>setSendFlash(false),1400);}
  const viewport=useRef<HTMLDivElement>(null);const runId=useRef('');const boot=useRef<Promise<string>|null>(null);const log=useRef<HTMLDivElement>(null);
  useEffect(()=>{let alive=true;let timer:ReturnType<typeof setTimeout>;
    async function start(){const query=new URLSearchParams(location.search);const id=query.get('run');if(id){
        const old=await api<View>('runs/'+id);
        if(old.mode==='standalone'&&old.spec.cast.some(p=>p.role==='本地讨论人物')){
          const topic=query.get('topic')?parseTopic(JSON.parse(query.get('topic')!)):{...defaultTopic,title:old.spec.title,description:old.spec.scenario.background.split('当前使用本地预设')[0]};
          const updated=await api<View>('runs',{reuseKey:'local-cast-v2:'+id,spec:localTopicSpec(topic)});return updated.id;
        }
        return id;
      }
      const health=await api<{configured:boolean;engineConfigured:boolean;generationEnabled:boolean}>('health');
      const topic=query.get('topic')?parseTopic(JSON.parse(query.get('topic')!)):defaultTopic;
      const key=(health.engineConfigured?'shijing-research-run-v1:':'shijing-agent-run-v2:')+JSON.stringify(topic);let previous='';try{previous=localStorage.getItem(key)||'';}catch{}
      if(previous){try{await api('runs/'+previous);return previous;}catch{}}

      // 引导流程只跑一次（deps 恒为空）：其中的状态语用 detectLocale() 现取，
      // 而不是渲染闭包里的 locale——启动状态要几秒后才显示，那时玩家可能已经切了语言
      if(health.generationEnabled!==false&&!health.engineConfigured&&!health.configured)throw new Error(t(detectLocale(),'error.apiKey'));
      setStatus(t(detectLocale(),'discussion.statusCast'));let next:View;
      if(health.engineConfigured)next=await api<View>('runs',{reuseKey:key,researchTopic:topic});
      else if(health.generationEnabled===false)next=await api<View>('runs',{reuseKey:key,spec:localTopicSpec(topic)});
      else{
        // Standalone art mode reuses the existing director once; every subsequent asset uses the saved cast IDs.
        const res=await fetch('/api/agents/topic',{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({topic}),signal:AbortSignal.timeout(260000)});const plan=await res.json() as TopicPlan&{error?:string};if(!res.ok)throw new Error(plan.error||t(detectLocale(),'error.cast'));
        setStatus(t(detectLocale(),'discussion.statusJobs'));
        next=await api<View>('runs',{reuseKey:key,spec:{id:crypto.randomUUID(),title:topic.title,scenario:{background:`公元${topic.year}年${topic.season}。${topic.description}`},cast:plan.characters.map(p=>({id:p.id,name:p.name,role:p.role,description:JSON.stringify(p),stance:p.personality})),metrics:[]}});
      }
      try{localStorage.setItem(key,next.id);}catch{}return next.id;
    }
    async function refresh(){try{const data=await api<View>('runs/'+runId.current);if(alive){setView(data);setSelected(old=>old&&data.spec.cast.some(p=>p.id===old)?old:data.spec.cast[0].id);setStatus('');}}catch(e){if(alive)setError((e as Error).message);}finally{if(alive)timer=setTimeout(refresh,2500);}}
    boot.current??=start();void boot.current.then(id=>{if(!alive)return;runId.current=id;void api('runs/'+id+'/prepare',{}).catch(e=>{if(alive)setError(e.message);});const url=new URL(location.href);url.searchParams.set('run',id);history.replaceState(null,'',url);void refresh();}).catch(e=>{if(alive){setError(e.name==='TimeoutError'?t(detectLocale(),'error.timeout'):e.message);setStatus('');}});
    return()=>{alive=false;clearTimeout(timer);};
  },[]);
  // UX-008：取宽高比例的较小者（与旧版讨论页同款公式）——720p 这类矮窗按高度收，
  // 画板连同底部输入区完整落进视口，不再被折叠线切掉发送栏。
  useEffect(()=>{const node=viewport.current;if(!node)return;const observer=new ResizeObserver(([entry])=>setScale(Math.min(entry.contentRect.width/1672,Math.max(200,entry.contentRect.height)/941)));observer.observe(node);return()=>observer.disconnect();},[]);
  useEffect(()=>{log.current?.scrollTo({top:log.current.scrollHeight,behavior:'smooth'});},[view?.messages.length]);
  async function submit(){if(!view||!text.trim()||sending)return;if(act&&/^(下达行动|执行|开始)[。！!]*$/.test(text.trim())){setError(t(locale,'error.orderEmpty'));return;}setSending(true);setError('');const message=text;setText('');try{setView(await api<View>(`runs/${view.id}/messages`,{commandId:crypto.randomUUID(),text:message,to:selected,act}));if(act){markOnboard('issue-order');void refreshAchievements(view.id);}}catch(e){setText(message);setError(t(locale,'error.orderFailed',{message:(e as Error).message}));}finally{setSending(false);}}
  async function jump(targetArg?:number){
   // target 由调用方传入（「+30日」「+1年」这类快捷按钮），缺省才读输入框。
   // 不能改成「setJumpDay 之后调 jump()」：React 的 state 更新是异步的，jump() 会读到旧值。
   // BUG-104：小数目标日服务端已会向上取整；前端同口径 ceil 后再做区间校验，
   // 玩家照旧可以填 830.5，不必先学「取整」这道门槛。
   const target=Math.ceil(targetArg??Number(jumpDay));
   if(!view||!Number.isFinite(target)||sending)return;
   const now=Math.floor(view.strategy?.worldTime.elapsedDays??0);
   if(target<1||target>3650){setJumpNote(t(locale,'error.jumpRange'));return;}
   if(target<=now){setJumpNote(t(locale,'error.jumpPast',{n:now+1}));return;}
   // 框同步挪到结算之后：被决策暂停的跳转（reachedTarget=false）必须把原目标留在框里，
   // 玩家再点「跳转」就是续跑原目标。提前改框/按新日期重算会让「+30日」静默把目标
   // 从 31 推到 46（实测 UX-012）。跳满了才把框同步成到达日。
   setSending(true);setJumpNote('');
   try{
    const r=await api<View&{worldResult?:{jump?:{advancedDays:number;reachedTarget:boolean;pauses:string[];leisure:string[]}}}>(`runs/${view.id}/world-jump`,{commandId:crypto.randomUUID(),expectedRevision:view.world.version,targetDay:target,courtState:court});
    setView(r);markOnboard('jump-time');const j=r.worldResult?.jump;
    if(j?.reachedTarget!==false)setJumpDay(String(target));
    // 跳转是最可能一次性解锁一摞成就的时刻（断粮、屯田、三十之年都随推进天数结算）：当场算、当场 toast
    void refreshAchievements(r.id);
    // BUG-105：被决策卡拦停时，剩余天数不再像被丢弃——点名拦停的决策、兵止之日与原目标，
    // 让玩家知道裁决后还能续行；「去裁决」按钮由下方 pendingDecision 存在时自然显示。
    const halted=j&&j.pauses.length>0&&r.strategy?.pendingDecision;
    setJumpLines(j?.leisure||[]);
    // BUG-113：跳转全程走完而驿报还在途时，补一句「军情 N 日内送达御前」——玩家才知道
    // 这次为何没被拦停，以及接下来哪一刻御案上会多出一张卡。
    const it=r.strategy?.inTransit;
    const courier=j&&j.reachedTarget&&!halted&&it?.reports?.length
      ?t(locale,'discussion.jumpCourier',{list:[...new Set(it.reports.map(x=>x.title||''))].filter(Boolean).slice(0,3).join(t(locale,'common.joiner')),days:Math.max(0,it.nextReportInDays??0)}):'';
    setJumpNote(j?t(locale,'discussion.jumpAdvanced',{days:j.advancedDays})
      +(halted?t(locale,'discussion.jumpHalted',{title:r.strategy!.pendingDecision!.title,day:Math.floor(r.strategy!.worldTime.elapsedDays)+1,target})
        :(j.reachedTarget?'':t(locale,'discussion.jumpShort',{target}))+(j.pauses.length?t(locale,'discussion.jumpPauses',{list:[...new Set(j.pauses)].join(t(locale,'common.joiner'))}):t(locale,'discussion.jumpClear')))+courier:'');
   }catch(e){setJumpNote((e as Error).message);}
   finally{setSending(false);}
  }
  /** 历史决策卡：把玩家点的选项送到 sidecar 结算，再拉一次最新投影。 */
  async function decide(choiceId:string){
    if(!view)return;setSending(true);setError('');
    try{const r=await api<View>(`runs/${view.id}/decision`,{commandId:crypto.randomUUID(),expectedRevision:view.strategy?.revision??view.world.version,choiceId});
     setView(r);
     // 裁决落地的那一刻，跳转栏里挂着的拦截/暂停文案就成了旧世界的话——不清掉，
     // 玩家会照着「尚有决策未定」去找一张已经裁过的卡（实测 BUG-005）。
     setJumpNote('');}catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  /** 点国策：花政治点、按日见成效。与裁决决策卡同一套回读（刷新整份 view）。 */
  async function adoptFocus(focusId:string){
    if(!view)return;setSending(true);setError('');
    try{const r=await api<View>(`runs/${view.id}/focus`,{commandId:crypto.randomUUID(),expectedRevision:view.strategy?.revision??view.world.version,focusId});
     setView(r);}catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  /** 立项研究：与点国策同一套回读。 */
  /** 定一条脑洞岔路：与裁决策卡同一套回读。 */
  async function decideWhatIf(cardId:string,choiceId:string){
    if(!view)return;setSending(true);setError('');
    try{const r=await api<View>('runs/'+view.id+'/whatif',{commandId:crypto.randomUUID(),expectedRevision:view.strategy?.revision??view.world.version,cardId,choiceId});
     setView(r);setJumpNote('');}catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  async function adoptTech(techId:string){
    if(!view)return;setSending(true);setError('');
    try{const r=await api<View>('runs/'+view.id+'/tech',{commandId:crypto.randomUUID(),expectedRevision:view.strategy?.revision??view.world.version,techId});
     setView(r);}catch(e){setError((e as Error).message);}finally{setSending(false);}
  }
  async function updateProvince(provinceId:string,patch:{governorName?:string;mode?:string;policy?:string}){
   if(!view)return;setSending(true);setError('');
   try{
    const r=await api<View>(`runs/${view.id}/province-update`,{commandId:crypto.randomUUID(),expectedRevision:view.world.version,provinceId,reason:'玩家在省政面板交付',...patch});
    setView(r);markOnboard('set-policy');
   }catch(e){setError((e as Error).message);}
   finally{setSending(false);}
  }
  async function openChronicleExport(){
   if(!view)return;setError('');
   try{
    const r=await api<{record:ChronicleRecord}>(`runs/${view.id}/chronicle`);
    setRecord(r.record);setExportOpen(true);markOnboard('export');
   }catch(e){setError((e as Error).message);}
  }
  /** 成就刷新：GET 即「算 + 落盘 + 推 Steam」一次做完。静默失败——未初始化世界的议题没有成就可算，不该拿红错打扰玩家 */
  async function refreshAchievements(id:string){try{const r=await api<AchievementsView&{newlyUnlocked:{name:string}[]}>(`runs/${id}/achievements`);setAchv(r);showToast(r.newlyUnlocked.map(a=>t(locale,'save.unlocked',{name:a.name})));}catch{}}
  function showToast(lines:string[]){if(!lines.length)return;setToast(lines);clearTimeout(toastTimer.current);toastTimer.current=setTimeout(()=>setToast([]),3000);}
  async function loadSlots(){try{setSlots((await api<{slots:SaveSlotView[]}>('saves')).slots);}catch(e){setSaveNote((e as Error).message);}}
  function openSaves(tab:'saves'|'achv'){setSavePanelTab(tab);setSavePanelOpen(true);setSaveNote('');void loadSlots();if(tab==='achv'&&view)void refreshAchievements(view.id);}
  async function saveToSlot(slot:number){if(!view)return;setSaveBusy(true);setSaveNote('');try{const r=await api<{slot:SaveSlotView}>('saves',{slot,runId:view.id,court});setSlots(prev=>prev.map(s=>s.slot===slot?r.slot:s));// UX-103：elapsedDays 是浮点推演日，提示里按全站「第 N 日 = floor+1」口径取整
setSaveNote(t(locale,'save.saved',{slot,title:r.slot.title,day:Math.floor(r.slot.elapsedDays)+1}));}catch(e){setSaveNote((e as Error).message);}finally{setSaveBusy(false);}}
  async function loadFromSlot(slot:number){
   if(!view)return;setSaveBusy(true);setSaveNote('');
   try{
    const r=await api<{entry:{gameId:string;title:string}}>('saves/load',{slot});
    // 本局的槽直接走后端回滚（BUG-114）：后端把快照写回并返回新 view，「存档→作死→读档」真的能回去。
    if(r.entry.gameId===view.id){
     const res=await api<{run:View}>('saves/load',{slot,restore:true,runId:view.id});
     setView(res.run);setSaveNote(t(locale,'save.loaded',{day:Math.floor(res.run.strategy?.worldTime.elapsedDays??0)+1}));
     return;
    }
    if(!(await runExists(r.entry.gameId))){setSaveNote(t(locale,'save.notOnMachine',{title:r.entry.title}));return;}
    location.href='/?run='+encodeURIComponent(r.entry.gameId);
   }catch(e){setSaveNote((e as Error).message);}
   finally{setSaveBusy(false);}
  }
  async function runExists(id:string){try{await api(`runs/${id}`);return true;}catch{return false;}}
  async function clearSlotAt(slot:number){setSaveBusy(true);setSaveNote('');try{await del(`saves/${slot}`);setSlots(prev=>prev.map(s=>s.slot===slot?{...s,gameId:'',title:'',savedAt:'',revision:0,elapsedDays:0,court:'',auto:false}:s));setSaveNote(t(locale,'save.cleared',{slot}));}catch(e){setSaveNote((e as Error).message);}finally{setSaveBusy(false);}}
  async function del<T>(path:string):Promise<T>{const res=await fetch('/api/agents/'+path,{method:'DELETE',signal:AbortSignal.timeout(20000)});const data=await res.json() as T&{error?:string};if(!res.ok)throw new Error(data.error||t(detectLocale(),'error.actionFailed'));return data;}
  // 终局自动存档：一局走完就落进空槽（槽满则静默跳过），免得玩家忘了存；同一局只触发一次，刷新不重复存
  const autoSaved=useRef('');
  useEffect(()=>{
   if(!view?.strategy?.verdict?.over||autoSaved.current===view.id)return;
   autoSaved.current=view.id;
   void (async()=>{
    try{
     const r=await api<{slot:SaveSlotView}>('saves',{slot:0,runId:view.id,court,auto:true});
     setSlots(prev=>prev.map(s=>s.slot===r.slot.slot?r.slot:s));
     showToast([t(detectLocale(),'save.autoSaved',{slot:r.slot.slot,title:r.slot.title})]);
    }catch{/* 槽满或暂不可存都不打扰终局画面：手动存档入口一直在 */}
   })();
  },[view?.strategy?.verdict?.over]);
  async function sync(){if(!view)return;try{setView(await api<View>(`runs/${view.id}/sync`,{}));setError('');}catch(e){setError((e as Error).message);}}
  async function retry(job:Job){try{await api(`jobs/${job.id}/retry`,{});setView(await api<View>('runs/'+job.runId));setError('');}catch(e){setError((e as Error).message);}}
  const people=view?.spec.cast??[];const selectedIndex=Math.max(0,people.findIndex(p=>p.id===selected));const group=Math.floor(selectedIndex/5);const visible=people.slice(group*5,group*5+5);
  const latest=(kind:Job['kind'],subject?:string)=>view?.jobs.filter(j=>j.kind===kind&&(!subject||j.subjectId===subject)&&j.status==='succeeded').at(-1);
  const storyTask=view?.jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate).at(-1);const story=displayStory?.runId===view?.id?displayStory:undefined;const storyProgress=view?.generationEnabled===false?t(locale,'story.disabled'):storyTask?({queued:t(locale,'story.queued'),planning:t(locale,'story.planning'),generating:t(locale,'story.generating'),checking:t(locale,'story.checking'),failed:t(locale,'story.failed'),interrupted:t(locale,'story.interrupted'),succeeded:t(locale,'story.succeeded')}[storyTask.status]):t(locale,'story.waiting');const assetUrl=(j?:Job)=>j?.asset?'/api/agents/assets/'+j.asset:'';
  const readyStory=view?.jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate&&j.status==='succeeded'&&j.asset).at(-1);
  useEffect(()=>{
    if(!readyStory?.asset)return;
    let live=true;const image=new Image();
    image.onload=()=>{void image.decode().then(()=>{if(live)setDisplayStory(readyStory);}).catch(()=>{/* Keep the previous scene if the new image cannot be decoded. */});};
    image.src='/api/agents/assets/'+readyStory.asset;
    return()=>{live=false;image.onload=null;};
  },[readyStory?.id,readyStory?.asset]);
  const assets:SceneAssets={characters:slotIds.map((slot,i)=>{const p=visible[i];const url=p?assetUrl(latest('portrait',p.id)):'';return{id:slot,name:p?.name||'—',role:p?.role||'',card:url,avatar:url,hero:url};}),storyboard:{image:assetUrl(story),sceneKey:story?.subjectId||'',title:story?.plan?.summary||'',caption:story?.plan?.summary||'',location:''}};
  const activeSlot=slotIds[selectedIndex%5];const done=view?.jobs.filter(j=>j.status==='succeeded').length??0;const failed=view?.jobs.filter(j=>['failed','interrupted'].includes(j.status))??[];
  // BUG-112：问对（act=false）不需要推演——无推演的阅览室局也放开讨论通道；
  // 军令勾选框、方针/军令快选与跳转仍只在推演局（engine 或 localSimulation）出现。
  const canOrder=view?.mode==='engine'||!!view?.strategy?.localSimulation;
  const readingRoom=!canOrder&&view?.mode==='standalone'&&!!view?.strategy?.ready&&!view?.strategy?.localSimulation;
  const canDiscuss=canOrder||!!readingRoom;
  // UX-015：人物档案卡数据——立绘按 subjectId 匹配既有 job，文案用 castProfile 防御解析
  //（description 可能是双重 JSON 编码；id 与姓名可能错位，展示只认 name）。
  const profilePerson=people.find(p=>p.id===selected);
  const profile=profilePerson?castProfile(profilePerson):null;
  const profilePortrait=profilePerson?assetUrl(latest('portrait',profilePerson.id)):'';
  const profileOpenNow=profileOpen&&!!profilePerson&&canDiscuss;
  return <main className="scene-viewport discussion-fullwidth" ref={viewport}>
    {view&&strategyOpen&&<StrategyScreen data={view.strategy||{armies:[],cities:[],actions:[],decisions:[],changes:[],worldTime:{elapsedDays:view.world.day},ready:false}} onClose={()=>setStrategyOpen(false)} onProvinceUpdate={updateProvince} onDecide={decide} onAdoptFocus={adoptFocus} onAdoptTech={adoptTech} onDecideWhatIf={decideWhatIf} busy={sending}/>}
    {view&&<MajorEventScreen runId={view.id} jobs={view.jobs} onRetry={retry} open={eventsOpen} onClose={()=>setEventsOpen(false)}/>}
    <PreparationScreen key={view?.id||'loading'} loadingStatus={status} people={people} jobs={view?.jobs??[]} paused={view?.generationEnabled===false} error={error} onRetry={retry}/>

    {/* 错误提示排在输入区之前：它现在是流内元素（不再是 fixed 浮层），排在后面会掉到
       输入框底下，玩家看不见。还有待决决策时补一枚「去裁决」——军令 409「尚有决策未定」
       曾把玩家卡死在输入框前（BUG-002），给一条立刻能走通的路。 */}
    {error&&<div className="agent-error" role="alert">{error}{view?.strategy?.pendingDecision&&<button onClick={openStrategy}>{t(locale,'discussion.gotoDecision')}</button>}<button onClick={()=>location.reload()}>{t(locale,'discussion.reconnect')}</button></div>}
    <div className="artboard" style={{top:`max(0px, calc((100svh - ${941*scale}px) / 2))`,transform:`translateX(-50%) scale(${scale})`,transformOrigin:"top center"}}><OriginalScene assets={assets} activeId={activeSlot} pristine={false} editingInput={true}/><CandleHome onStrategy={openStrategy} onEvents={()=>setEventsOpen(true)}/><LocaleSwitch/>{/* 虎符按钮在 CandleHome 里（该文件不在本次改动范围）：同位透明锚点让引导能框住它，pointer-events 关掉即不拦点击 */}<span className="onboard-hotspot" data-onboard="open-map" aria-hidden="true" style={{position:'absolute',left:0,top:645,width:172,height:205,pointerEvents:'none'}}/>
      <aside className="character-rail" aria-label={t(locale,'discussion.castRail')}><div className="character-list">{visible.map((p,i)=><button key={p.id} className={`character-card ${selected===p.id?'selected':''}`} aria-label={`${p.name} · ${p.role}`} aria-pressed={selected===p.id} onClick={()=>{setSelected(p.id);setProfileOpen(true);}}>{!assets.characters[i].card&&<span className="asset-pending">{view?.generationEnabled===false?t(locale,'discussion.assetsWaiting'):statusText[view?.jobs.filter(j=>j.kind==='portrait'&&j.subjectId===p.id).at(-1)?.status||'queued']}</span>}</button>)}</div></aside>
      <section className="dialogue-panel" aria-label={t(locale,'discussion.aria')}><div className="conversation" role="log" aria-live="polite" ref={log}>{view?.messages.length?view.messages.map(m=><article className={`message ${m.kind==='player'?'user':'assistant'}`} key={m.id}><span className="user-mark">{(m.name||t(locale,'discussion.historian')).slice(0,1)}</span><div className="message-content"><b>{m.name||t(locale,'discussion.historian')}</b><p>{m.text}</p></div></article>):<article className="message assistant"><div className="message-content"><b>{t(locale,'discussion.historian')}</b><p>{view?.spec.scenario.background||t(locale,'discussion.preparing')}</p>{/* BUG-108/UX-101：无推演独立局（spec 建局）不再借用「连接推演引擎」的误导文案，把实情说破 */}<p>{view?.strategy?.localSimulation?t(locale,'discussion.localSim'):view?.strategy?.ready&&view?.mode==='standalone'?t(locale,'discussion.localNoSim'):view?.mode==='standalone'?t(locale,'discussion.standalone'):''}</p></div></article>}</div>
      {profileOpenNow&&profilePerson&&profile&&<aside className="character-profile" role="dialog" aria-label={`${profilePerson.name} · ${t(locale,'profile.aria')}`}>
        <button type="button" className="profile-close" onClick={()=>setProfileOpen(false)} aria-label={t(locale,'profile.close')}>×</button>
        {profilePortrait&&<img className="profile-portrait" src={profilePortrait} alt=""/>}
        <h3>{profilePerson.name}</h3>
        <p className="profile-role">{profilePerson.role}</p>
        {profile.stance&&<p className="profile-line"><b>{t(locale,'profile.stance')}</b>{profile.stance}</p>}
        {profile.opening&&<p className="profile-line"><b>{t(locale,'profile.brief')}</b>{profile.opening}</p>}
        {profile.appearance&&<p className="profile-appearance">{profile.appearance}</p>}
      </aside>}</section>
      <form className="composer" data-onboard="issue-order" onSubmit={e=>{e.preventDefault();void submit();}}><label className="sr-only" htmlFor="agent-message">{t(locale,'discussion.input')}</label><textarea id="agent-message" rows={1} maxLength={2000} value={text} onChange={e=>setText(e.target.value)} disabled={sending||!!view?.strategy?.verdict?.over||!canDiscuss}/><button type="submit" className={`art-button send-button ${sendFlash?'send-flash':''}`} aria-label={t(locale,'common.send')} disabled={sending||!text.trim()||!canDiscuss}/></form>
      {readingRoom&&<p className="reading-note" role="note">{t(locale,'discussion.readingRoomNote')}</p>}
      {!assets.storyboard.image&&<div className="story-pending"><strong>{t(locale,'discussion.storyboard')}</strong><p>{storyProgress}</p></div>}
    </div>
    {chronicleOpen&&view&&<ChroniclePanel changes={view.strategy?.changes||[]} onClose={()=>setChronicleOpen(false)} onboarding={nextStep(onboardDone)}/>}
      {view?.strategy?.verdict?.over&&<div className={`verdict verdict-${view.strategy.verdict.outcome}`} role="status">
        {/* reason 徽标：终局是哪条判据促成的（统一/覆灭/年期已满）。玩家该知道自己是
            「打完了」还是「拖到了收尾」——这两种结束的意义完全不同。 */}
        <b>{view.strategy.verdict.outcome==='victory'?t(locale,'discussion.verdictVictory'):t(locale,'discussion.verdictDefeat')}</b>
        <span className="verdict-reason">{t(locale,'endgame.reason.'+view.strategy.verdict.reason)}</span>
        <p>{view.strategy.verdict.summary}</p>
        <div className="verdict-actions"><button onClick={()=>location.href='/'}>{t(locale,'discussion.restart')}</button><button onClick={()=>void openChronicleExport()}>{t(locale,'endgame.export')}</button></div>
      </div>}
      {canOrder&&<label className="agent-action"><input type="checkbox" checked={act} onChange={e=>setAct(e.target.checked)}/>{t(locale,'discussion.actionHint')}</label>}
      {/* 方针优先：这条链路的主流玩法是「主上下一句总调」，不是逐条微操。所以方针示例排在
          军令示例前面，并且默认可直接点——点一下就等于说了这句话。 */}
      {canOrder&&<p className="directive-hint">{t(locale,'discussion.directiveHint')}</p>}
      {canOrder&&<div className="composer-examples composer-examples-directive">
        {[t(locale,'discussion.directiveExample1'),t(locale,'discussion.directiveExample2'),t(locale,'discussion.directiveExample3')].map(x=><button key={x} type="button" className="composer-example composer-example-directive" onClick={()=>{setText(x);setAct(true);flashSend();}}>{x}</button>)}
      </div>}
      {/* 在途文书：古代没有电报。这一行让「迟」看得见——令走到哪了、军情何时送到。 */}
      {(view?.strategy?.localSimulation||view?.mode==='engine')&&(()=>{const it=view?.strategy?.inTransit;
        // 倒计时用带小数的当前日：floor 过再 ceil 会凭空多出 1 日，跟诏令回复里
        // 「N 日后到军中」自相矛盾（实测 BUG-007）。到军时刻是 elapsedDays+路程天数。
        const day=view?.strategy?.worldTime.elapsedDays??0;
        const reports=it?.reports.length??0,edicts=it?.edicts.length??0;
        const line=reports?t(locale,'discussion.inTransitReports',{count:reports,days:it?.nextReportInDays??0}):edicts?t(locale,'discussion.inTransitEdicts',{count:edicts,days:Math.max(0,Math.ceil((it!.edicts[0].arrivalDay)-day))}):t(locale,'discussion.inTransitNone');
        return <p className="in-transit" data-testid="in-transit">{line}</p>;})()}
      {/* 示例军令：本地裁判的语法（「魏延 进攻 长安」）不该靠玩家猜。点一条即填入并
         自动勾上「下达行动」——不勾就只是聊天，这个门槛没人想得到。 */}
      {(view?.strategy?.localSimulation||view?.mode==='engine')&&<div className="composer-examples">
        {[t(locale,'discussion.example1'),t(locale,'discussion.example2'),t(locale,'discussion.example3')].map(x=><button key={x} type="button" className="composer-example" onClick={()=>{setText(x);setAct(true);flashSend();}}>{x}</button>)}
      </div>}
      <button type="button" className="chronicle-toggle" onClick={()=>setChronicleOpen(v=>!v)} aria-expanded={chronicleOpen}>{chronicleOpen?t(locale,'panel.chronicle.collapse'):t(locale,'panel.chronicle.open')}</button>
      {view&&<button type="button" className="chronicle-toggle chronicle-export-toggle" data-onboard="export" onClick={()=>void openChronicleExport()}>{t(locale,'discussion.exportButton')}</button>}
      {exportOpen&&record&&<ChronicleExport record={record} onClose={()=>setExportOpen(false)}/>}
      {view&&<button type="button" className="chronicle-toggle saves-toggle" onClick={()=>openSaves('saves')} aria-expanded={savePanelOpen&&savePanelTab==='saves'}>{t(locale,'save.open')}</button>}
      {view&&<button type="button" className="chronicle-toggle achv-toggle" onClick={()=>openSaves('achv')} aria-expanded={savePanelOpen&&savePanelTab==='achv'}>{t(locale,'save.achievements')}</button>}
      {savePanelOpen&&view&&<SaveSlotsPanel tab={savePanelTab} onTab={setSavePanelTab} slots={slots} achv={achv} busy={saveBusy} note={saveNote} onSaveSlot={s=>void saveToSlot(s)} onLoadSlot={s=>void loadFromSlot(s)} onClearSlot={s=>void clearSlotAt(s)} onRefresh={()=>void refreshAchievements(view.id)} onClose={()=>setSavePanelOpen(false)}/>}
      {toast.length>0&&<div className="achv-toast" role="status">{toast.map((line,i)=><p key={i}>{line}</p>)}</div>}
      {(view?.strategy?.localSimulation)&&<form className="jump-bar" data-onboard="jump-time" onSubmit={e=>{e.preventDefault();void jump();}}>
       <label htmlFor="jump-day">{t(locale,'discussion.jumpTo')}</label>
       <input id="jump-day" type="number" min={1} max={3650} value={jumpDay} onChange={e=>setJumpDay(e.target.value)} disabled={sending||!!view?.strategy?.verdict?.over} placeholder={String(Math.floor(view.strategy.worldTime.elapsedDays)+suggestedJump)}/>
       <span>{t(locale,'discussion.daySuffix')}</span>
       <button type="submit" disabled={sending||!jumpDay.trim()||!!view?.strategy?.verdict?.over}>{t(locale,'discussion.jumpSubmit')}</button>
       {/* 「+30日」「+1年」填框之后要**直接提交**。只填框的话，玩家点下去唯一的变化是
           输入框里的数字，页面毫无动静——很容易判成「按钮坏了」（实测试玩反馈）。 */}
       <button type="button" disabled={sending||!!view?.strategy?.verdict?.over} onClick={()=>void jump(Math.floor(view.strategy!.worldTime.elapsedDays)+30)}>{t(locale,'discussion.jump30')}</button>
       <button type="button" disabled={sending||!!view?.strategy?.verdict?.over} onClick={()=>void jump(Math.floor(view.strategy!.worldTime.elapsedDays)+365)}>{t(locale,'discussion.jumpYear')}</button>
       <label htmlFor="court-state">{t(locale,'discussion.during')}</label>
       <select id="court-state" data-onboard="delegate" value={court} onChange={e=>{const v=e.target.value as typeof court;setCourt(v);setCourtTouched(true);markOnboard('delegate');try{localStorage.setItem('shijing-court-v1',v);}catch{}}} disabled={sending||!!view?.strategy?.verdict?.over}>
        <option value="attending">{translateEnum(locale,'court','attending')}</option><option value="delegated">{translateEnum(locale,'court','delegated')}</option><option value="indulging">{translateEnum(locale,'court','indulging')}</option></select>
       {jumpNote&&<p className="jump-note" role="status">{jumpNote}{view?.strategy?.pendingDecision&&<button onClick={openStrategy}>{t(locale,'discussion.gotoDecision')}</button>}</p>}
       {jumpLines.length>1&&<div className="jump-leisure" role="status">{jumpLines.map((l,i)=><p key={i}>{l}</p>)}</div>}
      </form>}
    {people.length>5&&<nav className="agent-pages" aria-label={t(locale,'discussion.groups')}>{Array.from({length:Math.ceil(people.length/5)},(_,i)=><button key={i} onClick={()=>setSelected(people[i*5].id)}>{t(locale,'discussion.peopleRange',{from:i*5+1,to:Math.min(people.length,i*5+5)})}</button>)}</nav>}
    {failed.length>0&&<details className="agent-jobs"><summary>{t(locale,'discussion.jobsFailed',{n:failed.length})}</summary>{failed.map(j=><p key={j.id}>{people.find(p=>p.id===j.subjectId)?.name||t(locale,'discussion.storyboard')}{t(locale,'common.colon')}{j.error}<button onClick={()=>void retry(j)}>{t(locale,'discussion.retryItem')}</button></p>)}</details>}
    {showWorld&&<aside className="agent-world"><button onClick={()=>setShowWorld(false)}>{t(locale,'world.close')}</button><h2>{t(locale,'world.title')}</h2><p>{t(locale,'world.version',{n:view?.world.version??0})} · {view?.mode==='engine'?t(locale,'world.enginePace'):t(locale,'world.elapsed',{n:view?.world.day??0})}</p>{!view?.spec.metrics.length&&<p>{t(locale,'world.noMetrics')}</p>}{view?.spec.metrics.map(m=><p key={m.key}>{m.label}{t(locale,'common.colon')}<strong>{view.world.metrics[m.key]}</strong> {m.unit}</p>)}{Object.entries(view?.world.cities??{}).map(([city,owner])=><p key={city}>{city}{t(locale,'common.colon')}{owner}</p>)}<h3>{t(locale,'world.events')}</h3>{view?.history.map(h=><p key={h.event.id}>{h.event.summary}</p>)}</aside>}
    {/* 引导卡片：有下一步或刚走完七步时在场；跳过与收起都只影响本次会话，跳过另存本机标记 */}
    {!onboardSkipped&&!onboardHidden&&(nextStep(onboardDone)||onboardFlash)&&<OnboardingOverlay steps={ONBOARDING_STEPS} done={onboardDone} onDismiss={()=>{setOnboardFlash(false);setOnboardHidden(true);}} onSkipAll={()=>{try{localStorage.setItem('shijing-onboard-skip-v1','1');}catch{}setOnboardSkipped(true);}}/>}
    {/* 选局面板：新玩家的第一道门；取消只关本次会话，刷新后仍会再问 */}
    {!scenarioChosen&&<ScenarioPicker scenarios={SCENARIOS} difficulties={DIFFICULTIES} onStart={startScenario} onCancel={()=>setScenarioChosen(true)}/>}
  </main>;
}
