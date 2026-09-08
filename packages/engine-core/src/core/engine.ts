// 主引擎：议题生成 → 多轮辩论（带数值反馈）→ 玩家裁决 → 数值结算（规则+大模型）→ 推进。

import type {
  ScenarioSpec, Scenario, Persona, TalkTask, RoundReport, SimulationResult,
  Decision, State, Delta, LLMProvider, PlayerDecide, MetricDef,
} from './types.ts';
import { initMemory, compressRound, type MemoryBank } from './memory.ts';
import { runDebateRound } from './debate.ts';
import { talkTaskFor } from './dialog.ts';
import { applyDrift } from './rules.ts';
import { computeSettlement } from './calc.ts';
import { createState, applyDeltas, formatState, formatDeltas } from './metrics.ts';

export interface EngineConfig {
  maxRoundsPerDebate?: number;
  onRound?: (report: RoundReport) => void;
  onState?: (round: number, state: State) => void;
}

function buildTranscript(
  spec: ScenarioSpec,
  rounds: RoundReport[],
  decision: Decision,
  settlement: SimulationResult['settlement'],
  finalMetrics: State,
  trajectory: { round: number; state: State }[],
): string {
  const L: string[] = [];
  L.push(`# ${spec.title}`);
  L.push(`\n【背景】${spec.scenario.background}`);
  L.push(`【核心矛盾】${spec.scenario.conflict}`);
  L.push(`\n--- 数值轨迹 ---`);
  for (const t of trajectory) {
    L.push(`回合${t.round === 0 ? '（初始）' : t.round}：${formatState(t.state, spec.metrics)}`);
  }
  L.push(`\n--- 辩论（${rounds.length} 轮）---`);
  for (const r of rounds) {
    L.push(`\n## 第 ${r.round} 轮 · ${r.task.topic}`);
    L.push(`（本回合前数值：${formatState(r.stateBefore, spec.metrics)}）`);
    for (const u of r.utterances) L.push(`[${u.speakerName}｜${u.stance ?? ''}] ${u.content}`);
    L.push(`（摘要）${r.summary}`);
    if (r.driftDeltas.length) L.push(`（本回合漂移）${formatDeltas(r.driftDeltas)}`);
  }
  L.push(`\n--- 裁决 ---`);
  L.push(`玩家决断：${decision.text}`);
  L.push(`意图：${decision.intent}`);
  L.push(`\n--- 执行衰减 ---`);
  L.push(settlement.narrative);
  if (settlement.factors.length) L.push(`偏差来源：${settlement.factors.map((f) => f.effect).join('；')}`);
  if (settlement.deltas.length) L.push(`数值变动：\n${formatDeltas(settlement.deltas)}`);
  if (settlement.thresholds.length) L.push(`阈值事件：${settlement.thresholds.map((t) => t.note).join('；')}`);
  L.push(`\n--- 终局指标 ---`);
  L.push(formatState(finalMetrics, spec.metrics));
  return L.join('\n');
}

// 主入口：接收一份完整 ScenarioSpec，跑完整个推演。
export async function runScenario(
  spec: ScenarioSpec,
  llm: LLMProvider,
  playerDecide: PlayerDecide,
  config: EngineConfig = {},
): Promise<SimulationResult> {
  const metrics: MetricDef[] = spec.metrics;
  let state: State = createState(metrics);
  const memory: MemoryBank = initMemory(spec.cast);
  const rounds: RoundReport[] = [];
  const trajectory: { round: number; state: State }[] = [{ round: 0, state: { ...state } }];

  let lastSummary: string | undefined;
  for (let round = 1; round <= spec.rounds; round++) {
    const stateBlock = formatState(state, metrics); // 反馈：当前数值注入角色 prompt
    // 议题带着上一轮辩论纪要进入下一轮，让讨论有真正的时间流动
    const task = talkTaskFor(spec, round, lastSummary);
    const utterances = await runDebateRound(spec.cast, task, llm, memory, {
      maxRounds: config.maxRoundsPerDebate,
      stateBlock,
    });
    const summary = await compressRound(utterances, llm, round);
    lastSummary = summary;
    for (const p of spec.cast) memory[p.id].history.push(summary);

    // 每回合被动漂移（规则驱动，确定性）
    const driftDeltas: Delta[] = applyDrift(state, spec.rules, metrics);
    const stateAfterDrift = applyDeltas(state, driftDeltas, metrics);

    const report: RoundReport = {
      round,
      task,
      utterances,
      summary,
      stateBefore: { ...state },
      stateAfter: { ...stateAfterDrift },
      driftDeltas,
    };
    rounds.push(report);
    state = stateAfterDrift;
    trajectory.push({ round, state: { ...state } });
    config.onRound?.(report);
    config.onState?.(round, state);
  }

  const decision = await playerDecide(spec.scenario.decisionPoint);
  const debateSummary = rounds.map((r) => r.summary).join('\n');
  const { settlement, stateAfter } = await computeSettlement(
    llm, metrics, spec.rules, state, spec.scenario, spec.cast, decision, debateSummary,
  );
  state = stateAfter;
  trajectory.push({ round: spec.rounds + 1, state: { ...state } });

  const finalMetrics = state;
  const transcript = buildTranscript(spec, rounds, decision, settlement, finalMetrics, trajectory);
  return {
    spec,
    scenario: spec.scenario,
    cast: spec.cast,
    rounds,
    decision,
    settlement,
    finalMetrics,
    stateTrajectory: trajectory,
    transcript,
  };
}
