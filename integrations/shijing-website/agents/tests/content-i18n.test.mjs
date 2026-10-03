// 内容层双语 v1 测试：纯 JS，直接以 Node 原生 TS 擦除运行 ../src/content-i18n.ts 与
// ../src/scenarios.ts（二者无运行时 .js 依赖）。stratagem.ts 顶层带着
// `import {assert} from './contracts.js'`，类型擦除解析不到 .js 后缀的 .ts 源，故计策
// 断言走 ../dist/（agents/tests 的既定约定，先 npm run agents:build 再跑本文件）。
//
// 期望键集一律从活数据推导（SCENARIOS × 3 字段 + STRATAGEMS × 2 字段），不写死数字：
// 引擎加剧本/加计策而表没跟上，当场红。任务书按「12 条计策」估了 36 键，引擎池子实有
// 10 条（v1 未扩军），故本版实为 4×3 + 10×2 = 32 键，全部有英文。
import {test} from 'node:test';
import assert from 'node:assert/strict';
import {CONTENT,contentText,hasEnglish,contentCoverage} from '../src/content-i18n.ts';
import {SCENARIOS,scenarioTitle,scenarioBackground,scenarioPremise,scenarioSummary,toRunSpec} from '../src/scenarios.ts';
import {STRATAGEMS,stratagemTitle,stratagemBasis,stratagemSummary,validateStratagem} from '../dist/stratagem.js';
import {LOCALES as SHELL_LOCALES,translate as shellTranslate} from '../../app/lib/i18n.ts';

const SCENARIO_FIELDS=['title','background','premise'];
const STRATAGEM_FIELDS=['title','basis'];
const EXPECTED_KEYS=[...SCENARIOS.flatMap(s=>SCENARIO_FIELDS.map(f=>`scenario.${s.id}.${f}`)),...STRATAGEMS.flatMap(s=>STRATAGEM_FIELDS.map(f=>`stratagem.${s.id}.${f}`))];
const CJK=/[\u4e00-\u9fff]/;

test('dist 与 src 同步：计策取值入口存在（过期就先 npm run agents:build）',()=>{
  assert.equal(typeof stratagemTitle,'function');
  assert.equal(typeof stratagemBasis,'function');
});

test('CONTENT 键集 = 活数据的每一条：剧本 4×3、计策 10×2，一张不多一张不少',()=>{
  assert.equal(SCENARIOS.length,4);
  assert.ok(STRATAGEMS.length>=10,'计策池至少 10 条');
  assert.deepEqual(Object.keys(CONTENT).sort(),[...EXPECTED_KEYS].sort());
});

test('contentCoverage：每个键都有英文，missing 为空',()=>{
  const cov=contentCoverage();
  assert.deepEqual(cov.missing,[]);
  assert.equal(cov.withEnglish,cov.total);
  assert.equal(cov.total,SCENARIOS.length*SCENARIO_FIELDS.length+STRATAGEMS.length*STRATAGEM_FIELDS.length);
  for(const key of EXPECTED_KEYS)assert.ok(hasEnglish(key),`${key} 缺英文`);
  assert.equal(hasEnglish('scenario.no-such-scenario.title'),false);
});

test('每个键在两种语言下都非空',()=>{
  for(const [key,entry] of Object.entries(CONTENT)){
    for(const locale of SHELL_LOCALES){
      const value=entry[locale];
      assert.equal(typeof value,'string',`${locale}/${key} 不是字符串`);
      assert.ok(value.trim().length>0,`${locale}/${key} 为空`);
    }
  }
});

test('zh-CN 与引擎数据逐字一致：内容表是译文层，不是第二个事实来源',()=>{
  for(const s of SCENARIOS){
    assert.equal(CONTENT[`scenario.${s.id}.title`]['zh-CN'],s.title);
    assert.equal(CONTENT[`scenario.${s.id}.background`]['zh-CN'],s.background);
    assert.equal(CONTENT[`scenario.${s.id}.premise`]['zh-CN'],s.premise);
  }
  for(const s of STRATAGEMS){
    assert.equal(CONTENT[`stratagem.${s.id}.title`]['zh-CN'],s.title);
    assert.equal(CONTENT[`stratagem.${s.id}.basis`]['zh-CN'],s.basis);
  }
});

test('与壳层表一致：剧本 title/premise 的英文与 app/lib/i18n.ts 逐字相同',()=>{
  for(const s of SCENARIOS)for(const field of ['title','premise'])
    assert.equal(contentText(`scenario.${s.id}.${field}`,'en'),shellTranslate('en',`scenario.${s.id}.${field}`),`${s.id}.${field} 两表漂移`);
});

test('contentText：英文命中；该键缺英文回落中文；未知 key 不抛',()=>{
  assert.equal(contentText('scenario.ziwugu-228.title','en'),'The Ziwu Valley Proposal');
  assert.equal(contentText('scenario.ziwugu-228.title','zh-CN'),'子午谷之议');
  // 缺英文回落中文：摘掉 en，en locale 拿到的仍是中文，而不是 key 或空串
  const key='scenario.chibi-208.premise';
  const before=structuredClone(CONTENT[key]);
  try{
    delete CONTENT[key].en;
    assert.equal(contentText(key,'en'),contentText(key,'zh-CN'));
    assert.match(contentText(key,'en'),CJK);
    assert.equal(contentText(key,'zh-CN'),before['zh-CN']);
  }finally{CONTENT[key]=structuredClone(before);}
  assert.equal(contentText(key,'en'),before.en);
  // 未知 key：不抛、非空；玩家可见路径上的兜底见下面 MOD/AI 用例
  assert.doesNotThrow(()=>contentText('scenario.does-not-exist.title','en'));
  assert.ok(contentText('scenario.does-not-exist.title','en').length>0);
});

test('scenarioTitle/Background/Premise：4 剧本 × 2 语言非空，中英不同',()=>{
  for(const s of SCENARIOS){
    const zh={title:scenarioTitle(s,'zh-CN'),background:scenarioBackground(s,'zh-CN'),premise:scenarioPremise(s,'zh-CN')};
    const en={title:scenarioTitle(s,'en'),background:scenarioBackground(s,'en'),premise:scenarioPremise(s,'en')};
    for(const field of SCENARIO_FIELDS){
      assert.equal(zh[field],s[field],`${s.id}.${field} 中文须与源数据一致`);
      assert.ok(en[field].trim().length>0,`${s.id}.${field} 英文为空`);
      assert.ok(!CJK.test(en[field]),`${s.id}.${field} 英文没翻干净：${en[field].slice(0,20)}…`);
      assert.notEqual(en[field],zh[field],`${s.id}.${field} 只翻了一半`);
    }
  }
});

test('stratagemTitle/Basis：每条计策 × 2 语言非空，中英不同',()=>{
  for(const s of STRATAGEMS){
    const zh={title:stratagemTitle(s,'zh-CN'),basis:stratagemBasis(s,'zh-CN')};
    const en={title:stratagemTitle(s,'en'),basis:stratagemBasis(s,'en')};
    assert.equal(zh.title,s.title);
    assert.equal(zh.basis,s.basis);
    for(const field of STRATAGEM_FIELDS){
      assert.ok(en[field].trim().length>0,`${s.id}.${field} 英文为空`);
      assert.ok(!CJK.test(en[field]),`${s.id}.${field} 英文没翻干净：${en[field].slice(0,20)}…`);
      assert.notEqual(en[field],zh[field],`${s.id}.${field} 只翻了一半`);
    }
  }
});

test('史实标注保严：空城计的「演义，非史实」必须翻过去，且不给演义类做出处链接',()=>{
  const s=STRATAGEMS.find(x=>x.id==='stratagem-empty-fort');
  assert.ok(s,'空城计须在池中');
  // 中文侧：源数据一字未动
  assert.match(s.basis,/演义/,'演义类必须显式标注');
  assert.match(s.basis,/非史实/);
  assert.equal(s.source,undefined,'演义类没有 wikisource 出处，不得伪造');
  // 英文侧：标注不许翻丢——Romance 与「非史实」两个信息点都要在
  const en=stratagemBasis(s,'en');
  assert.match(en,/Romance/,'英文 basis 丢了「演义」');
  assert.match(en,/not a historical record|not history/i,'英文 basis 丢了「非史实」');
  assert.match(en,/chapter 95/,'英文 basis 丢了回目');
  // 史实类计策：英文 basis 不得丢出处（三国志/史记），也不得自贬为非史实
  for(const t of STRATAGEMS.filter(x=>x.id!=='stratagem-empty-fort')){
    assert.match(stratagemBasis(t,'en'),/Records of the Three Kingdoms|Records of the Grand Historian/,`${t.id} 英文 basis 丢了出处`);
    assert.doesNotMatch(stratagemBasis(t,'en'),/not a historical record/i,`${t.id} 是史实类，不得自标非史实`);
    assert.ok(t.source&&/^https:\/\/zh\.wikisource\.org\//.test(t.source),`${t.id} 是史实类，须有 wikisource 出处`);
  }
});

test('locale 集合与 app/lib/i18n.ts 一致，每个壳层 locale 下取值都非空',()=>{
  assert.deepEqual([...SHELL_LOCALES].sort(),['en','zh-CN']);
  for(const locale of SHELL_LOCALES){
    for(const s of SCENARIOS)for(const get of [scenarioTitle,scenarioBackground,scenarioPremise])
      assert.ok(get(s,locale).trim().length>0,`${locale}/${s.id} 取值空`);
    for(const s of STRATAGEMS)for(const get of [stratagemTitle,stratagemBasis])
      assert.ok(get(s,locale).trim().length>0,`${locale}/${s.id} 取值空`);
  }
});

test('MOD 剧本与 AI 提案：未知 id 回落数据原值，玩家看不到 key',()=>{
  const made={id:'mod-brand-new',title:'全新剧本',year:230,season:'春',faction:'蜀汉',background:'架空开场。',cast:[],metrics:[],premise:'架空张力。',targetYears:5};
  assert.equal(scenarioTitle(made,'en'),'全新剧本');
  assert.equal(scenarioBackground(made,'en'),'架空开场。');
  assert.equal(scenarioPremise(made,'en'),'架空张力。');
  assert.equal(scenarioTitle(made,'zh-CN'),'全新剧本');
  const ai={id:'stratagem-ai-0abc',kind:'fire',title:'伪报粮尽',basis:'《孙子》百里趋利。'};
  assert.equal(stratagemTitle(ai,'en'),'伪报粮尽');
  assert.equal(stratagemBasis(ai,'en'),'《孙子》百里趋利。');
  assert.equal(stratagemBasis(ai,'zh-CN'),'《孙子》百里趋利。');
});

test('既有函数行为不变：summary 仍返回中文，池子与 toRunSpec 原样',()=>{
  // scenarioSummary：年代/阵营/人物/年数/premise 五行全中文
  const s=SCENARIOS.find(x=>x.id==='ziwugu-228');
  const lines=scenarioSummary(s);
  assert.equal(lines.length,5);
  assert.ok(lines.every(l=>CJK.test(l)),'scenarioSummary 仍须全中文');
  assert.ok(lines.some(l=>l.includes('年代：公元228年春')));
  assert.ok(lines.includes(s.premise),'summary 仍带中文 premise 原值');
  // stratagemSummary：依据行仍是中文 basis 原值
  const t=STRATAGEMS.find(x=>x.id==='stratagem-fire-wuchao');
  const sum=stratagemSummary(t);
  assert.ok(sum.some(l=>l.startsWith('依据：')&&l.includes(t.basis)),'stratagemSummary 仍返回中文 basis');
  assert.ok(sum.some(l=>CJK.test(l)));
  // toRunSpec 仍是中文 spec（LLM prompt 层不翻）
  const spec=toRunSpec(s);
  assert.equal(spec.title,'子午谷之议');
  assert.match(spec.scenario.background,/^公元228年春/);
  assert.ok(spec.scenario.background.includes(s.premise));
  assert.equal(spec.metrics.length,0);
  // 池子本身没被取值入口碰坏
  for(const x of STRATAGEMS)validateStratagem(x);
});
