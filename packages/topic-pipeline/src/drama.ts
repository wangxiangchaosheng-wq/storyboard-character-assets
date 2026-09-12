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

/** 来自 integrations/shijing-website 的现成人物素材库。
 *  名称 → avatar 路径（前端 /art/<name>-avatar.webp）。
 *  仅覆盖已知人物；不在列表中的角色回退到 SVG 首字头。 */
const CHAR_IMAGE: Record<string, string> = {
  '诸葛亮': '/art/zhuge-avatar.webp',
  '魏延': '/art/weiyan-avatar.webp',
  '杨仪': '/art/yangyi-avatar.webp',
  '姜维': '/art/jiangwei-avatar.webp',
  '费祎': '/art/feiyi-avatar.webp',
};

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
        image: CHAR_IMAGE[name],
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
        rounds: Math.min(10, Math.max(5, 2 + Math.floor(solid.length / 3))),
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
      image: CHAR_IMAGE[name],
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
  '{"cast":[{"name":"人名","role":"职务/身份","stance":"进取或稳守或协商","influence":0-100,"description":"典实简介","prompt":"私有人设指令（包含该角色知道什么秘密、想达到什么目的、如何对待其他角色）","traits":{"competence":0-100,"loyalty":0-100,"ambition":0-100,"power":0-100}}],"rounds":8,"seedEvents":["事件1","事件2"],"background":"背景","conflict":"核心矛盾","decisionPoint":"玩家最终裁决","successCriteria":"通关标准"}',
  '要求：',
  '1) cast 6~8 人（人多才有戏！覆盖朝廷各方势力：皇帝、后妃、满洲重臣、汉臣、旗人贵族、太监等）；',
  '2) stance 必须多样化：至少 2 个"进取"、2 个"稳守"、1~2 个"协商"，立场对立越明显越好；',
  '3) 必须包含 brief.title/body 中出现的所有具体人名（如"洪承畴""康熙帝"等），不得遗漏；',
  '4) 其余人物从该朝代的史实中选取代表性人物，可注明「（推演）」表示架空补充；',
  '5) 每个角色要有鲜明的人设和利益诉求，不能千人一面——进取方要激进、稳守方要保守、协商方要圆滑；',
  '6) 一切人物与事件只能来自考据或你说的「（推演）」——无考据凭空处不可硬编人名。',
  '【关键剧情设计】brief.body中描述的架空前提，必须在cast的description和prompt中体现，并作为剧情核心张力：',
  '- 如果body提到"秘密身份"/"隐藏身份"/"私生子"等，必须让知道这个秘密的角色（如孝庄、皇帝本人）在prompt中写明他们知道什么、打算怎么做；',
  '- 其他角色可能怀疑、猜测或利用这个秘密，形成暗线冲突；',
  '- background字段要直接点出这个秘密对朝局的影响；',
  '- conflict字段要用一句话概括这个秘密带来的核心矛盾。',
  '【强制约束】brief.title 和 brief.body 中出现的所有人名、朝代名、地名、年号等专有名词，',
  '必须原样保留，禁止替换、改写、谐音、乱码生成。禁止把"洪承畴"写成"洪承"，禁止把"康熙帝"写成"康熙"。',
].join('\n');

/** 过滤LLM偶尔返回的身份/元数据JSON（如{"name":"Agnes",...}），不是有效剧本 */
function isValidDramaJson(raw: string): boolean {
  try {
    const j = JSON.parse(raw);
    if (!j || typeof j !== 'object') return false;
    if (Array.isArray(j)) return false; // top-level array是错误格式
    // 必须是对象且有cast数组
    if (!Array.isArray(j.cast)) return false;
    if (j.cast.length < 2) return false;
    // 排除身份响应：只有name+developer/role等元字段，没有stance/role/influence
    const firstCast = j.cast[0];
    if (!firstCast || typeof firstCast !== 'object') return false;
    if (!firstCast.stance || !firstCast.role || !firstCast.influence) return false;
    return true;
  } catch {
    return false;
  }
}

export async function composeDrama(
  brief: TopicBrief,
  fill: FillResult,
  chat: ChatProvider,
): Promise<DramaDraft | undefined> {
  // 真实 key：让 LLM 基于考据写剧本（同 schema）
  if (chat.isReal() && fill && fill.facts) {
    const factsText = fill.facts
      .map((f, i) => `${i + 1}. ${f.claim}${f.url ? `〔${f.url}〕` : ''}`)
      .join('\n') || '（无命中考据，需自行按常识注明「（推演）」）';
    const userContent =
      DRAMA_PROMPT +
      `\n\n考据：\n${factsText}` +
      `\n\n【话题标题】${brief.title}` +
      `\n\n【话题原文】${brief.body ?? ''}` +
      `\n\n【玩家问题】${(brief.asks ?? []).join('；') || '（无）'}` +
      `\n\n⚠️ 重要指令：上述「话题原文」是玩家设定的架空前提，不是历史事实。你必须基于该前提设计剧本，不得忽略或偏离。如果原文提到了具体人物（如"洪承畴""康熙帝"），cast 中必须包含这些人物。`;

    // 最多重试3次，用递增的 maxTokens 避免截断
    const MAX_RETRIES = 3;
    const TOKEN_SIZES = [6000, 8000, 10000];
    for (let attempt = 0; attempt < MAX_RETRIES; attempt++) {
      try {
        const raw = await chat.generate([{ role: 'user', content: userContent }], {
          jsonMode: true,
          maxTokens: TOKEN_SIZES[attempt],
          timeoutMs: 120_000,
        });
        if (!isValidDramaJson(raw)) {
          console.error(`[composeDrama] attempt ${attempt + 1}: invalid schema, raw:`, raw.slice(0, 150));
          continue;
        }
        const j = JSON.parse(raw) as DramaDraft & { seedPoints?: string[] };
        if (j?.cast?.length >= 2) return normalizeDraft(j, fill, brief.title);
        console.error('[composeDrama] cast不够2人:', j?.cast?.length, 'raw:', raw.slice(0, 200));
      } catch (e) {
        console.error(`[composeDrama] attempt ${attempt + 1} error:`, (e as Error).message?.slice(0, 150));
      }
    }
    console.error('[composeDrama] 所有重试均失败，回退到确定性生成');
  }
  return dramaFromFacts(brief, fill);
}

/** 从考据事实中提取已知人物名（比标题解析更可靠）——fact entity 是 LLM 已识别的人名 */
function extractKnownPersonNames(fill: FillResult, briefTitle?: string): string[] {
  const names = new Set<string>();
  for (const f of fill.facts ?? []) {
    if (!f.entity) continue;
    // entity 可能是多个名字用顿号/逗号分隔（如"洪承畴、康熙"）
    for (const part of f.entity.split(/[、,\s]+/)) {
      const p = part.trim();
      if (p.length >= 2 && p.length <= 6 && /^[\u4e00-\u9fa5]+$/.test(p)) {
        names.add(p);
      }
    }
  }
  // 若 fact entity 不足，退回到标题解析兜底
  if (names.size < 2 && briefTitle) {
    for (const n of extractKnownNames(briefTitle)) names.add(n);
  }
  return [...names].slice(0, 8);
}

/** 从标题提取可能的人名片段（用于检测截断）——只返回2-4字符的纯中文段 */
function extractKnownNames(title: string): string[] {
  // 策略：找所有连续2-4字符中文段，但只在明显是"姓+名"模式时保留
  const segments = title.split(/[：:，,,。！？;；、\s]+/).filter(Boolean);
  const results: string[] = [];
  const seen = new Set<string>();

  for (const seg of segments) {
    // 跳过明显不是人名的段（含标点、数字、英文）
    if (!/^[\u4e00-\u9fa5]+$/.test(seg)) continue;
    // 提取所有2-4字符子串
    for (let len = 2; len <= 4 && len <= seg.length; len++) {
      for (let i = 0; i <= seg.length - len; i++) {
        const sub = seg.slice(i, i + len);
        if (!seen.has(sub)) seen.add(sub);
      }
    }
  }

  // 过滤：必须是"看起来像人名"的模式
  // 规则：
  // 1. 不在stopWords里
  // 2. 不以"的""了""在""是""他""她""我""我们""他们"等开头
  // 3. 长度2-4
  const STOP_PREFIX = new Set(['的','了','在','是','他','她','我','我们','他们','这个','那个','一个','这样','那样','什么','哪里','何时','因为','所以','如果','虽然','但是','而且','可以','应该','需要','能够','可能','也许','大概','忽然','突然','终于','开始','接着','然后','后来','最后','首先','其次','再次','还有','以及','对于','根据','通过','经过','进行','正在','已经','必须','禁止','例如','不得','虚构','替代','原文','人物','朝代','地名','年号','专有','名词','原样','保留','话题','推演','设定','用户','玩家','你','该','某']);
  // 标准百家姓单字集合（排除"时/司/向/古"等假姓氏）
  const SURNAME_CHARS = new Set('赵钱孙李周吴郑王冯陈褚卫蒋沈韩杨朱秦尤许何吕施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭鲁韦昌马苗凤花方俞任袁柳酆鲍史唐廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐于施张孔曹严华金魏陶姜戚谢邹喻柏水窦章云苏潘葛奚范彭鲁韦昌马苗凤花方俞任袁柳酆鲍史唐廉岑薛雷贺倪汤滕殷罗毕郝邬安常乐'.split(''));
  // 额外补充常见姓氏单字（不在传统百家姓中但实际是姓的）
  new Set('傅皮卞齐康伍余元卜顾孟平黄和穆萧尹姚邵湛汪祁毛禹狄米贝明臧计伏成戴谈宋茅庞熊纪舒屈项祝董梁杜阮蓝闵席季麻强贾路娄危江童颜郭梅盛林刁钟徐邱骆高夏蔡田樊胡凌霍虞万支柯昝管卢莫经房裘缪干解应宗丁宣贲邓郁单杭洪包诸左石崔吉钮龚程嵇邢滑裴陆荣翁荀羊於惠甄曲家封芮羿储靳汲邴糜松井段富巫乌焦巴弓牧隗山谷车侯宓蓬全郗班仰秋仲伊宁仇栾暴甘钭厉戎祖武符刘景詹束龙叶幸司韶郜黎蓟溥印宿白怀蒲邰从鄂索咸籍赖卓蔺屠蒙池乔阴胥能苍双闻莘党翟谭贡劳逄姬申扶堵冉宰郦雍璩桑桂濮牛寿通边扈燕冀郏浦尚农温别庄晏柴瞿阎充慕连茹习宦艾鱼容向古易慎戈廖庾终暨居衡步都耿满弘匡国文寇广禄阙东欧殳沃利蔚越夔隆师巩厍聂晁勾敖融冷訾辛阚那简饶空殒锺商牟佘佴伯赏宫夙禄满束东关西百酒势告利叔季儒童朴仉督子车颛孙端木巫马公西漆雕乐正壤驷公良拓跋夹谷宰父榖梁'.split('')).forEach(c => SURNAME_CHARS.add(c));
  // 移除已知的假姓氏单字（这些在百家姓原文中是词组的一部分，不是独立姓氏）
  SURNAME_CHARS.delete('时');
  SURNAME_CHARS.delete('司');
  SURNAME_CHARS.delete('向');
  SURNAME_CHARS.delete('古');
  SURNAME_CHARS.delete('易');
  const filtered = [...seen].filter(w => {
    if (w.length < 2 || w.length > 4) return false;
    if (STOP_PREFIX.has(w.slice(0, 1))) return false;
    if (!SURNAME_CHARS.has(w[0])) return false;
    // 排除非人名片段（含"是""的""了"等虚词的长段）
    if (w.length >= 4 && /是|的|了|在|于|与|而|但|或|且|以|之|乎|者|也|兮|乎/.test(w)) return false;
    return true;
  });

  // 去重：若 final 中已有更长名字包含当前候选，则跳过候选（保留长名）
  const final: string[] = [];
  for (const f of filtered) {
    // skip f if any existing x in final is longer and contains f
    const shouldSkip = final.some(x => f !== x && x.includes(f));
    if (!shouldSkip) final.push(f);
  }
  return final.slice(0, 6);
}

function isKnownName(name: string, knowns: string[]): boolean {
  if (knowns.includes(name)) return true;
  // 部分匹配：cast 名包含已知名，或已知名包含 cast 名
  return knowns.some(k => name.includes(k) || k.includes(name));
}

function findClosestKnown(name: string, knowns: string[]): string | null {
  for (const k of knowns) {
    if (name.includes(k) || k.includes(name)) return k;
  }
  return null;
}

function normalizeDraft(j: DramaDraft & { seedPoints?: string[] }, fill: FillResult, briefTitle?: string): DramaDraft {
  // 验证 cast 人名：优先从 fact entity 提取，兜底用标题解析
  const knownNames = extractKnownPersonNames(fill, briefTitle);
  // 无效名字特征：包含"话题/设定/用户/你"、或纯描述性短语、或长度>8的奇怪组合
  const isInvalidName = (n: string) => {
    if (!n || n.length < 2) return true;
    if (/^(话题|设定|用户|玩家|你|他|她|它|该|某)/.test(n)) return true;
    if (n.length > 8) return true;
    return false;
  };
  const cast: Persona[] = (j.cast ?? [])
    .filter(c => !isInvalidName(c.name ?? '')) // 过滤垃圾名字
    .map((c, i) => {
      let name = (c.name ?? '').trim();
      // 先按标点分割，取第一段（处理"洪承畴、康熙"这类复合名）
      const firstPart = name.split(/[,、,··_～—]/)[0].trim();
      if (firstPart && firstPart.length >= 2 && firstPart.length <= 6) name = firstPart;
      if (knownNames.length > 0) {
        // Rule 1: exact match — 保留原样
        if (knownNames.includes(name)) { /* no-op */ }
        // Rule 2: name 是某已知名的前缀（如 '洪承' → '洪承畴'），从描述/prompt 验证后补全
        else {
          for (const kn of knownNames) {
            if (kn.startsWith(name) && kn.length > name.length) {
              if (c.description?.includes(kn) || c.prompt?.includes(kn)) {
                name = kn;
                break;
              }
            }
          }
        }
        // Rule 3: name 明显长于已知名且包含它（如 '架空洪承畴' → '洪承畴'）
        if (name !== (c.name ?? '').trim()) {
          for (const kn of knownNames) {
            if (name.includes(kn) && name.length > kn.length + 1) {
              name = kn;
              break;
            }
          }
        }
      }
      return {
        ...c,
        id: `p${i + 1}`,
        name,
        // role 太长则截断，保留第一个 / 之前的部分；清洗拉丁残渣（如"SU 拜"）
        role: c.role
          ? (() => {
              let r = String(c.role).split(/[/\\]/)[0].trim().slice(0, 8);
              // 去除与中文混杂的孤立拉丁残渣（保留纯英文专名如"AI"）
              const cjk = r.replace(/[A-Za-z0-9\s]+/g, '').trim();
              if (cjk.length >= 2) r = cjk;
              return r || '当事方';
            })()
          : '当事方',
        description: c.description ?? '',
        traits: c.traits ?? { competence: 60, loyalty: 60, ambition: 50, power: 50 },
      };
    });
  // 确保至少有 2 个 cast 成员
  while (cast.length < 2) {
    const idx = cast.length;
    cast.push({
      id: `p${idx + 1}`,
      name: idx === 0 ? (knownNames[0] ?? '当事方') : (knownNames[0] ?? '当事方') + '（稳守派）',
      role: '当事方',
      stance: idx === 0 ? '进取' : '稳守',
      influence: 50 + idx * 10,
      image: CHAR_IMAGE[knownNames[0] ?? ''],
      description: '',
      prompt: `你是${cast[idx].name}，立场${cast[idx].stance}。发言符合身份与立场。`,
      traits: { competence: 60, loyalty: 60, ambition: 50, power: 50 },
    });
  }
  return {
    cast,
    rounds: Math.min(10, Math.max(5, Number(j.rounds) || 5)),
    seedEvents: Array.isArray(j.seedEvents) ? j.seedEvents : (j.seedPoints ?? []),
    background: j.background ?? '',
    conflict: j.conflict ?? '',
    decisionPoint: j.decisionPoint ?? '你最终做出怎样的决断？',
    successCriteria: j.successCriteria ?? '局面维持可持续的平衡',
  };
}