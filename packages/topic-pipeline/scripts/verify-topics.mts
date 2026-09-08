/**
 * 多话题实测验收（todo4）：mock 离线管线 + 预置史实库，生成五个话题的 spec 并打印
 * cast/背景/事件/轮数，检查「话题→剧本」是否真正差异化（而非套模板）。
 * 运行：node --experimental-strip-types scripts/verify-topics.mts
 */
import { MockChatProvider } from '@sim/llm';
import { createFactStore } from '@sim/facts';
import { runPipeline } from '../src/index.ts';

const topics = [
  '诸葛亮第五次北伐，屯田五丈原与司马懿对峙，粮尽退军',
  '一战：1914年萨拉热窝事件爆发，马恩河战役后西线堑壕战僵持',
  '二战欧洲战场：1944年诺曼底登陆后，西线联军如何推进',
  '王安石变法：青苗法、免役法推行，新旧党争',
  '崇祯十七年：李自成破京，明朝财政崩溃',
  '创业公司 C 轮融资：增长与烧钱之争',
];

const chat = new MockChatProvider();
const factsService = await createFactStore();

for (const text of topics) {
  const res = await runPipeline(
    { kind: 'text', text },
    {
      chat,
      facts: {
        search: { find: (q: string) => factsService.search(q, { limit: 3 }) },
        estimate: async () => undefined, // mock 下不估算
      },
    },
  );
  const s = res.spec;
  const st = res.status;
  console.log('\n================ ' + text.slice(0, 24) + ' …');
  if (!s) {
    console.log('→ 状态：', st.state, st.lastRevision?.join(';') ?? '');
    continue;
  }
  console.log('状态      ：', st.state, '| 估算占比=', st.estimatedRate);
  console.log('标题      ：', s.title);
  console.log('领域      ：', s.domain, '| 轮数:', s.rounds);
  console.log('cast      ：', s.cast.map((c) => `${c.name}(${c.stance}/${c.role})`).join('，'));
  console.log('背景      ：', (s.scenario.background ?? '').slice(0, 110));
  console.log('冲突      ：', (s.scenario.conflict ?? '').slice(0, 110));
  console.log('metrics   ：', s.metrics.map((m) => m.label).join(','));
  console.log('数值溯源  ：', (s.provenance ?? []).slice(0, 2).map((p) => `${p.metric}←${p.how}`).join(' | ') || '（缺）');
  console.log('公式推导  ：', (s.derivations ?? []).slice(0, 2).map((d) => `${d.formula}（${d.why.slice(0, 26)}）`).join(' | ') || '（缺）');
  console.log('seedEvents：', (s.seedEvents ?? []).slice(0, 2).map((e) => e.slice(0, 60)).join(' | ') || '（无）');
}