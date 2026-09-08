/**
 * 对外 spec 脱敏（publicSpec.ts）测试：
 * - rules[].formula 与 derivations[].formula 不出现在对外视图；
 * - 推导理由（why/ref）与复核结论（formulaAudit）保留；
 * - formulaAudit 不含公式原文。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { ScenarioSpec } from '@sim/engine-core';
import { toPublicSpec, leaksFormula } from './publicSpec.ts';

function fullSpec(): ScenarioSpec {
  return {
    domain: 'history',
    title: '推演',
    scenario: {
      title: '推演', background: '时局', conflict: '争议', participants: ['a'], rounds: 3,
      decisionPoint: '决断？', successCriteria: '平衡',
    },
    cast: [{ id: 'a', name: '甲', role: '推进', stance: '进', influence: 60, description: '', prompt: '', traits: { competence: 60, loyalty: 50, ambition: 40, power: 50 } }],
    metrics: [
      { key: 'gold', label: '国库', min: 0, max: 100, start: 60, higherIsBetter: true, description: '银两' },
    ],
    rules: [
      { id: 'r1', kind: 'drift', label: '演化', description: '漂移', target: 'gold', appliesTo: ['gold'], formula: 'round(gold*0.01)' },
      { id: 'r2', kind: 'threshold', label: '底线', description: '跌破', metric: 'gold', op: '<=', value: 20, fires: '告警' },
    ],
    rounds: 3,
    seedEvents: [],
    derivations: [
      { ruleId: 'r1', formula: 'round(gold*0.01)', why: '按区间 1% 脉动', ref: '惯例' },
      { ruleId: 'r2', formula: 'gold <= 20', why: '危险带', ref: '惯例' },
    ],
    formulaAudit: [
      { ruleId: 'r1', ok: true, issues: [], source: 'rule' },
      { ruleId: 'r2', ok: true, issues: [], source: 'rule' },
    ],
  };
}

test('脱敏后：无任何公式原文（rules.formula / derivations.formula），且无公式残迹', () => {
  const spec = fullSpec();
  const pub = toPublicSpec(spec);
  assert.equal(leaksFormula(pub), false, '对外视图不应包含公式');
  assert.equal(JSON.stringify(pub).includes('round(gold*0.01)'), false, '公式字符串不应出现');
  assert.equal(JSON.stringify(pub).includes('"formula"'), false, '不应有 formula 键');
  assert.ok(pub.rules && pub.rules.length === 2);
  assert.ok(pub.derivations && pub.derivations.length === 2);
});

test('脱敏保留：推导理由（why/ref）与复核结论（formulaAudit）', () => {
  const pub = toPublicSpec(fullSpec());
  assert.ok(pub.derivations![0].why.includes('1%'));
  assert.equal(pub.derivations![0].ref, '惯例');
  assert.ok(pub.formulaAudit && pub.formulaAudit.length === 2);
  const d = (JSON.stringify(pub.derivations));
  assert.ok(d.includes('why') && d.includes('ref'));
  // 对外视图不含公式原文：issues 里也必须有公式
  assert.equal(JSON.stringify(pub.formulaAudit).includes('round(gold*0.01)'), false);
});

test('原始 spec 仍含公式（内部使用不受影响）', () => {
  const spec = fullSpec();
  assert.equal(leaksFormula(spec), true, '内部 spec 必须保留公式（引擎执行用）');
  assert.ok(spec.rules?.[0]?.formula);
});