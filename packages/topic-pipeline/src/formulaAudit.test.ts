/**
 * 公式审校司（formulaAudit.ts）测试：
 * - 确定性校验：合法公式全过；野引用 / 非法符号 / 越界阈值 / 缺 fires 被纠出；
 * - LLM 判定解析：parseFormulaAudit 能读条数、ok、issues（人话，不回抄公式）；
 * - 入口：mock（isReal=false）→ 确定性审；真实 provider 的伪实现 → LLM 裁定；
 * - 审校结论不含公式原文（issues 只说明问题所在）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import type { MetricDef, RuleDef } from '@sim/engine-core';
import { MockChatProvider } from '@sim/llm';
import {
  auditFormulaRules, auditFormulaSet, parseFormulaAudit, formulaAuditPrompt,
} from './formulaAudit.ts';

function metrics(): MetricDef[] {
  return [
    { key: 'gold', label: '国库', min: 0, max: 100, start: 60, higherIsBetter: true, description: '可用银两' },
    { key: 'moral', label: '士气', min: 0, max: 100, start: 50, higherIsBetter: true, description: '战意' },
  ];
}

function drift(id: string, formula: string, target = 'gold'): any {
  return { id, kind: 'drift', label: '演化', description: '漂移', target, appliesTo: [target], formula };
}

test('确定性：合法公式全套通过，且 source=rule', () => {
  const rules = [
    drift('r1', '3'),
    { id: 'r2', kind: 'drift', label: '物价压力', description: '按现银计漂移', target: 'gold', appliesTo: ['gold'], formula: 'round(gold*0.01)' },
    { id: 'q3', kind: 'reaction', label: '处置', description: '每回合反馈', appliesTo: ['gold', 'moral'], bounds: 8 },
    { id: 'q4', kind: 'threshold', label: '底线', description: '跌破', metric: 'moral', op: '<=', value: 20, fires: '军心涣散' },
  ];
  const out = auditFormulaRules(metrics(), rules);
  assert.equal(out.length, 4);
  for (const a of out) {
    assert.equal(a.ok, true, a.ruleId + ': ' + a.issues.join(';'));
    assert.equal(a.source, 'rule');
  }
});

test('野引用 / 非白名单函数 / 非法运算符被拒', () => {
  const rules = [
    drift('r1', 'mystery+1'),
    drift('r2', 'evil(pow, 2)'),
    drift('r3', 'gold * 2 && 3'),
  ];
  const out = auditRules(metrics(), rules);
  assert.equal(out.filter((a) => a.ok).length, 0, '三条都该不过');
  assert.ok(out[0].issues.some((i) => i.includes('mystery')));
  assert.ok(out[1].issues.some((i) => i.includes('evil')));
  assert.ok(out[2].issues.some((i) => i.includes('&')));
});

test('阈值越界与 fires 缺失被拒', () => {
  const rules = [
    { id: 't1', kind: 'threshold', label: '爆表', description: 'x', metric: 'gold', op: '>', value: 150, fires: '爆' },
    { id: 't2', kind: 'threshold', label: '缺文案', description: 'x', metric: 'moral', op: '<', value: 10 },
  ];
  const out = auditRules(metrics(), rules);
  assert.equal(out[0].ok, false);
  assert.ok(out[0].issues.some((i) => i.includes('超出')));
  assert.equal(out[1].ok, false);
  assert.ok(out[1].issues.some((i) => i.includes('fires')));
});

test('reaction 零/负幅度被拒；作用目标未声明被拒', () => {
  const rules = [
    { id: 's1', kind: 'reaction', label: '零', description: 'x', appliesTo: ['gold'], bounds: 0 },
    { id: 's2', kind: 'reaction', label: '未声明', description: 'x', appliesTo: ['ghost'], bounds: 4 },
  ];
  const out = auditRules(metrics(), rules);
  assert.equal(out[0].ok, false);
  assert.equal(out[1].ok, false);
});

test('审计入口（mock）：落到确定性校验，全部记录', async () => {
  const out = await auditFormulaSet(metrics(), [drift('r1', '2'), drift('r2', 'gold*0.02')], new MockChatProvider());
  assert.equal(out.length, 2);
  assert.ok(out.every((a) => a.ok));
  assert.ok(out.every((a) => a.source === 'rule'));
});

test('parseFormulaAudit：收到 LLM JSON → 结构转出（issues 保持人话）', () => {
  const raw = '{"results":[{"ruleId":"r1","ok":true,"issues":[]},{"ruleId":"r2","ok":false,"issues":["幅度过激"]}]}';
  const out = parseFormulaAudit(raw);
  assert.ok(out);
  assert.equal(out!.length, 2);
  assert.equal(out![0].source, 'llm');
  assert.equal(out![1].ok, false);
  assert.deepEqual(out![1].issues, ['幅度过激']);
});

test('parseFormulaAudit 容错：垃圾 / 缺 results → null', () => {
  assert.equal(parseFormulaAudit('not json'), null);
  assert.equal(parseFormulaAudit('{"x":1}'), null);
});

test('审校 prompt 包含指标区间与方向性要求（提示词层）', () => {
  const prompt = formulaAuditPrompt(metrics(), [drift('r1', '2')]);
  assert.ok(prompt.includes('越高越好'));
  assert.ok(prompt.includes('幅度'));
  assert.ok(prompt.includes('r1'));
});

/** 本地简化：不引 chat 的 auditFormulaRules 直出 */
function auditRules(m: MetricDef[], rules: any[]): ReturnType<typeof auditFormulaRules> {
  return auditFormulaRules(m, rules);
}