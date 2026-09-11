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

/**
 * 从 claim 中提取职务/称谓，优先匹配已知官职模式，其次匹配实体名自带后缀。
 * 避免把”诸葛亮北伐最多同时对付一个方向”错误地解析为 role=”北伐最多同时对付一个方向”。
 */
const TITLE_PATTERNS = [
  /官至\s*(.{2,8})/,           // 官至丞相 / 官至前将军
  /拜\s*(.{2,8})/,             // 拜中护军 / 拜相
  /封\s*(.{2,8})侯/,          // 封南郑侯 / 封武乡侯
  /任\s*(.{2,8})/,             // 任尚书令 / 任司空
  /为\s*(.{2,6})丞相/,        // 为诸葛亮所重 → 跳过
  /谥?\s*(.{2,6})?/,
  // 常见官职关键词（按长度排序，长的优先）
] as const;

/** 已知官职/称谓词表：出现即直接采用 */
const KNOWN_TITLES = [
  '丞相','大将军','司空','司徒','太尉','尚书令','中书令','尚书仆射',
  '前将军','后将军','左将军','右将军','征西将军','镇西将军','骠骑将军',
  '州牧','郡守','县令','都督','长史','司马','从事','校尉','都护',
  '司徒','太傅','太保','大司马','大司空',
  '内侍','太监','司礼','宦官','郎中','侍郎',
  '皇帝','天子','陛下','诸侯王','藩王',
  '丞相府长史','丞相参军','军师将军','益州刺史',
];

function roleHint(entity: string, claims: string[]): string {
  // 1. 优先扫描所有 claim，找已知官职词
  for (const c of claims) {
    for (const title of KNOWN_TITLES) {
      if (c.includes(title)) return title;
    }
    // 2. 匹配”官至X” / “拜X” / “封X侯”等结构
    const m1 = c.match(/官至\s*(.{2,8})/);
    if (m1 && m1[1].length >= 2 && m1[1].length <= 8) return m1[1];
    const m2 = c.match(/拜\s*(.{2,8})/);
    if (m2 && m2[1].length >= 2 && m2[1].length <= 8) return m2[1];
    const m3 = c.match(/封\s*(.{2,6})侯/);
    if (m3) return m3[1] + '侯';
  }
  // 3. 回退：检查实体名本身是否已含称谓（如”曹魏”→”魏主”/”曹魏”视为势力名）
  const lower = entity.toLowerCase();
  if (/诸葛亮|诸葛/.test(lower)) return '丞相';
  if (/魏延/.test(lower)) return '前将军';
  if (/费祎|费诗/.test(lower)) return '尚书令';
  if (/姜维/.test(lower)) return '卫将军';
  if (/司马懿|仲达/.test(lower)) return '太尉';
  if (/曹操|孟德/.test(lower)) return '丞相';
  if (/刘备|玄德/.test(lower)) return '昭烈帝';
  if (/孙权|仲谋/.test(lower)) return '吴主';
  if (/崇祯|思宗/.test(lower)) return '皇帝';
  if (/司马光/.test(lower)) return '宰相';
  if (/王安石/.test(lower)) return '宰相';
  if (/安禄山/.test(lower)) return '节度使';
  if (/郭子仪/.test(lower)) return '元帅';
  if (/诸葛亮/.test(lower)) return '丞相';
  // 4. 最后回退到”当事方”
  return '当事方';
}

/** 概念实体（法/谷/伐/镇/案/乱/饷/使/军 等结尾）不算人物，不进 cast —— 语言学术语，非题材特判 */
const NON_PERSON_TAIL = /(之变|之难|之乱|之祸|末|初|际|乱|变|战|役|法|制|镇|案|策|论|学|盟|约|库|税|饷|朝|代|纪|历|史|谷|伐|坡|山|碑|标|新|使|军|国)$/;

/** 供考据司在「检索池」层也做人物优先排序（实体名天然可当人名者先入池） */
export function isPersonName(name: string): boolean {
  if (name.length < 2 || name.length > 6) return false;
  if (NON_PERSON_TAIL.test(name)) return false;
  return true;
}

function oppositeOf(s: string): string {
  return s === '进取' ? '稳守' : s === '稳守' ? '进取' : '稳守';
}

/**
 * 话题中的角色关键词识别：检测玩家可能扮演的角色。
 * 如”户部尚书””AI助手””穿越者””皇帝””将军”等。
 */
const ROLE_KEYWORDS: Array<{ pattern: RegExp; role: string; stance: string; desc: string; prompt: string }> = [
  { pattern: /户部|财政部|财政|钱粮|国库|钱粮/, role: '户部尚书', stance: '稳健', desc: '掌管国家财政，盯着国库空虚发愁。', prompt: '你是户部尚书，掌管朝廷财政。你的立场是稳健——深知国库空虚，任何开支都要精打细算。说话引经据典，列举数据。' },
  { pattern: /兵部|将领|元帅|都督|武将|军师/, role: '兵部尚书', stance: '进取', desc: '手握兵权，主张以战止战。', prompt: '你是兵部尚书或一线将领，手握重兵。你的立场是进取——认为唯有主动出击才能保住江山。说话干脆利落，不谈虚的。' },
  { pattern: /AI|人工智能|穿越|系统|助手|未来/, role: '穿越者', stance: '协商', desc: '来自未来的异乡人，带着现代知识却无处施展。', prompt: '你是一个来自现代的AI助手，意外穿越到这个时代。你的立场是协商——既看到问题所在，又受制于身份。说话时常引用现代概念作比喻。' },
  { pattern: /皇帝|天子|陛下|万岁|圣上/, role: '皇帝', stance: '进取', desc: '九五之尊，却困于危局。', prompt: '你是当朝皇帝，身处危局但仍有决策权。你的立场是进取——渴望力挽狂澜、中兴社稷。说话有帝王气度，但难掩焦灼。' },
  { pattern: /农民|流寇|起义|叛军|造反/, role: '起义领袖', stance: '进取', desc: '揭竿而起，与朝廷为敌。', prompt: '你是起义军领袖，聚众几十万与朝廷对抗。你的立场是进取——不破不立。说话粗犷直接，充满草根智慧。' },
  { pattern: /内阁|首辅|宰相|丞相|大学士/, role: '内阁首辅', stance: '协商', desc: '百官之首，周旋于各方之间。', prompt: '你是内阁首辅，百官之首却处处受制。你的立场是协商——想做事但必须平衡各方势力。说话圆滑但有底线。' },
  { pattern: /太监|宦官|内侍|司礼/, role: '司礼太监', stance: '稳守', desc: '皇帝近侍，掌握信息渠道。', prompt: '你是司礼监太监，虽无品级却权势滔天。你的立场是稳守——不想时局生变影响自己的地位。说话阴阳怪气，点到为止。' },
];

function detectPlayerRole(topic: string): { role: string; stance: string; desc: string; prompt: string } | null {
  for (const kw of ROLE_KEYWORDS) {
    if (kw.pattern.test(topic)) {
      return { role: kw.role, stance: kw.stance, desc: kw.desc, prompt: kw.prompt };
    }
  }
  return null;
}

function buildPlayerPersona(topic: string, hashSeed: number): Persona {
  const detected = detectPlayerRole(topic);
  if (!detected) {
    // 未识别到具体角色，生成一个通用的”谋士”角色
    const rnd = seeded(hashSeed);
    return {
      id: 'player',
      name: '玩家',
      role: '谋士',
      stance: '协商',
      influence: Math.round(45 + rnd() * 20),
      description: '旁听各方辩论，为主上出谋划策。',
      prompt: '你是主上的谋士，观察各方辩论，适时提出建议。立场是协商——不偏不倚，力求周全。',
      traits: { competence: Math.round(60 + rnd() * 25), loyalty: Math.round(70 + rnd() * 20), ambition: Math.round(30 + rnd() * 30), power: Math.round(40 + rnd() * 20) },
    };
  }
  const rnd = seeded(hashSeed);
  return {
    id: 'player',
    name: detected.role,
    role: detected.role,
    stance: detected.stance,
    influence: Math.round(55 + rnd() * 30),
    description: detected.desc,
    prompt: detected.prompt,
    traits: {
      competence: Math.round(60 + rnd() * 30),
      loyalty: Math.round(60 + rnd() * 30),
      ambition: Math.round(40 + rnd() * 30),
      power: Math.round(50 + rnd() * 30),
    },
  };
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

  // 检测玩家角色并注入 cast
  const playerRole = detectPlayerRole(brief.title + ' ' + (brief.body ?? ''));

  if (top.length < 2) {
    // 单人/少人考据时：从该人物的史实中推演出对立立场，避免空 cast
    if (top.length >= 1) {
      const [name, fxs] = top[0]!;
      const claims = fxs.map((f) => f.claim);
      const role = roleHint(name, claims);
      const rnd = seeded(hashText(name + ':pair'));
      // 进取派：基于该人物历史上主动出击的史实
      const advPersona: Persona = {
        id: 'p0', name, role, stance: '进取',
        influence: Math.round(60 + rnd() * 30),
        description: claims.slice(0, 2).join('；'),
        prompt:
          `你是${name}（${role}），立场进取。` +
          `你的依据：${claims.slice(0, 2).join('；')}` +
          (claims.length > 2 ? `；另有:${claims[2]}` : '') +
          '。发言符合身份与立场，引用已知史实，不额外编造。',
        traits: {
          competence: Math.round(60 + rnd() * 30),
          loyalty: Math.round(60 + rnd() * 30),
          ambition: Math.round(65 + rnd() * 25),
          power: Math.round(50 + rnd() * 35),
        },
      };
      // 稳守派：同一人物在稳守视角下的演绎
      const hedgePersona: Persona = {
        id: 'p1',
        name: name + '（稳守派）',
        role,
        stance: '稳守',
        influence: Math.round(50 + rnd() * 30),
        description: claims.slice(0, 1).join('；'),
        prompt:
          `你是${name}（${role}），立场稳守。` +
          `你的依据：${claims.slice(0, 2).join('；')}` +
          (claims.length > 2 ? `；另有:${claims[2]}` : '') +
          '。发言符合身份与立场，引用已知史实，不额外编造。',
        traits: {
          competence: Math.round(60 + rnd() * 30),
          loyalty: Math.round(65 + rnd() * 25),
          ambition: Math.round(40 + rnd() * 25),
          power: Math.round(50 + rnd() * 35),
        },
      };
      const solid = facts.filter((f) => !f.estimated);
      return {
        cast: [advPersona, hedgePersona],
        rounds: Math.min(5, Math.max(3, 2 + Math.floor(solid.length / 3))),
        seedEvents: solid.slice(0, 4).map((f) => f.claim + (f.url ? `〔${f.url}〕` : '')),
        background: solid.slice(0, 3).map((f) => f.claim).join('；'),
        conflict: `${brief.title}——${name}主张进取，${name}（稳守派）主张持重，各方各执己见。`,
        decisionPoint: `你作为统筹者，最终下达怎样的决断？`,
        successCriteria: '让朝局在史料约束内走向可接受的平衡。',
      };
    }
    // 无任何人物考据 → 情境式剧本
    const solid = facts.filter((f) => !f.estimated);
    if (solid.length < 1) return undefined;
    const rounds = Math.min(5, Math.max(3, 2 + Math.floor(solid.length / 3)));
    const cast: Persona[] = playerRole
      ? [buildPlayerPersona(brief.title, hashText('player'))]
      : [];
    return {
      cast,
      rounds,
      seedEvents: solid.slice(0, 4).map((f) => f.claim + (f.url ? `〔${f.url}〕` : '')),
      background: solid.slice(0, 3).map((f) => f.claim).join('；'),
      conflict: playerRole
        ? `${brief.asks[0] ?? brief.title}——${playerRole.role}置身其中，需你在史料约束下做出决断。`
        : `${brief.asks[0] ?? brief.title}——当事各方立场未定，需你在史料约束下裁决。`,
      decisionPoint: playerRole
        ? `你作为${playerRole.role}，最终做出怎样的抉择？`
        : '你作为统筹者，最终下达怎样的决断？',
      successCriteria: '让朝局在史料约束内走向可接受的平衡。',
    };
  }

  const cast: Persona[] = [];
  for (const [i, [name, fxs]] of top.entries()) {
    const claims = fxs.map((f) => f.claim);
    const blob = claims.join(' ');
    const stance = i === 0 ? stanceOf(blob) : oppositeOf(cast[0]?.stance ?? '进取');
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

  // 注入玩家角色到 cast 末尾
  if (playerRole) {
    const playerP = buildPlayerPersona(brief.title, hashText('player') + top.length);
    cast.push(playerP);
  }

  const solid = facts.filter((f) => !f.estimated);
  const rounds = Math.min(5, Math.max(3, 2 + Math.floor(solid.length / 3)));
  const seedEvents = solid.slice(0, 4).map((f) => f.claim + (f.url ? `〔${f.url}〕` : ''));

  const playerDesc = playerRole ? `，${playerRole.role}亦在其中` : '';
  return {
    cast,
    rounds,
    seedEvents,
    background: solid.slice(0, 3).map((f) => f.claim).join('；'),
    conflict: `${brief.asks[0] ?? brief.title}——${cast[0].name}主张${cast[0].stance}，${cast[1]?.name ?? '另一方'}主张${cast[1]?.stance ?? '对立'}${playerDesc}，各方各执己见。`,
    decisionPoint: playerRole
      ? `你作为${playerRole.role}，最终做出怎样的抉择？`
      : '你作为统筹者，最终下达怎样的决断？',
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