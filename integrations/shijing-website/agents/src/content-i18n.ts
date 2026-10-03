/**
 * 内容层双语表 v1（简体中文 + English）——与 app/lib/i18n.ts 同一套机制、同样的理由不引库。
 *
 * 壳层表（app/lib/i18n.ts）由 app/ 构建消费，内容表由 agents/ 的推演代码与 Node 测试直接
 * 读取——两个构建域各一张点分表，取值函数同一形状（locale 命中 → en 缺回落中文 → 调用方
 * 兜底），靠 app/lib/i18n.test.mjs 与 agents/tests/content-i18n.test.mjs 分别兜底。
 *
 * 覆盖范围（Steam 全球发行的内容门槛：玩家要读的正文，而非按钮标签）：
 * - 剧本预设：agents/src/scenarios.ts 四题的 title / background / premise
 * - 计策依据：agents/src/stratagem.ts 每条计策的 title / basis
 *
 * 硬规则：
 * 1. zh-CN 值与 agents/src 的数据逐字一致（测试有漂移断言）——中文的事实来源就在数据里，
 *    本表是它的译文层，不是第二个事实来源。英文缺失一律回落中文。
 * 2. 史实纪律：演义类计策（空城计）的「演义，非史实」标注必须翻过去；翻译不得加入原文
 *    没有的断言，也不得丢出处（《三国志》《史记》与裴注引书）。
 * 3. 不翻：LLM prompt 与 AI 生成内容、引擎生成句（scenarioSummary/stratagemSummary 等
 *    既有函数原位返回中文）、public/map 静态编年、存量 SQLite 对局数据。
 */

export type Locale='zh-CN'|'en';

/** 内容键 → { 'zh-CN': 中文, en: 英文 }。zh 与数据同源，en 缺表项时取值回落 zh。 */
export const CONTENT:Record<string,Partial<Record<Locale,string>>>={

 // ── 剧本预设（键与 app/lib/i18n.ts 的 scenario.* 对齐：卡片标题与 premise 同一译文）──
 'scenario.ziwugu-228.title':{'zh-CN':'子午谷之议',en:'The Ziwu Valley Proposal'},
 'scenario.ziwugu-228.background':{'zh-CN':'诸葛亮北伐，魏延请率精兵五千直出子午谷奇袭长安；诸葛亮以为悬危，不如安从坦道，平取陇右。陇西三郡响应，关中震动。汉中粮道千里：兵少不足以守长安，兵多无以供——这一局争的是粮，不是勇。',
  en:'Zhuge Liang’s northern campaign: Wei Yan asked to lead five thousand picked troops straight out of the Ziwu Valley and take Chang’an by surprise. Zhuge Liang judged the route too perilous — better to advance by the open road at a measured pace and win Longyou step by step. The three commandies west of the Long rose in answer, and Guanzhong trembled. The grain road from Hanzhong runs a thousand li: too few men to hold Chang’an, too many to feed — this game is fought over grain, not over valor.'},
 'scenario.ziwugu-228.premise':{'zh-CN':'五千奇兵换长安，还是三郡渐收：险与稳，赌的是粮道而不是勇力。',
  en:'Trade five thousand shock troops for Chang’an, or gather the three commandies step by step: bold or steady, the wager is the grain road, not valor.'},

 'scenario.guandu-200.title':{'zh-CN':'官渡拉锯',en:'The Guandu Stalemate'},
 'scenario.guandu-200.background':{'zh-CN':'曹操与袁绍相持于官渡，彼众我寡，粮且尽，操书与荀彧议还许。袁绍粮车相望，淳于琼屯乌巢；许攸奔曹，乌巢之火是这一局的枢纽。本地推演沿用十二城样板舆图、蜀执政位不变——本剧本定的是廷议情境与粮草账，史事只约束解释。',
  en:'Cao Cao and Yuan Shao stood locked at Guandu — the enemy host the greater, ours the smaller, and the grain all but gone. Cao Cao wrote to Xun Yu about falling back to Xu. Yuan Shao’s grain carts stretched beyond eyesight, and Chun Yu Qiong held Wuchao; Xu You fled over to Cao. The fire at Wuchao is the hinge of this game. The local simulation reuses the twelve-city template map and keeps the Shu leadership unchanged: what this scenario fixes is the court deliberation and the grain ledger — history only constrains the reading.'},
 'scenario.guandu-200.premise':{'zh-CN':'粮尽之前先乱：守住粮道的人活着走出官渡，勇战在此只是账目。',
  en:'Disorder comes before the grain runs out: whoever holds the supply line walks out of Guandu — brave fighting is only accounting here.'},

 'scenario.chibi-208.title':{'zh-CN':'赤壁前夕',en:'Eve of Red Cliffs'},
 'scenario.chibi-208.background':{'zh-CN':'曹操大军南下，据江陵，顺流东下；刘备新败于当阳，进退未决；孙权拥兵江东，群臣咸言迎曹。孙刘结盟则生，各自为战则亡。赤壁在望，风与火皆不在人算之中。',
  en:'Cao Cao’s great army marched south, took Jiangling, and drove down with the current. Liu Bei, newly defeated at Dangyang, could not decide whether to advance or fall back. Sun Quan held his armies east of the river, and every minister spoke of welcoming Cao. If Sun and Liu stand together they live; if each fights alone they die. Red Cliffs is in sight — but neither the wind nor the fire lies within mortal reckoning.'},
 'scenario.chibi-208.premise':{'zh-CN':'联盟谈得成，仗才打得起来：这一局先定外交，再定水火。',
  en:'No alliance, no battle: this game settles diplomacy first, fire and water second.'},

 'scenario.baidi-223.title':{'zh-CN':'白帝托孤',en:'The Baidi Entrustment'},
 'scenario.baidi-223.background':{'zh-CN':'刘备病笃于白帝，召诸葛亮与尚书令李严属以后事，嗣君刘禅冲幼。南中未平，孙吴之好新结，蜀汉的内政与军府俱托于丞相一人。成都方定，而国库空虚。',
  en:'Liu Bei lay dying at Baidi and summoned Zhuge Liang and the Secretariat Director Li Yan to commit the affairs of state to them; the heir Liu Shan was still a child. Nanzhong was not yet pacified and the peace with Wu newly struck; both the civil government and the army of Shu Han rested on the chancellor alone. Chengdu had only just been settled, and the treasury stood empty.'},
 'scenario.baidi-223.premise':{'zh-CN':'受托之后先安内还是先攘外：冲幼的嗣君、未平的南中、初结的吴盟。',
  en:'After the trust is given: secure the inside first, or the outside? A young heir, unpacified Nanzhong, a fresh alliance with Wu.'},

 // ── 计策依据（id 归 agents/src/stratagem.ts；AI 提案的 stratagem-ai-* 不入表，回落原题）──
 'stratagem.stratagem-fire-wuchao.title':{'zh-CN':'火烧乌巢',en:'Burn Wuchao'},
 'stratagem.stratagem-fire-wuchao.basis':{'zh-CN':'官渡之战，曹操从许攸之谋夜袭乌巢，烧袁军粮谷；见《三国志·武帝纪》与《荀攸传》。',
  en:'At the battle of Guandu, Cao Cao followed Xu You’s counsel and raided Wuchao by night, burning the Yuan army’s grain; see Records of the Three Kingdoms: Annals of Emperor Wu and Biography of Xun You.'},

 'stratagem.stratagem-fire-chibi.title':{'zh-CN':'赤壁风火',en:'Wind and Fire at Red Cliffs'},
 'stratagem.stratagem-fire-chibi.basis':{'zh-CN':'建安十三年冬，孙刘联军以火攻大破曹军于赤壁；见《三国志·吴主传》与《周瑜传》。',
  en:'In the winter of the thirteenth year of the Jian’an era, the Sun–Liu allied forces shattered Cao Cao’s army at Red Cliffs with a fire attack; see Records of the Three Kingdoms: Annals of the Lord of Wu and Biography of Zhou Yu.'},

 'stratagem.stratagem-supply-cut.title':{'zh-CN':'断敌粮道',en:'Cut the Enemy’s Grain Road'},
 'stratagem.stratagem-supply-cut.basis':{'zh-CN':'官渡相持，袁军粮谷被焚而溃；诸葛亮以北伐屡因粮尽退兵，见《三国志·诸葛亮传》。',
  en:'At the Guandu standoff the Yuan army broke once its grain was burned; Zhuge Liang’s northern campaigns turned back for want of grain time and again; see Records of the Three Kingdoms: Biography of Zhuge Liang.'},

 'stratagem.stratagem-sow-discord.title':{'zh-CN':'离间二将',en:'Sow Discord Between Two Commanders'},
 'stratagem.stratagem-sow-discord.basis':{'zh-CN':'曹操离间马超与韩遂，遂有关中之内溃；见《三国志·武帝纪》裴注引《典略》。',
  en:'Cao Cao set Ma Chao and Han Sui at odds, and Guanzhong collapsed from within; see Pei Songzhi’s commentary in Records of the Three Kingdoms: Annals of Emperor Wu, quoting the Dianlüe.'},

 'stratagem.stratagem-feign-defect.title':{'zh-CN':'苦肉诈降',en:'The Bitter-Flesh Ruse of Feigned Defection'},
 'stratagem.stratagem-feign-defect.basis':{'zh-CN':'赤壁之役，黄盖豫降书以焚曹船；见《三国志·吴主传》裴注引《江表传》。',
  en:'At the battle of Red Cliffs, Huang Gai sent word of surrender beforehand, and so burned Cao Cao’s ships; see Pei Songzhi’s commentary in Records of the Three Kingdoms: Annals of the Lord of Wu, quoting the Jiangbiao Zhuan.'},

 'stratagem.stratagem-flood.title':{'zh-CN':'水淹七军',en:'Flood the Seven Armies'},
 'stratagem.stratagem-flood.basis':{'zh-CN':'建安二十四年，汉水暴溢，关羽乘船攻于禁七军；见《三国志·关羽传》。',
  en:'In the twenty-fourth year of the Jian’an era, the Han River burst its banks, and Guan Yu attacked Yu Jin’s seven armies by boat; see Records of the Three Kingdoms: Biography of Guan Yu.'},

 'stratagem.stratagem-empty-fort.title':{'zh-CN':'披扇空城',en:'The Empty City with a Feather Fan'},
 'stratagem.stratagem-empty-fort.basis':{'zh-CN':'《三国演义》第九十五回，诸葛亮于西城披扇阶上，司马懿疑而不进。**演义，非史实**；史无其事，不敢入正史。',
  en:'Romance of the Three Kingdoms, chapter 95: at Xicheng, Zhuge Liang sat on the steps holding a feather fan, and Sima Yi suspected a trap and did not advance. **Romance, not a historical record** — no such event is in the histories, so it is not entered as history.'},

 'stratagem.stratagem-ambush-ziwu.title':{'zh-CN':'险道设伏',en:'Ambush on the Treacherous Road'},
 'stratagem.stratagem-ambush-ziwu.basis':{'zh-CN':'魏延请直从褒中出子午谷，诸葛亮以为危不如安；险道设伏之理见《三国志·魏延传》裴注引《魏略》。',
  en:'Wei Yan asked to march straight out of the Ziwu Valley from Baozhong; Zhuge Liang held that the risky course was no better than the safe one. The principle of ambushing a treacherous road appears in Pei Songzhi’s commentary to the Biography of Wei Yan in Records of the Three Kingdoms, quoting the Weilüe.'},

 'stratagem.stratagem-ambush-maling.title':{'zh-CN':'马陵伏弩',en:'The Crossbow Ambush at Maling'},
 'stratagem.stratagem-ambush-maling.basis':{'zh-CN':'战国齐魏马陵之战，孙膑减灶伏弩射杀庞涓；见《史记·孙子吴起列传》。',
  en:'In the Warring States, at the battle of Maling between Qi and Wei, Sun Bin reduced the cooking fires, hid crossbowmen in ambush, and shot Pang Juan dead; see Records of the Grand Historian: Biographies of Sun Tzu and Wu Qi.'},

 'stratagem.stratagem-relieve-besiege.title':{'zh-CN':'围魏救赵',en:'Besiege Wei to Save Zhao'},
 'stratagem.stratagem-relieve-besiege.basis':{'zh-CN':'战国齐孙膑围魏救赵，攻其必救以解邯郸；见《史记·孙子吴起列传》。',
  en:'In the Warring States, Sun Bin of Qi besieged Wei to save Zhao — striking at what Wei had to rescue, and so lifting the siege of Handan; see Records of the Grand Historian: Biographies of Sun Tzu and Wu Qi.'},
};

/**
 * 取值链：locale 命中 → 该键中文 → 调用方给的原始中文兜底（数据字段值）→ key 本身。
 * 英文缺失永不把 key 或空串递给玩家：取值入口（scenarioTitle 等）都带 fallback，
 * 只有直接调用且不给 fallback 时才会看到 key——那与 translate 的调试约定一致。
 */
export function contentText(key:string,locale:Locale,fallback?:string):string{
 const entry=CONTENT[key];
 if(entry){
  const hit=entry[locale];
  if(typeof hit==='string'&&hit!=='')return hit;
  const zh=entry['zh-CN'];
  if(typeof zh==='string'&&zh!=='')return zh;
 }
 if(typeof fallback==='string'&&fallback!=='')return fallback;
 return key;
}

export function hasEnglish(key:string):boolean{
 const en=CONTENT[key]?.en;
 return typeof en==='string'&&en.trim().length>0;
}

/** 覆盖盘点：total 键数、withEnglish 有英文的键数、missing 缺英文的键（应为空）。 */
export function contentCoverage():{total:number;withEnglish:number;missing:string[]}{
 const keys=Object.keys(CONTENT);
 const missing=keys.filter(k=>!hasEnglish(k));
 return {total:keys.length,withEnglish:keys.length-missing.length,missing};
}
