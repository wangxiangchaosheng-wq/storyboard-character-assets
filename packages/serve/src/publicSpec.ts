/**
 * 对外 spec 视图（公式保密化）：
 * 公式原文（rules[].formula、derivations[].formula、reaction effect）只活在引擎与
 * 审校司内部，任何下发到 API / UI 的 spec 都经 toPublicSpec 剥离公式原文，
 * 只保留「推导理由 + 复核结论（formulaAudit：ok/issues/source）」。
 * 这是硬性边界：新增对外 spec 端点时也必须走这里。
 */
import type { ScenarioSpec, RuleDef, DerivationNote } from '@sim/engine-core';

/** 对外发布的 RuleDef：不含公式原文，供 API / UI 消费 */
type PublicRule = Omit<RuleDef, 'formula' | 'effect'>;

export function toPublicSpec(spec: ScenarioSpec): ScenarioSpec {
  const pub: ScenarioSpec = {
    ...spec,
    rules: (spec.rules ?? []).map((r) => {
      // 剥离公式字段：RuleDef 含 formula/effect 可选字段，对外版本不含
      const { formula: _f, effect: _e, ...rest } = r;
      void _f;
      void _e;
      return rest as PublicRule;
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
  const hasSecret = (r: RuleDef) => r.formula !== undefined || r.effect !== undefined;
  const hasDerivationFormula = (d: DerivationNote) => d.formula !== undefined;
  return (spec.rules ?? []).some(hasSecret) ||
    (spec.derivations ?? []).some(hasDerivationFormula);
}