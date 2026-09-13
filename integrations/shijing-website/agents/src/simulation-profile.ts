import type {RulesProfile,RuleParameter} from './simulation-types.js';
const p=(value:number,min:number,max:number,unit:string,note:string):RuleParameter=>({value,min,max,unit,sourceKind:'simulation',note});
/** These are explicit modelling assumptions. Sources constrain interpretation, not these coefficients. */
export function localProfile():RulesProfile {
 return {id:'hanzhong-local-v1',version:1,status:'experimental',sources:[
  {url:'https://ctext.org/text.pl?if=gb&node=603669&remap=gb',note:'魏延传裴注：子午谷方案是提案，十日不是实测行军速度；负粮五千不作为公斤数。'},
  {url:'https://ctext.org/text.pl?if=gb&node=602731&show=parallel',note:'张郃传：取水通道影响战局；未提供本模型的伤亡或口粮系数。'}],parameters:{
  marchKmDay:p(20,15,25,'km/day','审核稿基础速度；道路与负重另计'),
  forcedFactor:p(1.3,1.15,1.4,'倍','审核稿急行军倍率'),
  fatigueSpeed:p(.005,.003,.007,'每疲劳点','审核稿疲劳速度折减'),
  fatigueMarch:p(8,6,10,'点/day','审核稿普通行军疲劳'),
  fatigueForced:p(18,15,22,'点/day','审核稿急行军疲劳'),
  fatigueRest:p(15,10,18,'点/day','审核稿充分补给休整恢复'),
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
