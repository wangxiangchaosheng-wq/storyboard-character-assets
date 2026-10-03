'use client';
import { useCallback, useEffect, useState } from 'react';
import LocaleSwitch from './LocaleSwitch';
import ScenarioPicker from './ScenarioPicker';
import { useDialogFocus } from '../hooks/use-dialog-focus';
import { SCENARIOS, toRunSpec, type ScenarioPreset } from '../../agents/src/scenarios';
import { DIFFICULTIES } from '../../agents/src/onboarding';
import { useLocale, translate as t } from '../lib/i18n';

/**
 * 启动器 v1：史境的独立入口页面（根页面 /，Electron 壳加载的就是它）。
 *
 * 为什么要有它：游戏要先有一个「人样」的门面——标题、择局、续局、调试，而不是把玩家
 * 直接按进一张 iframe 地图里。Steam 客户端负责启动，这一页负责启动之后的事。
 *
 * 三条入口共用同一套底盘：
 * - 开始新局 → 选局面板（剧本 + 难度）→ 建 standalone 对局 → 进 /play?run=<id>（地图主页）；
 * - 继续对局 → GET /runs 列本机既有对局 → 点哪局进哪局；
 * - 调试模式 → /play/debug（AI 分析与运行控制台）。
 *
 * 离线纪律：建局走 spec 直建（AGENT_ALLOW_API_GENERATION=false 也能开本地十二城世界），
 * 不依赖任何付费生成；启动器本身只读 health/runs 两个只读端点。
 */

type View = { id: string; title?: string; spec?: { title: string }; mode?: string; createdAt?: string; strategy?: { ready?: boolean; worldTime?: { elapsedDays?: number; startYear?: number }; verdict?: { over?: boolean } } };
type Health = { configured?: boolean; engineConfigured?: boolean; generationEnabled?: boolean; libraryCount?: number };
type RunSummary = { id: string; title: string; mode: string; createdAt: string };

function detectLocale(): 'zh-CN' | 'en' {
  try { const v = localStorage.getItem('shijing-locale'); if (v === 'en' || v === 'zh-CN') return v; } catch { /* 隐私模式 */ }
  return navigator.language?.toLowerCase().startsWith('zh') ? 'zh-CN' : 'en';
}

async function api<T>(path: string, body?: unknown): Promise<T> {
  const res = await fetch('/api/agents/' + path, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
    signal: AbortSignal.timeout(body === undefined ? 20000 : 60000),
  });
  const data = await res.json() as T & { error?: string };
  if (!res.ok) throw new Error(data.error || t(detectLocale(), 'error.http', { status: res.status }));
  return data;
}

export default function LauncherScreen() {
  const [locale] = useLocale();
  const [health, setHealth] = useState<Health | null>(null);
  const [healthError, setHealthError] = useState('');
  const [runs, setRuns] = useState<RunSummary[]>([]);
  const [runsError, setRunsError] = useState('');
  const [panel, setPanel] = useState<'none' | 'new' | 'continue'>('none');
  const [starting, setStarting] = useState(false);
  const [startError, setStartError] = useState('');
  // 续局浮层（role=dialog）的焦点管理：打开移焦进浮层、Esc 关闭、Tab 圈闭、
  // 关闭后焦点还回「继续对局」按钮。清单 #B：此前四家 dialog 都只挂了 role 不管焦点。
  const runsDialog = useDialogFocus<HTMLElement>({ open: panel === 'continue', onClose: () => setPanel('none') });

  useEffect(() => {
    let alive = true;
    api<Health>('health').then(h => { if (alive) setHealth(h); }).catch(e => { if (alive) setHealthError(e instanceof Error ? e.message : String(e)); });
    api<{ runs: RunSummary[] }>('runs?limit=30').then(r => { if (alive) setRuns(r.runs || []); })
      .catch(e => { if (alive) setRunsError(e instanceof Error ? e.message : String(e)); });
    return () => { alive = false; };
  }, []);

  /** 建局并入场。spec 直建不接付费生成，离线可玩。 */
  const startScenario = useCallback(async (scenarioId: string, difficultyId: string) => {
    // 连点「开局」只能建一局：starting 是同步置的，第二次进来直接挡住，
    // 否则两次 POST /runs 会建出两个对局（第二个成孤儿）。
    if (starting) return;
    const scenario: ScenarioPreset | undefined = SCENARIOS.find(s => s.id === scenarioId);
    if (!scenario) { setStartError(t(locale, 'launcher.error.noScenario')); return; }
    setStarting(true); setStartError('');
    try {
      const view = await api<View>('runs', { spec: toRunSpec(scenario) });
      // 选局面板的本机契约（AgentDiscussion 与历史行为都读这两个键）：选过即不再挡在首页前
      try {
        localStorage.setItem('shijing-scenario-v1', scenarioId);
        localStorage.setItem('shijing-difficulty-v1', difficultyId);
      } catch { /* 隐私模式下存储不可用只影响下次默认值，不挡入场 */ }
      location.href = '/play?run=' + encodeURIComponent(view.id);
    } catch (e) {
      setStartError(e instanceof Error ? e.message : String(e));
      setStarting(false);
    }
  }, [locale]);

  const engineState = healthError
    ? t(locale, 'launcher.engine.offline')
    : health
      ? (health.engineConfigured ? t(locale, 'launcher.engine.engine') : t(locale, 'launcher.engine.local'))
      : t(locale, 'common.loading');

  return (
    <main className="launcher" aria-label={t(locale, 'launcher.aria')}>
      <div className="launcher-frame">
        <header className="launcher-head">
          <div className="launcher-titles">
            <h1 className="launcher-title">史境 · 三國</h1>
            <p className="launcher-subtitle">{t(locale, 'launcher.subtitle')}</p>
          </div>
          <div className="launcher-head-actions">
            <LocaleSwitch />
            <a className="launcher-map-link" href="/map/index.html">{t(locale, 'launcher.map')}</a>
          </div>
        </header>

        <p className="launcher-tagline">{t(locale, 'launcher.tagline')}</p>

        <nav className="launcher-entries" aria-label={t(locale, 'launcher.entries')}>
          <button type="button" className="launcher-entry launcher-entry-primary" onClick={() => { setPanel('new'); setStartError(''); }} disabled={starting}>
            <b>{t(locale, 'launcher.new')}</b>
            <small>{t(locale, 'launcher.newHint')}</small>
          </button>
          <button type="button" className="launcher-entry" onClick={() => setPanel('continue')} disabled={starting}>
            <b>{t(locale, 'launcher.continue')}</b>
            <small>{runs.length ? t(locale, 'launcher.continueHint', { n: runs.length }) : t(locale, 'launcher.continueEmpty')}</small>
          </button>
          <a className="launcher-entry" href="/play/debug">
            <b>{t(locale, 'launcher.debug')}</b>
            <small>{t(locale, 'launcher.debugHint')}</small>
          </a>
        </nav>

        <footer className="launcher-foot">
          <span className={`launcher-engine ${healthError ? 'is-offline' : ''}`} aria-live="polite">
            <i aria-hidden="true" />{engineState}
          </span>
          <span className="launcher-foot-note">{t(locale, 'launcher.offlineNote')}</span>
        </footer>
      </div>

      {panel === 'new' && <ScenarioPicker
        scenarios={SCENARIOS}
        difficulties={DIFFICULTIES}
        onStart={(scenarioId, difficultyId) => void startScenario(scenarioId, difficultyId)}
        onCancel={() => setPanel('none')}
      />}

      {panel === 'continue' && <section ref={runsDialog} className="launcher-runs" role="dialog" aria-modal="true" aria-label={t(locale, 'launcher.continue')}>
        <div className="launcher-runs-card">
          <header className="launcher-runs-head">
            <h2>{t(locale, 'launcher.continue')}</h2>
            <button type="button" onClick={() => setPanel('none')} aria-label={t(locale, 'common.close')}>×</button>
          </header>
          {runsError && <p className="launcher-runs-error" role="alert">{runsError}</p>}
          {!runsError && !runs.length && <p className="launcher-runs-empty">{t(locale, 'launcher.continueEmptyBody')}</p>}
          <ul className="launcher-runs-list">
            {runs.map(r => <li key={r.id}>
              <a href={'/play?run=' + encodeURIComponent(r.id)}>
                <b>{r.title || r.id}</b>
                <small>
                  {r.createdAt ? new Date(r.createdAt).toLocaleString(locale) : t(locale, 'common.unknown')}
                  {' · '}{r.mode === 'standalone' ? t(locale, 'launcher.mode.local') : t(locale, 'launcher.mode.engine')}
                </small>
              </a>
            </li>)}
          </ul>
        </div>
      </section>}

      {starting && <p className="launcher-starting" role="status">{t(locale, 'launcher.starting')}</p>}
      {startError && <p className="launcher-start-error" role="alert">{startError}</p>}
    </main>
  );
}
