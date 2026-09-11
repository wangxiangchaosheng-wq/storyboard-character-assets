/**
 * 估算器（docs/07 §6）：缺口 → LLM 数值估价（value/min/max/unit/basis/confidence）。
 * 铁律：估算必须带推理链（basis）；LLM 不可用、JSON 非法、区间错乱 → 返回 undefined，
 * 缺口留给下游兜底，绝不假装是史实。
 */
import type { Fact } from '@sim/contracts';
import type { ChatProvider } from '@sim/llm';

export interface EstimateGap {
  topic: string;
  whyMissing: string;
}

export interface EstimateDraft {
  value: number;
  min: number;
  max: number;
  unit?: string;
  basis: string;
  confidence?: number;
}

export function estimatePrompt(gap: EstimateGap): string {
  return (
    '你是历史推演引擎的数值估算器。下面的「缺口」是剧本需要但史料没有的数值。\n' +
    '请给出：value（你判断的适中值）、min、max（合理区间，min≤value≤max）、unit（单位）、\n' +
    'basis（一两句推理链：用了哪些公开史实/通说推出来）、confidence（0-1）。\n' +
    '不知道就如实把 confidence 给低（≤0.4），不要硬造高置信。\n' +
    '只输出 JSON（不要代码块）：\n' +
    '{"value":..,"min":..,"max":..,"unit":"..","basis":"..","confidence":..}\n\n' +
    `缺口：${gap.topic}\n为什么影响推演：${gap.whyMissing}`
  );
}

/** 解析 + 校验：JSON 合法、min ≤ value ≤ max、confidence 在 0..1、basis 非空，否则 undefined。 */
export function parseEstimate(raw: string): EstimateDraft | undefined {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch {
    return undefined;
  }
  const o = j as Record<string, unknown>;
  const value = Number(o.value);
  const min = Number(o.min);
  const max = Number(o.max);
  if (!Number.isFinite(value) || !Number.isFinite(min) || !Number.isFinite(max)) {
    return undefined;
  }
  if (!(min <= value && value <= max)) return undefined;
  const confidence = o.confidence === undefined ? 0.5 : Number(o.confidence);
  if (!Number.isFinite(confidence) || confidence < 0 || confidence > 1) return undefined;
  const basis = typeof o.basis === 'string' && o.basis.trim().length > 0 ? o.basis.trim() : '';
  if (!basis) return undefined;
  return {
    value,
    min,
    max,
    unit: typeof o.unit === 'string' ? o.unit : undefined,
    basis,
    confidence,
  };
}

/** 对缺口做一次估算，返回可入库 Fact；任何不合格路径都返回 undefined。 */
export async function estimateGap(
  llm: ChatProvider,
  gap: EstimateGap,
  seq: string,
): Promise<Fact | undefined> {
  let raw: string;
  try {
    raw = await llm.generate([{ role: 'user', content: estimatePrompt(gap) }], {
      jsonMode: true,
    });
  } catch {
    return undefined;
  }
  const draft = parseEstimate(raw);
  if (!draft) return undefined;

  const { value, min, max } = draft;
  const claim =
    gap.topic +
    `约为 ${value}${draft.unit ? draft.unit : ''}` +
    (min !== value || max !== value ? `（区间 ${min}–${max}${draft.unit ?? ''}）` : '');
  return {
    id: `est-${seq}`,
    claim,
    entity: gap.topic,
    source: 'ai_estimate',
    estimated: true,
    confidence: draft.confidence ?? 0.5,
    basis: draft.basis,
  };
}