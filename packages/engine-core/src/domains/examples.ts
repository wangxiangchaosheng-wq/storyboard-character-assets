// 手写示例：一份完整的 ScenarioSpec。展示「开发者/AI 如何快速搭起一套数值 + 剧本」。
// 这份 spec 可直接交给 runScenario 运行，无需任何预设。
// 重点看 metrics / rules 的声明式写法：drift 用 formula（安全表达式），reaction 用 bounds 约束大模型。

import type { ScenarioSpec } from '../core/types.ts';

export const financingSpec: ScenarioSpec = {
  domain: 'custom',
  title: '创业公司 B 轮融资推演',
  scenario: {
    title: '创业公司 B 轮融资推演',
    background: '一家成长期 SaaS 公司站在 B 轮关口：拿谁的的钱、稀释多少、怎么稳住团队。',
    conflict: '是否接受战略投资人带条款的 B 轮：CEO 要速度，CFO 要安全，CTO 要独立，HRD 要人心。',
    participants: ['ceo', 'cfo', 'cto', 'hrd'],
    rounds: 3,
    decisionPoint: '作为创始人，你最终接受哪版 Term Sheet？',
    successCriteria: '在估值、现金、团队之间取得可持续的平衡。',
  },
  cast: [
    { id: 'ceo', name: 'CEO', role: '创始人', stance: '增长', influence: 80, description: '要速度与市场份额。', prompt: '你是 CEO，立场增长。说话果断、谈愿景与速度，愿意为增长接受条款。', traits: { competence: 80, loyalty: 80, ambition: 85, power: 80 } },
    { id: 'cfo', name: 'CFO', role: '财务负责人', stance: '安全', influence: 65, description: '盯现金流与稀释。', prompt: '你是 CFO，立场安全。强调 runway 与估值质量，警惕对赌。', traits: { competence: 82, loyalty: 78, ambition: 45, power: 62 } },
    { id: 'cto', name: 'CTO', role: '技术负责人', stance: '独立', influence: 55, description: '怕失去技术路线主导权。', prompt: '你是 CTO，立场独立。强调产品自主与控制权，警惕战略投资人插手。', traits: { competence: 88, loyalty: 72, ambition: 50, power: 50 } },
    { id: 'hrd', name: 'HRD', role: '人力负责人', stance: '人心', influence: 50, description: '担心条款引发团队动荡。', prompt: '你是 HRD，立场人心。强调团队稳定与期权，警惕变故伤士气。', traits: { competence: 70, loyalty: 75, ambition: 40, power: 45 } },
  ],
  metrics: [
    { key: 'valuation', label: '估值', min: 0, max: 1000, start: 300, unit: '百万', higherIsBetter: true, description: '公司投后估值' },
    { key: 'runway', label: '现金跑道', min: 0, max: 24, start: 8, unit: '月', higherIsBetter: true, description: '按当前消耗可支撑的月数' },
    { key: 'cohesion', label: '团队凝聚力', min: 0, max: 100, start: 70, higherIsBetter: true, description: '核心团队稳定度' },
  ],
  rules: [
    // drift：每月固定烧钱，跑道 -1；跑道过低时估值承压
    { id: 'f-drift-runway', kind: 'drift', label: '月度现金消耗', description: '固定运营成本消耗现金跑道', target: 'runway', formula: '-1' },
    { id: 'f-drift-val', kind: 'drift', label: '跑道压力传导估值', description: '跑道低于 4 月时估值承压', effect: (s) => ({ valuation: s.runway < 4 ? -20 : 0 }) },
    // reaction：融资决策影响（不同指标上限不同，演示按指标分别设 bounds）
    {
      id: 'f-react-term', kind: 'reaction', label: 'Term Sheet 对经营的影响',
      description: '接受哪版条款，改变估值/跑道/凝聚力',
      appliesTo: ['valuation', 'runway', 'cohesion'],
      bounds: { valuation: 120, runway: 6, cohesion: 12 },
    },
    // threshold：危险信号
    { id: 'f-thr-runway', kind: 'threshold', label: '现金枯竭', description: '跑道耗尽', metric: 'runway', op: '<=', value: 2, fires: '现金见底，被迫贱卖或停摆。' },
    { id: 'f-thr-cohesion', kind: 'threshold', label: '团队崩盘', description: '凝聚力崩溃', metric: 'cohesion', op: '<=', value: 30, fires: '核心成员出走，产品失速。' },
  ],
  seedEvents: ['投资人给出两版 Term Sheet：A 版高估值带对赌，B 版低估值无条款。'],
  rounds: 3,
};

export const EXAMPLE_SPECS: Record<string, ScenarioSpec> = {
  financing: financingSpec,
};
