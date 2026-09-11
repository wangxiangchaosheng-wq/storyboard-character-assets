import {parseTopic} from './topic-contract.js';
import {parseSpec} from './contracts.js';

// Local cast presets are editable discussion participants, not historical research or simulation results.
const names=['诸葛亮','魏延','杨仪','姜维','费祎','刘禅','赵云','马谡','王平','马岱','廖化','张嶷','蒋琬','董允','李严','司马懿','曹真','张郃','郭淮','曹叡','孙尚香','黄月英','蔡文姬','张春华','刘备','曹操','孙权','周瑜'];
export function localTopicSpec(value:unknown){
 const topic=parseTopic(value),text=topic.title+' '+topic.description;
 const named=names.filter(name=>text.includes(name)||(name==='曹叡'&&text.includes('曹睿')));
 if(/大学生|大[一二三四五][的]?学[生子]|大学.{0,8}学[生子]|穿越学[生子]/.test(text))named.push(/女大学生|女生|女学生/.test(text)?'女大学生':'穿越大学生');
 const roles:Record<string,string>={'诸葛亮':'蜀汉丞相','魏延':'蜀汉将领','杨仪':'蜀汉幕僚','姜维':'蜀汉将领','费祎':'蜀汉文臣','穿越大学生':/人民大学|人大/.test(text)?'人大大三学子':'穿越大学生','女大学生':/人民大学|人大/.test(text)?'人大女大学生':'穿越女大学生'};
 const defaults=topic.faction==='wei'?['司马懿','曹叡','曹真','张郃','郭淮']:topic.faction==='wu'?['孙权','周瑜','孙尚香']:['诸葛亮','魏延','杨仪','姜维','费祎'];
 const cast=[...new Set([...named,...defaults])].slice(0,Math.max(5,named.length));
 return parseSpec({id:'local-'+Date.now().toString(36),title:topic.title,scenario:{background:`公元${topic.year}年${topic.season}。${topic.description}\n当前使用本地预设讨论人物，未调用 AI 选角；名单不代表经考证的实际在场人物。`},cast:cast.map((name,i)=>({id:'local-person-'+i,name,role:roles[name]||'三国人物',description:'使用现有素材库形象；人物立场与行动尚未推演。',stance:'待讨论'})),metrics:[]});
}
