/**
 * 应用壳（docs/08 · 参考图 1672x941）：三阶段会话状态机。
 *   world  —— 话题输入 → 设定生成（WorldPanel）
 *   game   —— 廷议操作页：CastPanel / StoryPanel / MapPanel / InputBar 接真 API
 *   ending —— 终局判定页（verdict + 叙事 + 指标）
 * 数据一律走 @sim/serve 的 HTTP 契约；无路由依赖，刷新即回 world（状态在服务端可续）。
 */
import { useCallback, useEffect, useState } from 'react';
import type { EndingView, GameOption, TurnView } from '@sim/contracts';
import { createGame, decide, gameOptions, gameState, type SpecPayload } from './api.ts';
import { WorldPanel } from './components/World.tsx';
import { CastPanel, type CastMember } from './components/Cast.tsx';
import { StoryPanel, type StoryLine } from './components/Story.tsx';
import { MapPanel } from './components/Map.tsx';
import { InputBar } from './components/Input.tsx';

type Phase = 'world' | 'court' | 'ending';

export default function App() {
  const [phase, setPhase] = useState<Phase>('world');
  const [spec, setSpec] = useState<SpecPayload | null>(null);
  const [player, setPlayer] = useState('');
  const [gameId, setGameId] = useState<string | null>(null);
  const [view, setView] = useState<TurnView | null>(null);
  const [options, setOptions] = useState<GameOption[]>([]);
  const [entries, setEntries] = useState<StoryLine[]>([]);
  const [ending, setEnding] = useState<EndingView | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [bootKey, setBootKey] = useState(0);

  // ---------- 世界页回调：建局 → 首回合 ----------
  const startGame = useCallback(async (topicId: string, s: SpecPayload, name: string) => {
    setSpec(s);
    setPlayer(name || '陛下');
    setError(null);
    try {
      const g = await createGame(topicId, name || '陛下');
      setGameId(g.gameId);
      if (g.view) {
        setView(g.view);
        setEntries([...turnToLines(g.view, name)]);
      }
      setOptions(g.options ?? []);
      setPhase('court');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  // 进廷议后兜底装载（create 未带回 view 或 StrictMode 重挂时）
  useEffect(() => {
    if (phase !== 'court' || !gameId || view) return;
    let alive = true;
    void (async () => {
      try {
        const [st, op] = await Promise.all([gameState(gameId), gameOptions(gameId)]);
        if (!alive) return;
        if (st.latest) {
          setView(st.latest);
          setEntries([...turnToLines(st.latest, player)]);
        }
        setOptions(op.options);
      } catch (e) {
        if (alive) setError(e instanceof Error ? e.message : String(e));
      }
    })();
    return () => {
      alive = false;
    };
  }, [phase, gameId, view, player]);

  // ---------- 决策 → 推进 / 终局 ----------
  const onDecide = useCallback(
    async (option: string, text?: string) => {
      if (!gameId || busy) return;
      setBusy(true);
      setError(null);
      try {
        const res = await decide(gameId, { option, text });
        if (res.ending) {
          setEnding(res.ending);
          setPhase('ending');
          return;
        }
        if (res.next?.view) {
          const nv = res.next.view;
          const intent = res.settled.decided?.intent ?? text ?? option;
          setEntries((prev) => [
            ...prev,
            {
              speaker: player,
              name: player,
              side: 'player',
              text: `决断：${intent}`,
            },
            ...turnToLines(nv, player),
          ]);
          setView(nv);
          setOptions(res.next.options);
        } else {
          const st = await gameState(gameId);
          if (st.latest) {
            const last = st.latest;
            setEntries((prev) => [...prev, ...turnToLines(last, player)]);
            setView(last);
          }
          setOptions((await gameOptions(gameId)).options);
        }
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      } finally {
        setBusy(false);
      }
    },
    [busy, gameId, player],
  );

  // ---------- 再来一局 ----------
  const reset = useCallback(() => {
    setPhase('world');
    setSpec(null);
    setPlayer('');
    setGameId(null);
    setView(null);
    setOptions([]);
    setEntries([]);
    setEnding(null);
    setError(null);
    setBootKey((k) => k + 1);
  }, []);

  // ---------- 渲染 ----------
  if (phase === 'world') {
    return (
      <div className="root-center">
        <WorldPanel key={bootKey} onReady={startGame} />
        {error && <div className="error-toast">{error}</div>}
      </div>
    );
  }

  if (phase === 'ending' && ending) {
    return <EndingPage ending={ending} onRestart={reset} />;
  }

  const spoke = new Set(entries.filter((l) => l.side === 'npc').map((l) => l.speaker));
  const cast: CastMember[] =
    spec?.spec.cast.map((c) => ({
      id: c.id,
      name: c.name,
      role: c.role,
      stance: c.stance,
      influence: c.influence,
      active: spoke.has(c.id),
    })) ?? [];
  cast.push({ id: 'player', name: player || '陛下', role: '陛下（你）', active: true });

  const metrics = spec?.spec.metrics ?? [];
  const stateNow = view?.stateAfter ?? {};
  const round = view?.turn ?? 0;
  const totalRounds = spec?.spec.rounds ?? 3;

  return (
    <div className="court-layout">
      <CastPanel members={cast} />
      <StoryPanel
        title={view ? `${view.title} · 第 ${round}/${totalRounds} 回合` : '廷议 · 准备中…'}
        subtitle={view?.summary}
        lines={entries}
      />
      <MapPanel metrics={metrics} state={stateNow} />
      <InputBar
        options={options}
        onDecide={onDecide}
        disabled={busy}
        turn={round}
        totalRounds={totalRounds}
      />
      {error && <div className="error-toast">{error}</div>}
    </div>
  );
}

function turnToLines(v: TurnView, playerName: string): StoryLine[] {
  return (v.lines ?? []).map((l) => ({
    speaker: l.speaker,
    name: l.name,
    text: l.content,
    side: l.speaker === playerName ? 'player' : 'npc',
    stance: l.stance,
  }));
}

function EndingPage({ ending, onRestart }: { ending: EndingView; onRestart: () => void }) {
  const verdictText =
    ending.verdict === 'victory' ? '⚔ 大捷' : ending.verdict === 'defeat' ? '☠ 败局' : '终局未定';
  return (
    <div className="root-center">
      <section className="world-panel card ending-card">
        <h1 className="world-title">终 局</h1>
        <p className={`verdict ${ending.verdict}`}>{verdictText}</p>
        <h2>{ending.title}</h2>
        <p className="spec-bg">{ending.narrative}</p>
        <ul className="metric-list ending-metrics">
          {Object.entries(ending.metrics ?? {}).map(([k, v]) => (
            <li className="metric-bar" key={k}>
              <div className="metric-head">
                <span>{k}</span>
                <b>{v}</b>
              </div>
            </li>
          ))}
        </ul>
        <button className="action-btn ending-restart" onClick={onRestart}>
          再 来 一 局
        </button>
      </section>
    </div>
  );
}