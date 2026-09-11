/**
 * 即跑入口（docs/00「现在就玩」）：任意「一句话提问」或知乎话题链接
 * → 全管线离线 → 打印可玩剧本 + 动态数值 + 公式溯源。
 *
 *   pnpm topic "淝水之战：前秦 80 万大军为何败给东晋 8 万北府兵？"
 *   pnpm topic:url https://www.zhihu.com/question/xxxx            （需联网）
 *
 * 默认走 mock 全离线（不发 LLM/搜索请求）；数字线索、语域科目、规则推导全部
 * 由数值司按话题动态生成（values.ts），不写死任何话题常量。
 */
import { MockChatProvider } from '@sim/llm';
import { createFactStore } from '@sim/facts';
import { runPipeline } from '../src/index.ts';

async function main() {
  const args = process.argv.slice(2);
  const raw = args.filter((a) => a !== '--url').join(' ').trim();
  const isUrl = args.includes('--url') || /^https?:\/\//.test(raw);
  if (!raw) {
    console.log('用法：pnpm topic:ask "一句话提问" | pnpm topic:url <知乎/公开链接>');
    process.exit(2);
  }

  const chat = new MockChatProvider();
  const factsService = await createFactStore();
  const res = await runPipeline(
    isUrl ? { kind: 'url', url: raw } : { kind: 'text', text: raw },
    {
      chat,
      facts: {
        search: { find: (q: string) => factsService.search(q, { limit: 3 }) },
        estimate: async () => undefined, // mock 不估算；真实模式由 Estimator 出数
      },
    },
  );

  const { spec, status } = res;
  console.log('\n════════ 提问 ════════');
  console.log(isUrl ? `[链接] ${raw}` : `[文本] ${raw.slice(0, 46)}${raw.length > 46 ? '…' : ''}`);
  console.log('状态：', status.state, status.lastRevision?.length ? `（修订：${status.lastRevision.join('；')}）` : '');
  if (!spec) process.exit(1);
  console.log('估算占比：', status.estimatedRate, '| 已考据事实：', res.fill?.facts.length ?? 0, '条');

  console.log('\n════════ ① 剧本（构演司）════════');
  console.log('标题   ：', spec.title);
  console.log('背景   ：', (spec.scenario.background ?? '').slice(0, 140));
  console.log('冲突   ：', (spec.scenario.conflict ?? '').slice(0, 140));
  console.log('人物   ：', spec.cast.map((c) => `${c.name}（${c.stance}·${c.role}）`).join('，'));
  console.log('轮数   ：', spec.rounds);
  console.log('开局事件：', (spec.seedEvents ?? []).length ? spec.seedEvents!.slice(0, 3).map((e) => e.slice(0, 50)).join(' | ') : '（无）');

  console.log('\n════════════════ 数值 = 数值司（动态）════════════════');
  for (const m of spec.metrics) {
    const p = (spec.provenance ?? []).find((x) => x.metric === m.key);
    console.log(
      `· ${m.label}  [${m.min}–${m.max}] 初始 ${m.start}${m.unit ? ' ' + m.unit : ''}  ` +
      `${m.higherIsBetter ? '越高越好' : '越低越好'}\n   溯源：${p?.how ?? '（无）'}${p?.estimate ? `\n   估算：${p.estimate}` : ''}`,
    );
  }

  console.log('\n════════════════ 公式 = 数值司（动态）════════════════');
  for (const r of spec.rules) {
    const d = (spec.derivations ?? []).find((x) => x.ruleId === r.id);
    const shape =
      r.kind === 'drift' ? `每轮 ${r.formula}` :
      r.kind === 'reaction' ? `行动连动 ±${JSON.stringify(r.bounds)}` :
      `${r.metric} ${r.op} ${r.value} → ${r.fires}`;
    console.log(`· [${r.kind}] ${r.label}：${shape}`);
    if (d) console.log(`   推导：${d.why}${d.ref ? `（${d.ref}）` : ''}`);
  }

  console.log('\n验证：', status.state === 'ready' ? '✔ 可玩（已过审校司对齐校验）' : '✘ 未就绪');
}

await main();