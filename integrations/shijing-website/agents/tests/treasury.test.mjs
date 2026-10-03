import {test} from 'node:test';
import assert from 'node:assert/strict';
import {seedFiscal,validateFiscal,fiscalIncome,armyUpkeep,settleFiscal,fiscalSummary,setTaxRate,setCorruption,ARMY_PAY_PER_DAY,CORVEE_PER_DAY} from '../dist/treasury.js';
import {assessUpheaval,UPHEAVAL_LABELS} from '../dist/upheaval.js';
import {buildInitialWorld} from '../dist/world-bootstrap.js';

function province(id,name,seat,agriculture,commerce,manpower,specialties,ownerFactionId='shu'){
 return {id,name,seatCityId:seat,memberCityIds:[],ownerFactionId,governor:{id:'governor-'+seat,name:'守将（模拟）'},mode:'unset',policy:null,agriculture,commerce,manpower,specialties,source:'测试设定'};
}
function fixture(){
 return {schemaVersion:'world-state/v1',worldId:'treasury-fixture',scenarioId:'treasury-test',mapId:'test-map-v1',revision:0,
  clock:{startLabel:'建兴六年',elapsedDays:0},
  factions:{shu:{id:'shu',name:'蜀',color:'#20573f'},wei:{id:'wei',name:'魏',color:'#a54d39'}},
  cities:{hanzhong:{id:'hanzhong',name:'汉中',kind:'city',point:{x:0.3,y:0.4},ownerFactionId:'shu',governor:{id:'governor-hanzhong',name:'守将（模拟）'},foodKg:20000,defense:70},
   chengdu:{id:'chengdu',name:'成都',kind:'city',point:{x:0.2,y:0.6},ownerFactionId:'shu',governor:{id:'governor-chengdu',name:'守将（模拟）'},foodKg:30000,defense:70}},
  armies:{'army-wei-yan':{id:'army-wei-yan',name:'魏延部',factionId:'shu',commander:{id:'wei-yan',name:'魏延'},troops:5000,foodKg:60000,morale:80,location:{kind:'city',cityId:'hanzhong'},status:'stationed'},
   'army-jiang-wan':{id:'army-jiang-wan',name:'蒋琬部',factionId:'shu',commander:{id:'jiang-wan',name:'蒋琬'},troops:3000,foodKg:12000,morale:70,location:{kind:'route',actionId:'a1'},status:'marching'}},
  actions:{},decisions:{},
  provinces:{'prov-hanzhong':province('prov-hanzhong','汉中','hanzhong',2100000,900000,6000,['铁','漆']),
   'prov-chengdu':province('prov-chengdu','益州','chengdu',3600000,2200000,5000,['蜀锦','井盐'])}};
}
const ZERO={coin:0,food:0,corvee:0,manpower:0};
const ledgerRow=(day=0,note='n')=>({day,income:{...ZERO},expense:{...ZERO},note});

test('seedFiscal opens an empty treasury with the prescribed rates',()=>{
 const s=seedFiscal();
 assert.equal(s.version,1);
 assert.deepEqual(s.treasury,{...ZERO});
 assert.equal(s.taxRate,0.3);assert.equal(s.corruption,0.15);
 assert.equal(s.arrearsDays,0);assert.deepEqual(s.lastSettlement,[]);
 validateFiscal(s);
 // 两个种子互不共享对象：改一个不能污染下一个
 const a=seedFiscal(),b=seedFiscal();
 a.treasury.coin=999;a.lastSettlement.push(ledgerRow());
 assert.equal(b.treasury.coin,0);assert.equal(b.lastSettlement.length,0);
});

test('validateFiscal accepts the seed and rejects every broken invariant',()=>{
 const bad=mutate=>{const s=seedFiscal();mutate(s);return s;};
 const cases=[
  [bad(s=>{s.version=2;}),/版本/],
  [bad(s=>{s.treasury.coin=-1;}),/国库钱/],
  [bad(s=>{s.treasury.food=-0.5;}),/国库粮/],
  [bad(s=>{s.treasury.corvee=Number.NaN;}),/国库民力/],
  [bad(s=>{s.treasury.manpower=Infinity;}),/国库兵役/],
  [bad(s=>{s.taxRate=1.5;}),/税率/],
  [bad(s=>{s.taxRate=-0.01;}),/税率/],
  [bad(s=>{s.corruption=1.0001;}),/腐败/],
  [bad(s=>{s.corruption=-1;}),/腐败/],
  [bad(s=>{s.arrearsDays=-1;}),/欠饷天数/],
  [bad(s=>{s.arrearsDays=Number.NaN;}),/欠饷天数/],
  [bad(s=>{delete s.treasury.coin;}),/国库/],
  [bad(s=>{s.treasury.gold=1;}),/国库/],
  [bad(s=>{delete s.treasury;}),/国库/],
  [bad(s=>{s.lastSettlement=Array.from({length:51},()=>ledgerRow());}),/50/],
  [bad(s=>{s.lastSettlement=[ledgerRow(-1)];}),/日号/],
  [bad(s=>{s.lastSettlement=[{day:0,income:{coin:-1,food:0,corvee:0,manpower:0},expense:{...ZERO},note:'n'}];}),/收入钱/],
  [bad(s=>{s.lastSettlement=[{day:0,income:{...ZERO},expense:{coin:0,food:0,corvee:0,manpower:0},note:'x'.repeat(501)}];}),/摘要/],
  [bad(s=>{delete s.lastSettlement;}),/结算记录/],
 ];
 for(const [s,re] of cases)assert.throws(()=>validateFiscal(s),re,`应当拒绝：${re}`);
 // 边界合法值：税率与腐耗可取到 0 与 1，欠饷与库存可以很大
 const edge=seedFiscal();edge.taxRate=0;edge.corruption=1;edge.arrearsDays=1e6;edge.treasury.manpower=1e9;
 validateFiscal(edge);
 // 结算记录恰好 50 条仍然合法：丢最旧的规则是上限，不是触发的门槛
 const fifty=seedFiscal();fifty.lastSettlement=Array.from({length:50},()=>ledgerRow(3));
 validateFiscal(fifty);
});

test('fiscalIncome folds provinces through tax and corruption, and never books food',()=>{
 const w=fixture();
 const income=fiscalIncome(w,365,0.3,0.15);
 // 汉中+益州 365 日 coin 产出 = (900000+2200000)×1.05（两省皆有守将）= 3255000
 assert.ok(Math.abs(income.coin-3255000*0.3*0.85)<1e-6,`coin 应 = Σ产出 × 税率 × (1-腐耗)，实得 ${income.coin}`);
 assert.ok(Math.abs(income.corvee-4620000*0.85)<1e-6,'民力不收税，但被腐败消耗');
 assert.equal(income.manpower,11550,'兵役人口不收税也不被腐败吃');
 assert.equal(income.food,0,'粮食不走国库：它已结余在治所库存，此处必须恒为 0');
 // 税率归零只收不到钱：民力与兵役照征，税是钱的专属概念
 const zero=fiscalIncome(w,365,0,0.15);
 assert.equal(zero.coin,0);assert.equal(zero.manpower,11550);assert.ok(zero.corvee>0);
 // 腐败翻倍只吃钱与民力，不动兵役
 const rot=fiscalIncome(w,365,0.3,0.3);
 assert.ok(Math.abs(rot.coin-3255000*0.3*0.7)<1e-6);
 assert.ok(Math.abs(rot.corvee-4620000*0.7)<1e-6);
 assert.equal(rot.manpower,11550);
 // 天数线性：半年的收入是一年的一半
 const half=fiscalIncome(w,182.5,0.3,0.15);
 assert.ok(Math.abs(half.coin-income.coin/2)<1e-6);
 // 无省世界全零，且不炸
 const bare=fixture();delete bare.provinces;
 assert.deepEqual(fiscalIncome(bare,365,0.3,0.15),{...ZERO});
 // 0 天与负天数不产出
 assert.deepEqual(fiscalIncome(w,0,0.3,0.15),{...ZERO});
 assert.deepEqual(fiscalIncome(w,-5,0.3,0.15),{...ZERO});
 // 确定性：同输入同输出
 assert.deepEqual(fiscalIncome(w,365,0.3,0.15),fiscalIncome(w,365,0.3,0.15));
});

test('armyUpkeep prices troops per head per day and never bends to corruption',()=>{
 const w=fixture();
 // 国库口径内的单价 0.2 币/人/日（见 treasury.ts 的校准注释）；本 fixture 无 simulation 层，
 // 属旧刻度 0.02——两侧都由 armyUpkeep 的实际输出钉死
 assert.equal(ARMY_PAY_PER_DAY,0.2);assert.equal(CORVEE_PER_DAY,0.05);
 const u=armyUpkeep(w,10);
 assert.equal(u.coin,1600,'旧刻度：Σ人头 8000 × 0.02 × 10 日');
 assert.equal(u.food,80000,'军粮 = Σ人头 8000 × 1 kg × 10 日');
 // 线性：天数翻倍，币粮翻倍
 const dbl=armyUpkeep(w,20);
 assert.equal(dbl.coin,3200);assert.equal(dbl.food,160000);
 // 人头线性：撤走一支军队，开支按比例下降
 const fewer=fixture();delete fewer.armies['army-jiang-wan'];
 assert.equal(armyUpkeep(fewer,10).coin,1000);
 // 0 天与负天无开支
 assert.deepEqual(armyUpkeep(w,0),{coin:0,food:0});
 assert.deepEqual(armyUpkeep(w,-1),{coin:0,food:0});
 // 覆没军队不再领军饷军粮
 const dead=fixture();dead.armies['army-jiang-wan'].status='destroyed';
 assert.equal(armyUpkeep(dead,10).coin,1000);
 assert.equal(armyUpkeep(dead,10).food,50000);
 // 无军世界零开支
 const bare=fixture();bare.armies={};
 assert.deepEqual(armyUpkeep(bare,10),{coin:0,food:0});
});

test('settleFiscal books income, pays the army, and bottoms out honestly',()=>{
 const w=fixture();
 const s=seedFiscal();
 const first=settleFiscal(s,w,365);
 assert.equal(s.treasury.coin,771625,'先入账 830025，再扣军饷 58400');
 assert.equal(s.treasury.corvee,3927000);
 assert.equal(s.treasury.manpower,11550);
 assert.equal(s.treasury.food,0,'国库的粮仓永远是空的：粮食不走国库');
 assert.equal(s.arrearsDays,0,'库银充足时不应欠饷');
 assert.equal(s.lastSettlement.length,1);
 const rec=s.lastSettlement[0];
 assert.equal(rec.day,0,'结算日号取自世界时钟');
 assert.equal(rec.income.coin,830025);
 assert.equal(rec.expense.coin,58400,'出账 = 实发，不是应发');
 assert.equal(rec.expense.food,0,'军粮不走国库账');
 assert.ok(rec.note.length<=500&&rec.note.includes('欠饷')===false);
 assert.ok(first[0].includes('库入 钱 830025')&&first[0].includes('税率 30%')&&first[0].includes('腐耗 15%'));
 assert.equal(first[1],'军饷 58400，实发 58400');
 assert.ok(!first.some(l=>l.startsWith('欠饷')),'足额发放时不应出现欠饷行');
 validateFiscal(s);
 // 国库见底：只发一部分，欠饷按天累积，且任何一项不许变负
 const s2=seedFiscal();
 setTaxRate(s2,0);   // 税基归零：钱粮两空
 s2.treasury.coin=100;
 const short1=settleFiscal(s2,w,30);
 assert.equal(s2.treasury.coin,0,'实发 100 后国库必须见底且不为负');
 assert.equal(s2.arrearsDays,30,'欠一天记一天');
 assert.equal(short1[1],'军饷 4800，实发 100，短 4700');
 assert.deepEqual(short1.filter(l=>l.startsWith('欠饷')),['欠饷 30 日']);
 const short2=settleFiscal(s2,w,30);
 assert.equal(s2.arrearsDays,60,'欠饷是累计值，不是单次值');
 assert.equal(s2.treasury.coin,0);
 assert.ok(s2.treasury.manpower>0&&s2.treasury.corvee>0,'民力与兵役不看库银：税基归零也照征');
 validateFiscal(s2);
 // 补足后欠饷归零
 const s3=seedFiscal();s3.treasury.coin=1e9;
 const full=settleFiscal(s3,w,30);
 assert.equal(s3.arrearsDays,0,'库银充足即刻清账');
 assert.ok(!full.some(l=>l.startsWith('欠饷')));
 validateFiscal(s3);
});

test('corruption eats income but never the army pay',()=>{
 const w=fixture();
 const honest=seedFiscal(),rotten=seedFiscal();
 setCorruption(rotten,0.9);
 const a=settleFiscal(honest,w,365),b=settleFiscal(rotten,w,365);
 // 军饷一行必须逐字相同：刚性支出不因官吏贪墨而少发一个铜板
 assert.equal(a[1],b[1],'腐败不得影响军饷');
 assert.equal(honest.lastSettlement[0].expense.coin,rotten.lastSettlement[0].expense.coin);
 assert.equal(honest.arrearsDays,rotten.arrearsDays);
 assert.ok(honest.treasury.coin>rotten.treasury.coin,'差别只应体现在收入端');
 assert.ok(Math.abs(honest.treasury.coin-rotten.treasury.coin-(3255000*0.3*0.85-3255000*0.3*0.1))<1e-6);
});

test('lastSettlement keeps only the newest fifty, and zero days settle nothing',()=>{
 const w=fixture(),s=seedFiscal();
 for(let i=0;i<60;i++){w.clock.elapsedDays=i+1;settleFiscal(s,w,1);}
 assert.equal(s.lastSettlement.length,50,'最多 50 条，丢最旧的');
 assert.equal(s.lastSettlement[49].day,60,'最新一条排在最后');
 assert.equal(s.lastSettlement[0].day,11,'第 1..10 条已被丢弃');
 validateFiscal(s);
 // 0 天与负天不结算：不清零欠饷，不多记旧账
 const frozen=structuredClone(s);
 assert.deepEqual(settleFiscal(s,w,0),[]);
 assert.deepEqual(settleFiscal(s,w,-3),[]);
 assert.deepEqual(s,frozen);
});

test('fiscalSummary flags arrears in one line each',()=>{
 const s=seedFiscal();
 assert.deepEqual(fiscalSummary(s),['库钱 0','民力 0','兵役 0','欠饷 0 日']);
 s.treasury.coin=12000;s.treasury.corvee=3000;s.treasury.manpower=5000;s.arrearsDays=3;
 const lines=fiscalSummary(s);
 assert.equal(lines.length,4);
 assert.equal(lines[0],'库钱 12000');assert.equal(lines[1],'民力 3000');assert.equal(lines[2],'兵役 5000');
 assert.equal(lines[3],'欠饷 3 日（恐生哗变）','欠饷 > 0 必须标注，玩家不能对军心后知后觉');
 s.arrearsDays=0;
 assert.equal(fiscalSummary(s)[3],'欠饷 0 日','不欠饷时不标注');
});

test('setTaxRate and setCorruption clamp to 0..1',()=>{
 const s=seedFiscal();
 setTaxRate(s,0.5);assert.equal(s.taxRate,0.5);
 setTaxRate(s,1.5);assert.equal(s.taxRate,1);setTaxRate(s,-2);assert.equal(s.taxRate,0);
 setTaxRate(s,Number.NaN);assert.equal(s.taxRate,0,'NaN 夹紧为 0，不把 NaN 写进国库');
 setCorruption(s,0.2);assert.equal(s.corruption,0.2);
 setCorruption(s,9);assert.equal(s.corruption,1);setCorruption(s,-0.001);assert.equal(s.corruption,0);
 setCorruption(s,0.3333333333);assert.equal(s.corruption,0.33333333,'落账前 round8');
 validateFiscal(s);
});

test('a world without provinces still owes its army, and says why nothing came in',()=>{
 const bare=fixture();delete bare.provinces;
 const s=seedFiscal();
 const out=settleFiscal(s,bare,30);
 assert.ok(out[0].includes('无省可征'),'无省可征必须写明，玩家才对得上空账');
 assert.equal(s.treasury.coin,0);
 assert.equal(s.arrearsDays,30,'没有税基也得发饷：发不出就是欠饷');
 assert.equal(s.lastSettlement[0].expense.coin,0);
 validateFiscal(s);
});

test('three consecutive settlements accumulate monotonically and conserve the ledger',()=>{
 const w=fixture();
 const s=seedFiscal();
 const coins=[];
 for(let i=0;i<3;i++){
  w.clock.elapsedDays+=365;
  const before=s.treasury.coin;
  settleFiscal(s,w,365);
  coins.push(s.treasury.coin);
  assert.ok(s.treasury.coin>before,'库银应逐次增长：年入 83 万 > 年薪饷 5.84 万');
  const rec=s.lastSettlement[i];
  assert.ok(Math.abs(before+rec.income.coin-rec.expense.coin-s.treasury.coin)<1e-6,'守恒：旧库 + 入账 = 新库 + 实发');
 }
 assert.equal(coins[0],771625);assert.equal(coins[1],1543250);assert.equal(coins[2],2314875);
 assert.equal(s.treasury.manpower,11550*3,'兵役人口只增不减');
 assert.equal(s.treasury.corvee,3927000*3);
 assert.equal(s.treasury.food,0,'结算再多次，国库也一粒粮都不存');
 assert.equal(s.arrearsDays,0);
 assert.equal(s.lastSettlement.length,3);
 validateFiscal(s);
 assert.equal(fiscalSummary(s)[0],'库钱 2314875');
 // 确定性：同一世界同一序列，两次推演分文不差
 const w2=fixture(),s2=seedFiscal();
 for(let i=0;i<3;i++){w2.clock.elapsedDays+=365;settleFiscal(s2,w2,365);}
 assert.deepEqual(s2,s);
  // 结算不改动世界：世界状态只由授权的结算层改写
  const frozen=structuredClone(w);
  settleFiscal(s,w,365);
  assert.deepEqual(w,frozen);
});

/* ---------------- 属主口径（B3）：国库只征本方的省、只发本方的饷 ---------------- */

/** 国库口径内的世界：带 simulation 层，玩家恒为 shu，省与军混编三方。 */
function scopedWorld(){
 const w=fixture();
 w.simulation={version:1,mode:'local',playerFactionId:'shu',activeArmyIds:['army-wei-yan','army-jiang-wan'],armies:{}};
 w.cities['c-luoyang']={id:'c-luoyang',name:'洛阳',kind:'city',point:{x:0.6,y:0.3},ownerFactionId:'wei',governor:{id:'governor-c-luoyang',name:'洛阳守将（模拟）'},foodKg:40000,defense:80};
 w.cities['c-jianye']={id:'c-jianye',name:'建业',kind:'city',point:{x:0.7,y:0.6},ownerFactionId:'wu',governor:{id:'governor-c-jianye',name:'建业守将（模拟）'},foodKg:40000,defense:75};
 w.armies['army-luoyang']={id:'army-luoyang',name:'洛阳守军',factionId:'wei',commander:{id:'cmd-luoyang',name:'曹真'},troops:6000,foodKg:30000,morale:70,location:{kind:'city',cityId:'c-luoyang'},status:'stationed'};
 w.armies['army-jianye']={id:'army-jianye',name:'建业守军',factionId:'wu',commander:{id:'cmd-jianye',name:'陆逊'},troops:4000,foodKg:30000,morale:70,location:{kind:'city',cityId:'c-jianye'},status:'stationed'};
 w.provinces['prov-luoyang']=province('prov-luoyang','洛阳','c-luoyang',2600000,2500000,6000,['农','商'],'wei');
 w.provinces['prov-jianye']=province('prov-jianye','扬州','c-jianye',1800000,2300000,5000,['商','盐'],'wu');
 return w;
}
/** 只有 shu 两省（汉中+益州）时的 30 日 coin 入库：双方皆有守将，模式未定。 */
const SHU_ONLY_30=((900000+2200000)*1.05)*(30/365)*0.3*0.85;
/** 四省合计的 30 日 coin 入库（属主过滤失效时会拿到这个数）。 */
const ALL_FOUR_30=SHU_ONLY_30+((2500000+2300000)*1.05)*(30/365)*0.3*0.85;

test('fiscalIncome taxes only the player faction『s provinces, not the whole map',()=>{
 const w=scopedWorld();
 const income=fiscalIncome(w,30,0.3,0.15);
 assert.ok(Math.abs(income.coin-SHU_ONLY_30)<1e-6,`只辖 2 省时应得 ${SHU_ONLY_30}，实得 ${income.coin}`);
 // 关键是「不是全图」：四省合计的 173,854 正是修复前那个六倍虚账的量级
 assert.ok(Math.abs(income.coin-ALL_FOUR_30)>1e5,`不得把魏吴的省算进蜀汉国库：全图四省应为 ${ALL_FOUR_30}`);
 // 属主跟着走：把四省都判给 shu，入库才等于四省合计（过滤器认 ownerFactionId，不是省的数量）
 const owned=scopedWorld();for(const p of Object.values(owned.provinces))p.ownerFactionId='shu';
 assert.ok(Math.abs(fiscalIncome(owned,30,0.3,0.15).coin-ALL_FOUR_30)<1e-6,'属主变更后口径随之变更');
 // 一省不剩：无省可征，入库归零，但民力兵役同样归零（没有可征的人）
 const lost=scopedWorld();for(const p of Object.values(lost.provinces))p.ownerFactionId='wei';
 assert.deepEqual(fiscalIncome(lost,30,0.3,0.15),{...ZERO},'本方无省可征');
 // 无省层旧存档：不炸，全零
 const bare=scopedWorld();delete bare.provinces;
 assert.deepEqual(fiscalIncome(bare,30,0.3,0.15),{...ZERO});
 // 无 simulation 层的局按全图征收（阅览室/外部引擎快照账本不设属主过滤）
 const foreign=fixture();foreign.provinces['prov-luoyang']=province('prov-luoyang','洛阳','hanzhong',2600000,2500000,6000,['商'],'wei');
 const unfiltered=fiscalIncome(foreign,30,0.3,0.15);
 assert.ok(Math.abs(unfiltered.coin-(SHU_ONLY_30+2500000*1.05*(30/365)*0.3*0.85))<1e-6,'无 simulation 层沿用全图口径');
});

test('armyUpkeep pays only the player faction『s armies; enemy troops eat their own wages',()=>{
 const w=scopedWorld();
 assert.equal(armyUpkeep(w,30).coin,48000,'军饷 = 本方 2 军 8,000 人 × 0.2 × 30 日');
 assert.equal(armyUpkeep(w,30).food,240000,'军粮同样只算本方');
 // 把魏吴守军删掉，本方军饷一个子儿都不变——他们的饷从不经过蜀汉国库
 const fewer=structuredClone(w);delete fewer.armies['army-luoyang'];delete fewer.armies['army-jianye'];
 assert.equal(armyUpkeep(fewer,30).coin,48000,'敌军不吃我军饷');
 assert.equal(armyUpkeep(fewer,30).food,240000);
 // 本方覆没的军队不再领军饷
 const dead=structuredClone(w);dead.armies['army-jiang-wan'].status='destroyed';
 assert.equal(armyUpkeep(dead,30).coin,30000,'只剩魏延部 5,000 人');
 // 换一个属主：玩家是 wei 时，饷单变成洛阳+建业两军
 const asWei=scopedWorld();asWei.simulation.playerFactionId='wei';
 assert.equal(armyUpkeep(asWei,30).coin,36000,'洛阳守军 6,000 人 × 0.2 × 30 日');
 // 无 simulation 层：全军一起算（旧口径），饷率也沿用旧刻度 0.02
 const legacy=structuredClone(w);delete legacy.simulation;
 assert.equal(armyUpkeep(legacy,30).coin,18000*0.02*30,'口径外的局沿用旧刻度 0.02 币/人/日');
});

test('a settlement on a scoped world books only what the player owns, and says so',()=>{
 const w=scopedWorld();
 const s=seedFiscal();
 const out=settleFiscal(s,w,30);
 assert.ok(out[0].startsWith('库入 钱 68221.23')&&out[0].includes('本方 2 省'),out[0]);
 assert.ok(out[1].startsWith('军饷 48000（本方 2 军 8000 人），实发 48000'),out[1]);
 assert.ok(Math.abs(s.treasury.coin-(SHU_ONLY_30-48000))<1e-6,`入库 68,221 − 军饷 48,000，实得 ${s.treasury.coin}`);
 assert.equal(s.arrearsDays,0,'开局本方两省养得活本方两军，不欠');
 validateFiscal(s);
});

test('the arrears channel accumulates once the player cannot fund their own army',()=>{
 // 入不敷出的局面一：两省 levy 全募（1.1 万人）之后再加一支兵——年饷越过岁入
 const w=scopedWorld();
 w.armies['army-wei-yan'].troops=12000;      // 军饷 2,400 币/日 > 两省日入库 2,274 币
 const s=seedFiscal();
 const first=settleFiscal(s,w,30);
 assert.equal(s.arrearsDays,30,'第一期就发不出（本方 15,000 人月支 90,000 > 入库 68,221）：欠一天记一天');
 assert.ok(first[2].startsWith('欠饷 30 日'),first[2]);
 assert.equal(s.treasury.coin,0,'入库全填进军饷仍差一截，国库见底且不为负');
 // 欠饷按日累加，不是单期值
 const second=settleFiscal(s,w,30);
 assert.equal(s.arrearsDays,60,'欠饷是累计值');assert.equal(second[2],'欠饷 60 日');
 // 库银一回暖即刻清账（先入账后发饷，同一天补上即不算欠）
 s.treasury.coin=1e6;
 assert.equal(settleFiscal(s,w,30)[2],undefined,'补足后不再欠饷');
 assert.equal(s.arrearsDays,0);
 validateFiscal(s);
 // 入不敷出的局面二：州郡尽失（本方一省不剩）——入库归零而军饷照发，每期都欠
 const lost=scopedWorld();for(const p of Object.values(lost.provinces))p.ownerFactionId='wu';
 const t=seedFiscal();
 assert.equal(settleFiscal(t,lost,30).length,3,'无省可征也要发饷');
 assert.equal(t.arrearsDays,30,'本期短 48,000：入库归零，军饷照发');
 settleFiscal(t,lost,30);
 assert.equal(t.arrearsDays,60,'欠饷按日累加');
 assert.equal(t.treasury.coin,0);validateFiscal(t);
 // 入不敷出的局面三：税率归零（免税年景）——民力兵役照征，钱一分不入
 const broke=scopedWorld();
 const u=seedFiscal();setTaxRate(u,0);
 const lines=settleFiscal(u,broke,30);
 assert.equal(u.arrearsDays,30,'税基归零：钱粮两空，军饷照发');
 assert.ok(u.treasury.corvee>0&&u.treasury.manpower>0,'民力与兵役不看库银：税基归零也照征');
 assert.ok(lines[0].includes('税率 0%'),lines[0]);
 validateFiscal(u);
});

test('arrears booked by the treasury move the mutiny risk across the major line',()=>{
 // 同一支粮足气衰的军：欠饷与否，决定它只值得记一笔，还是必须打断玩家的朝局
 const w=scopedWorld();
 w.armies['army-wei-yan'].morale=30;w.armies['army-wei-yan'].foodKg=1e6; // 不缺粮，只欠饷
 const mutiny=days=>assessUpheaval(w,days).risks.find(r=>r.kind==='mutiny'&&r.subjectId==='army-wei-yan');
 const calm=mutiny(0),owed=mutiny(30);
 assert.equal(calm.risk,0.35,'不欠饷：0.5×(1−30/100)，只是 notable');
 assert.equal(calm.tier,'notable');
 assert.ok(Math.abs(owed.risk-0.55)<1e-9,'欠饷 30 日：+0.2×1，越过 major 线 0.4');
 assert.equal(owed.tier,'major');
 assert.ok(owed.reason.includes('欠饷 30 日'),owed.reason);
 // 本方口径：敌军的风险不进本方预警（与 assessUpheaval 的 scope 约定一致）
 assert.equal(assessUpheaval(w,30).risks.some(r=>['army-luoyang','army-jianye'].includes(r.subjectId)),false);
});

test('the real bootstrap world is scoped: two provinces in, not twelve',()=>{
 // 与 QA 实测同一条路：buildInitialWorld 的真世界（12 省、12 军、蜀汉只辖 2 省）
 const spec={id:'treasury-boot-spec',title:'诸葛亮北伐：子午谷奇谋',scenario:{background:'公元228年春。汉中向长安进军。'},cast:[{id:'wei-yan',name:'魏延',role:'蜀汉将领',description:'测试'}],metrics:[]};
 const boot=()=>buildInitialWorld({id:'treasury-boot-run',spec,mode:'standalone',world:{version:0,day:0,metrics:{},cities:{}},engineTurn:0}).snapshot;
 const w=boot();
 const mine=Object.values(w.provinces).filter(p=>p.ownerFactionId===w.simulation.playerFactionId);
 assert.equal(Object.keys(w.provinces).length,12,'开局 12 省');
 assert.equal(mine.length,2,'蜀汉开局只辖汉中、益州两省');
 const income=fiscalIncome(w,30,0.3,0.15);
 assert.ok(Math.abs(income.coin-SHU_ONLY_30)<1e-6,`30 日入库应 ≈ 6.82 万（本方两省），实得 ${income.coin}`);
 // 修复前这个数是全图 12 省的 40.27 万——六倍虚账，锁死不复活
 assert.ok(Math.abs(income.coin-402725.34246575)>1e5,'不得按全图 12 省入库');
 assert.equal(armyUpkeep(w,30).coin,48000,'军饷只按本方两军 8,000 人计（修复前是全图 12 军 38,000 人的 22,800）');
 const s=seedFiscal();
 const out=settleFiscal(s,w,30);
 assert.ok(out[0].includes('本方 2 省')&&out[1].includes('本方 2 军 8000 人'),out.join('；'));
 assert.equal(s.arrearsDays,0,'两省养两军：不欠');
 // 挂机十年（10 次 365 日结算）：国库量级回到「两省岁入 − 两军年饷」的十倍
 const idle=seedFiscal();
 for(let i=0;i<10;i++){w.clock.elapsedDays+=365;settleFiscal(idle,w,365);}
 assert.ok(Math.abs(idle.treasury.coin-2460250)<1e-3,`十年挂机应 ≈ 246 万（岁入 83.0 万 − 年饷 58.4 万）×10，实得 ${idle.treasury.coin}`);
 assert.ok(idle.treasury.coin>0&&idle.arrearsDays===0,'挂机不欠饷：国库养得起自己的军队');
 assert.ok(Math.abs(idle.treasury.coin-10*(830025-584000))<1e-3,'年度净增 = 岁入 830,025 − 年饷 584,000，无虚账');
});

