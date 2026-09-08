import type { Persona, TalkTask } from './types.ts';

// 简易字符串哈希：同输入 ⇒ 同输出，让 mock 发言确定、复现、可对照。
function hash(s: string): number {
  let h = 5381;
  for (let i = 0; i < s.length; i++) h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  return Math.abs(h);
}

type Stance = 'support' | 'hedge' | 'weigh';

/**
 * 姿态由「人设」推导，而不是掷骰子：
 * 进取/推动者 → 果决（support）；仲裁/权衡者 → 居中（weigh）；其余（稳健/保守）→ 设限（hedge）。
 * 这样 mock 的言行始终贴合角色身份，不会出现「稳健派忽然主张豪赌」的人设撕裂。
 */
function stanceOf(p: Persona): Stance {
  // 只从身份字段（stance/role）判立场，不读 prompt：
  // prompt 常描述「居中调度、推进朝局」之类的职责文案，混进去会把仲裁者误判成支持派。
  // 判定顺序：仲裁/居中先于进取——「权衡全局」优先于「主张推进」。
  const tag = `${p.stance ?? ''} ${p.role ?? ''}`;
  if (/仲裁|居中|平衡|权衡|客观|理智|中立/.test(tag)) return 'weigh';
  if (/进取|主动|扩张|敢任|果决|破局|使命/.test(tag)) return 'support';
  return 'hedge';
}

/** 从一段话里抠出一句可引用的短句（去标点、取最长分句、截短）。 */
function quoteOf(text: string, max = 22): string {
  const clean = text.replace(/[「」『』“”‘’《》（）()]/g, '').replace(/\s+/g, ' ').trim();
  const seg = clean.split(/[，。！？；：]/).filter((x) => x.trim().length >= 4);
  const pick = seg.sort((a, b) => b.length - a.length)[0] || clean;
  return pick.slice(0, max);
}

/** 从当前数值快照里挑一句有数字的簿册，让发言落在具体事实上。 */
function numericSnapshot(stateBlock?: string): string {
  if (!stateBlock || !stateBlock.trim()) return '';
  const items = stateBlock
    .replace(/\s+/g, ' ')
    .split(/[，;；]/)
    .filter((x) => /\d/.test(x));
  if (!items.length) return '';
  return `查今日簿册，${items[0].replace(/^[^：:]*[：:]\s*/, '').trim().slice(0, 24)}，`;
}

/** 从议题文案里提炼一句短焦点（去掉「合议」「你最终下达…」这类框架语）。 */
function focusOf(topic: string): string {
  const m = topic.match(/「([^」]*)」/);
  const raw = (m ? m[1] : topic).replace(/[「」『』]/g, '');
  // 只留第一段（冒号/逗号前常是主题词）；再削掉"作为统筹者"之类前缀
  const first = raw.split(/[，,：:。!！?？]+/).map(x => x.trim()).find(x => x.length > 0) || raw;
  return (first.replace(/^(作为|身为)[^，。！？]{0,10}/, '').trim() || '此局').slice(0, 16);
}

/** 自己的主张（按立场挑变体；确定性由 seed 决定）。 */
function claimOf(p: Persona, st: Stance, topic: string, seed: number): string {
  const t = focusOf(topic);
  const bank =
    st === 'support'
      ? [
          `依我之见，${t}一事迟则生变，正该尽快定局。`,
          `我看局势已经明朗——再拖，主动权就交出去了，宁可先动。`,
          `我的主张只有一条：抓住眼下的转机打出去，稳赢不如快胜。`,
        ]
      : st === 'weigh'
        ? [
            `我不画非黑即白的图，${t}要分步看：先保住根本，再图进取。`,
            `两边之言我都听了——此局考验的是弹性，不是锋芒。`,
            `我落子的习惯是留后手：${t}，宜缓则缓，宜急则急，不可走极端。`,
          ]
        : [
            `为社稷计，${t}正该按住：越是顺风，越要先算清代价。`,
            `当下最忌头脑发热。${t}若处置失度，输的不止一朝一夕。`,
            `我仍持保留：这个局若成了，退路便窄了，须防最坏一步。`,
          ];
  return bank[seed % bank.length];
}

/** 收束句：分量不同，语气不同，不再是全员一句「此事还需主上定夺」。 */
function codaOf(p: Persona): string {
  const inf = p.influence ?? 0;
  if (inf > 60) return '此事我揽下督办，主上只需给我分寸。';
  if (inf > 40) return '主上若有疏解之策，臣愿先试办。';
  return '这一点，恳请主上三思而后断。';
}

/** 接前一位的话头：立场一致 → 附议；相反 → 驳；中立 → 转个弯。 */
function takeOf(prev: { name: string; content: string }, same: boolean, seed: number): string {
  const q = quoteOf(prev.content);
  if (same) {
    const v = [
      `同${prev.name}所虑，他在「${q}」这一层说得透，我再补一句：`,
      `${prev.name}那句「${q}」，正合我意，另添一个佐证：`,
    ];
    return v[seed % v.length];
  }
  const v = [
    `${prev.name}刚说的「${q}」——恕我直言，我的立场正好相反：`,
    `接${prev.name}的话：「${q}」，我并不认同，理由如下：`,
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
  opts: { seed?: string } = {},
): string {
  const st = stanceOf(p);
  const seedKey = opts.seed ?? '';
  const seed = hash(p.id + ':' + (task.round ?? 0) + ':' + seedKey);
  const topic = (task.topic || '').replace(/\s+/g, ' ').slice(0, 60);
  const parts: string[] = [];
  if (prevSpeaker?.name && prevSpeaker.content) {
    const same = prevSpeaker.stance !== undefined && prevSpeaker.stance === p.stance;
    parts.push(takeOf({ name: prevSpeaker.name, content: prevSpeaker.content }, same, seed));
  } else if (seedKey) {
    // 开局第一位 & 玩家促议：先对上主上的话，再立自己主张（不再背通用开场白）
    const q = seedKey.replace(/[「」『』]/g, '').replace(/\s+/g, ' ').slice(0, 24);
    const openAck =
      st === 'support'
        ? [`主上问「${q}」，臣的答复笃定：当断即断，正是此刻。`]
        : st === 'weigh'
          ? [`主上既问「${q}」，臣先把两边账都摆开：`, `就着「${q}」，臣此时不便一口应承。`]
          : [`主上问「${q}」，臣回：此事最怕操切，请先容臣细说。`];
    parts.push(openAck[seed % openAck.length]);
  } else {
    const open =
      st === 'support'
        ? ['先把话摆明：这个时机，我主张当机立断。', '我说了也许犯众怒，但今日必须讲：该出手了。']
        : st === 'weigh'
          ? ['我先把账盘清：此事分难易两面，不能一概而论。', '恕我直陈：把账算细了再动手，不算胆小。']
          : ['开场我先亮明态度：此议，我保留意见。', '大家畅言，我先泼一盆冷水——请先看清代价。'];
    parts.push(open[hash(p.id + ':open') % open.length]);
  }
  const snap = numericSnapshot(stateBlock);
  if (snap) parts.push(snap);
  parts.push(claimOf(p, st, topic, seed));
  if (historyText.trim() && seed % 3 === 0) parts.push('刚才已见几份奏对，我始终盯着其中的利害处。');
  parts.push(codaOf(p));
  return parts.join('\n');
}

/**
 * 交锋轮（辩论第 2 轮起）：针对一轮前立场相左者的原话作回应——这才是「有来有回」。
 * opts.seed 同样影响变体选择，避免不同番次的交锋轮永远同款句式。
 */
export function mockPersonaRebutt(
  p: Persona,
  task: TalkTask,
  opponents: { name: string; content: string }[],
  stateBlock?: string,
  opts: { seed?: string } = {},
): string {
  const st = stanceOf(p);
  const seed = hash(p.id + ':re:' + (task.round ?? 0) + ':' + (opts.seed ?? ''));
  const t = opponents.length ? opponents[seed % opponents.length] : undefined;
  const q = t ? quoteOf(t.content) : '';
  const snap = numericSnapshot(stateBlock) || '';
  const head =
    st === 'support'
      ? `方才${t ? t.name + '「' + q + '」' : '那位'}之说，恕我不能认同：`
      : st === 'weigh'
        ? `${t ? '方才那番「' + q + '」' : '方才之说'}，平心而论自有道理，但关键在别把路堵死：`
        : `方才「${q}」这一层，我恰恰最担心${t ? '' : ''}：`;
  const tail =
    st === 'support'
      ? '再等，等于把主动拱手让人。'
      : st === 'weigh'
        ? '不如各退一步，先小试一月再复盘。'
        : '宁可慢半拍，好过一路滑下去。';
  return [head, snap, tail].filter(Boolean).join('\n');
}

/** 点名对答（玩家「问策」）：接主上一句话，按身份回应。 */
export function mockPersonaChat(p: Persona, playerText: string, stateBlock?: string): string {
  const st = stanceOf(p);
  const seed = hash(p.id + ':chat:' + playerText);
  const theme = playerText.replace(/[。.！!?？\s]+$/, '').slice(0, 32);
  const lead =
    st === 'support'
      ? [
          `主上点到这事，我正有此意——「${theme}」，与我之虑合拍。`,
          `回主上：臣观「${theme}」，正当其时。`,
        ]
      : st === 'weigh'
        ? [
            `主上之意臣已了然，但「${theme}」我先摆两笔账，再说其他。`,
            `臣不悖主上，只把这事的得失两头都摊开：`,
          ]
        : [
            `臣斗胆：若按「${theme}」这条走，风险这一栏，我先记下了。`,
            `主上容禀，「${theme}」一事，我劝莫急进。`,
          ];
  const snap = numericSnapshot(stateBlock);
  const claim = claimOf(p, st, theme, seed);
  return [lead[seed % lead.length], snap, claim, codaOf(p)].filter(Boolean).join('\n');
}