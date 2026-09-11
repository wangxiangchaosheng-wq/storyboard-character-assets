// 数值状态：初始化、约束、应用变动、格式化。
// 这是「规则改变数值」的唯一落点 —— 所有规则产出的 Delta 最终都经这里落盘并夹紧到合法区间。

import type { MetricDef, State, Delta } from './types.ts';

// 校验指标定义，返回问题列表（空 = 通过）。用于「流程化约束」。
export function validateMetrics(metrics: MetricDef[]): string[] {
  const errs: string[] = [];
  const seen = new Set<string>();
  for (const m of metrics) {
    if (!m.key || !/^[\w一-龥]+$/.test(m.key)) errs.push(`指标 key 非法：${m.key}`);
    if (seen.has(m.key)) errs.push(`指标 key 重复：${m.key}`);
    seen.add(m.key);
    if (m.min >= m.max) errs.push(`${m.key} 的 min 必须小于 max`);
    if (m.start < m.min || m.start > m.max) errs.push(`${m.key} 的 start 超出 [min,max]`);
  }
  return errs;
}

// 把指标 clamp 到 [min,max]；非法输入兜底到 min。
export function clampMetric(m: MetricDef, v: number): number {
  if (!Number.isFinite(v)) return m.min;
  return Math.max(m.min, Math.min(m.max, v));
}

// 由定义初始化一份状态。未知 / 缺失的指标会被忽略。
export function createState(metrics: MetricDef[], overrides: State = {}): State {
  const s: State = {};
  for (const m of metrics) s[m.key] = clampMetric(m, overrides[m.key] ?? m.start);
  return s;
}

// 应用一组变动：按 key 累加，跳过未定义指标，最后统一 clamp。
export function applyDeltas(state: State, deltas: Delta[], metrics: MetricDef[]): State {
  const byKey = new Map<string, MetricDef>();
  for (const m of metrics) byKey.set(m.key, m);
  const next: State = { ...state };
  for (const d of deltas) {
    const m = byKey.get(d.key);
    if (!m) continue; // 忽略规则引用了不存在的指标
    next[d.key] = clampMetric(m, (next[d.key] ?? m.min) + d.amount);
  }
  return next;
}

// 给大模型 / 人类看的状态快照：「民心 58 · 财政 49 万」。
// 只展示数值本身；指标区间（min/max）是机制信息，不随快照外露。
export function formatState(state: State, metrics?: MetricDef[]): string {
  const keys = metrics?.map((m) => m.key) ?? Object.keys(state);
  return keys
    .map((k) => {
      const m = metrics?.find((x) => x.key === k);
      const v = state[k];
      const unit = m?.unit ? ` ${m.unit}` : '';
      // 截断浮点精度，避免暴露 JS 浮点误差（如 703.2018875000001）
      const display = Number.isFinite(v) ? Math.round(v * 100) / 100 : v;
      return `${m?.label ?? k} ${display}${unit}`;
    })
    .join('  ·  ');
}

// 把一组变动渲染成可读表（用于剧本 transcript）。
export function formatDeltas(deltas: Delta[]): string {
  if (!deltas.length) return '（无数值变动）';
  return deltas
    .map((d) => {
      const sign = d.amount >= 0 ? '+' : '';
      return `${d.key} ${sign}${d.amount}（${d.source}：${d.reason}）`;
    })
    .join('\n');
}
