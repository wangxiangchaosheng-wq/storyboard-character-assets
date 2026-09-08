// 生成器：把"领域 + 主题"快速变成一份可运行的 ScenarioSpec。
// 三种来源：① 内置预设（history/business/emotion）；② 自然语言构思（conceiveScript）；③ 手写 JSON spec 文件。

import { readFileSync } from 'node:fs';
import type { Domain, ScenarioSpec, Persona, Scenario } from '../core/types.ts';
import { getPreset, type DomainPreset } from './personaLibrary.ts';
import { specFromJson, validateSpec } from './conception.ts';

// 话题化覆盖位：构演 Agent 把「史实检索/话题信息」落到预设之上 ——
// 数值内核（metrics/rules）保持领域预设不动（正确性已由测试锁定），
// cast/scenario/seedEvents 允许被话题化内容整体替换。
export interface SpecOverrides {
  /** 话题化角色（替换 Archetypes 切片；缺省 = 预设 archetypes） */
  cast?: Persona[];
  /** 剧本字段覆盖（缺省 = buildScenario(theme)） */
  scenario?: Partial<Scenario>;
  /** 开局事件：史实/检索条目以开局扰动进入推演 */
  seedEvents?: string[];
}

// 从内置预设构建 spec（metrics + rules + cast + scenario 一次性齐备）。
export function buildSpec(
  domain: Domain,
  theme: string,
  nAgents?: number,
  overrides: SpecOverrides = {},
): ScenarioSpec {
  const preset: DomainPreset = getPreset(domain);
  const cast: Persona[] = overrides.cast ?? (nAgents ? preset.archetypes.slice(0, nAgents) : preset.archetypes);
  const base = preset.buildScenario(theme);
  const scenario: Scenario = {
    ...base,
    ...overrides.scenario,
    // 数值/轮数用默认回填：半成品覆盖位（rounds 显式给 undefined）不会抹掉预设
    rounds: overrides.scenario?.rounds ?? base.rounds,
    // participants 缺省跟随 cast（话题化角色时保持自洽）
    participants: overrides.scenario?.participants ?? cast.map((c) => c.id),
  };
  return {
    domain,
    title: scenario.title,
    scenario,
    cast,
    metrics: preset.metrics,
    rules: preset.rules,
    rounds: scenario.rounds,
    seedEvents: overrides.seedEvents,
  };
}

// 从手写 JSON spec 文件加载（开发者快速搭建的落点）。
// JSON 中的 drift 规则用 formula（字符串），reaction 用 bounds，threshold 用 op/value；
// 不支持内联函数 effect（JSON 无法表达函数），需要函数请改用 TS 直接构造 spec。
export function loadSpecFile(path: string): ScenarioSpec {
  const raw = readFileSync(path, 'utf-8');
  const spec = specFromJson(raw, 'custom');
  if (!spec) throw new Error(`无法解析 spec 文件：${path}`);
  const check = validateSpec(spec);
  if (!check.ok) throw new Error(`spec 校验失败：\n` + check.errors.join('\n'));
  if (check.warnings.length) console.warn('[spec] 警告：\n' + check.warnings.join('\n'));
  return spec;
}
