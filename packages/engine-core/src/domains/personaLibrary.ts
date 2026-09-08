// 三领域预设：人设池 + 数值体系(MetricDef[]) + 规则(RuleDef[])。
// 一份预设 = 一份"可运行的数值与剧本脚手架"，引擎零改动即可切换领域。
// 这是「快速搭建」的现成样板：要加新领域，复制一份 preset 即可。

import type { Domain, Persona, Scenario, MetricDef, RuleDef } from '../core/types.ts';

export interface DomainPreset {
  label: string;
  description: string;
  metrics: MetricDef[];
  rules: RuleDef[];
  archetypes: Persona[]; // 人设池（天然含对立立场）
  buildScenario: (theme: string) => Scenario;
}

// ---------- 历史：皇帝（玩家） + 多方大臣 ----------
const history: DomainPreset = {
  label: '历史推演',
  description: '以掌权者视角，与不同立场的历史角色推演重大抉择。',
  metrics: [
    { key: 'minxin', label: '民心', min: 0, max: 100, start: 60, higherIsBetter: true, description: '百姓对统治的拥护程度' },
    { key: 'caizheng', label: '财政', min: 0, max: 100, start: 55, higherIsBetter: true, description: '国库充盈程度' },
    { key: 'junli', label: '军力', min: 0, max: 100, start: 50, higherIsBetter: true, description: '军队战斗与供给能力' },
  ],
  rules: [
    { id: 'h-drift-cost', kind: 'drift', label: '日常维持开销', description: '每季固定消耗财政', target: 'caizheng', formula: '-2' },
    {
      id: 'h-drift-support', kind: 'drift', label: '民心与军力自然损耗',
      description: '财政紧张时民心下滑更快；军力缓慢损耗',
      effect: (s) => ({ minxin: s.caizheng < 40 ? -3 : -1, junli: -1 }),
    },
    {
      id: 'h-react-decision', kind: 'reaction', label: '决策落地对国势的影响',
      description: '玩家裁决 + 廷议结果，改变民心/财政/军力', appliesTo: ['minxin', 'caizheng', 'junli'], bounds: 10,
    },
    { id: 'h-thr-finance', kind: 'threshold', label: '财政危机', description: '财政枯竭', metric: 'caizheng', op: '<=', value: 20, fires: '国库见底，催征与减禄势在必行，朝野震动。' },
    { id: 'h-thr-people', kind: 'threshold', label: '民变', description: '民心崩溃', metric: 'minxin', op: '<=', value: 20, fires: '民怨沸腾，各地骚动四起。' },
    { id: 'h-thr-army', kind: 'threshold', label: '边患失控', description: '军力崩坏', metric: 'junli', op: '<=', value: 15, fires: '边备废弛，外敌叩关。' },
  ],
  archetypes: [
    { id: 'power-eunuch', name: '权阉', role: '内廷权臣', stance: '利己', influence: 75, description: '掌权已久，优先保全自身权位与派系利益。', prompt: '你是内廷权臣，立场利己。说话圆滑、护短、强调稳定与皇权威严，反对可能动摇你权位的变化。', traits: { competence: 55, loyalty: 40, ambition: 85, power: 80 } },
    { id: 'frontier-general', name: '边将', role: '前线将领', stance: '务实', influence: 65, description: '常年领兵，看重边防与军饷实利。', prompt: '你是前线将领，立场务实。说话直率、重结果，关心粮饷与边患，反对空谈。', traits: { competence: 80, loyalty: 70, ambition: 50, power: 60 } },
    { id: 'reform-scholar', name: '清流', role: '朝中言官', stance: '改革', influence: 55, description: '主张变法图强，常与既得利益者冲突。', prompt: '你是朝中清流，立场改革。说话凛然、引经据典，痛陈时弊，主张革除积弊。', traits: { competence: 70, loyalty: 75, ambition: 45, power: 40 } },
    { id: 'conservative-elder', name: '老臣', role: '资深官僚', stance: '保守', influence: 60, description: '经验丰富，倾向于维持旧制、规避风险。', prompt: '你是资深老臣，立场保守。说话持重、援引祖制，反对激进变动。', traits: { competence: 65, loyalty: 65, ambition: 35, power: 55 } },
  ],
  buildScenario: (theme) => ({
    title: `历史推演：${theme || '朝局危机'}`,
    background: `时局动荡，${theme || '一桩关乎国运的抉择'}摆在御前。各方立场悬殊，需你裁决。`,
    conflict: `${theme || '是否推行激进变革'}：支持者主张当断则断，反对者强调祖制与稳定。`,
    participants: ['power-eunuch', 'frontier-general', 'reform-scholar'],
    rounds: 3,
    decisionPoint: '作为掌权者，你最终下达怎样的决断？',
    successCriteria: '决策能在各方博弈中落地，并尽可能保全大局。',
  }),
};

// ---------- 行业 · 公司：决策者 + 增长/风控/技术 ----------
const business: DomainPreset = {
  label: '行业·公司推演',
  description: '以决策者视角，推演重大战略在内部博弈中的真实走向。',
  metrics: [
    { key: 'cash', label: '现金流', min: 0, max: 100, start: 60, higherIsBetter: true, description: '公司可动用现金健康度' },
    { key: 'market', label: '市场份额', min: 0, max: 100, start: 50, higherIsBetter: true, description: '相对市场的占有度' },
    { key: 'morale', label: '团队士气', min: 0, max: 100, start: 65, higherIsBetter: true, description: '核心团队状态' },
  ],
  rules: [
    { id: 'b-drift-burn', kind: 'drift', label: '月度现金消耗', description: '固定运营成本消耗现金流', target: 'cash', formula: '-3' },
    { id: 'b-drift-morale', kind: 'drift', label: '士气自然下滑', description: '无干预时团队士气缓慢流失', target: 'morale', formula: '-1' },
    {
      id: 'b-react-decision', kind: 'reaction', label: '战略决策对经营的影响',
      description: '玩家指令 + 内部博弈，改变现金流/份额/士气', appliesTo: ['cash', 'market', 'morale'], bounds: 12,
    },
    { id: 'b-thr-cash', kind: 'threshold', label: '资金链断裂', description: '现金枯竭', metric: 'cash', op: '<=', value: 10, fires: '现金流告罄，被迫裁员或紧急融资。' },
    { id: 'b-thr-morale', kind: 'threshold', label: '核心离职', description: '士气崩盘', metric: 'morale', op: '<=', value: 20, fires: '骨干批量出走，业务失速。' },
  ],
  archetypes: [
    { id: 'growth-cmo', name: '增长负责人', role: 'CMO', stance: '增长', influence: 60, description: '信奉规模优先，主张 All-in 新机会。', prompt: '你是增长负责人，立场增长。说话激昂、用数据施压，主张大胆投入换增长。', traits: { competence: 75, loyalty: 70, ambition: 80, power: 55 } },
    { id: 'risk-cfo', name: '财务负责人', role: 'CFO', stance: '风控', influence: 65, description: '紧盯现金流与风险，习惯性踩刹车。', prompt: '你是财务负责人，立场风控。说话冷静、强调底线与回报，反对无节制烧钱。', traits: { competence: 80, loyalty: 75, ambition: 40, power: 60 } },
    { id: 'tech-cto', name: '技术负责人', role: 'CTO', stance: '技术债', influence: 55, description: '关注系统可持续性，担心被速度拖垮。', prompt: '你是技术负责人，立场技术债。说话务实、谈架构与人力，反对透支工程能力。', traits: { competence: 85, loyalty: 70, ambition: 50, power: 50 } },
  ],
  buildScenario: (theme) => ({
    title: `公司推演：${theme || '战略转向'}`,
    background: `公司面临${theme || '一次关键战略转向'}。增长、风控、技术三方诉求冲突，需你拍板。`,
    conflict: `${theme || '是否 All-in 新方向'}：增长派要速度，风控派要安全，技术派要可持续。`,
    participants: ['growth-cmo', 'risk-cfo', 'tech-cto'],
    rounds: 3,
    decisionPoint: '作为决策者，你对这次战略转向下达什么指令？',
    successCriteria: '指令能在组织惯性中有效落地，平衡增长与风险。',
  }),
};

// ---------- 情感模拟：关系中的「我」 + 回避/焦虑/控制 ----------
const emotion: DomainPreset = {
  label: '情感模拟',
  description: '以关系中的「我」或旁观者视角，推演情感冲突中的言与行。',
  metrics: [
    { key: 'intimacy', label: '亲密度', min: 0, max: 100, start: 55, higherIsBetter: true, description: '彼此靠近的程度' },
    { key: 'trust', label: '信任', min: 0, max: 100, start: 50, higherIsBetter: true, description: '对关系可靠性的信心' },
    { key: 'security', label: '安全感', min: 0, max: 100, start: 45, higherIsBetter: true, description: '在关系中的安定感' },
  ],
  rules: [
    { id: 'e-drift-security', kind: 'drift', label: '张力自然消耗安全感', description: '未化解的矛盾持续侵蚀安全感', target: 'security', formula: '-1' },
    {
      id: 'e-react-decision', kind: 'reaction', label: '关键对话对关系的影响',
      description: '你说出的那句话 + 对方反应，改变亲密度/信任/安全感', appliesTo: ['intimacy', 'trust', 'security'], bounds: 8,
    },
    { id: 'e-thr-trust', kind: 'threshold', label: '关系破裂', description: '信任崩溃', metric: 'trust', op: '<=', value: 15, fires: '信任见底，关系名存实亡。' },
    { id: 'e-thr-security', kind: 'threshold', label: '彻底回避', description: '安全感归零', metric: 'security', op: '<=', value: 10, fires: '对方彻底退守，沟通断联。' },
  ],
  archetypes: [
    { id: 'avoidant', name: '回避型伴侣', role: '伴侣', stance: '逃避', influence: 50, description: '冲突时习惯后撤、冷处理。', prompt: '你是回避型伴侣，立场逃避。说话含蓄、回避锋面，冲突时退守沉默或转移话题。', traits: { competence: 50, loyalty: 55, ambition: 40, power: 45 } },
    { id: 'anxious', name: '焦虑型自己', role: '自己', stance: '焦虑', influence: 50, description: '渴望确认，易在关系中过度索求。', prompt: '你是焦虑型的自己，立场焦虑。说话带着不安与求证，渴望被回应与确认。', traits: { competence: 55, loyalty: 60, ambition: 45, power: 40 } },
    { id: 'controlling', name: '控制型长辈', role: '长辈', stance: '控制', influence: 60, description: '以「为你好」之名介入关系。', prompt: '你是控制型长辈，立场控制。说话以经验与权威压人，强调「我都是为你好」。', traits: { competence: 60, loyalty: 50, ambition: 70, power: 65 } },
  ],
  buildScenario: (theme) => ({
    title: `情感推演：${theme || '一次摊牌'}`,
    background: `一段关系里，${theme || '积压已久的矛盾'}到了临界点。各方反应未必真诚。`,
    conflict: `${theme || '是否摊牌'}：一方想确认，一方想逃避，第三方想掌控。`,
    participants: ['avoidant', 'anxious', 'controlling'],
    rounds: 3,
    decisionPoint: '作为「我」，你此刻说出的那句话是什么？',
    successCriteria: '这句话能否撬动真实的改变，而非又一次循环。',
  }),
};

export const DOMAIN_PRESETS: Record<Domain, DomainPreset> = { history, business, emotion } as Record<Domain, DomainPreset>;

export function listDomains(): Domain[] {
  return Object.keys(DOMAIN_PRESETS) as Domain[];
}

export function getPreset(domain: Domain): DomainPreset {
  return DOMAIN_PRESETS[domain];
}
