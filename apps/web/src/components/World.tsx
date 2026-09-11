/**
 * 世界页（docs/08 首页）：输入话题 → ingest → build → 进度跟踪（轮询 1.5s 兜底 + SSE 实时文案）
 * → spec 就绪 → 交还 App 建局。玩家名可选手填，默认「陛下」。
 */
import { useCallback, useEffect, useRef, useState } from 'react';
import {
  buildTopic,
  fetchSpec,
  ingestTopic,
  subscribeSse,
  topicStatus,
  type SpecPayload,
} from '../api.ts';

interface WorldProps {
  onReady: (topicId: string, spec: SpecPayload, player: string) => void;
}

const PROGRESS_LABEL: Record<string, string> = {
  ingest: '读取素材…',
  search: '检索史料…',
  spec: '生成推演设定…',
  ready: '设定就绪',
  failed: '生成失败',
};

export function WorldPanel({ onReady }: WorldProps) {
  const [text, setText] = useState('');
  const [player, setPlayer] = useState('陛下');
  const [topicId, setTopicId] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [step, setStep] = useState<string | null>(null);
  const [progress, setProgress] = useState<string[]>([]);
  const [spec, setSpec] = useState<SpecPayload | null>(null);
  const [error, setError] = useState<string | null>(null);
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const push = useCallback((line: string) => {
    setProgress((p) => (p.length > 40 ? [...p.slice(-39), line] : [...p, line]));
  }, []);

  const formatState = useCallback((data: unknown): string => {
    if (!data) return '';
    const s = data as { state?: string; step?: string };
    const key = s.state ?? s.step ?? '';
    return PROGRESS_LABEL[key] ?? (typeof data === 'string' ? data : JSON.stringify(data));
  }, []);

  const start = async () => {
    const src = text.trim();
    if (!src || busy) return;
    setBusy(true);
    setError(null);
    setProgress([]);
    try {
      const input = /^https?:\/\//.test(src)
        ? ({ kind: 'url', url: src } as const)
        : ({ kind: 'text', text: src } as const);
      const { topicId: id } = await ingestTopic(input);
      setTopicId(id);
      setProgress(['话题已登记：' + id.slice(0, 48)]);
      await buildTopic(id);
      push('管线已启动…');
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };

  // topicId 固定后：轮询兜底 + SSE 实时文案
  useEffect(() => {
    if (!topicId) return;
    let stopped = false;
    let timer: ReturnType<typeof setInterval> | undefined;
    const tick = async () => {
      try {
        const st = await topicStatus(topicId);
        if (!alive.current || stopped) return;
        setStep(st.state);
        if (st.state === 'failed') {
          setError('设定生成失败，请重试或换一个话题');
          setBusy(false);
        } else if (st.state === 'ready') {
          const sp = await fetchSpec(topicId);
          if (alive.current && !stopped) setSpec(sp);
          setBusy(false);
        }
      } catch (e) {
        if (alive.current && !stopped) setError(e instanceof Error ? e.message : String(e));
      }
    };
    void tick();
    timer = setInterval(() => void tick(), 1500);
    const off = subscribeSse(`/api/topics/${encodeURIComponent(topicId)}/events`, (ev) => {
      if (!alive.current) return;
      if (ev.event === 'topics.build.progress') push(formatState(ev.data));
    });
    return () => {
      stopped = true;
      if (timer) clearInterval(timer);
      off();
    };
  }, [topicId, push, formatState]);

  return (
    <section className="world-panel card">
      <h1 className="world-title">帝国廷议 · 历史推演台</h1>
      {!spec && (
        <>
          <p className="world-hint">
            输入一个历史话题或史料链接（如「诸葛亮北伐」「官渡之战」），AI
            将检索史料并生成推演世界。
          </p>
          <div className="world-form">
            <input
              className="command-input world-input"
              value={text}
              onChange={(e) => setText(e.target.value)}
              onKeyDown={(e) => e.key === 'Enter' && void start()}
              placeholder="诸葛亮北伐 / 官渡之战 / https://…"
              disabled={busy}
            />
            <button className="action-btn" onClick={() => void start()} disabled={busy}>
              {busy ? '推演中…' : '创 建'}
            </button>
          </div>
          {busy && (
            <>
              <div className="progress">
                <div className="progress-fill" />
              </div>
              <p className="world-step">{formatState(step)}</p>
            </>
          )}
          {progress.length > 0 && (
            <ul className="progress-log">
              {progress.map((l, i) => (
                <li key={i}>{l}</li>
              ))}
            </ul>
          )}
          {error && <p className="world-error">{error}</p>}
        </>
      )}
      {spec && (
        <div className="spec-card">
          <h2>{spec.spec.title}</h2>
          <p className="spec-bg">{spec.spec.scenario?.background}</p>
          <p className="spec-bg">{spec.spec.scenario?.conflict}</p>
          <p className="spec-meta">
            {spec.spec.domain} · {spec.spec.rounds} 回合 ·{' '}
            {spec.spec.cast.map((c) => c.name).join('、')}
          </p>
          <div className="world-form">
            <span className="world-player-label">你的署名</span>
            <input
              className="world-input"
              value={player}
              onChange={(e) => setPlayer(e.target.value)}
              maxLength={12}
            />
            <button className="action-btn" onClick={() => onReady(topicId!, spec, player)}>
              进入廷议
            </button>
          </div>
        </div>
      )}
    </section>
  );
}