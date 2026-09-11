/**
 * 架空推演演示 —— 集成搜索 + 可行性引擎。
 *   node --experimental-strip-types scripts/air-history-demo.ts --mock "话题"
 *   node --experimental-strip-types scripts/air-history-demo.ts "话题"  (需真实 LLM key)
 */
import { MockChatProvider, MockSearchProvider } from '@sim/llm';
import { createFactStore } from '@sim/facts';
import { runPipeline } from '../src/index.ts';
import { runScenario, type LLMProvider, type FeasibilityResult } from '../../engine-core/src/index.ts';
import type { Decision } from '../../engine-core/src/core/types.ts';

async function main() {
  const args = process.argv.slice(2);
  const isMock = args.includes('--mock');
  const raw = args.filter((a) => a !== '--mock' && a !== '--real').join(' ').trim();
  if (!raw) {
    console.log('用法：node --experimental-strip-types scripts/air-history-demo.ts [--mock] "话题"');
    process.exit(2);
  }

  console.log(`\n${'═'.repeat(60)}`);
  console.log(`  架空推演引擎 · ${isMock ? '全离线 Mock（含搜索+可行性）' : '真实 LLM'}`);
  console.log(`${'═'.repeat(60)}\n`);
  console.log(`📝 话题：${raw}\n`);

  // ① 生成 Spec（含搜索）
  const chat = new MockChatProvider();
  const search = new MockSearchProvider();
  const factsService = await createFactStore();
  const res = await runPipeline(
    { kind: 'text', text: raw },
    {
      chat,
      facts: {
        search: { find: (q: string) => factsService.search(q, { limit: 3 }) },
        estimate: async () => undefined,
      },
    },
  );
  const { spec, status } = res;
  if (!spec) {
    console.error('✘ 管线未生成 Spec，状态：', status);
    process.exit(1);
  }
  console.log(`✅ 管线完成：状态=${status.state}\n`);
  console.log(`📋 剧本：${spec.title}`);
  console.log(`   人物：${spec.cast.map((c) => `${c.name}（${c.stance}·${c.role}）`).join('、')}`);
  console.log(`   指标：${spec.metrics.map((m) => `${m.label}(${m.key})`).join('、')}\n`);

  // ② AI 玩家决策（集成可行性推理，把话题背景传入让决策有依据）
  const aiDecide = async (decisionPoint: string): Promise<Decision> => {
    const topPersona = [...spec.cast].sort((a, b) => b.influence - a.influence)[0];
    const stance = topPersona?.stance ?? '协商';
    const stances: Record<string, string> = {
      进取: '当机立断，全力推进。',
      稳守: '稳扎稳打，先固根本，再图进取。',
      协商: '兼听则明，取中间路线，平衡各方利益。',
    };
    return {
      text: `[${topPersona?.name ?? '统筹者'}] ${stances[stance]}`,
      intent: stances[stance],
    };
  };

  // ③ 跑引擎推演（带可行性引擎）
  console.log(`\n${'─'.repeat(60)}`);
  console.log('开始推演…\n');

  const result = await runScenario(spec, chat as unknown as LLMProvider, aiDecide, {
    search,
    enableFeasibility: true,
    onRound: (r) => {
      console.log(`\n${'─'.repeat(50)}`);
      console.log(`📜 第 ${r.round} 轮 · 「${r.task.topic}」`);
      console.log(`[局势] ${Object.entries(r.stateBefore).map(([k,v]) => `${k}=${Number(v).toFixed?.(1) ?? v}`).join(' | ')}`);
      for (const u of r.utterances) {
        console.log(`\n🎭 ${u.speakerName}（${u.stance ?? '无立场'}）：`);
        u.content.split('\n').forEach((line) => console.log(`   ${line}`));
      }
      if (r.driftDeltas.length) {
        console.log(`\n[漂移] ${r.driftDeltas.map((d) => `${d.key}${d.amount > 0 ? '+' : ''}${Number(d.amount).toFixed?.(2) ?? d.amount}`).join(' | ')}`);
      }
    },
  });

  // ④ 输出完整剧本
  console.log(`\n\n${'═'.repeat(60)}`);
  console.log('【推演剧本】');
  console.log(`${'═'.repeat(60)}`);
  console.log(result.transcript);
  console.log(`\n${'═'.repeat(60)}\n`);
}

await main();
