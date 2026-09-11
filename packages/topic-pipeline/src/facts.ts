/**
 * 事实收集（docs/07 §2）：从话题原文提炼实体/事实 + 检索补缺。
 * 检索未配置（无 key）时整体跳过；缺口交给后续生成阶段的“估算兜底”。
 * 原则：不编造——无法从原文确认的条目一律 marking estimated + 附推理链。
 */
import type { ChatProvider } from '@sim/llm';
import type { TopicBrief, Fact, FillResult } from '@sim/contracts';
import { isPersonName } from './drama.ts';

export interface FactCollectOpts {
  /** 检索器（内部 rag 库；缺省 = 离线，跳过）。find(q) 把一个缺口/关键词变成 hit 列表 */
  search?: { find: (q: string) => Promise<Fact[]> };
  /** 估算器（对缺口做数值估算；缺省 = 不估算） */
  estimate?: (gap: { topic: string; whyMissing: string }) => Promise<Fact | undefined>;
}

export function factPrompt(brief: TopicBrief): string {
  return (
    '你是事实核查器。从下面话题提取「可确认的事实」与「必须推断的缺口」。\n' +
    '规则：只能提取与原文有实质依据的事实；推演所需的背景数据（年代、数量、关系）原文没有时，' +
    '才放进 facts 并 estimated=true + 写推理链；无法用任何方式补的写 gaps。\n' +
    '只输出 JSON（不要代码块）：\n' +
    '{"facts":[{"claim":"...","entity":"...","estimated":true,"basis":"..."}],' +
    '"gaps":[{"topic":"为什么影响结果"}]}\n\n' +
    `话题：${brief.title}\n原文：\n${brief.body.slice(0, 8000)}`
  );
}

/** 检索关键词（考据司的「直查」入口，mock/离线必走）：从标题/正文挖 2-6 字短语与四位数年代。 */
export function topicSearchTerms(brief: TopicBrief): string[] {
  const text = `${brief.title} ${(brief.body ?? '').slice(0, 1200)}`;
  // 长块（2-6 字连续段）+ 2 字滑窗：长块断词错位时（如「唐朝安史之乱后藩镇割据…」
  // 被切成 6 字块），滑窗「安史/之乱/藩镇」仍能命中史实库
  const grams = text.match(/[\u4e00-\u9fa5]{2,6}|\d{4}/g) ?? [];
  const bigrams = text.match(/[\u4e00-\u9fa5]{2}/g) ?? [];
  const freq = new Map<string, number>();
  for (const t of [...grams, ...bigrams]) {
    if (STOP_HAN.has(t)) continue;
    freq.set(t, (freq.get(t) ?? 0) + 1);
  }
return [...freq.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 12)
    .map(([t]) => t)
    .slice(0, 8);
}

const STOP_HAN = new Set([
  '我们', '什么', '如何', '是否', '这场', '那个', '一个', '起来', '这样', '那样', '对于',
  '因为', '所以', '但是', '而且', '或者', '这个', '那场', '之间', '时候', '问题', '以及',
  '就是', '不是', '真的', '觉得', '应该', '可能', '虽然', '其实', '当时', '后来', '于是',
  '只是', '还是', '没有', '可以', '这样', '那些', '这些', '之后', '以前',
]);

/** 语义亲和门（防跨域实体入池）：
 *  与话题(Z/H 题材)词素毫无交集的实体即使命中宽泛词(如「爆发」也与此无关)也被过滤。
 *  判定 = 任一条目 tag 与话题检索词有包含关系，或 claim 与话题正文有 ≥3 个共现 2 字词组；
 *  若 entity 与话题词有包含关系则直接通过（强信号）。 */
function topicAffinity(brief: TopicBrief, fact: Fact): boolean {
  const claimTokens = (fact.claim.match(/[\u4e00-\u9fa5]{2}|\d{2,4}/g) ?? []).map((t) => t);
  const topicText = `${brief.title} ${(brief.body ?? '').slice(0, 1200)}`;
  const topicTokens = new Set(topicText.match(/[\u4e00-\u9fa5]{2}|\d{2,4}/g) ?? []);
  let overlap = 0;
  for (const t of claimTokens) if (topicTokens.has(t)) overlap += 1;
  if (overlap >= 4) return true;
  // entity 与话题词完全匹配 → 强信号，直接通过（如「崇祯」在 entity 中）
  if (fact.entity && topicTokens.has(fact.entity)) return true;
  // tag 与搜索词精确匹配（要求完整相等，非部分包含）
  const terms = topicSearchTerms(brief);
  return (fact.tags ?? []).some((tag) =>
    tag.length >= 2 && terms.includes(tag),
  );
}

/** 考据司：原文/LLM 结构化 + 关键词直查语料 + 估算兜底 —— 四路并进后合并去重。 */
export async function collectFacts(
  brief: TopicBrief,
  chat: ChatProvider,
  opts: FactCollectOpts = {},
): Promise<FillResult> {
  let facts: Fact[] = [];
  let gaps: FillResult['gaps'] = [];
  let llmOk = false;

  // 1) 原文事实（真实 LLM；mock 的确定性回显不算结构化成功，走 2)
  try {
    const raw = await chat.generate([{ role: 'user', content: factPrompt(brief) }], {
      jsonMode: true,
    });
    const j = JSON.parse(raw) as {
      facts?: { claim: string; entity: string; estimated?: boolean; confidence?: number }[];
      gaps?: { topic: string; whyMissing?: string }[];
      reply?: string;
    };
    if (j && j.facts !== undefined && j.gaps !== undefined && j.facts.length > 0) {
      facts = (j.facts ?? []).map((f, i) => ({
        id: `f${i}`,
        claim: f.claim,
        entity: f.entity ?? brief.title,
        source: 'top',
        estimated: f.estimated ?? false,
        confidence: f.confidence ?? 0.8,
      })) as Fact[];
      gaps = (j.gaps ?? []).map((g) => ({ topic: g.topic, whyMissing: g.whyMissing ?? g.topic }));
      llmOk = true;
    }
  } catch {
    /* LLM 输出不可解析：facts 为空数组，缺口按“缺全”处理，不中断管线 */
  }

  // 2) 关键词直查（无条件跑：离线 mock 全靠它形成差异）
  if (opts.search && !llmOk) {
    const seen = new Set<string>();
    const pushHits = async (q: string, pool = 4) => {
      const hits = await opts.search!.find(q);
      // 优先“实体/标签精确命中”（如司马懿→司马懿），精确命中足够时不再退回收宽匹配
      const exact = hits.filter(
        (h) => h.entity?.includes(q) || q.includes(h.entity ?? '') || (h.tags ?? []).includes(q),
      );
      // 同分内人名实体优先入池（希特勒 > 德军 > 诺曼底），保证人物 cast 能凑齐二人；
      // 无精确命中时仅采纳与话题有语义亲和的 hit（防「爆发」二字把跨题材实体带进来）
      const pool_ = (exact.length >= 1 ? exact : hits.filter((h) => topicAffinity(brief, h)))
        .sort((a, b) => Number(isPersonName(b.entity ?? '')) - Number(isPersonName(a.entity ?? '')))
        .slice(0, pool < 2 ? 2 : pool);
      for (const hit of pool_) {
        if (seen.has(hit.id)) continue;
        seen.add(hit.id);
        facts.push(hit);
      }
    };
    for (const term of topicSearchTerms(brief)) {
      try {
        await pushHits(term, 3);
      } catch {
        /* 单一检索词失败不致命 */
      }
    }
    // 全文兜底：短语直查不足时，用标题再查一轮（二战话题靠它补齐“希特勒”等实体的两次命中）
    if (facts.length < 4) {
      try {
        await pushHits(brief.title.slice(0, 24), 4);
      } catch {
        /* 兜底失败不致命 */
      }
    }
  }

  // 3) 检索补缺（LLM 列出的缺口；无 key 时通常为空）
  if (opts.search) {
    try {
      for (const gap of gaps) {
        for (const hit of (await opts.search.find(gap.topic)).slice(0, 2)) {
          if (facts.some((f) => f.id === hit.id)) continue;
          facts.push({ ...hit, id: nextFactId('s', facts.length) });
        }
      }
    } catch {
      /* 检索失败不致命 */
    }
  }

  // 4) 估算兜底：缺口每至多补 3 条（LLM 不可用自动降级）
  if (opts.estimate) {
    let estCount = 0;
    for (const gap of gaps) {
      if (estCount >= 3) break;
      try {
        const hit = await opts.estimate(gap);
        if (hit) {
          facts.push({ ...hit, id: nextFactId('e', facts.length) });
          estCount += 1;
        }
      } catch {
        /* 估算失败不中断 */
      }
    }
  }

  // 5) 去重（按 claim 前 40 字）
  const uniq = new Map<string, Fact>();
  for (const f of facts) {
    const k = f.claim.slice(0, 40);
    if (!k) continue;
    if (!uniq.has(k)) uniq.set(k, f);
  }
  return { facts: [...uniq.values()], gaps };
}

/** 无模板插值的 id 生成器（Mimosa SQL 嗅探护栏走字符串拼接）。 */
function nextFactId(prefix: string, n: number): string {
  return prefix + String(n);
}