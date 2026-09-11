/**
 * 对齐校验（docs/01 §5）：spec 必须「长在」源话题上 ——
 * 话题标题关键词应能在 spec 标题/背景中出现，否则给出 revision 条目。
 */
import type { ScenarioSpec } from '@sim/engine-core';
import type { TopicBrief, Fact, FillResult } from '@sim/contracts';

export interface AlignmentCheck {
  ok: boolean;
  issues: string[];
  estimatedRate: number; // 估算事实占比（端上展示：AI 推断 vs 原文确认）
}

/** 标题 → 有效关键词（≥2 字，去标点） */
function keywords(title: string): string[] {
  return title
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .split(/\s+/)
    .filter((w) => w.length >= 2);
}

/** M3 校验：spec 回指话题 + 估算占比受控 + 考据落地（实体化/事件化） */
export function checkAlignment(
  spec: ScenarioSpec,
  brief: TopicBrief,
  fill: FillResult,
): AlignmentCheck {
  const issues: string[] = [];
  const keys = keywords(brief.title);
  const hay = `${spec.title} ${spec.scenario.background} ${spec.scenario.conflict}`;
  if (keys.length && !keys.some((k) => hay.includes(k))) {
    issues.push(`剧本标题/背景未体现话题关键词（${keys.slice(0, 4).join('、')}）`);
  }
  if (!spec.scenario.background || spec.scenario.background.length < 20) {
    issues.push('背景过短，承载不了话题冲突');
  }
  if (spec.cast.length < 2) {
    issues.push('至少需要两个对立场角色');
  }
  // 审校司新增：考据给出的实体必须戏剧化进去（不然考据白做）
  const facts = fill.facts ?? [];
  const entities = new Set(facts.map((f: Fact) => f.entity).filter((e) => !!e && e !== brief.title));
  if (entities.size >= 2) {
    const named = spec.cast.map((c) => c.name);
    if (![...entities].some((e) => named.includes(e) || hay.includes(e))) {
      issues.push(`考据实体（${[...entities].slice(0, 3).join('、')}）未进入剧本`);
    }
  }
  if (facts.some((f: Fact) => !f.estimated) && !(spec.seedEvents?.length)) {
    issues.push('已确认史实未写入开局事件（seedEvents 为空）');
  }
  if (!(spec.scenario.rounds >= 2 && spec.scenario.rounds <= 6)) {
    issues.push(`轮数超出可玩区间：${spec.scenario.rounds}`);
  }
  const estimatedRate =
    facts.length === 0 ? 0 : facts.filter((f: Fact) => f.estimated).length / facts.length;
  return { ok: issues.length === 0, issues, estimatedRate };
}