// 规则引擎：确定性漂移、阈值检测、规则描述（给大模型看）。
// 关键点：drift 支持「声明式公式」(formula) 与「开发者函数」(effect) 两种写法，
// 公式计算走自写的*安全*求值器（不允许任意代码执行），让 spec 可被 AI 直接生成。

import type { State, RuleDef, MetricDef, Delta, ThresholdEvent } from './types.ts';
import { clampMetric } from './metrics.ts';

// ---------------- 安全算术求值器（调度场算法） ----------------
// 支持：+ - * / % ^、括号、一元负号、函数 min/max/clamp/abs/round/floor/ceil/sqrt。
// 变量名解析为当前 state（缺失=0），除零返回 0。不触碰任何 JS 运行时，安全。

type Tok =
  | { t: 'num'; v: number }
  | { t: 'id'; v: string }
  | { t: 'op'; v: string }
  | { t: 'lp' }
  | { t: 'rp' }
  | { t: 'comma' };

function tokenize(expr: string): Tok[] {
  const toks: Tok[] = [];
  let i = 0;
  const isDigit = (c: string) => c >= '0' && c <= '9';
  const isIdStart = (c: string) => /[A-Za-z_一-龥]/.test(c);
  const isId = (c: string) => /[A-Za-z0-9_一-龥]/.test(c);
  while (i < expr.length) {
    const c = expr[i];
    if (c === ' ' || c === '\t' || c === '\n') { i++; continue; }
    if (isDigit(c) || (c === '.' && isDigit(expr[i + 1] ?? ''))) {
      let j = i + 1;
      while (j < expr.length && (isDigit(expr[j]) || expr[j] === '.')) j++;
      toks.push({ t: 'num', v: parseFloat(expr.slice(i, j)) });
      i = j;
      continue;
    }
    if (isIdStart(c)) {
      let j = i + 1;
      while (j < expr.length && isId(expr[j])) j++;
      toks.push({ t: 'id', v: expr.slice(i, j) });
      i = j;
      continue;
    }
    if ('+-*/%^'.includes(c)) { toks.push({ t: 'op', v: c }); i++; continue; }
    if (c === '(') { toks.push({ t: 'lp' }); i++; continue; }
    if (c === ')') { toks.push({ t: 'rp' }); i++; continue; }
    if (c === ',') { toks.push({ t: 'comma' }); i++; continue; }
    throw new Error(`公式无法解析，位置 ${i} 字符 "${c}"`);
  }
  return toks;
}

const FUNCS: Record<string, (a: number[]) => number> = {
  min: (a) => Math.min(...a),
  max: (a) => Math.max(...a),
  clamp: (a) => a.length >= 3 ? Math.max(a[1], Math.min(a[2], a[0])) : a[0],
  abs: (a) => Math.abs(a[0]),
  round: (a) => Math.round(a[0]),
  floor: (a) => Math.floor(a[0]),
  ceil: (a) => Math.ceil(a[0]),
  sqrt: (a) => Math.sqrt(a[0]),
};

const PREC: Record<string, number> = { '+': 1, '-': 1, '*': 2, '/': 2, '%': 2, '^': 3 };
const RIGHT = new Set(['^']);

function toRPN(toks: Tok[]): Tok[] {
  const out: Tok[] = [];
  const stack: Tok[] = [];
  for (const tk of toks) {
    if (tk.t === 'num' || tk.t === 'id') out.push(tk);
    else if (tk.t === 'op') {
      while (
        stack.length &&
        stack[stack.length - 1].t === 'op' &&
        (RIGHT.has(tk.v) ? PREC[(stack[stack.length - 1] as any).v] > PREC[tk.v]
                          : PREC[(stack[stack.length - 1] as any).v] >= PREC[tk.v])
      ) out.push(stack.pop()!);
      stack.push(tk);
    } else if (tk.t === 'comma') {
      while (stack.length && stack[stack.length - 1].t !== 'lp') out.push(stack.pop()!);
    } else if (tk.t === 'lp') stack.push(tk);
    else if (tk.t === 'rp') {
      while (stack.length && stack[stack.length - 1].t !== 'lp') out.push(stack.pop()!);
      if (!stack.length) throw new Error('括号不匹配');
      stack.pop();
    }
  }
  while (stack.length) out.push(stack.pop()!);
  return out;
}

function evalRPN(rpn: Tok[], vars: State): number {
  const st: number[] = [];
  for (const tk of rpn) {
    if (tk.t === 'num') st.push(tk.v);
    else if (tk.t === 'id') st.push(vars[tk.v] ?? 0);
    else if (tk.t === 'op') {
      const b = st.pop() ?? 0;
      const a = st.pop() ?? 0;
      let r = 0;
      switch (tk.v) {
        case '+': r = a + b; break;
        case '-': r = a - b; break;
        case '*': r = a * b; break;
        case '/': r = b === 0 ? 0 : a / b; break;
        case '%': r = b === 0 ? 0 : a % b; break;
        case '^': r = Math.pow(a, b); break;
      }
      st.push(r);
    }
  }
  return st.pop() ?? 0;
}

// 对外安全 API：在给定状态下求一个公式的值。
export function evalFormula(expr: string, state: State): number {
  const rpn = toRPN(tokenize(expr));
  return evalRPN(rpn, state);
}

// ---------------- 漂移：每回合确定性改变数值 ----------------

export function applyDrift(state: State, rules: RuleDef[], _metrics: MetricDef[]): Delta[] {
  const out: Delta[] = [];
  for (const r of rules) {
    if (r.kind !== 'drift') continue;
    if (r.effect) {
      const d = r.effect(state);
      for (const [k, v] of Object.entries(d)) {
        out.push({ key: k, amount: v, reason: r.label, source: r.id });
      }
    } else if (r.target && r.formula != null) {
      const v = evalFormula(r.formula, state);
      out.push({ key: r.target, amount: v, reason: r.label, source: r.id });
    }
  }
  return out;
}

// 解析某规则对某个指标的最大变动绝对值（支持单值或按指标分别设）。
// rule 可为 undefined：无规则命中时由调用方给兜底幅度。
export function resolveBound(rule: RuleDef | undefined, key: string): number | undefined {
  if (rule == null || rule.bounds == null) return undefined;
  if (typeof rule.bounds === 'number') return rule.bounds;
  return rule.bounds[key];
}

// 把规则浓缩成给大模型的文字说明（反应规则尤其依赖它）。
export function describeRules(rules: RuleDef[]): string {
  return rules
    .map((r) => {
      const scope = r.appliesTo?.length ? `（影响：${r.appliesTo.join('、')}）` : '';
      let bound = '';
      if (r.bounds != null) {
        if (typeof r.bounds === 'number') bound = ` 幅度上限：每回合 ±${r.bounds}。`;
        else bound = ` 幅度上限：${Object.entries(r.bounds).map(([k, v]) => `${k} ±${v}`).join('，')}。`;
      }
      const thr = r.kind === 'threshold' && r.metric
        ? ` 触发条件：${r.metric} ${r.op} ${r.value}。`
        : '';
      return `- [${r.kind}] ${r.label}：${r.description}${scope}${bound}${thr}`;
    })
    .join('\n');
}

// 阈值检测：返回被触发的事件（不改数值，只发信号）。
export function checkThresholds(state: State, rules: RuleDef[], metrics: MetricDef[]): ThresholdEvent[] {
  const events: ThresholdEvent[] = [];
  for (const r of rules) {
    if (r.kind !== 'threshold' || !r.metric || !r.op || r.value == null) continue;
    const v = state[r.metric];
    if (v == null) continue;
    const hit =
      (r.op === '>=' && v >= r.value) ||
      (r.op === '<=' && v <= r.value) ||
      (r.op === '>' && v > r.value) ||
      (r.op === '<' && v < r.value) ||
      (r.op === '==' && v === r.value);
    if (hit) {
      const m = metrics.find((x) => x.key === r.metric);
      events.push({
        ruleId: r.id,
        metric: r.metric,
        value: v,
        label: r.label,
        note: r.fires ?? `${m?.label ?? r.metric} 达到 ${v}${m ? '/' + m.max : ''}`,
      });
    }
  }
  return events;
}
