import { createProvider } from '../src/core/llm.ts';
import { buildSpec, loadSpecFile } from '../src/domains/generator.ts';
import { conceiveScript } from '../src/domains/conception.ts';
import { runScenario } from '../src/core/engine.ts';
import { DOMAIN_PRESETS, listDomains } from '../src/domains/personaLibrary.ts';
import { formatState, formatDeltas } from '../src/core/metrics.ts';
import type { Decision, Domain, ScenarioSpec } from '../src/core/types.ts';
import * as readline from 'node:readline';

function parseArgs(argv: string[]): Record<string, string> {
  const out: Record<string, string> = {};
  for (let i = 0; i < argv.length; i++) {
    if (argv[i].startsWith('--')) {
      const key = argv[i].slice(2);
      const val = argv[i + 1] && !argv[i + 1].startsWith('--') ? argv[++i] : 'true';
      out[key] = val;
    }
  }
  return out;
}

function ask(question: string): Promise<string> {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => rl.question(question, (a) => { rl.close(); resolve(a); }));
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv.slice(2));
  const llm = createProvider({ apiKey: args.apiKey, baseUrl: args.baseUrl, model: args.model });
  const interactive = args.interactive === 'true';
  console.log(
    `\n[引擎] 提供器=${llm.name}` +
      (llm.isReal() ? '' : '（离线 mock；可用 --api-key 接入真实 LLM）') +
      `\n`,
  );

  // ---- 选定 spec：手写文件 > 自然语言构思 > 内置预设 ----
  let spec: ScenarioSpec;
  if (args.spec) {
    spec = loadSpecFile(args.spec);
    console.log(`[spec] 已从文件加载：${args.spec}`);
  } else if (args.brief || args.conceive === 'true') {
    const brief = args.brief || args.theme || '一个需要权衡的复杂局面';
    console.log(`[构思] 基于自然语言主题构思 spec：${brief}`);
    spec = await conceiveScript(brief, llm, { domain: (args.domain as Domain) || undefined });
  } else {
    const domain = (args.domain as Domain) || 'history';
    const valid = listDomains();
    if (!valid.includes(domain)) {
      console.error(`未知领域 ${domain}，可选：${valid.join(' / ')}`);
      process.exit(1);
    }
    const nAgents = parseInt(args.agents || '3', 10);
    spec = buildSpec(domain, args.theme || '', nAgents);
    console.log(`[领域] ${DOMAIN_PRESETS[domain].label}`);
  }

  console.log(`[议题] ${spec.title}`);
  console.log(`[数值体系] ${spec.metrics.map((m) => `${m.label}(${m.min}-${m.max})`).join('、')}`);
  console.log(`[矛盾] ${spec.scenario.conflict}\n`);

  const playerDecide = async (point: string): Promise<Decision> => {
    let text: string;
    if (interactive && process.stdin.isTTY) {
      text = (await ask(`\n${point}\n> `)).trim();
      if (!text) text = '按多数意见审慎推进。';
    } else {
      text = '综合各方立场，采取折中而坚定的方案，明确权责与期限。';
    }
    return { text, intent: text };
  };

  const result = await runScenario(spec, llm, playerDecide, {
    onRound: (r) => {
      console.log(`\n=== 第 ${r.round} 轮 · ${r.task.topic} ===`);
      for (const u of r.utterances) console.log(`[${u.speakerName}｜${u.stance ?? ''}] ${u.content}`);
      if (r.driftDeltas.length) console.log(`（本回合漂移）${formatDeltas(r.driftDeltas)}`);
      console.log(`→ 当前数值：${formatState(r.stateAfter, spec.metrics)}`);
    },
  });

  console.log(`\n========== 裁决 ==========`);
  console.log(`玩家决断：${result.decision.text}`);
  console.log(`\n========== 执行衰减 ==========`);
  console.log(result.settlement.narrative);
  if (result.settlement.factors.length) console.log(`偏差来源：${result.settlement.factors.map((f) => f.effect).join('；')}`);
  if (result.settlement.deltas.length) console.log(`数值变动：\n${formatDeltas(result.settlement.deltas)}`);
  if (result.settlement.thresholds.length) console.log(`阈值事件：${result.settlement.thresholds.map((t) => t.note).join('；')}`);

  console.log(`\n========== 数值轨迹 ==========`);
  for (const t of result.stateTrajectory) {
    const tag = t.round === 0 ? '初始' : t.round > spec.rounds ? '终局' : `第${t.round}轮后`;
    console.log(`  ${tag}：${formatState(t.state, spec.metrics)}`);
  }
  console.log(`\n（完整剧本见 result.transcript，可在代码中写入文件）`);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
