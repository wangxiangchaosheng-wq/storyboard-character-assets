import type { Persona, TalkTask } from './types.ts';

// 简易字符串哈希：同输入 ⇒ 同输出，让 mock 发言确定、复现、可对照。
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

type Stance = 'support' | 'hedge' | 'weigh';

function stanceOf(p: Persona): Stance {
  const tag = `${p.stance ?? ''} ${p.role ?? ''}`;
  if (/仲裁|居中|平衡|权衡|客观|理智|中立/.test(tag)) return 'weigh';
  if (/进取|主动|扩张|敢任|果决|破局|使命/.test(tag)) return 'support';
  return 'hedge';
}

/** 从一段话里抠出一句可引用的短句（去标点、取最长分句、截短）。 */
function quoteOf(text: string, max = 22): string {
  const clean = text.replace(/[「」『』"'"'"'"'"''《》（）()]/g, '').replace(/\s+/g, ' ').trim();
  const seg = clean.split(/[，。！？；：]/).filter((x) => x.trim().length >= 4);
  const pick = seg.sort((a, b) => b.length - a.length)[0] || clean;
  return pick.slice(0, max);
}

/** 从当前数值快照里挑一句有数字的簿册——按 seed 轮转不同指标，
 * 避免每轮发言都引用同一个数字；同时处理值为0或空的情况。 */
function numericSnapshot(stateBlock?: string, seed = 0): string {
  if (!stateBlock || !stateBlock.trim()) return '';
  const items = stateBlock
    .replace(/\s+/g, ' ')
    .split(/[，;；]/)
    .filter((x) => x.trim().length >= 3 && /\d/.test(x));
  if (!items.length) return '';
  const idx = seed % items.length;
  const item = items[idx] ?? items[0];
  // 清理并截取：去掉开头非数字前缀，保留到最后一个数字+单位
  const cleaned = item.replace(/^[^：:]*[：:]\s*/, '').trim();
  if (!cleaned) return '';
  // 匹配 "数字 单位" 模式，确保有完整数值
  const match = cleaned.match(/^([\d.]+)\s*(万户|万两|万石|万|人|亿|%)?/);
  if (!match || !match[1]) return '';
  const label = cleaned.slice(0, 20);
  return `查今日簿册，${label}，`;
}

/** 从议题文案里提炼一句短焦点。 */
function focusOf(topic: string): string {
  const m = topic.match(/「([^」]*)」/);
  const raw = (m ? m[1] : topic).replace(/[「」『』]/g, '');
  const first = raw.split(/[，,：:。!！?？]+/).map(x => x.trim()).find(x => x.length > 0) || raw;
  return (first.replace(/^(作为|身为)[^，。！？]{0,10}/, '').trim() || '此局').slice(0, 16);
}

/** 判断话题是否带战乱/危机语义，影响漂移叙事。 */
function isConflictTopic(topic: string): boolean {
  return /战|乱|起义|起义|攻破|自缢|农民|流寇|边患|叛|伐|征|讨|破|灭/.test(topic);
}

/**
 * 主张：按立场 × 话题类型 × 轮次相位 三维度选变体。
 * seed 综合了角色 id + 轮次 + 玩家促议，保证每轮每角色都不同。
 */
function claimOf(p: Persona, st: Stance, topic: string, seed: number): string {
  const t = focusOf(topic);
  const conflict = isConflictTopic(topic);
  const phase = seed % 6; // 6 种相位变体
  const bank =
    st === 'support'
      ? conflict
        ? [
            `${t}一事，敌势正炽，此时不战何时战？宜速发精锐，以攻代守。`,
            `臣观天时有变——再拖下去，敌军势大更难收拾。此刻正是出手良机。`,
            `战机稍纵即逝。臣请旨：集中兵力，${t}一步到位，莫留后患。`,
            `臣附议进取。${t}若不成，退一步便是万丈深渊，不如赌这一把。`,
            `依臣之见，${t}当断则断。宁可战死，不可坐以待毙。`,
            `朝中虽有异议，但时不我待。${t}一事，臣愿领命行事。`,
            `臣斗胆进言：${t}正该趁势而为。现在不动，日后追悔莫及。`,
          ]
        : [
            `依我之见，${t}一事迟则生变，正该尽快定局。`,
            `我看局势已经明朗——再拖，主动权就交出去了，宁可先动。`,
            `我的主张只有一条：抓住眼下的转机打出去，稳赢不如快胜。`,
            `${t}之议，正当其时。机不可失，时不再来。`,
            `臣以为${t}不可缓。趁此有利态势，一举而定。`,
            `与其被动应对，不如主动出击。${t}，臣主战。`,
            `形势大好，此时不${t}更待何时？臣请主上果断决断。`,
          ]
      : st === 'weigh'
        ? conflict
          ? [
              `打仗要算账。${t}固然要紧，但兵源粮饷可还充足？臣先问三件事：粮、兵、时。`,
              `臣不反对${t}，但须分三步走：先稳后方，再探敌情，最后决战。`,
              `两边之言我都听了——此局考验的是弹性，不是锋芒。${t}宜缓不宜急。`,
              `臣落子的习惯是留后手：${t}，宜缓则缓，宜急则急，不可走极端。`,
              `臣以为${t}可议，但需配套措施。先安内，再图外，方为长策。`,
              `冒进固然可耻，但观望同样致命。${t}要干，但要算清代价再干。`,
              `臣的建议是：${t}可以，但先派斥候探明虚实，不可盲目出兵。`,
            ]
          : [
              `我不画非黑即白的图，${t}要分步看：先保住根本，再图进取。`,
              `两边之言我都听了——此局考验的是弹性，不是锋芒。`,
              `我落子的习惯是留后手：${t}，宜缓则缓，宜急则急，不可走极端。`,
              `此事利弊参半，臣不能一口咬定。容臣把两头账都算清楚。`,
              `臣的意见是：${t}可以，但需步步为营，不可急于求成。`,
              `凡事预则立。${t}之前，臣建议先做三件事：清查、安抚、备战。`,
              `激进与保守都不是臣的风格。臣主张稳中求进，${t}一事循序渐进。`,
            ]
        : conflict
          ? [
              `为社稷计，${t}正该按住：越是顺风，越要先算清代价。`,
              `当下最忌头脑发热。${t}若处置失度，输的不止一朝一夕。`,
              `我仍持保留：这个局若成了，退路便窄了，须防最坏一步。`,
              `臣不敢苟同。${t}看似机会，实为陷阱。此时出兵，正中敌下怀。`,
              `兵者，国之大事。${t}之事，请主上三思。臣看到的只有风险，没有胜算。`,
              `臣冒死直谏：${t}万万不可。此刻出兵，无异于以卵击石。`,
              `臣以为当务之急不是${t}，而是安内。内不定，何以对外？`,
            ]
          : [
              `为社稷计，${t}正该按住：越是顺风，越要先算清代价。`,
              `当下最忌头脑发热。${t}若处置失度，输的不止一朝一夕。`,
              `我仍持保留：这个局若成了，退路便窄了，须防最坏一步。`,
              `臣有异议。${t}虽好，但代价几何？臣看不到明确的回报。`,
              `臣建议暂缓${t}。先稳定现状，再谋后续。`,
              `${t}并非不可，但时机未成熟。臣请主上再等一等。`,
              `臣所见者与诸公不同。${t}的风险，诸公似乎未曾细算。`,
            ];
  return bank[phase];
}

/** 收束句：按影响力 + 轮次 + 话题类型三重变化。 */
function codaOf(p: Persona, round: number, conflict?: boolean): string {
  const inf = p.influence ?? 0;
  const phase = (hash(p.id + ':coda') + round) % 6;
  const base =
    inf > 60
      ? ['此事我揽下督办，主上只需给我分寸。', '臣请缨督办，必不负主上所托。', '主上只管下旨，剩下的交给臣。']
      : inf > 40
        ? ['主上若有疏解之策，臣愿先试办。', '臣愿分忧，请主上示下。', '若主上信任，臣愿试行一策。']
        : ['这一点，恳请主上三思而后断。', '臣言尽于此，请主上圣裁。', '臣愚见如此，伏惟主上决断。'];
  const conflictAdd = conflict
    ? phase < 2
      ? '战事紧迫，请主上早作决断。'
      : phase < 4
        ? '臣所言皆关乎生死存亡，望主上明察。'
        : '局势千钧一发，请主上速决。'
    : '';
  return base[phase % base.length] + (conflictAdd ? ' ' + conflictAdd : '');
}

/** 接前一位的话头：立场一致 → 附议；相反 → 驳；中立 → 转个弯。 */
function takeOf(prev: { name: string; content: string }, same: boolean, seed: number): string {
  const q = quoteOf(prev.content);
  if (same) {
    const v = [
      `同${prev.name}所虑，他在「${q}」这一层说得透，我再补一句：`,
      `${prev.name}那句「${q}」，正合我意，另添一个佐证：`,
      `${prev.name}言之有理，臣亦以为然，惟愿再加一分：`,
    ];
    return v[seed % v.length];
  }
  const v = [
    `${prev.name}刚说的「${q}」——恕我直言，我的立场正好相反：`,
    `接${prev.name}的话：「${q}」，我并不认同，理由如下：`,
    `对于${prev.name}的观点「${q}」，臣有不同看法：`,
    `${prev.name}高见，但臣以为其忽略了关键一点——`,
  ];
  return v[seed % v.length];
}

/**
 * 首轮·正式廷议发言：人设立场驱动，具体引用前一位的原话。
 * 结构：接话（或开场）→ 簿册数值（按需）→ 主张 → 收束。
 * opts.seed 把「玩家原话/诏令」混进种子与开场，使每番廷议不复读老台词。
 */
export function mockPersonaReply(
  p: Persona,
  task: TalkTask,
  historyText: string,
  stateBlock?: string,
  prevSpeaker?: { name: string; stance?: string; content?: string },
  opts: { seed?: string; round?: number } = {},
): string {
  const st = stanceOf(p);
  const seedKey = opts.seed ?? '';
  const round = opts.round ?? task.round ?? 0;
  const seed = hash(p.id + ':' + round + ':' + seedKey);
  const topic = (task.topic || '').replace(/\s+/g, ' ').slice(0, 60);
  const conflict = isConflictTopic(topic);
  const parts: string[] = [];

  if (prevSpeaker?.name && prevSpeaker.content) {
    const same = prevSpeaker.stance !== undefined && prevSpeaker.stance === p.stance;
    parts.push(takeOf({ name: prevSpeaker.name, content: prevSpeaker.content }, same, seed));
  } else if (seedKey) {
    // 开局第一位 & 玩家促议：先对上主上的话，再立自己主张
    const q = seedKey.replace(/[「」『』]/g, '').replace(/\s+/g, ' ').slice(0, 24);
    const openAck =
      st === 'support'
        ? [`主上问「${q}」，臣的答复笃定：当断即断，正是此刻。`,
           `主上既开此议，臣便直陈：「${q}」，此事刻不容缓。`]
        : st === 'weigh'
          ? [`主上既问「${q}」，臣先把两边账都摆开：`,
             `就着「${q}」，臣此时不便一口应承，容臣细细拆解。`]
          : [`主上问「${q}」，臣回：此事最怕操切，请先容臣细说。`,
             `主上既提「${q}」，臣不得不泼一盆冷水——`];
    parts.push(openAck[seed % openAck.length]);
  } else {
    // 无促议时的开场，按(角色hash + 轮次)混合选变体，避免首轮所有角色说同一句话
    const roundPhase = ((hash(p.id + ':phase') + round) % 3);
    const open =
      st === 'support'
        ? roundPhase === 0
          ? ['先把话摆明：这个时机，我主张当机立断。', '我说了也许犯众怒，但今日必须讲：该出手了。']
          : roundPhase === 1
            ? ['时不我待，臣不能再沉默。${t}，臣主战。', '臣今日就要说一句：该动起来了！']
            : ['诸位大人还在犹豫，臣便先表个态：此事，主战。', '臣不怕得罪人——${t}，现在就必须做。']
        : st === 'weigh'
          ? roundPhase === 0
            ? ['我先把账盘清：此事分难易两面，不能一概而论。', '恕我直陈：把账算细了再动手，不算胆小。']
            : roundPhase === 1
              ? ['臣的看法是：这事有门道，但得一步步来。', '容臣把利弊都摊开来，再议不迟。']
              : ['诸位各抒己见，臣先听一圈，再说话。', '此事非同小可，容臣慢慢道来。']
          : roundPhase === 0
            ? ['开场我先亮明态度：此议，我保留意见。', '大家畅言，我先泼一盆冷水——请先看清代价。']
            : roundPhase === 1
              ? ['臣有话要说——但不是什么好话。', '在下不才，想请各位先冷静三秒。']
              : ['臣有不同意见，诸位莫怪。', '容臣泼一盆冷水：诸公的方案，臣不敢苟同。'];
    parts.push(open[hash(p.id + ':open' + round) % open.length].replace('${t}', focusOf(topic)));
  }

  const snap = numericSnapshot(stateBlock, seed);
  if (snap) parts.push(snap);
  parts.push(claimOf(p, st, topic, seed));
  if (historyText.trim() && seed % 4 === 0) {
    const refs = [
      '方才几位大人的奏对，臣都记在了心里。',
      '此前的争论，臣旁听良久，今有新的想法。',
      '诸位刚才的辩论，让臣又想到一层——',
    ];
    parts.push(refs[seed % refs.length]);
  }
  parts.push(codaOf(p, round, conflict));
  return parts.join('\n');
}

/**
 * 交锋轮（辩论第 2 轮起）：针对一轮前立场相左者的原话作回应。
 */
export function mockPersonaRebutt(
  p: Persona,
  task: TalkTask,
  opponents: { name: string; content: string }[],
  stateBlock?: string,
  opts: { seed?: string; round?: number } = {},
): string {
  const st = stanceOf(p);
  const round = opts.round ?? task.round ?? 0;
  const seed = hash(p.id + ':re:' + round + ':' + (opts.seed ?? ''));
  const t = opponents.length ? opponents[seed % opponents.length] : undefined;
  const q = t ? quoteOf(t.content) : '';
  const conflict = isConflictTopic((task.topic ?? ''));
  const snap = numericSnapshot(stateBlock, seed) || '';

  const phase = seed % 8;
  const head =
    st === 'support'
      ? phase < 2
        ? `方才${t ? t.name + '「' + q + '」' : '那位'}之说，恕我不能认同：`
        : phase < 4
          ? `${t ? t.name : '方才'}所言，臣以为失之偏颇——`
          : `臣不同意${t ? t.name : '上述'}的观点。理由如下：`
          : phase < 6
            ? `${t ? '方才' + t.name + '「' + q + '」' : '方才之说'}，并非没有道理，但……`
            : `恕臣直言，${t ? t.name + '的观点「' + q + '」' : '上述说法'}，有一个致命漏洞：`;
  const tail =
    st === 'support'
      ? phase < 3
        ? '再等，等于把主动拱手让人。此一时彼一时，现在就是最佳战机。'
        : phase < 5
          ? '时不我待。对手不会等我们讨论完再行动。'
          : '臣再次强调：当断不断，反受其乱。'
      : st === 'weigh'
        ? phase < 3
          ? '不如各退一步，先小试一月再复盘。'
          : phase < 5
            ? '进有进的风险，退有退的代价，臣建议中间路线。'
            : '两边都对，两边都错。关键看主上如何权衡。'
        : phase < 3
          ? '宁可慢半拍，好过一路滑下去。'
          : phase < 5
            ? '臣不是反对，只是认为现在还不是时候。'
            : '请主上听臣一言：此刻强行动手，恐有得不偿失之虞。';

  return [head, snap, tail].filter(Boolean).join('\n');
}

/** 点名对答（玩家「问策」）：接主上一句话，按身份回应。 */
export function mockPersonaChat(p: Persona, playerText: string, stateBlock?: string): string {
  const st = stanceOf(p);
  const seed = hash(p.id + ':chat:' + playerText);
  const theme = playerText.replace(/[。.！!?？\s]+$/, '').slice(0, 32);
  const phase = seed % 6;
  const lead =
    st === 'support'
      ? phase < 2
        ? [`主上点到这事，我正有此意——「${theme}」，与我之虑合拍。`,
           `回主上：臣观「${theme}」，正当其时。`]
        : [`主上圣明，「${theme}」一事，臣正欲进言。`,
           `主上既然问及「${theme}」，臣便不再隐瞒——臣主此议。`]
      : st === 'weigh'
        ? phase < 2
          ? [`主上之意臣已了然，但「${theme}」我先摆两笔账，再说其他。`,
             `臣不悖主上，只把这事的得失两头都摊开：`]
          : [`「${theme}」一事，臣有几句话要说——先听利弊，再作决断。`,
             `主上的意思臣懂，但「${theme}」不能只看一面。`]
        : [`臣斗胆：若按「${theme}」这条走，风险这一栏，我先记下了。`,
           `主上容禀，「${theme}」一事，我劝莫急进。`];
  const snap = numericSnapshot(stateBlock, seed);
  const claim = claimOf(p, st, theme, seed);
  return [lead[phase % lead.length], snap, claim].filter(Boolean).join('\n');
}
