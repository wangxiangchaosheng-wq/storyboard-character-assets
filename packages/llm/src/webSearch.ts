/**
 * 网络搜索 provider（docs/06 §4）。
 * 统一抽象：search(query) → Fact[]。
 * 三种实现：
 *   - WebSearchProvider  ：真实 LLM 模式下通过 safeFetch 查询搜索引擎
 *   - MockSearchProvider ：离线模式，基于 topic 关键词返回确定性模拟结果
 *   - EmptySearchProvider：无任何搜索能力（缺省）
 */
import type { Fact } from '@sim/contracts';

export interface SearchProvider {
  isReal(): boolean;
  /** 搜索 query，返回相关事实条目。搜索失败不抛错，返回空数组。 */
  search(query: string): Promise<Fact[]>;
}

// ──────────────────────────────────────────────
// 空搜索 provider（缺省）
// ──────────────────────────────────────────────
export class EmptySearchProvider implements SearchProvider {
  readonly name = 'empty';
  isReal(): boolean { return false; }
  async search(_query: string): Promise<Fact[]> { return []; }
}

// ──────────────────────────────────────────────
// Mock 搜索：基于 topic 关键词返回确定性"模拟"结果
// ──────────────────────────────────────────────
const MOCK_FACTS_POOL: Array<{ keywords: RegExp; facts: Array<{ claim: string; entity: string; estimated?: boolean }> }> = [
  {
    keywords: /三国|蜀|魏|吴|诸葛|周瑜|曹操|刘备|关羽|张飞|荆州|赤壁/,
    facts: [
      { claim: '蜀汉巅峰时期兵力约10万人，常年维持在8-12万之间。', entity: '蜀汉', estimated: true },
      { claim: '曹魏鼎盛期兵力约60-80万，但分散在各大军区。', entity: '曹魏', estimated: true },
      { claim: '孙吴兵力约20-30万，主要守江淮和荆州。', entity: '孙吴', estimated: true },
      { claim: '两线作战需要兵力达到对手单线的1.5倍以上才可能成功。', entity: '军事', estimated: true },
      { claim: '蜀汉国力最弱，长期处于防守态势，主动两线进攻极为困难。', entity: '蜀汉', estimated: true },
      { claim: '诸葛亮北伐最多同时对付一个方向，从未敢两线开战。', entity: '诸葛亮', estimated: false },
    ],
  },
  {
    keywords: /崇祯|明.*末|李自成|农民|起义|国库|军饷|边患|后金|清/,
    facts: [
      { claim: '明末国库岁入约300万两白银，常年入不敷出。', entity: '明财政', estimated: true },
      { claim: '明末军费开支占财政支出70%以上，兵饷常常拖欠。', entity: '明军', estimated: true },
      { claim: '李自成1644年率军约20-30万攻入北京。', entity: '李自成', estimated: true },
      { claim: '明朝同时面临关外清军和内部农民军两个方向，两线作战拖垮财政。', entity: '明末', estimated: false },
      { claim: '崇祯年间加派辽饷、剿饷、练饷三饷，加重百姓负担引发更多起义。', entity: '明政', estimated: false },
    ],
  },
  {
    keywords: /融资|创业|公司|估值|现金流|团队|商业/,
    facts: [
      { claim: 'B轮融资通常估值在1-10亿美元区间，取决于行业增速。', entity: '融资', estimated: true },
      { claim: '现金流断裂是创业公司第一死亡原因，runway < 6月需紧急应对。', entity: '创业', estimated: true },
      { claim: '战略投资人往往要求董事会席位和对赌条款，影响公司控制权。', entity: '投资人', estimated: false },
      { claim: '过度稀释股权（>30%）会导致创始团队失去控制权。', entity: '股权', estimated: true },
    ],
  },
];

function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) { h ^= s.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

export class MockSearchProvider implements SearchProvider {
  readonly name = 'mock-search';
  isReal(): boolean { return false; }

  async search(query: string): Promise<Fact[]> {
    const matched = MOCK_FACTS_POOL.filter((pool) => pool.keywords.test(query));
    if (matched.length === 0) return [];
    const h = hashText(query);
    const allFacts = matched.flatMap((p) => p.facts);
    const selected = allFacts.filter((_, i) => (h + i * 7) % 3 !== 0);
    return selected.slice(0, 5).map((f, i) => ({
      id: 'm' + i, claim: f.claim, entity: f.entity,
      source: 'search', estimated: f.estimated ?? false,
      confidence: f.estimated ? 0.5 : 0.9,
    }));
  }
}

// ──────────────────────────────────────────────
// 真实 web 搜索（预留接口）
// 需要配置 SEARCH_API_KEY 后启用；当前返回空数组不影响 mock 流程
// ──────────────────────────────────────────────
export class WebSearchProvider implements SearchProvider {
  readonly name = 'web-search';
  isReal(): boolean { return process.env.SEARCH_API_KEY !== undefined; }

  async search(_query: string): Promise<Fact[]> {
    // 预留：接入 Bing/SerpAPI 等搜索引擎
    // 当前未配置 SEARCH_API_KEY 时 isReal() 返回 false，调用方会降级到 mock
    return [];
  }
}
