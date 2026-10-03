'use client';
import { useCallback, useEffect, useRef, useState } from 'react';
import LocaleSwitch from '../../../app/components/LocaleSwitch';
import { useLocale, translate as t, type Locale } from '../../../app/lib/i18n';
// 事件流水的形状以引擎契约为准（agents/src/world-contracts.ts）：changes 是 FieldChange[]
// （entity/field/before/after/unit/reason），related 是 EntityRef[]。只引类型，运行时不打包。
import type { EntityRef, FieldChange } from '../../../agents/src/world-contracts';
import type { SimulationReport } from '../../../agents/src/simulation-types';

/**
 * 调试控制台 v1：/play/debug。
 *
 * 这一页服务两类使用者——开发者与「代管 AI」：
 * - **看**：世界原始快照（world）、事件流水（world-events）、派生分析（国策/史实锚点/脑洞/成就）；
 * - **跑**：指令台直发军令（act=true）、按小时推进（world-advance）、跳到指定推演日（world-jump）。
 *
 * 与游戏内界面共用同一套 sidecar 端点，没有任何私有通道——这里能做的，游戏里也都能做；
 * 区别只是这里把原始结构摊开给会看的人。所有写操作都带 commandId（幂等键）与
 * expectedRevision（乐观锁），与引擎纪律一致。
 */

type WorldSnapshot = {
  revision: number;
  clock: { elapsedDays: number };
  cities: Record<string, { id: string; name: string; ownerFactionId: string; foodKg: number; troops?: number }>;
  armies: Record<string, { id: string; name: string; troops: number; foodKg: number; morale: number; status: string; location: { kind: string } }>;
  simulation?: { playerFactionId: string; timeHours: number; activeArmyIds: string[]; armies: Record<string, { atCityId: string | null; order: unknown }> };
  politics?: { prestige: number; factions: Record<string, { approval: number }> };
  focuses?: { points: number; active: { focusId: string; endsDay: number }[]; available: { id: string; title: string }[] };
  techs?: { points: number; active: { techId: string; endsDay: number }[]; available: { id: string; title: string }[] };
  // HistoryAnchor 的字段是 title/day（anchors.ts），不是 label——按 label 读会恒 undefined。
  anchors?: { id: string; title: string; day: number }[];
  whatIfs?: { id: string; title: string }[];
  pendingDecision?: { eventId: string } | null;
  decisions: Record<string, { id: string; title: string; status: string }>;
};
type View = { id: string; title?: string; spec?: { title: string }; mode?: string; createdAt?: string };
/**
 * 对齐 agents/src/world-contracts.ts 的 WorldEvent：changes: FieldChange[]、related: EntityRef[]。
 * 引擎侧 worldId/settlementId/decisionId/source 恒有、simulationReport 可选，但旧事件可能
 * 没有这些键——判为可选：有值就摊开，没有不显示（渲染见 eventMeta / eventDetailLines）。
 */
type WorldEvent = {
  id: string;
  revision: number;
  fromDay: number;
  toDay: number;
  title: string;
  summary: string;
  changes: FieldChange[];
  related: EntityRef[];
  worldId?: string;
  settlementId?: string;
  decisionId?: string | null;
  source?: string;
  simulationReport?: SimulationReport;
};
type RunSummary = { id: string; title: string; mode: string; createdAt: string };
type AnalysisResult = { derived?: number; reason?: string };
type AchievementsView = { progress: { id: string; unlocked: boolean }[]; newlyUnlocked: { name: string }[]; summary: string[]; steamAvailable: boolean };

/**
 * 变化值格式化（调试台原值口径）：
 * - null/undefined 一律显示 'null'——引擎的不变量是 before: prev?.[field] ?? null
 *   （world-state.ts / world-agent.ts），「此前无此值」与「值就是空」在 JSON 里同为 null；
 *   显示 null 原文才能与同页「原始 JSON」逐字对上，也不会把 null 和真正的空字符串值混为一谈。
 * - 空字符串显示 ""（JSON 原文），同样为了可分辨；
 * - 数字/布尔/数组/对象走 JSON 原文，不做千分位、单位换算等「美化」——这一页要的是可核对。
 */
const fmtChangeValue = (locale: Locale, v: FieldChange['before'] | undefined): string => {
  if (v === null || v === undefined) return t(locale, 'debug.eventNullValue');
  if (typeof v === 'string') return v === '' ? '""' : v;
  return JSON.stringify(v);
};

/** 事件头部的流水号/来源/决策：有值才拼；全都没有返回空串，调用方不渲染这一行。 */
const eventMeta = (locale: Locale, e: WorldEvent): string => [
  e.settlementId ? t(locale, 'debug.eventSettlement', { id: e.settlementId }) : '',
  e.decisionId ? t(locale, 'debug.eventDecision', { id: e.decisionId }) : '',
  e.source ? t(locale, 'debug.eventSource', { source: e.source }) : '',
].filter(Boolean).join(' · ');

/**
 * 事件详情行（展开后显示）：每条 change 一行
 * 「{entity.type}/{entity.id} · {field}: 原值 X → 新值 Y {unit}」（unit 可空），
 * 下缩进一行挂 reason；末尾是相关对象（{type}:{id}）与推演报告（有才显示）。
 */
const eventDetailLines = (locale: Locale, e: WorldEvent): string[] => {
  const lines: string[] = [];
  for (const c of e.changes || []) {
    const unit = c.unit ? ` ${c.unit}` : '';
    lines.push(`${c.entity.type}/${c.entity.id} · ${c.field}: ${t(locale, 'debug.eventBefore', { value: fmtChangeValue(locale, c.before) })} → ${t(locale, 'debug.eventAfter', { value: fmtChangeValue(locale, c.after) })}${unit}`);
    if (c.reason) lines.push(`    ${t(locale, 'debug.eventReason', { reason: c.reason })}`);
  }
  if (!e.changes?.length) lines.push(t(locale, 'debug.eventNoChanges'));
  const related = (e.related || []).map(r => `${r.type}:${r.id}`);
  lines.push(t(locale, 'debug.eventRelated', { list: related.length ? related.join(t(locale, 'common.joiner')) : t(locale, 'common.none') }));
  const report = e.simulationReport;
  if (report) {
    let line = t(locale, 'debug.eventSimReport', { kind: report.kind, hours: report.advancedHours, rules: report.rulesVersion });
    if (report.pauseReason) line += ` · ${t(locale, 'debug.eventPause', { reason: report.pauseReason })}`;
    lines.push(line);
  }
  return lines;
};

function detectLocale(): 'zh-CN' | 'en' {
  try { const v = localStorage.getItem('shijing-locale'); if (v === 'en' || v === 'zh-CN') return v; } catch { /* 隐私模式 */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/agents/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 20000 : 120000),
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || t(detectLocale(), 'error.http', { status: res.status }));
  return data;
}

const TAB_KEYS = ['world', 'events', 'commands', 'analysis'] as const;
type Tab = typeof TAB_KEYS[number];

export default function DebugConsolePage() {
  const [locale] = useLocale();
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runId, setRunId] = useState('');
  const [tab, setTab] = useState<Tab>('world');
  const [world, setWorld] = useState<WorldSnapshot | null>(null);
  const [events, setEvents] = useState<WorldEvent[]>([]);
  const [view, setView] = useState<View | null>(null);
  const [busy, setBusy] = useState('');
  const [log, setLog] = useState<string[]>([]);
  const [text, setText] = useState('推进 1 天');
  const [act, setAct] = useState(true);
  const [analysis, setAnalysis] = useState<Record<string, string>>({});
  const logBox = useRef<HTMLPreElement>(null);

  const note = useCallback((line: string) => setLog(l => [...l.slice(-200), `[${new Date().toLocaleTimeString(locale)}] ${line}`]), [locale]);

  useEffect(() => {
    api<{ runs: RunSummary[] }>('runs?limit=50').then(r => setRuns(r.runs || [])).catch(e => note(e instanceof Error ? e.message : String(e)));
  }, [note]);

  /** 拉全量：view（投影）+ world（原始）+ events（尾部流水）。 */
  const refresh = useCallback(async (id: string) => {
    if (!id) return;
    try {
      const [v, w, e] = await Promise.all([
        api<View & { world?: { version: number }; strategy?: { revision?: number } }>('runs/' + id),
        api<{ world: WorldSnapshot | null }>('runs/' + id + '/world'),
        api<{ events: WorldEvent[] }>('runs/' + id + '/world-events?limit=40&latest=1'),
      ]);
      setView(v); setWorld(w.world); setEvents(e.events || []);
    } catch (e) { note((e instanceof Error ? e.message : String(e))); }
  }, [note]);

  useEffect(() => { if (runId) void refresh(runId); }, [runId, refresh]);

  /** 写操作统一走这里：都带 commandId 幂等键；报错只进日志，不打断面板。 */
  const act_ = useCallback(async (label: string, path: string, body: unknown, after?: () => void) => {
    setBusy(label);
    try {
      await api(path, body);
      note(`${label}：完成`);
      after ? after() : (runId && void refresh(runId));
    } catch (e) {
      note(`${label}：${e instanceof Error ? e.message : String(e)}`);
    } finally { setBusy(''); }
  }, [note, refresh, runId]);

  const sendCommand = useCallback(() => {
    if (!runId || !text.trim()) return;
    void act_(t(locale, 'debug.send'), `runs/${runId}/messages`, { commandId: crypto.randomUUID(), text: text.trim(), act });
  }, [act_, act, locale, runId, text]);

  const advance = useCallback((hours: number) => {
    if (!runId || !world) return;
    void act_(t(locale, 'debug.advance', { h: hours }), `runs/${runId}/world-advance`, { commandId: crypto.randomUUID(), expectedRevision: world.revision, hours });
  }, [act_, locale, runId, world]);

  const jump = useCallback(() => {
    if (!runId || !world) return;
    void act_(t(locale, 'debug.jump'), `runs/${runId}/world-jump`, { commandId: crypto.randomUUID(), expectedRevision: world.revision, targetDay: world.clock.elapsedDays + 365, courtState: 'delegated' });
  }, [act_, locale, runId, world]);

  const derive = useCallback((kind: 'focus' | 'anchor' | 'whatif', label: string) => {
    if (!runId) return;
    void (async () => {
      setBusy(label);
      try {
        const r = await api<AnalysisResult>(`runs/${runId}/${kind}-refresh`, {});
        const line = r.reason || `${t(locale, 'debug.derived')} ${r.derived ?? 0}`;
        setAnalysis(a => ({ ...a, [kind]: line }));
        note(`${label}：${line}`);
      } catch (e) {
        note(`${label}：${e instanceof Error ? e.message : String(e)}`);
      } finally { setBusy(''); }
    })();
  }, [locale, note, runId]);

  const loadAchievements = useCallback(() => {
    if (!runId) return;
    void (async () => {
      setBusy(t(locale, 'debug.achievements'));
      try {
        const r = await api<AchievementsView>(`runs/${runId}/achievements`);
        // #8：真实响应是 {progress,newlyUnlocked,summary,steamAvailable}——曾经按 {unlocked,locked}
        // 读，两个字段都不存在，调试台永远显示「已解锁 0 / 0」（假数据）。
        const unlocked = r.progress.filter(p => p.unlocked).length;
        const line = `${t(locale, 'debug.unlocked')} ${unlocked} / ${r.progress.length}` + (r.steamAvailable ? '' : '（本机记录）');
        setAnalysis(a => ({ ...a, achievements: line }));
        note(line);
      } catch (e) { note(`${t(locale, 'debug.achievements')}：${e instanceof Error ? e.message : String(e)}`); }
      finally { setBusy(''); }
    })();
  }, [locale, note, runId]);

  useEffect(() => { logBox.current?.scrollTo({ top: logBox.current.scrollHeight }); }, [log]);

  const day = world ? Math.floor(world.clock.elapsedDays) + 1 : 0;
  const cityCount = world ? Object.keys(world.cities).length : 0;
  const ownCities = world ? Object.values(world.cities).filter(c => c.ownerFactionId === world.simulation?.playerFactionId).length : 0;

  return (
    <main className="debug" aria-label={t(locale, 'debug.aria')}>
      <header className="debug-head">
        <a className="debug-back" href="/">← {t(locale, 'launcher.aria')}</a>
        <h1>{t(locale, 'debug.title')}</h1>
        <div className="debug-head-actions">
          <LocaleSwitch />
          <button type="button" onClick={() => runId && void refresh(runId)} disabled={!runId || !!busy}>{t(locale, 'common.retry')}</button>
        </div>
      </header>

      <section className="debug-picker" aria-label={t(locale, 'debug.run')}>
        <label htmlFor="debug-run">{t(locale, 'debug.run')}</label>
        <select id="debug-run" value={runId} onChange={e => setRunId(e.target.value)}>
          <option value="">{t(locale, 'debug.runPick')}</option>
          {runs.map(r => <option key={r.id} value={r.id}>{r.title || r.id} · {r.mode === 'standalone' ? t(locale, 'launcher.mode.local') : t(locale, 'launcher.mode.engine')}</option>)}
        </select>
        {view && <span className="debug-run-meta">{view.spec?.title || view.id}</span>}
        {world && <span className="debug-run-meta">
          {t(locale, 'debug.day', { day })} · {t(locale, 'debug.rev', { rev: world.revision })} · {t(locale, 'debug.citiesValue', { own: ownCities, total: cityCount })}
        </span>}
        {world?.pendingDecision && <span className="debug-run-pending">{t(locale, 'debug.pending')} {world.pendingDecision.eventId}</span>}
      </section>

      <nav className="debug-tabs" aria-label={t(locale, 'debug.tabs')}>
        {TAB_KEYS.map(k => <button key={k} type="button" className={tab === k ? 'selected' : ''} aria-pressed={tab === k} onClick={() => setTab(k)}>{t(locale, `debug.tab.${k}`)}</button>)}
      </nav>

      {!runId && <p className="debug-empty">{t(locale, 'debug.empty')}</p>}

      {runId && tab === 'world' && <section className="debug-world" aria-label={t(locale, 'debug.tab.world')}>
        <h2>{t(locale, 'debug.snapshot')}</h2>
        {!world && <p className="debug-empty">{t(locale, 'debug.noWorld')}</p>}
        {world && <div className="debug-world-summary">
          <dl>
            <div><dt>{t(locale, 'debug.player')}</dt><dd>{world.simulation?.playerFactionId || '—'}</dd></div>
            <div><dt>{t(locale, 'debug.prestige')}</dt><dd>{world.politics ? Math.round(world.politics.prestige) : '—'}</dd></div>
            <div><dt>{t(locale, 'debug.armies')}</dt><dd>{Object.keys(world.armies).length}</dd></div>
            <div><dt>{t(locale, 'debug.activeArmies')}</dt><dd>{world.simulation?.activeArmyIds.length ?? 0}</dd></div>
            <div><dt>{t(locale, 'debug.focusPoints')}</dt><dd>{world.focuses ? Math.floor(world.focuses.points) : '—'}</dd></div>
            <div><dt>{t(locale, 'debug.techPoints')}</dt><dd>{world.techs ? Math.floor(world.techs.points) : '—'}</dd></div>
            <div><dt>{t(locale, 'debug.decisions')}</dt><dd>{Object.keys(world.decisions).length}</dd></div>
          </dl>
        </div>}
        {world && <details className="debug-raw"><summary>{t(locale, 'debug.raw')}</summary><pre>{JSON.stringify(world, null, 2)}</pre></details>}
      </section>}

      {runId && tab === 'events' && <section className="debug-events" aria-label={t(locale, 'debug.tab.events')}>
        <h2>{t(locale, 'debug.eventTitle')}</h2>
        {!events.length && <p className="debug-empty">{t(locale, 'debug.noEvents')}</p>}
        <ol className="debug-event-list">
          {events.map(e => {
            const meta = eventMeta(locale, e);
            return <li key={e.id}>
              <header><b>r{e.revision}</b><span>{t(locale, 'debug.eventDay', { day: Math.floor(e.toDay) + 1 })}</span><span className="debug-event-title">{e.title}</span><span className="debug-event-changes">{t(locale, 'debug.eventChanges', { n: e.changes.length })}</span></header>
              <p>{e.summary}</p>
              {!!meta && <p>{meta}</p>}
              <details className="debug-raw">
                <summary>{t(locale, 'debug.eventChangesDetail')}</summary>
                <pre>{eventDetailLines(locale, e).join('\n')}</pre>
              </details>
            </li>;
          })}
        </ol>
      </section>}

      {runId && tab === 'commands' && <section className="debug-commands" aria-label={t(locale, 'debug.tab.commands')}>
        <h2>{t(locale, 'debug.console')}</h2>
        <form className="debug-cmd-form" onSubmit={e => { e.preventDefault(); sendCommand(); }}>
          <input value={text} onChange={e => setText(e.target.value)} aria-label={t(locale, 'debug.cmdLabel')} placeholder={t(locale, 'debug.cmdPlaceholder')} disabled={!!busy} />
          <label className="debug-act"><input type="checkbox" checked={act} onChange={e => setAct(e.target.checked)} disabled={!!busy} />act</label>
          <button type="submit" disabled={!!busy || !text.trim()}>{t(locale, 'debug.send')}</button>
        </form>
        <div className="debug-quick" aria-label={t(locale, 'debug.quick')}>
          {['魏延 行军 长安', '魏延 补给 汉中 10000', '探查长安虚实', '推进 1 天', '粜粮 5万'].map(c => <button key={c} type="button" onClick={() => setText(c)} disabled={!!busy}>{c}</button>)}
        </div>
        <div className="debug-run-controls" aria-label={t(locale, 'debug.controls')}>
          <b>{t(locale, 'debug.controls')}</b>
          <button type="button" onClick={() => advance(24)} disabled={!!busy || !world}>+1 {t(locale, 'debug.days')}</button>
          <button type="button" onClick={() => advance(24 * 7)} disabled={!!busy || !world}>+7 {t(locale, 'debug.days')}</button>
          <button type="button" onClick={() => advance(24 * 30)} disabled={!!busy || !world}>+30 {t(locale, 'debug.days')}</button>
          <button type="button" onClick={() => advance(24 * 90)} disabled={!!busy || !world}>+90 {t(locale, 'debug.days')}</button>
          <button type="button" onClick={jump} disabled={!!busy || !world}>{t(locale, 'debug.jump')}</button>
        </div>
        <pre className="debug-log" ref={logBox} aria-live="polite" aria-label={t(locale, 'debug.log')}>{log.join('\n')}</pre>
      </section>}

      {runId && tab === 'analysis' && <section className="debug-analysis" aria-label={t(locale, 'debug.tab.analysis')}>
        <h2>{t(locale, 'debug.analysis')}</h2>
        <div className="debug-analysis-actions">
          <button type="button" onClick={() => derive('focus', t(locale, 'debug.deriveFocus'))} disabled={!!busy}>{t(locale, 'debug.deriveFocus')}</button>
          <button type="button" onClick={() => derive('anchor', t(locale, 'debug.deriveAnchors'))} disabled={!!busy}>{t(locale, 'debug.deriveAnchors')}</button>
          <button type="button" onClick={() => derive('whatif', t(locale, 'debug.deriveWhatIf'))} disabled={!!busy}>{t(locale, 'debug.deriveWhatIf')}</button>
          <button type="button" onClick={loadAchievements} disabled={!!busy}>{t(locale, 'debug.achievements')}</button>
          <a href={'/discussion?run=' + encodeURIComponent(runId)}>{t(locale, 'debug.enterGame')}</a>
        </div>
        {!!Object.keys(analysis).length && <dl className="debug-analysis-results">
          {Object.entries(analysis).map(([k, v]) => <div key={k}><dt>{t(locale, `debug.analysis.${k}`)}</dt><dd>{v}</dd></div>)}
        </dl>}
        {world?.focuses && <div className="debug-analysis-block">
          <h3>{t(locale, 'debug.focusList')}（{world.focuses.available.length}）</h3>
          <ul>{world.focuses.available.map(f => <li key={f.id}>{f.title}{world.focuses!.active.some(a => a.focusId === f.id) ? ' · ' + t(locale, 'debug.active') : ''}</li>)}</ul>
        </div>}
        {world?.techs && <div className="debug-analysis-block">
          <h3>{t(locale, 'debug.techList')}（{world.techs.available.length}）</h3>
          <ul>{world.techs.available.map(x => <li key={x.id}>{x.title}{world.techs!.active.some(a => a.techId === x.id) ? ' · ' + t(locale, 'debug.active') : ''}</li>)}</ul>
        </div>}
        {!!world?.anchors?.length && <div className="debug-analysis-block">
          <h3>{t(locale, 'debug.anchorList')}（{world.anchors.length}）</h3>
          <ul>{world.anchors.map(a => <li key={a.id}>{t(locale, 'debug.eventDay', { day: a.day })} · {a.title}</li>)}</ul>
        </div>}
        {!!world?.whatIfs?.length && <div className="debug-analysis-block">
          <h3>{t(locale, 'debug.whatIfList')}（{world.whatIfs.length}）</h3>
          <ul>{world.whatIfs.map(w => <li key={w.id}>{w.title}</li>)}</ul>
        </div>}
      </section>}
    </main>
  );
}
