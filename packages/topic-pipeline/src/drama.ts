/**
 * 构演司（docs/01 §4「四司分工 · 第二席」）：把考据结果变成可入局的剧本——cast 实体化、
 * 剧本/事件引自史实，轮数随题材厚度浮动。双实现：
 *  - 真实 LLM：给出同构 JSON，考据充分时人物/剧情更鲜活；
 *  - mock/离线：确定性启发（实体频次 → 角色、立场轮替保证对立、事实即事件）。
 * 考据为空（查无实体）时返回 undefined → 上层回落领域预设 cast（绝不硬造人物）。
 */
import type { ChatProvider } from '@sim/llm';
import type { TopicBrief, Fact, FillResult } from '@sim/contracts';
import type { Persona } from '@sim/engine-core';

export interface DramaDraft {
  cast: Persona[];
  rounds?: number;
  seedEvents?: string[];
  background?: string;
  conflict?: string;
  decisionPoint?: string;
  successCriteria?: string;
}

// ---------- mock 确定性启发（与话题无关的语言学信号） ----------

/** FNV-1a：同一个人物永远得到同一套数值（可复现） */
function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 内容极性：进取词加分、持守词减分 → “进取/稳守/权衡” 三类立场（保证阵营对立） */
const PUSH = ['北伐', '出师', '征', '讨', '战', '破', '献策', '兵进', '变革', '变法', '开拓', '出手', '出征', '进占', '主战', '自强', '翻案'];
const HOLD = ['守', '固', '稳', '旧', '祖', '止', '退', '和谈', '收缩', '防御', '持重', '因循', '维持', '保守', '停', '观望'];

function stanceOf(text: string): string {
  const push = PUSH.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  const hold = HOLD.reduce((n, w) => n + (text.includes(w) ? 1 : 0), 0);
  if (push > hold) return '进取';
  if (hold > push) return '稳守';
  return '协商';
}

/** 从人物的相关 claim 里取职务/称谓（无则“当事方”） */
function roleHint(entity: string, claims: string[]): string {
  for (const c of claims) {
    const idx = c.indexOf(entity);
    if (idx < 0) continue;
    const tail = c.slice(idx + entity.length, idx + entity.length + 30).split(/[，。、；]/)[0].trim();
    if (tail.length >= 2 && tail.length <= 24) return tail;
  }
  return '当事方';
}

/** 概念实体（法/谷/伐/镇/案/乱/饷/使/军 等结尾）不算人物，不进 cast —— 语言学术语，非题材特判 */
const NON_PERSON_TAIL = /(之变|之难|之乱|之祸|乱|变|战|役|法|制|镇|案|策|论|学|盟|约|库|税|饷|朝|代|纪|历|史|谷|伐|坡|山|碑|标|新|使|军|国)$/;

/** 供考据司在「检索池」层也做人物优先排序（实体名天然可当人名者先入池） */
export function isPersonName(name: string): boolean {
  if (name.length < 2 || name.length > 6) return false;
  if (NON_PERSON_TAIL.test(name)) return false;
  return true;
}

function oppositeOf(s: string): string {
  return s === '进取' ? '稳守' : s === '稳守' ? '进取' : '稳守';
}

function dramaFromFacts(brief: TopicBrief, fill: FillResult): DramaDraft | undefined {
  const facts = fill.facts;
  const entities = new Map<string, Fact[]>();
  for (const f of facts) {
    const e = (f.entity ?? '').trim();
    if (!e || e === brief.title.trim() || !isPersonName(e)) continue;
    if (!entities.has(e)) entities.set(e, []);
    entities.get(e)!.push(f);
  }
  const top = [...entities.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 4);
  if (top.length < 2) {
    // 无人物考据但已有确认史实 → 仍成局：情境式剧本（cast 留空 → 上层用默认阵容，
    // 背景/开局事件全部引自史实，绝不硬造人名）
    const solid = facts.filter((f) => !f.estimated);
    if (solid.length < 1) return undefined;
    return {
      cast: [],
      rounds: Math.min(5, Math.max(3, 2 + Math.floor(solid.length / 3))),
      seedEvents: solid.slice(0, 4).map((f) => f.claim + (f.url ? `〔${f.url}〕` : '')),
      background: solid.slice(0, 3).map((f) => f.claim).join('；'),
      conflict: `${brief.asks[0] ?? brief.title}——当事各方立场未定，需你在史料约束下裁决。`,
      decisionPoint: '你作为统筹者，最终下达怎样的决断？',
      successCriteria: '让局面在史料约束内走向可接受的平衡。',
    };
  }

  const cast: Persona[] = [];
  for (const [i, [name, fxs]] of top.entries()) {
    const claims = fxs.map((f) => f.claim);
    const blob = claims.join(' ');
    // 首角立场取自素材极性；p1+ 一律与 p0 对立（素材同向也强行对立），保证至少两类立场
    const stance = i === 0 ? stanceOf(blob) : oppositeOf(cast[0].stance);
    const rnd = seeded(hashText(name));
    cast.push({
      id: `p${i}`,
      name,
      role: roleHint(name, claims),
      stance,
      influence: Math.round(50 + rnd() * 45),
      description: claims.slice(0, 2).join('；'),
      prompt:
        `你是${name}（${roleHint(name, claims)}），立场${stance}。` +
        `你的依据：${claims.slice(0, 2).join('；')}` +
        (claims.length > 2 ? `；另有:${claims[2]}` : '') +
        '。发言符合身份与立场，引用已知史实，不额外编造。',
      traits: {
        competence: Math.round(60 + rnd() * 30),
        loyalty: stance === '稳守' ? Math.round(65 + rnd() * 25) : Math.round(45 + rnd() * 35),
        ambition: stance === '进取' ? Math.round(65 + rnd() * 25) : Math.round(40 + rnd() * 30),
        power: Math.round(50 + rnd() * 35),
      },
    });
  }

  const solid = facts.filter((f) => !f.estimated);
  const rounds = Math.min(5, Math.max(3, 2 + Math.floor(solid.length / 3)));
  const seedEvents = solid.slice(0, 4).map((f) => f.claim + (f.url ? `〔${f.url}〕` : ''));

  return {
    cast,
    rounds,
    seedEvents,
    background: solid.slice(0, 3).map((f) => f.claim).join('；'),
    conflict: `${brief.asks[0] ?? brief.title}——${cast[0].name}主张${
      cast[0].stance}，${cast[1].name}主张${cast[1].stance}，另有${cast.length > 2 ? cast[2].name : '第三方'}插言。`,
    decisionPoint: `你作为统筹者，最终下达怎样的决断？`,
    successCriteria: `盘活朝局：${cast.map((c) => c.stance).join('、')}三方至少稳住一方、别让全盘崩落。`,
  };
}

// ---------- LLM 构演（真实 key 分支，输出契约与 mock 同 schema，失败回落） ----------

const DRAMA_PROMPT = [
  '你是历史推演引擎的「构演司」：把考据出的史实/开题设计成一局可推演的剧本。只输出 JSON（不要代码块）：',
  '{"cast":[{"name":"人名","role":"职务/身份","stance":"进取或稳守或协商","influence":0-100,"description":"典实简介","traits":{"competence":0-100,"loyalty":0-100,"ambition":0-100,"power":0-100}}],"rounds":3,"seedEvents":["事件1","事件2"],"background":"背景（罗列考据）","conflict":"核心矛盾","decisionPoint":"玩家最终裁决","successCriteria":"通关标准"}',
  '要求：cast 2~4 人且 stance 必须出现对立；一切人物与事件只能来自考据或你说的「（推演）」——无考据凭空处不可硬编人名。',
  '玩家提示词是最高指令：它可指向任意年代与地区（含「数十年后」的人物换代），可指定/更换/增删任意人物与阵营——',
  '照玩家给的名单来，不套任何固定阵容；玩家没提的部分才按考据补齐。',
].join('\n');

export async function composeDrama(
  brief: TopicBrief,
  fill: FillResult,
  chat: ChatProvider,
): Promise<DramaDraft | undefined> {
  // 真实 key：让 LLM 基于考据写剧本（同 schema）
  if (chat.isReal()) {
    try {
      const raw = await chat.generate(
        [
          {
            role: 'user',
            content:
              DRAMA_PROMPT +
              `\n\n考据：\n${fill.facts.map((f, i) => `${i + 1}. ${f.claim}${f.url ? `〔${f.url}〕` : ''}`).join('\n') || '（无命中考据，需自行按常识注明「（推演）」）'}` +
              `\n\n话题：${brief.title}\n原文：${brief.body.slice(0, 1500)}\n存疑句：${brief.asks[0] ?? ''}`,
          },
        ],
        { jsonMode: true },
      );
      const j = JSON.parse(raw) as DramaDraft & {
        seedPoints?: string[];
      };
      if (j?.cast?.length >= 2) return normalizeDraft(j);
    } catch {
      /* JSON 不合规 → mock 启发式 */
    }
  }
  return dramaFromFacts(brief, fill);
}

function normalizeDraft(j: DramaDraft & { seedPoints?: string[] }): DramaDraft {
  const cast: Persona[] = (j.cast ?? []).map((c, i) => ({
    ...c,
    id: `p${i + 1}`,
    description: c.description ?? '',
    traits: c.traits ?? { competence: 60, loyalty: 60, ambition: 50, power: 50 },
  }));
  return {
    cast,
    rounds: Math.min(5, Math.max(3, Number(j.rounds) || 3)),
    seedEvents: Array.isArray(j.seedEvents) ? j.seedEvents : (j.seedPoints ?? []),
    background: j.background ?? '',
    conflict: j.conflict ?? '',
    decisionPoint: j.decisionPoint ?? '你最终做出怎样的决断？',
    successCriteria: j.successCriteria ?? '局面维持可持续的平衡',
  };
}