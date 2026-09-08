/**
 * 公式审校司（接入 generate 流水线，docs/01 §4「审校司」的数值侧）：
 * 数值司给出 metrics/rules（含公式）后，复核员核对每条规则是否
 *  —— 表达式可执行（语法/运算符/函数白名单）；
 *  —— 仅引用已声明指标（防野指针）；
 *  —— 变动范围、阈值、作用域与指标定义一致；
 *  —— 公式方向与「越高越好/越低越好」相称（LLM 裁定）。
 *
 * 双实现，输出 schema 完全一致（FormulaAudit）：
 *  - 真实 LLM：审校司读公式与指标语义，逐条裁定 ok / 问题（issues 人话，不含公式原文）；
 *  - mock / 离线：确定性规则引擎逐条校验，规则可推导、可复核。
 *
 * 约定：对外（UI / API view）一律不含公式原文；本模块的 issues 也不回带公式。
 * 公式只活在内核 spec（引擎执行用）。
 */
import type { MetricDef, RuleDef, FormulaAudit } from '@sim/engine-core';
import { evalFormula } from '@sim/engine-core';
import type { ChatProvider } from '@sim/llm';

// ---------------- 确定性校验（mock/离线兜底，「规则引擎审公式」） ----------------

const FN_NAMES = new Set(['min', 'max', 'clamp', 'abs', 'round', 'floor', 'ceil', 'sqrt']);
const OP_SET = new Set(['>=', '<=', '>', '<', '==']);
const SAFE_CHARS = new Set('+-*/%^(),. ');

/** 试算一次公式：出有限数即语法与执行通过（除零等对 0 兜底，不报错） */
function tryBatch(expr: string, state: Record<string, number>): number | null {
  try {
    const v = evalFormula(expr, state);
    return Number.isFinite(v) ? v : null;
  } catch {
    return null;
  }
}

/** 提取表达式中引用的标识符，返回「未声明的量」：非法字符、函数名或指标 key 之外的名字 */
function unknownIdentifiers(expr: string, metricKeys: Set<string>): string[] {
  const bad: string[] = [];
  const nameRe = /[A-Za-z0-9_一-龥]/;
  let cur = '';
  const flush = () => {
    if (!cur) return;
    if (!/^[0-9.]+$/.test(cur) && !FN_NAMES.has(cur) && !metricKeys.has(cur)) bad.push(cur);
    cur = '';
  };
  for (const ch of expr) {
    if (nameRe.test(ch)) { cur += ch; continue; }
    flush();
    if (!SAFE_CHARS.has(ch)) bad.push(ch);
  }
  flush();
  return [...new Set(bad)];
}

function driftAudit(rule: RuleDef, keys: Set<string>): FormulaAudit {
  const issues: string[] = [];
  const expr = rule.formula ?? '';
  const badRef = unknownIdentifiers(expr, keys);
  if (badRef.length) issues.push(`公式引用了未声明的量：${badRef.join('、')}（只允许指标 key 与 min/max/clamp/abs/round/sqrt 等函数）`);
  if (rule.target && !keys.has(rule.target)) issues.push(`漂移目标「${rule.target}」不在指标内`);
  // 用全指标中点试算：能算出有限值即可执行
  const probe: Record<string, number> = {};
  for (const k of keys) probe[k] = 50;
  if (issues.length === 0 && tryBatch(expr, probe) === null) {
    issues.push('公式无法执行（语法/运算符有误）');
  }
  return { ruleId: rule.id, ok: issues.length === 0, issues, source: 'rule' };
}

function reactionAudit(rule: RuleDef, keys: Set<string>): FormulaAudit {
  const issues: string[] = [];
  for (const t of rule.appliesTo ?? []) {
    if (!keys.has(t)) issues.push(`作用对象「${t}」不在指标内`);
  }
  if (rule.bounds != null) {
    const boundsList = typeof rule.bounds === 'number'
      ? [[null, rule.bounds] as const]
      : Object.entries(rule.bounds as Record<string, number>);
    for (const [k, v] of boundsList) {
      if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) {
        issues.push(k ? `「${k}」的幅度上限应为正数` : '幅度上限应为正数');
      }
    }
  }
  return { ruleId: rule.id, ok: issues.length === 0, issues, source: 'rule' };
}

function thresholdAudit(rule: RuleDef, metrics: MetricDef[]): FormulaAudit {
  const issues: string[] = [];
  const m = metrics.find((x) => x.key === rule.metric);
  if (!m) {
    issues.push(`触发指标「${rule.metric}」不在指标内`);
  } else if (rule.value != null && (rule.value < m.min || rule.value > m.max)) {
    issues.push(`阈值 ${rule.value} 超出指标区间 [${m.min}, ${m.max}]`);
  }
  if (!OP_SET.has(rule.op ?? '')) issues.push(`比较符「${rule.op ?? ''}」不支持（应>=/<=/>/</==）`);
  if (rule.fires == null || rule.fires === '') issues.push('阈值触发缺 fires 文案');
  return { ruleId: rule.id, ok: issues.length === 0, issues, source: 'rule' };
}

/** mock/离线：确定性逐条审（不联网；任何环境都可用） */
export function auditFormulaRules(metrics: MetricDef[], rules: RuleDef[]): FormulaAudit[] {
  const keys = new Set(metrics.map((m) => m.key));
  return rules.map((r) => {
    if (r.kind === 'drift') return driftAudit(r, keys);
    if (r.kind === 'reaction') return reactionAudit(r, keys);
    return thresholdAudit(r, metrics);
  });
}

// ---------- LLM 审校（真实 provider 才走到；审校裁定也走同样 FormulaAudit schema） ----------

/** 给审校 LLM 的问卷：完整公式会给到 agent（否则无法评合理与否），但让它只回裁决语（issues 不回抄公式） */
export function formulaAuditPrompt(metrics: MetricDef[], rules: RuleDef[]): string {
  const ml = metrics
    .map((m) => `- ${m.key}（${m.label}）区间 [${m.min}, ${m.max}] 起点 ${m.start}，${m.higherIsBetter ? '越高越好' : '越低越好'}，含义：${m.description}`)
    .join('\n');
  const rl = rules
    .map((r) => {
      const base = `- ${r.id} [${r.kind}] ${r.label}：${r.description}`;
      if (r.kind === 'drift') return `${base}（作用于 ${r.target ?? '未指定'}，公式：${r.formula}）`;
      if (r.kind === 'reaction') return `${base}（作用于 ${(r.appliesTo ?? []).join('、')}，幅度上限 ±${typeof r.bounds === 'number' ? r.bounds : JSON.stringify(r.bounds)}）`;
      return `${base}（触发：${r.metric} ${r.op} ${r.value}，fires：${r.fires}）`;
    })
    .join('\n');
  return (
    '你是模拟引擎的「审校司」：判断每条规则的公式在指标语义面前是否合理。\n' +
    '重点：1) 漂移公式方向与该指标「越高越好/越低越好」是否一致（良性指标不该被无理由抽干，风险指标不该凭空涨）；' +
    '2) 漂移幅度是否与指标区间成比例（0-100 区间每轮 ±10 以上属过激）；' +
    '3) 反应幅度是否过度（一回合 ±50% 属过激）；' +
    '4) 阈值是否落在区间内且位于合理触发带；' +
    '5) 公式引用的名字是否都在指标表里（漂移公式只许出现指标 key 与数值）。\n\n' +
    `指标：\n${ml}\n\n规则（公式原文仅限本环节核对使用）：\n${rl}\n\n` +
    '输出 JSON（不要代码块）：{"results":[{"ruleId":"r1","ok":true,"issues":[]},{"ruleId":"r2","ok":false,"issues":["幅度过激"]}]}\n' +
    'issues 一句话说清「公式为什么不合理」或「它好在哪」。不得回抄公式原文——你的裁决会成为公开文案。'
  );
}

interface AuditJson { results?: { ruleId?: string; ok?: boolean; issues?: string | string[] }[] }

export function parseFormulaAudit(raw: string): FormulaAudit[] | null {
  try {
    const start = raw.indexOf('{');
    const end = raw.lastIndexOf('}');
    const obj = JSON.parse(raw.slice(start, end + 1)) as AuditJson;
    if (!obj || !Array.isArray(obj.results)) return null;
    return obj.results.map((r) => ({
      ruleId: String(r.ruleId ?? ''),
      ok: r.ok === true,
      issues: typeof r.issues === 'string' ? (r.issues ? [r.issues] : []) : (r.issues ?? []),
      source: 'llm' as const,
    }));
  } catch {
    return null;
  }
}

/** 公式审校司主入口：真实 LLM 审校；否则确定性审校；二者任一失败都落回确定性 */
export async function auditFormulaSet(
  metrics: MetricDef[],
  rules: RuleDef[],
  chat?: ChatProvider,
): Promise<FormulaAudit[]> {
  const deterministic = auditFormulaRules(metrics, rules);
  if (!chat?.isReal()) return deterministic;
  try {
    const raw = await chat.generate([{ role: 'user', content: formulaAuditPrompt(metrics, rules) }], {
      jsonMode: true,
    });
    const got = parseFormulaAudit(raw);
    if (got && got.length === rules.length) return got;
  } catch {
    /* 落回确定性 */
  }
  return deterministic;
}