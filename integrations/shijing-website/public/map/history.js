// Historical reference records, separate from player-created discussion scenarios.
const source=(volume)=>`https://zh.wikisource.org/wiki/三國志/卷${volume}`;
export const sources={shu:source('35'),wei:source('03'),wu:source('47')};
export const kingdoms={
 shu:{name:'蜀汉',ruler:'刘禅',seat:'成都',description:'以益州为根基，经汉中向秦岭以北用兵。',focus:'秦岭道路、汉中补给和与东吴的协同。'},
 wei:{name:'曹魏',ruler:'曹叡',seat:'洛阳',description:'控制中原和北方广大地区，西线与蜀汉对峙，东南与孙吴交战。',focus:'关中防御、陇右稳定与东西两线的兵力调度。'},
 wu:{name:'孙吴',ruler:'孙权',seat:'建业',description:'据长江中下游及江南地区，与蜀汉保持联盟，对抗曹魏。',focus:'长江水路、淮南战线与蜀吴联盟。'}
};
// Marker coordinates use the supplied 2048 × 1156 map image as reference.
export const places=[
 {name:'成都',x:460,y:705,faction:'shu',kind:'都城',region:'益州',note:'蜀汉政治中枢。刘禅在此主持朝廷，北伐军需由后方组织转运。'},
 {name:'汉中',x:655,y:522,faction:'shu',kind:'郡与军事区域',region:'益州北部',note:'汉中盆地是蜀汉北伐的主要出发与补给区域；地图标记代表区域，不是全郡的精确边界。'},
 {name:'长安',x:903,y:348,faction:'wei',kind:'城市',region:'关中',note:'曹魏关中重镇。子午谷方案将其作为设想中的进攻目标，不能据此认定已被蜀汉占领。'},
 {name:'洛阳',x:1114,y:408,faction:'wei',kind:'都城',region:'河南地区',note:'曹魏政治中枢，西线与东南战事的部署由朝廷统筹。'},
 {name:'并州',x:942,y:105,faction:'wei',kind:'州',region:'今山西一带',note:'曹魏北方州域，涉及北部边防；本图是州级示意，不对应单座城。'},
 {name:'幽州',x:1414,y:40,faction:'wei',kind:'州',region:'北方、东北方向',note:'曹魏北方州域。辽东公孙氏具有独立性，不能将全域简单视为朝廷直接控制。'},
 {name:'徐州',x:1571,y:386,faction:'wei',kind:'州',region:'黄淮以东',note:'处于曹魏东部，连接淮泗交通和东南战线。'},
 {name:'凉州',x:507,y:220,faction:'wei',kind:'州',region:'西北、河西方向',note:'曹魏西北州域。凉州、雍州和陇右不能完全混称；地图位置为示意。',label:true},
 {name:'荆州',x:1159,y:704,faction:'wu',kind:'州域示意',region:'长江中游',note:'此图标指向吴方荆州区域；荆州北部仍有魏方控制地区，不能把全州都归于吴。'},
 {name:'建业',x:1664,y:593,faction:'wu',kind:'城市',region:'扬州、丹阳郡',note:'孙吴经营江东的重要城市，现今南京一带。'},
 {name:'会稽',x:1745,y:765,faction:'wu',kind:'郡',region:'扬州东南部',note:'孙吴辖下的会稽郡，是江东东南部的重要行政区域；不是州。'},
 {name:'交州',x:1006,y:976,faction:'wu',kind:'州',region:'岭南及今越南北部一带',note:'孙吴南方州域，离建业遥远，治理依赖地方行政与水陆交通。'}
];
export const events=[
 {id:'northern-1',year:228,season:'春',factions:['shu','wei'],places:['汉中','长安','洛阳','成都'],title:'诸葛亮首次北伐',summary:'蜀军出祁山，街亭失利后退回汉中。魏延的子午谷提议属于方案讨论，不是已经实施的战果。',source:sources.shu},
 {id:'shiting',year:228,season:'秋',factions:['wu','wei'],places:['荆州','建业','洛阳'],title:'石亭之战',summary:'陆逊等率吴军击败曹休所部，战场位于淮南方向。',source:sources.wu},
 {id:'chencang',year:228,season:'冬',factions:['shu','wei'],places:['汉中','长安','成都'],title:'围攻陈仓',summary:'诸葛亮出散关围陈仓，未能攻克，随后撤军。',source:sources.shu},
 {id:'wudu',year:229,season:'春',factions:['shu','wei'],places:['汉中','成都','长安'],title:'蜀取武都、阴平',summary:'陈式进攻武都、阴平，诸葛亮进至建威支援，蜀汉取得二郡。',source:sources.shu},
 {id:'wu-emperor',year:229,season:'夏',factions:['wu','shu'],places:['建业','荆州','会稽','交州','成都'],title:'孙权称帝，蜀吴续盟',summary:'孙权在武昌称帝；蜀汉遣陈震庆贺，双方继续结盟。',source:sources.wu},
 {id:'capital-jianye',year:229,season:'秋',factions:['wu'],places:['建业','荆州','会稽','交州'],title:'孙权迁都建业',summary:'孙权从武昌迁都建业，陆逊留辅太子孙登守武昌。',source:sources.wu},
 {id:'wei-invasion',year:230,season:'秋',factions:['wei','shu'],places:['汉中','长安','洛阳','成都'],title:'曹魏进攻汉中',summary:'曹真等分路伐蜀，连日大雨阻碍行军，最终退兵。',source:sources.wei},
 {id:'qishan',year:231,season:'春',factions:['shu','wei'],places:['汉中','长安','成都','洛阳'],title:'再出祁山',summary:'诸葛亮再次出兵祁山，魏方由司马懿等应对。',source:sources.shu},
 {id:'return-231',year:231,season:'夏',factions:['shu','wei'],places:['汉中','长安'],title:'蜀军因粮运退兵',summary:'蜀军粮运受阻后撤，张郃追击时战死。',source:sources.shu},
 {id:'wuzhang',year:234,season:'春',factions:['shu','wei'],places:['汉中','长安','成都','洛阳'],title:'五丈原对峙',summary:'诸葛亮由斜谷出兵，在五丈原与司马懿对峙，并分兵屯田。',source:sources.shu},
 {id:'liang-death',year:234,season:'秋',factions:['shu','wei'],places:['汉中','长安','成都'],title:'诸葛亮病逝，蜀军撤回',summary:'诸葛亮在军中病逝，蜀军随后撤退，北伐进入新的阶段。',source:sources.shu}
];
export const order={春:0,夏:1,秋:2,冬:3};
export function happened(event,year,season){return event.year<year||(event.year===year&&order[event.season]<=order[season]);}
export function knownEvents(year,season){return events.filter(e=>happened(e,year,season));}
export function kingdomInfo(id,year,season){const k={...kingdoms[id]};if(id==='wu'){const emperor=year>229||year===229&&order[season]>=1;const moved=year>229||year===229&&order[season]>=2;k.ruler=emperor?'孙权 · 吴帝':'孙权 · 吴王';k.seat=moved?'建业':'武昌';}return k;}
