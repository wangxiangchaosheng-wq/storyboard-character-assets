import {assert,type World,type Settlement,type Spec} from './contracts.js';
export function initialWorld(spec:Spec,cities:Record<string,string>={}):World {
  assert(cities&&typeof cities==='object'&&!Array.isArray(cities)&&Object.keys(cities).length<=200&&Object.entries(cities).every(([k,v])=>k.length>0&&k.length<100&&typeof v==='string'&&v.length>0&&v.length<100&&!['__proto__','constructor','prototype'].includes(k)),'城市数据无效');
  return {version:0,day:0,metrics:Object.fromEntries(spec.metrics.map(m=>[m.key,m.start])),cities:{...cities}};
}
/** Only confirmed referee events mutate state. Reject the whole event on any invalid field. */
export function settle(world:World,event:Settlement,spec:Spec):World {
  assert(event?.confirmed===true,'只有裁判已确认的结果才能更新世界');
  assert(typeof event.id==='string'&&event.id.length>0&&event.id.length<=200,'事件编号无效');
  assert(event.expectedVersion===world.version,'世界版本已变化，请读取最新状态再提交',409);
  assert(typeof event.summary==='string'&&event.summary.length>0&&event.summary.length<=12000,'缺少事件说明');
  assert(typeof event.significant==='boolean','必须注明是否为重大事件');
  assert(Number.isInteger(event.elapsedDays)&&event.elapsedDays>=0&&event.elapsedDays<=3650,'经过天数无效');
  assert(Array.isArray(event.deltas)&&event.deltas.length<=60&&Array.isArray(event.cityChanges)&&event.cityChanges.length<=200,'事件变化格式无效');
  const next=structuredClone(world); const seen=new Set<string>();
  for(const d of event.deltas){
    const m=spec.metrics.find(m=>m.key===d.metric);
    assert(m&&!seen.has(d.metric)&&Number.isFinite(d.by),'指标不存在、重复或变化量无效'); seen.add(d.metric);
    const value=next.metrics[d.metric]+d.by;
    assert(Number.isFinite(value)&&value>=m.min&&value<=m.max,`${m.label}超出允许范围，事件未执行`);
    next.metrics[d.metric]=value;
  }
  const cities=new Set<string>();
  for(const c of event.cityChanges){
    assert(Object.hasOwn(next.cities,c.city)&&!cities.has(c.city)&&next.cities[c.city]===c.from&&typeof c.to==='string'&&c.to.length>0&&c.to.length<=100,'城市不存在、归属已变化或重复提交');
    cities.add(c.city);next.cities[c.city]=c.to;
  }
  next.day+=event.elapsedDays;next.version++;return next;
}
