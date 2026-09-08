/**
 * 对外 spec 视图（公式保密化）：
 * 公式原文（rules[].formula、derivations[].formula、reaction effect）只活在引擎与
 * 审校司内部，任何下发到 API / UI 的 spec 都经 toPublicSpec 剥离公式原文，
 * 只保留「推导理由 + 复核结论（formulaAudit：ok/issues/source）」。
 * 这是硬性边界：新增对外 spec 端点时也必须走这里。
 */
import type { ScenarioSpec, DerivationNote } from '@sim/engine-core';

export function toPublicSpec(spec: ScenarioSpec): ScenarioSpec {
  const pub: ScenarioSpec = {
    ...spec,
    rules: (spec.rules ?? []).map((r) => {
      const { formula, effect, ...rest } = r as any;
      void formula;
      void effect;
      return rest;
    }),
    derivations: (spec.derivations ?? []).map((d: DerivationNote) => ({
      ruleId: d.ruleId,
      why: d.why,
      ref: d.ref,
    })),
  };
  return pub;
}

/** 判断一个已发布的 spec 中是否仍带公式原文（供测试与审计用） */
export function leaksFormula(spec: ScenarioSpec): boolean {
  return (spec.rules ?? []).some((r) => (r as any).formula !== undefined || (r as any).effect !== undefined) ||
    (spec.derivations ?? []).some((d) => (d as any).formula !== undefined);
}