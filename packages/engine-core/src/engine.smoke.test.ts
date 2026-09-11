/**
 * 引擎 smoke：financing 全规格 + mock 提供器端到端跑通。
 * 断言不炸 + 数值恒在界内 + 两次运行结果一致（确定性护栏）。
 * 不联网、不入真实 provider。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { financingSpec } from './domains/examples.ts';
import { MockProvider } from './core/llm.ts';
import { formatState } from './core/metrics.ts';
import { runScenario } from './core/engine.ts';
import type { PlayerDecide } from './core/types.ts';

const decide: PlayerDecide = async () => ({
  text: '先稳住现金流，再谈扩张',
  intent: '测试用固定裁决：保守经营',
});

test('financing 规格 3 回合端到端可跑', async () => {
  const llm = new MockProvider();
  const res = await runScenario(financingSpec, llm, decide, {
    onState: (_r, state) => {
      for (const m of financingSpec.metrics) {
        const v = state[m.key];
        assert.ok(v !== undefined, `指标 ${m.key} 必须存在`);
        assert.ok(v >= m.min && v <= m.max, `${m.key}=${v} 越界 [${m.min},${m.max}]`);
      }
    },
  });

  assert.ok(res.rounds.length >= 3, '仿真数量未达规格回合数（spec.rounds）');
  assert.ok(res.transcript.length > 0);
  assert.deepEqual(res.finalMetrics, res.stateTrajectory.at(-1)?.state);
  const snap = formatState(res.finalMetrics, financingSpec.metrics);
  assert.ok(snap.includes('估值'));
  // 数值只展示「指标 + 值」：区间上限（/max）是机制信息，不随快照外露
  assert.ok(!/\d+\/\d+/.test(snap), `状态快照不得带 /max：${snap}`);
});

test('同输入同 provider ⇒ 逐字段一致（确定性护栏）', async () => {
  const run = () =>
    runScenario(financingSpec, new MockProvider(), decide, {
      maxRoundsPerDebate: 2,
    });
  const [a, b] = await Promise.all([run(), run()]);
  assert.deepEqual(a.finalMetrics, b.finalMetrics);
  assert.deepEqual(a.transcript, b.transcript);
});