import type {RulesProfile,RuleParameter} from './simulation-types.js';
const p=(value:number,min:number,max:number,unit:string,note:string):RuleParameter=>({value,min,max,unit,sourceKind:'simulation',note});
/** These are explicit modelling assumptions. Sources constrain interpretation, not these coefficients. */
export function localProfile():RulesProfile {
 return {id:'hanzhong-local-v1',version:1,status:'experimental',sources:[
  {url:'https://ctext.org/text.pl?if=gb&node=603669&remap=gb',note:'魏延传裴注：子午谷方案是提案，十日不是实测行军速度；负粮五千不作为公斤数。'},
  {url:'https://ctext.org/text.pl?if=gb&node=602731&show=parallel',note:'张郃传：取水通道影响战局；未提供本模型的伤亡或口粮系数。'}],parameters:{
  // 25 而不是 20：汉中↔长安 240km 且 terrainFactor 0.75，20 意味着基础路速只有 15km/日、
  // transit 约 28 天、需粮 ~168t，而魏延部携粮上限是 120t（见 simulation-state 的 capacityKg）
  // ——数量级差距，奇袭流算术上无解。25 后基础路速 18.75km/日、transit 约 16.7 天、
  // 需粮约 100t，落在「困难但可行」那档。区间本来就是 [15,25]，不需要放宽边界，
  // 旧存档照样加载。
  marchKmDay:p(25,15,25,'km/day','审核稿基础速度；道路与负重另计'),
  forcedFactor:p(1.3,1.15,1.4,'倍','审核稿急行军倍率'),
  // .003 而不是 .005：.005 会让疲劳因子在约第 10 天触底 .5，即便路速提到 25 也走不完全程。
  // .003 下第 16 天仍有 0.71，保证 transit 完成。区间本来就是 [.003,.007]。
  fatigueSpeed:p(.003,.003,.007,'每疲劳点','审核稿疲劳速度折减'),
  fatigueMarch:p(8,6,10,'点/day','审核稿普通行军疲劳'),
  fatigueForced:p(18,15,22,'点/day','审核稿急行军疲劳'),
  fatigueRest:p(15,10,18,'点/day','审核稿充分补给休整恢复'),
 // 士气原先只减不增：一战之后归零，此后战斗效能腰斩、任何接触都触发「士气过低」暂停，
 // 一局余下时间再也翻不了身。休整恢复让「打下来→驻屯整备→再出击」成为可执行的循环。
 moraleRest:p(1.5,.5,3,'点/day','驻屯休整、补给充足的士气恢复'),
  forcedLimit:p(70,60,80,'点','审核稿急行军上限'),
  rationKg:p(1,.8,1.2,'kg/person/day','粮食当量；非史料定额'),
  waterLitres:p(4,3,6,'L/person/day','供水游戏抽象，非医学或历史定额'),
  foodMorale:p(8,4,12,'点/day','完全断粮时的模拟士气下降'),
  waterMorale:p(16,8,24,'点/day','完全缺水时的模拟士气下降'),
  hungerDesertion:p(.01,.005,.02,'比例/day','持续断粮48小时后的模拟逃散率'),
  hungerThresholdHours:p(48,24,72,'hour','断粮后进一步影响人员的阈值'),
  lossRate:p(.04,.02,.06,'比例/day','接战期间丧失战力率；待独立案例校准'),
  combatRatioMin:p(.5,.25,.75,'倍','审核稿战力比损失下限'),
  combatRatioMax:p(2,1.5,3,'倍','审核稿战力比损失上限'),
  woundedShare:p(.6,.4,.8,'比例','战斗损失中伤员比例；待校准'),
  recoveryRate:p(.05,.02,.08,'比例/day','安全且补给充分时的伤员恢复率'),
  frontage:p(2500,1000,5000,'人/方','单路接战容量的抽象参数'),
  combatFatigue:p(24,16,32,'点/day','持续接战疲劳'),
  retreatMorale:p(25,20,35,'点','本地守军紧急退出判断'),
  assaultDefender:p(1.5,1.2,2,'倍','完整城防对守军有效战力的最大修正'),
  blockadeNeed:p(1.5,1,2,'倍','完全封锁所需围城可战兵力与守军之比；简化'),
  siegeDamage:p(2,1,3,'城防点/day','每单位攻城能力对城防的持续损伤'),
  pursuitFactor:p(.5,.25,.75,'倍','接触中撤退的追击损失系数'),
  carrierKg:p(40,30,50,'kg/person','独立运输人员装载能力；不含个人装备'),
  shipmentLoss:p(.002,0,.005,'比例/day','运输货物损耗'),
  navigationMax:p(1.05,1,1.1,'倍','已登记熟悉道路的最大导航加成'),
  intelHours:p(24,12,48,'hour','过期情报不用于新的进攻决策'),
  minimumOrderHours:p(6,3,12,'hour','普通本地决策保持时间，紧急事件可打断'),
 }};
}
export const parameter=(profile:RulesProfile,name:string):number=>{
 const p=profile.parameters[name];if(!p)throw new Error('缺少本地规则参数 '+name);return p.value;
};
