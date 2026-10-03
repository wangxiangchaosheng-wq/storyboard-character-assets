'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import StrategyScreen from './StrategyScreen';
import NationalPowerPanel, { nationalPower } from './NationalPowerPanel';
import FocusPanel from './FocusPanel';
import TechPanel from './TechPanel';
import ProvincePanel from './ProvincePanel';
import DiplomacyPanel from './DiplomacyPanel';
import TreasuryPanel from './TreasuryPanel';
import FogPanel from './FogPanel';
import StratagemPanel from './StratagemPanel';
import AlarmBanner from './AlarmBanner';
import ChroniclePanel from './ChroniclePanel';
import ChronicleExport from './ChronicleExport';
import SaveSlotsPanel, { type SaveSlotView, type AchievementsView } from './SaveSlotsPanel';
import MajorEventScreen from './MajorEventScreen';
import DecisionCard from './DecisionCard';
import LocaleSwitch from './LocaleSwitch';
import { ONBOARDING_STEPS, nextStep, onboardingProgress, difficulty, type OnboardingStepId } from '../../agents/src/onboarding';
import { buildChronicle, type ChronicleRecord } from '../../agents/src/historian';
import type { Run, Job } from '../../agents/src/contracts';
import { useLocale, translate as t, translateEnum } from '../lib/i18n';

/**
 * 地图主页（/play）——史境的核心界面。
 *
 * 为什么是这个形状：玩家绝大多数交互都发生在地图上（点城、点军队、看路线、裁决、下令）。
 * 既然地图是主页面，面板就该**从地图上进**，而不是跳到另一屏再跳回来——参考 P 社那套：
 * 地图常满屏，顶栏给时间与国力，侧栏一条图标轨，点哪域开哪域的面板（停在图上，不遮全屏），
 * 底部一条指令栏随时能说话。
 *
 * 与 AgentDiscussion 的关系：那一页是「廷议/问对」的人物对话界面，作为本页一个面板
 * （廷议）继续可用；本页不复用它的实现——两套交互模型，共享的是 sidecar 端点与纪律
 * （commandId 幂等 + expectedRevision 乐观锁）。
 *
 * 顺带把一批**孤儿面板**接上了线：NationalPowerPanel / AlarmBanner / TreasuryPanel /
 * DiplomacyPanel / FogPanel / StratagemPanel 此前建好了却没有任何地方渲染，
 * 而 StrategyData 早就投影了 politics / diplomacy / fiscal / alarms 数据。
 */

type View = Run & { strategy?: import('../lib/strategy').StrategyData; jobs?: Job[]; generationEnabled?: boolean; history?: { event: { id: string; summary: string } }[] };

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/agents/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 20000 : 270000),
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || t(detectLocale(), 'error.taskPending'));
  return data;
}
function detectLocale(): 'zh-CN' | 'en' {
  try { const v = localStorage.getItem('shijing-locale'); if (v === 'en' || v === 'zh-CN') return v; } catch { /* 隐私模式 */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

/** 侧栏图标轨的域。键即 i18n 前缀 play.dock.<key>。 */
const PANELS = ['power', 'politics', 'fiscal', 'focus', 'tech', 'province', 'diplomacy', 'fog', 'stratagem', 'chronicle', 'court', 'saves'] as const;
type Panel = typeof PANELS[number];

export default function PlayScreen() {
  const [locale] = useLocale();
  const [view, setView] = useState<View | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState(() => t(locale, 'play.loading'));
  const [panel, setPanel] = useState<Panel | null>(null);
  const [saveTab, setSaveTab] = useState<'saves' | 'achv'>('saves');
  /** 开面板：存档/成就抽屉要把列表真的拉回来（否则槽位永远是空的），
   *  切到成就页签要真的核算一次。 */
  const openPanel = useCallback((p: Panel) => {
    setPanel(cur => (cur === p ? null : p));
    if (p !== 'saves') return;
    void (async () => { try { setSlots((await api<{ slots: SaveSlotView[] }>('saves')).slots); } catch { /* 列表失败只让面板空着 */ } })();
    void (async () => {
      try {
        const r = await api<AchievementsView & { newlyUnlocked: { name: string }[] }>('runs/' + runId.current + '/achievements');
        setAchv(r);
        showToast(r.newlyUnlocked.map(a => t(locale, 'save.unlocked', { name: a.name })));
      } catch { /* 无成就可算时不打扰 */ }
    })();
  }, [locale]);
  const [text, setText] = useState('');
  const [act, setAct] = useState(false);
  const [jumpDay, setJumpDay] = useState('');
  const [note, setNote] = useState('');
  const [record, setRecord] = useState<ChronicleRecord | null>(null);
  const [exportOpen, setExportOpen] = useState(false);
  const [eventsOpen, setEventsOpen] = useState(false);
  const [slots, setSlots] = useState<SaveSlotView[]>([]);
  const [achv, setAchv] = useState<AchievementsView | null>(null);
  const [toast, setToast] = useState<string[]>([]);
  const [saveNote, setSaveNote] = useState('');
  const [rawWorld, setRawWorld] = useState<import('../../agents/src/world-contracts').WorldSnapshot | null>(null);
  // 引导进度与难度档位：**不能**在 useState 初值里读 localStorage——SSR 时它不存在，
  // 服务端兜底成 [] / standard，客户端首帧 hydration 读到真值 → 两侧 HTML 不一致，
  // React  hydration 报错、且难度徽章会从「寻常」闪成真实档位（静态审查实测）。
  // 照 useLocale 的做法：首帧给无害默认值，挂载后再读本机。
  const [onboardDone, setOnboardDone] = useState<OnboardingStepId[]>([]);
  const [courtId, setCourtId] = useState(() => difficulty('standard'));
  useEffect(() => {
    try {
      const raw: unknown = JSON.parse(localStorage.getItem('shijing-onboard-v1') || '[]');
      setOnboardDone(Array.isArray(raw) ? raw.filter((x): x is OnboardingStepId => ONBOARDING_STEPS.some(step => step.id === x)) : []);
    } catch { /* 隐私模式下就当没做过引导 */ }
    try { setCourtId(difficulty(localStorage.getItem('shijing-difficulty-v1') || 'standard')); } catch { /* 同上 */ }
  }, []);
  const log = useRef<HTMLDivElement>(null);
  const runId = useRef('');
  const toastTimer = useRef<ReturnType<typeof setTimeout>>(undefined);
  useEffect(() => () => clearTimeout(toastTimer.current), []);

  // 只依赖 URL 里的 run 参数（读一次存 ref）：切语言不该把整局重拉一遍、轮询计时器归零
  //（原来 deps 是 [locale]，LocaleSwitch 一切就走 boot + prepare + 重置 2.5s 计时）。
  const runParam = useRef<string | null>(null);
  if (runParam.current === null) runParam.current = new URLSearchParams(location.search).get('run');
  const localeRef = useRef(locale); localeRef.current = locale;
  useEffect(() => {
    const id = runParam.current;
    if (!id) { setStatus(t(localeRef.current, 'play.noRun')); return; }
    runId.current = id;
    let alive = true, timer: ReturnType<typeof setTimeout>;
    async function boot() {
      try { const v = await api<View>('runs/' + id); if (alive) { setView(v); setStatus(''); void api('runs/' + id + '/prepare', {}).catch(() => { /* 准备失败不挡看图 */ }); } }
      catch (e) { if (alive) setStatus((e as Error).message); }
    }
    void boot();
    // 2.5s 轮询与廷议页同口径：世界在被 AI 代决、任务在后台推进，地图要能自己跟上
    const tick = () => { void api<View>('runs/' + id).then(v => { if (alive) { setView(v); setError(''); } }).catch(() => { /* 单次失败交给下一次 */ }).finally(() => { if (alive) timer = setTimeout(tick, 2500); }); };
    timer = setTimeout(tick, 2500);
    return () => { alive = false; clearTimeout(timer); };
  }, []);

  useEffect(() => { log.current?.scrollTo({ top: log.current.scrollHeight, behavior: 'smooth' }); }, [view?.messages.length]);
  // 这一页地图就是主页面——「点虎符摊开舆图」那一步在这里天然完成，直接记掉，
  // 否则引导卡会拿着一句本页不存在的操作提示玩家（截图实测）。
  useEffect(() => { markOnboard('open-map'); }, []);
  useEffect(() => { const url = new URL(location.href); url.searchParams.set('run', runId.current); history.replaceState(null, '', url); }, [view?.id]);

  function markOnboard(id: OnboardingStepId) {
    if (onboardDone.includes(id)) return;
    const next = [...onboardDone, id];
    setOnboardDone(next);
    try { localStorage.setItem('shijing-onboard-v1', JSON.stringify(next)); } catch { /* 存储不可用只影响进度记忆 */ }
  }
  function showToast(lines: string[]) { if (!lines.length) return; setToast(lines); clearTimeout(toastTimer.current); toastTimer.current = setTimeout(() => setToast([]), 3200); }

  /** 说话：勾了 act 就是军令，没勾就是问对。与廷议页同一端点。 */
  async function submit() {
    if (!view || busy) return;
    // 空话拦截：勾了「下达行动」却只说「下达行动/执行/开始」时，原先会打到服务端吃一条裸 400。
    // 与廷议页同一道门（AgentDiscussion 的正则），两页口径一致。
    if (!text.trim() || (act && /^(下达行动|执行|开始)[。！!]*$/.test(text.trim()))) { setError(t(locale, 'error.orderEmpty')); return; }
    setBusy(true); setError(''); setNote('');
    const message = text; setText('');
    try {
      const r = await api<View>(`runs/${view.id}/messages`, { commandId: crypto.randomUUID(), text: message, act });
      setView(r);
      if (act) markOnboard('issue-order');
    } catch (e) { setText(message); setError(t(locale, 'error.orderFailed', { message: (e as Error).message })); }
    finally { setBusy(false); }
  }

  /** 跳转到指定推演日（内部按日分片，遇暂停即停）。 */
  async function jump(targetArg?: number) {
    if (!view || busy) return;
    const target = Math.ceil(targetArg ?? Number(jumpDay));
    const now = Math.floor(view.strategy?.worldTime.elapsedDays ?? 0);
    if (!Number.isFinite(target) || target < 1 || target > 3650) { setNote(t(locale, 'error.jumpRange')); return; }
    if (target <= now) { setNote(t(locale, 'error.jumpPast', { n: now + 1 })); return; }
    setBusy(true); setNote(''); setError('');
    try {
      const r = await api<View & { worldResult?: { jump?: { advancedDays: number; reachedTarget: boolean; pauses: string[]; leisure: string[] } } }>(`runs/${view.id}/world-jump`, {
        commandId: crypto.randomUUID(), expectedRevision: view.world.version, targetDay: target, courtState: 'delegated',
      });
      setView(r);
      const j = r.worldResult?.jump;
      if (j?.reachedTarget !== false) setJumpDay(String(target));
      setNote(j ? t(locale, 'discussion.jumpAdvanced', { days: j.advancedDays }) + (j.pauses.length ? t(locale, 'discussion.jumpPauses', { list: [...new Set(j.pauses)].join(t(locale, 'common.joiner')) }) : t(locale, 'discussion.jumpClear')) : '');
      if (j?.reachedTarget) markOnboard('jump-time');
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }

  /** 推进固定小时（引擎的 advance，不出跳转汇报）——调试与快进都走它。 */
  async function advance(hours: number) {
    if (!view || busy) return;
    setBusy(true); setError(''); setNote('');
    try {
      const r = await api<View>(`runs/${view.id}/world-advance`, { commandId: crypto.randomUUID(), expectedRevision: view.world.version, hours });
      setView(r); setNote(t(locale, 'play.advanced', { h: hours }));
    } catch (e) { setNote((e as Error).message); }
    finally { setBusy(false); }
  }

  async function decide(choiceId: string) {
    if (!view) return;
    if (s?.verdict?.over) return; // 终局后地图上的待决卡/国策/省政不该还能点 setBusy(true); setError('');
    try { setView(await api<View>(`runs/${view.id}/decision`, { commandId: crypto.randomUUID(), expectedRevision: view.strategy?.revision ?? view.world.version, choiceId })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function adoptFocus(focusId: string) {
    if (!view) return;
    if (s?.verdict?.over) return; // 终局后地图上的待决卡/国策/省政不该还能点 setBusy(true); setError('');
    try { setView(await api<View>(`runs/${view.id}/focus`, { commandId: crypto.randomUUID(), expectedRevision: view.strategy?.revision ?? view.world.version, focusId })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function adoptTech(techId: string) {
    if (!view) return;
    if (s?.verdict?.over) return; // 终局后地图上的待决卡/国策/省政不该还能点 setBusy(true); setError('');
    try { setView(await api<View>(`runs/${view.id}/tech`, { commandId: crypto.randomUUID(), expectedRevision: view.strategy?.revision ?? view.world.version, techId })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function decideWhatIf(cardId: string, choiceId: string) {
    if (!view) return;
    if (s?.verdict?.over) return; // 终局后地图上的待决卡/国策/省政不该还能点 setBusy(true); setError('');
    try { setView(await api<View>('runs/' + view.id + '/whatif', { commandId: crypto.randomUUID(), expectedRevision: view.strategy?.revision ?? view.world.version, cardId, choiceId })); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function updateProvince(provinceId: string, patch: { governorName?: string; mode?: string; policy?: string }) {
    if (!view) return;
    if (s?.verdict?.over) return; // 终局后地图上的待决卡/国策/省政不该还能点 setBusy(true); setError('');
    try { setView(await api<View>(`runs/${view.id}/province-update`, { commandId: crypto.randomUUID(), expectedRevision: view.world.version, provinceId, reason: t(locale, 'play.provinceReason'), ...patch })); markOnboard('set-policy'); }
    catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function openExport() {
    if (!view) return;
    try { setRecord((await api<{ record: ChronicleRecord }>(`runs/${view.id}/chronicle`)).record); setExportOpen(true); markOnboard('export'); }
    catch (e) { setError((e as Error).message); }
  }
  async function loadSlots() { try { setSlots((await api<{ slots: SaveSlotView[] }>('saves')).slots); } catch { /* 存档列表失败只让面板空着 */ } }
  /** DELETE 单独一个助手：api() 只在有 body 时才选 POST，清空槽位必须显式 DELETE
      （曾用 api(path, undefined) 发成 GET，404 还被 catch 吞掉，槽位看着毫无变化）。 */
  async function del(path: string): Promise<void> {
    const res = await fetch('/api/agents/' + path, { method: 'DELETE', signal: AbortSignal.timeout(20000) });
    if (!res.ok) throw new Error((await res.json() as { error?: string }).error || t(locale, 'error.http', { status: res.status }));
  }
  async function refreshAchv() { try { const r = await api<AchievementsView & { newlyUnlocked: { name: string }[] }>(`runs/${runId.current}/achievements`); setAchv(r); showToast(r.newlyUnlocked.map(a => t(locale, 'save.unlocked', { name: a.name }))); } catch { /* 无成就可算时不打扰 */ } }
  async function saveToSlot(slot: number) { if (!view) return; setBusy(true); setSaveNote(''); try { const r = await api<{ slot: SaveSlotView }>('saves', { slot, runId: view.id, court: courtId.name }); setSlots(p => p.map(s => s.slot === slot ? r.slot : s)); setSaveNote(t(locale, 'save.saved', { slot, title: r.slot.title, day: Math.floor(r.slot.elapsedDays) + 1 })); } catch (e) { setSaveNote((e as Error).message); } finally { setBusy(false); } }
  async function loadFromSlot(slot: number) {
    if (!view) return; setBusy(true);
    try {
      const r = await api<{ entry: { gameId: string; title: string } }>('saves/load', { slot });
      if (r.entry.gameId === view.id) { const res = await api<{ run: View }>('saves/load', { slot, restore: true, runId: view.id }); setView(res.run); setNote(t(locale, 'save.loaded', { day: Math.floor(res.run.strategy?.worldTime.elapsedDays ?? 0) + 1 })); }
      else location.href = '/play?run=' + encodeURIComponent(r.entry.gameId);
    } catch (e) { setError((e as Error).message); } finally { setBusy(false); }
  }
  async function clearSlot(slot: number) {
    setBusy(true); setSaveNote('');
    try { await del(`saves/${slot}`); setSlots(p => p.map(s => s.slot === slot ? { ...s, gameId: '', title: '', savedAt: '', revision: 0, elapsedDays: 0, court: '', auto: false } : s)); setSaveNote(t(locale, 'save.cleared', { slot })); }
    catch (e) { setSaveNote((e as Error).message); } finally { setBusy(false); }
  }

  const s = view?.strategy;
  const day = s ? Math.floor(s.worldTime.elapsedDays) + 1 : 0;
  // 国力聚合复用 NationalPowerPanel 的纯函数（只数本方、把军队携粮与属城库存都算上），
  // 不在顶栏另写一份口径——两处对不上时玩家不知道该信哪个。
  const power = s ? nationalPower(s, locale) : null;
  const troops = power?.rows.find(r => r.key === 'troops')?.value.split(' ')[0] ?? '0';
  const food = power?.rows.find(r => r.key === 'foodKg')?.value.split(' ')[0] ?? '0';
  const ownCities = power?.cities.mine ?? 0;
  const cityTotal = power?.cities.total ?? 0;
  const goal = s?.goal;
  const alarms = s?.alarms ?? [];
  const canOrder = view?.mode === 'engine' || !!s?.localSimulation;
  const next = nextStep(onboardDone);

  const drawer = useCallback(() => {
    if (!view || !panel || !s) return null;
    switch (panel) {
      case 'power': return <NationalPowerPanel data={s} />;
      case 'politics': return s.politics ? <section className="play-pane"><h2>{t(locale, 'play.dock.politics')}</h2><p className="play-pane-line">{t(locale, 'play.prestige')} <b>{Math.round(s.politics.prestige)}</b> · {t(locale, 'play.absence')} {s.politics.absenceDays} {t(locale, 'play.days')}</p><ul className="play-factions">{s.politics.factions.map(f => <li key={f.key} className={f.angry ? 'angry' : ''}><b>{f.name}</b><span>{t(locale, 'play.clout')} {Math.round(f.clout)} · {t(locale, 'play.approval')} {Math.round(f.approval)} · {t(locale, 'play.loyalty')} {Math.round(f.loyalty)}</span><em>{translateEnum(locale, 'panel.diplomacy.stance', f.stance)}</em></li>)}</ul>{s.politics.summary.map((x, i) => <p key={i} className="play-pane-note">{x}</p>)}</section> : null;
      case 'fiscal': return s.fiscal ? <TreasuryPanel data={s} /> : null;
      case 'focus': return s.focuses ? <FocusPanel focuses={s.focuses} busy={busy} onAdopt={id => void adoptFocus(id)} /> : null;
      case 'tech': return s.techs ? <TechPanel techs={s.techs} busy={busy} onAdopt={id => void adoptTech(id)} /> : null;
      case 'province': return s.provinces ? <ProvincePanel provinces={s.provinces} onUpdate={(id, p) => void updateProvince(id, p)} busy={busy} /> : null;
      // 外交面板吃的是引擎的 DiplomaticState（不是投影视图），按需拉一次原始世界；
      // 不跟着 2.5s 轮询走——那是上百 KB 的原始快照，为一个面板每分钟拉 24 次不值得。
      case 'diplomacy': return rawWorld?.diplomacy && rawWorld.simulation?.playerFactionId ? <DiplomacyPanel state={rawWorld.diplomacy} playerFactionId={rawWorld.simulation.playerFactionId} /> : <p className="play-pane-note">{rawWorld ? t(locale, 'play.noDiplomacy') : t(locale, 'play.loading')}</p>;
      case 'fog': return <FogPanel data={s} />;
      // 计策面板的资格判定（eligibility）要读本方军队与城池，必须给真世界快照
      case 'stratagem': return <StratagemPanel world={rawWorld} />;
      case 'chronicle': return <ChroniclePanel changes={s.changes || []} onClose={() => setPanel(null)} onboarding={next} />;
      case 'court': return <section className="play-pane play-court" aria-label={t(locale, 'play.dock.court')}>
        <h2>{t(locale, 'play.dock.court')}</h2>
        <div className="play-court-log" ref={log} role="log" aria-live="polite">
          {view.messages.length ? view.messages.slice(-60).map(m => <article key={m.id} className={`play-msg ${m.kind === 'player' ? 'user' : ''}`}><b>{m.name || t(locale, 'discussion.historian')}</b><p>{m.text}</p></article>) : <p className="play-pane-note">{view.spec.scenario.background}</p>}
        </div>
        <p className="play-pane-note">{t(locale, 'play.courtHint')}</p>
        <a className="play-court-link" href={'/discussion?run=' + encodeURIComponent(view.id)}>{t(locale, 'play.courtOpen')}</a>
      </section>;
      case 'saves': return <SaveSlotsPanel tab={saveTab} onTab={setSaveTab} slots={slots} achv={achv} busy={busy} note={saveNote} onSaveSlot={x => void saveToSlot(x)} onLoadSlot={x => void loadFromSlot(x)} onClearSlot={x => void clearSlot(x)} onRefresh={() => void refreshAchv()} onClose={() => setPanel(null)} />;
      default: return null;
    }
  }, [view, panel, s, busy, locale, next, slots, achv, saveNote, saveTab, rawWorld]);

  // 外交/计策面板按需拉一次原始世界：DiplomacyPanel 吃引擎的 DiplomaticState + 玩家阵营 id，
  // StratagemPanel 的资格判定要吃本方军队与城池（eligibility 直接读 WorldSnapshot）——
  // 这两样都不是投影视图里的形状。拉过一次就缓存：一局之内结构不会因轮询而需要刷新，
  // 玩家重开会自动失效（组件重挂）。
  // 曾经在这里传 `{} as never` 给 eligibility，玩家一输「火攻」就 TypeError 白屏整页
  // （placeholder 里写的词必然命中关键词）——所以必须给真快照。
  useEffect(() => {
    if ((panel !== 'diplomacy' && panel !== 'stratagem') || rawWorld || !runId.current) return;
    let alive = true;
    void api<{ world: import('../../agents/src/world-contracts').WorldSnapshot | null }>(`runs/${runId.current}/world`)
      .then(r => { if (alive) setRawWorld(r.world ?? null); })
      .catch(() => { if (alive) setRawWorld(null); });
    return () => { alive = false; };
  }, [panel, rawWorld]);

  if (!view) return <main className="play-boot" aria-busy="true"><p>{status || t(locale, 'play.loading')}</p><a href="/">{t(locale, 'play.backLauncher')}</a></main>;

  return <main className="play" aria-label={t(locale, 'play.aria')}>
    {/* 顶栏：时间与国力常驻（P 社顶栏逻辑）——玩家任何时候都知道「今天几号、手里有什么」 */}
    <header className="play-top">
      <a className="play-back" href="/" aria-label={t(locale, 'play.backLauncher')}>← {t(locale, 'launcher.aria')}</a>
      <b className="play-title">{view.spec.title}</b>
      <span className="play-clock">{t(locale, 'play.day', { day })}</span>
      <span className="play-stat">{t(locale, 'play.troops')} <b>{troops}</b></span>
      <span className="play-stat">{t(locale, 'play.food')} <b>{food}</b></span>
      <span className="play-stat">{t(locale, 'play.citiesHeld')} <b>{ownCities}/{cityTotal}</b></span>
      {/* 胜利目标：赢要达成什么，常驻顶栏——P 社顶栏那条「战争目标」逻辑。
          want 是引擎拼好的中文短语（「占 6 城」），这里只报进度 held/need，别把短语和数字重复一遍。 */}
      {goal && <span className={`play-goal ${goal.met ? 'met' : ''}`} title={goal.summary}>{t(locale, 'play.goal', { held: goal.held, need: goal.need })}</span>}
      {s?.politics && <span className="play-stat">{t(locale, 'play.prestige')} <b>{Math.round(s.politics.prestige)}</b></span>}
      {s?.focuses && <span className="play-stat">{t(locale, 'play.focusPoints')} <b>{Math.floor(s.focuses.points)}</b></span>}
      {alarms.length > 0 && <button type="button" className="play-alarms" onClick={() => setPanel('power')}>{t(locale, 'play.alarms', { n: alarms.length })}</button>}
      <span className="play-top-right">
        <LocaleSwitch />
        <button type="button" onClick={() => setPanel('saves')}>{t(locale, 'save.open')}</button>
        <button type="button" onClick={() => void openExport()}>{t(locale, 'discussion.exportButton')}</button>
      </span>
    </header>

    {/* 警报条：哗变/断粮这类要命的事，横幅压在顶栏下 */}
    {alarms.length > 0 && <AlarmBanner alarms={alarms} />}

    <div className="play-body">
      {/* 地图：常满屏。对象详情、待决卡、国策/科技树都由图内联的面板负责 */}
      <div className="play-map">
        <StrategyScreen inline data={s ?? { armies: [], cities: [], actions: [], decisions: [], changes: [], worldTime: { elapsedDays: view.world.day }, ready: false }}
          onClose={() => { }} onDecide={c => void decide(c)} busy={busy}
          onAdoptFocus={id => void adoptFocus(id)} onAdoptTech={id => void adoptTech(id)}
          onDecideWhatIf={(id, c) => void decideWhatIf(id, c)} onProvinceUpdate={(id, p) => void updateProvince(id, p)} />
      </div>

      {/* 侧栏图标轨：点哪域开哪域（P 社 outliner 逻辑） */}
      <nav className="play-dock" aria-label={t(locale, 'play.dockAria')}>
        {PANELS.map(k => <button key={k} type="button" className={panel === k ? 'selected' : ''} aria-pressed={panel === k} onClick={() => openPanel(k)} title={t(locale, `play.dock.${k}`)}>
          <span aria-hidden="true">{t(locale, `play.dockIcon.${k}`)}</span>{t(locale, `play.dock.${k}`)}
          {k === 'power' && alarms.length > 0 && <i className="play-dock-badge">{alarms.length}</i>}
        </button>)}
      </nav>

      {/* 抽屉：域面板停在地图之上，不遮全屏；再点一次图标收起 */}
      {panel && drawer() && <aside className="play-drawer" aria-label={t(locale, `play.dock.${panel}`)}>
        <button type="button" className="play-drawer-close" onClick={() => setPanel(null)} aria-label={t(locale, 'common.close')}>×</button>
        {drawer()}
      </aside>}
    </div>

    {/* 底部指令栏：随时能说话；勾「下达行动」才是军令 */}
    <footer className="play-command">
      <form onSubmit={e => { e.preventDefault(); void submit(); }} className="play-cmd-form">
        <label className="sr-only" htmlFor="play-cmd">{t(locale, 'discussion.input')}</label>
        <input id="play-cmd" value={text} onChange={e => setText(e.target.value)} disabled={busy || !!s?.verdict?.over || !canOrder} placeholder={t(locale, 'play.cmdPlaceholder')} />
        {canOrder && <label className="play-act"><input type="checkbox" checked={act} onChange={e => setAct(e.target.checked)} disabled={busy} />{t(locale, 'discussion.actionHint')}</label>}
        <button type="submit" disabled={busy || !text.trim() || !!s?.verdict?.over}>{t(locale, 'common.send')}</button>
      </form>
      <div className="play-time" role="group" aria-label={t(locale, 'play.timeAria')}>
        <label className="sr-only" htmlFor="play-jump">{t(locale, 'discussion.jumpTo')}</label>
        <input id="play-jump" type="number" min={1} max={3650} value={jumpDay} onChange={e => setJumpDay(e.target.value)} disabled={busy || !!s?.verdict?.over || !canOrder} placeholder={String(day)} />
        <button type="button" disabled={busy || !!s?.verdict?.over || !canOrder} onClick={() => void jump()}>{t(locale, 'discussion.jumpSubmit')}</button>
        <button type="button" disabled={busy || !!s?.verdict?.over || !canOrder} onClick={() => void jump(day + 30)}>{t(locale, 'discussion.jump30')}</button>
        <button type="button" disabled={busy || !!s?.verdict?.over || !canOrder} onClick={() => void jump(day + 365)}>{t(locale, 'discussion.jumpYear')}</button>
        <button type="button" disabled={busy || !!s?.verdict?.over || !canOrder} onClick={() => void advance(24)}>{t(locale, 'play.advance1')}</button>
      </div>
      {note && <p className="play-note" role="status">{note}</p>}
      {error && <p className="play-error" role="alert">{error}</p>}
      {/* 无推演的独立局：把「这一局只能问对与阅览」说清楚，别让玩家对着一排灰按钮猜 */}
      {!canOrder && view?.mode === 'standalone' && !!s?.ready && <p className="play-note" role="note">{t(locale, 'discussion.readingRoomNote')}</p>}
    </footer>

    {/* onRetry 要的是 jobId 而不是 runId——sidecar 的路由是 jobs/:jobId/retry，
        传 runId 过去打中的不是这个任务。 */}
    {view && <MajorEventScreen runId={view.id} jobs={view.jobs ?? []} onRetry={(job: Job) => void api('jobs/' + job.id + '/retry', {})} open={eventsOpen} onClose={() => setEventsOpen(false)} />}
    {exportOpen && record && <ChronicleExport record={record} onClose={() => setExportOpen(false)} />}
    {s?.verdict?.over && <div className={`play-verdict verdict-${s.verdict.outcome}`} role="status">
      <b>{s.verdict.outcome === 'victory' ? t(locale, 'discussion.verdictVictory') : t(locale, 'discussion.verdictDefeat')}</b>
      <span>{t(locale, 'endgame.reason.' + s.verdict.reason)}</span>
      <p>{s.verdict.summary}</p>
      <div><button onClick={() => { location.href = '/'; }}>{t(locale, 'discussion.restart')}</button><button onClick={() => void openExport()}>{t(locale, 'endgame.export')}</button></div>
    </div>}
    {toast.length > 0 && <div className="play-toast" role="status">{toast.map((l, i) => <p key={i}>{l}</p>)}</div>}
    {next && <aside className="play-onboard" role="note"><b>{t(locale, `onboarding.${next.id}.title`)}</b><p>{t(locale, `onboarding.${next.id}.body`)}</p></aside>}
    {!onboardDone.length && <p className="play-court-hint">{t(locale, 'play.firstHint', { court: courtId.name })}</p>}
  </main>;
}
