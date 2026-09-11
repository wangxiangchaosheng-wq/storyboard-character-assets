/**
 * 右上 · 形势面板：底图（占位）+ 军国大略指标条（metrics/state 实时）。
 * 指标来自 spec.metrics，取值来自服务端 state；
 * 数值/区间均为契约 MetricRange 形状。
 */
import type { MetricRange } from '@sim/contracts';
import { useAsset } from '../assets/useAsset.ts';

function Bar({ key, label, min, max, value }: MetricRange & { value: number }) {
  const lo = Math.min(min, max);
  const hi = Math.max(min, max);
  const pct = hi === lo ? 100 : Math.max(0, Math.min(100, ((value - lo) / (hi - lo)) * 100));
  return (
    <li className="metric-bar">
      <div className="metric-head">
        <span>{label ?? key}</span>
        <b>{value}</b>
      </div>
      <div className="metric-track">
        <div className="metric-fill" style={{ width: `${pct}%` }} />
      </div>
      <small>
        {min} ~ {max}
      </small>
    </li>
  );
}

export function MapPanel({
  metrics,
  state,
}: {
  metrics: MetricRange[];
  state: Record<string, number>;
}) {
  const base = useAsset('map/base');
  return (
    <section className="map-panel">
      <h2 className="panel-title">形 势</h2>
      <img className="map-base" src={base.url} alt="沙盘底图" />
      {base.isPlaceholder && <span className="corner-tag">素材完善中</span>}
      <ul className="metric-list">
        {metrics.map((m) => (
          <Bar key={m.key} label={m.label} min={m.min} max={m.max} value={state[m.key] ?? m.min} />
        ))}
      </ul>
    </section>
  );
}