/**
 * Spec 生成（docs/01 §4）：TopicBrief + Facts → ScenarioSpec。四司流水：
 *
 *   考据司  事实收集与检索（facts.ts：原文提取 + 词条直查 + 估算兜底）
 *   构演司  实体化 cast + 剧本/事件（drama.ts：话题语料 → 实体聚类 → 角色/冲突/轮数）
 *   数值司  AI 动态推导数值体系（values.ts：metrics/rules + provenance「数值去哪找真实」
 *          + derivations「公式为何这样推」，LLM 无法可用时按事实线索离线确定性推导）
 *   审校司  校验回灌（validateSpec + checkAlignment，至多 3 轮收敛）
 *
 * mock 全程确定性可离线；真实 LLM 时构演司/数值司都产真实内容（考据充分 → 更鲜活的
 * 人物/冲突/数值）。数值不为任何话题写死：默认无预设数值内核（docs/01 §4「数值司
 * 无预设」），唯一兜底是本话题考据为空时的领域预设阵容（cast 兜底，数值仍动态）。
 */
import type { ChatProvider } from '@sim/llm';
import { validateSpec } from '@sim/engine-core';
import type { ScenarioSpec, Domain, Persona } from '@sim/engine-core';
import type { TopicBrief, FillResult } from '@sim/contracts';
import type { FactCollectOpts } from './facts.ts';
import { collectFacts } from './facts.ts';
import { composeDrama } from './drama.ts';
import { deriveNumbers } from './values.ts';
import { auditFormulaSet } from './formulaAudit.ts';

export interface GenMeta {
  scenario: 'topic' | 'preset'; // topic=考据驱动实体化；preset=无命中考据回落预设 cast
  theme: string;
  conflict: string;
  cast: Persona[];
  seedNotes: string[];
  provenanceCount: number;   // 数值溯源条目数（≥metrics 数）
  derivationCount: number;   // 公式推导条目数（≥rules 数）
  formulaAuditCount: number; // 公式复核条目数（=rules 数；全部通过才会出 spec）
}

export interface SpecWithMeta {
  spec: ScenarioSpec;
  meta: GenMeta;
}

export interface GenerateOpts {
  /** 考据司的检索/估算设施（mock 离线时也可只给 search），缺省 = 不检索 */
  facts?: FactCollectOpts;
  /** 已完成的考据结果（pipeline 复用；缺省 = 本函数内部再考据一次） */
  fill?: FillResult;
}

/** 数值司兜底判定：domain 选择（历史话题默认 history；构演司给过 domain 时用） */
function pickDomain(theme: string, cast: Persona[]): Domain {
  const t = theme + ' ' + cast.map((c) => c.name + c.role).join(' ');
  if (/公司|创业|融资|市场|团队|创业|现金流|商业/.test(t)) return 'business';
  if (/情感|复仇|表白|婚姻|亲密|家庭|伴侣|恋人|恋爱/.test(t)) return 'emotion';
  return 'history';
}

/** 话题标签收起：去掉标点与提问词，取第一段；过长时在「之乱/之战/之变」等术语结语处截断 */
function shortTheme(title: string): string {
  const segs = title.split(/[：:，,。；;？?！!]/).map((s) => s.trim()).filter(Boolean);
  let t = segs[0] ?? title;
  if (segs.length > 1 && t.length < 3) t += segs[1];
  if (t.length > 8) {
    const m = t.slice(0, 9).match(/之乱|之变|之战|大战|事变|革命|新政|之战/);
    if (m && m.index !== undefined) t = t.slice(0, m.index + m[0].length);
    else t = t.slice(0, 8);
  }
  return t.replace(/[^\p{L}\p{N}]+/gu, '').slice(0, 8) || '议题';
}

/** 三司合流 + 审校（内部已 verify validateSpec；抛错由 pipeline 转 failed） */
export async function generateSpec(
  brief: TopicBrief,
  chat: ChatProvider,
  opts: GenerateOpts = {},
): Promise<SpecWithMeta> {
  // ① 考据司（外部已传 fill 则复用）
  const fill = opts.fill ?? (await collectFacts(brief, chat, opts.facts));

  // ② 构演司（动机/立场实体化）
  const drama = await composeDrama(brief, fill, chat);

  // ③ 组装 cast + domain（必须先有 cast 才能判断领域）
  const theme = brief.title.slice(0, 32);
  const label = shortTheme(brief.title);
  const dramaCast = drama?.cast ?? [];
  const cast: Persona[] = dramaCast.length >= 2 ? dramaCast : defaultCast(label);
  const domain = pickDomain(theme + (drama?.conflict ?? ''), cast);

  // ④ 数值司：动态推导（LLM 或离线线索），不套预设数值
  const nums = await deriveNumbers(brief, fill, drama, chat, domain);

  // 组装 spec：场景/人物来自构演司；数值/规则来自数值司；溯源随 spec 落库
  const scenarioTitle = `话题推演：${brief.title.slice(0, 24)}`;
  const spec: ScenarioSpec = {
    domain,
    title: scenarioTitle,
    scenario: {
      title: scenarioTitle,
      background: drama?.background ?? `时局围绕「${label}」展开。各方立场悬殊，需你统筹。`,
      conflict: drama?.conflict ?? `${label}：支持者主张当断则断，反对者强调稳字当头。`,
      participants: cast.map((c) => c.id),
      rounds: drama?.rounds ?? 3,
      decisionPoint: drama?.decisionPoint ?? '作为统筹者，你最终下达怎样的决断？',
      successCriteria: drama?.successCriteria ?? '让局面在各方博弈中走向可接受的平衡。',
    },
    cast,
    metrics: nums.metrics,
    rules: nums.rules,
    rounds: drama?.rounds ?? 3,
    seedEvents: drama?.seedEvents,
    provenance: nums.provenance,
    derivations: nums.derivations,
  };

  // ④ 审校司·公式复核：LLM 有裁定时采纳其结论，否则确定性规则引擎兜底；
  //    审计记录随 spec 落库，公式原文不对外下发（只出 ok/issues/source）
  const formulaAudit = await auditFormulaSet(nums.metrics, nums.rules, chat);
  const bad = formulaAudit.filter((a) => !a.ok);
  if (bad.length > 0) {
    // 公式不合理 → 拒收这版数值（上游 try/catch 转 failed 并带复核意见）
    const detail = bad.map((a) => `${a.ruleId}：${a.issues.join('；')}`).join('；');
    const auditLine = chat?.isReal() ? '审校司裁定' : '确定性规则引擎校验';
    throw new Error(`数值公式未通过${auditLine}：${detail}`);
  }
  spec.formulaAudit = formulaAudit;

  const check = validateSpec(spec);
  if (!check.ok) {
    // 动态推导产物不合格 → 回滚到预设（仅 cast 兜底），不会硬生成坏数值
    throw new Error(`生成 spec 校验失败：${check.errors.join('；')}`);
  }
  return {
    spec,
    meta: {
      scenario: drama && drama.cast.length >= 2 ? 'topic' : 'preset',
      theme,
      conflict: spec.scenario.conflict.slice(0, 80),
      cast: spec.cast,
      seedNotes: spec.seedEvents ?? [],
      provenanceCount: nums.provenance.length,
      derivationCount: nums.derivations.length,
      formulaAuditCount: (spec.formulaAudit ?? []).length,
    },
  };
}

/** 考据为空时的最小兜底阵容（不硬造历史人物；三足：推进/稳健/仲裁） */
function defaultCast(theme: string): Persona[] {
  const t = theme || '议题';
  return [
    {
      id: 'a', name: `${t}推进方`, role: '推动者',
      stance: '进取', influence: 60,
      description: '主张积极推进', prompt: `你支持推进「${t}」，立场进取，讲求效率与成果。`,
      traits: { competence: 70, loyalty: 60, ambition: 60, power: 55 },
    },
    {
      id: 'b', name: `${t}稳健方`, role: '制衡者',
      stance: '稳健', influence: 60,
      description: '主张慎重推进', prompt: `你支持稳健谨慎地处理「${t}」，强调风险与节奏。`,
      traits: { competence: 70, loyalty: 60, ambition: 40, power: 55 },
    },
    {
      id: 'c', name: '仲裁者', role: '中间人',
      stance: '客观', influence: 50,
      description: '居中权衡各方', prompt: `你居中观察「${t}」的推进，要求兼顾多方的合理诉求。`,
      traits: { competence: 60, loyalty: 60, ambition: 30, power: 50 },
    },
  ];
}