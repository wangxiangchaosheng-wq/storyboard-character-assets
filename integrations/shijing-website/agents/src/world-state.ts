import {validateSimulation} from './simulation-state.js';
import {AgentError, assert} from './contracts.js';
import type {Action, Army, ArmyLocation, City, Decision, EntityRef, FieldChange, JsonValue, Mutation, Point, SettlementInput, WorldEvent, WorldSnapshot} from './world-contracts.js';

const forbidden = new Set(['__proto__', 'constructor', 'prototype']);
const object = (x: unknown): x is Record<string, unknown> => !!x && typeof x === 'object' && !Array.isArray(x);
export function record(x: unknown, label: string): asserts x is Record<string, unknown> { assert(object(x), `${label}必须是对象`); }
export function identifier(x: unknown): asserts x is string { assert(typeof x === 'string' && /^[\w-]{1,120}$/.test(x) && !forbidden.has(x), '对象编号无效（使用字母、数字、下划线或短横线）'); }
function text(x: unknown, label: string, max = 2000): asserts x is string { assert(typeof x === 'string' && x.trim().length > 0 && x.length <= max, `${label}无效`); }
function number(x: unknown, label: string, min = 0, max = Number.MAX_SAFE_INTEGER, integer = false): asserts x is number { assert(typeof x === 'number' && Number.isFinite(x) && x >= min && x <= max && (!integer || Number.isSafeInteger(x)), `${label}超出允许范围`); }
function oneOf(x: unknown, values: readonly string[], label: string) { assert(typeof x === 'string' && values.includes(x), `${label}无效`); }
function point(x: unknown): asserts x is Point { record(x, '坐标'); number(x.x, '横坐标', 0, 1); number(x.y, '纵坐标', 0, 1); }
function person(x: unknown) { record(x, '人物'); identifier(x.id); text(x.name, '人物名', 100); }
function location(x: unknown): asserts x is ArmyLocation {
  record(x, '位置'); oneOf(x.kind, ['city', 'route', 'field'], '位置类型');
  if (x.kind === 'city') identifier(x.cityId);
  else if (x.kind === 'route') identifier(x.actionId);
  else { point(x.point); text(x.label, '位置名称', 100); }
}
const armyStatuses = ['stationed', 'marching', 'besieging', 'fighting', 'resting', 'destroyed'];
const actionStatuses = ['planned', 'active', 'completed', 'failed', 'cancelled'];
const decisionStatuses = ['issued', 'executing', 'completed', 'failed', 'cancelled'];
function army(x: unknown): asserts x is Army {
  record(x, '军队'); identifier(x.id); text(x.name, '军队名称', 100); identifier(x.factionId); person(x.commander);
  number(x.troops, '兵力', 0, Number.MAX_SAFE_INTEGER, true); number(x.foodKg, '军粮'); number(x.morale, '士气', 0, 100);
  location(x.location); oneOf(x.status, armyStatuses, '军队状态');
  assert((x.troops === 0) === (x.status === 'destroyed'), '零兵力军队必须标记覆灭，覆灭军队兵力必须为零');
}
function city(x: unknown): asserts x is City {
  record(x, '城池'); identifier(x.id); text(x.name, '城池名称', 100); identifier(x.ownerFactionId); point(x.point);
  oneOf(x.kind, ['city', 'pass'], '城池类型'); if (x.governor !== null) person(x.governor);
  number(x.foodKg, '城池库存'); number(x.defense, '城防', 0, 100);
}
function ref(x: unknown): asserts x is EntityRef { record(x, '关联对象'); identifier(x.id); oneOf(x.type, ['army', 'city', 'action'], '关联对象类型'); }
function action(x: unknown): asserts x is Action {
  record(x, '行动'); identifier(x.id); identifier(x.decisionId); identifier(x.armyId);
  oneOf(x.kind, ['march', 'attack', 'retreat', 'resupply'], '行动类型'); oneOf(x.status, actionStatuses, '行动状态');
  for (const end of [x.origin, x.target]) { record(end, '路线端点'); if (end.cityId !== null) identifier(end.cityId); point(end.point); text(end.label, '端点名称', 100); }
  assert(Array.isArray(x.route) && x.route.length >= 2 && x.route.length <= 200, '路线需要2—200个点'); x.route.forEach(point);
  number(x.progress, '行军进度', 0, 1);
  for (const d of [x.startedDay, x.estimatedArrivalDay, x.endedDay]) if (d !== null) number(d, '行动日期', 0, Number.MAX_SAFE_INTEGER);
}
function decision(x: unknown): asserts x is Decision {
  record(x, '决策'); identifier(x.id); text(x.title, '决策标题', 200); text(x.orderText, '决策命令', 5000); identifier(x.issuerId);
  number(x.issuedDay, '下令日期', 0, Number.MAX_SAFE_INTEGER); oneOf(x.status, decisionStatuses, '决策状态');
  assert(Array.isArray(x.related) && x.related.length <= 200, '关联对象过多或格式不正确'); x.related.forEach(ref);
}
function dictionary(x: unknown, label: string, validate: (v: unknown) => void, allIds?: Set<string>) {
  record(x, label); assert(Object.keys(x).length <= 500, `${label}数量超过500`);
  for (const [key, value] of Object.entries(x)) { identifier(key); record(value, label); assert(key === value.id, `${label}编号与字典键不一致`); validate(value); if (allIds) { assert(!allIds.has(key), '军队、城池、行动和决策编号不能重复'); allIds.add(key); } }
}
export function validateWorld(raw: unknown): asserts raw is WorldSnapshot {
  record(raw, '世界'); assert(raw.schemaVersion === 'world-state/v1', '不支持的世界格式');
  identifier(raw.worldId); identifier(raw.scenarioId); assert(raw.mapId === 'event-map-v1', '当前仅支持事件地图 event-map-v1');
  number(raw.revision, '世界版本', 0, Number.MAX_SAFE_INTEGER, true);
  record(raw.clock, '时间'); text(raw.clock.startLabel, '起始年代', 200); number(raw.clock.elapsedDays, '经过天数', 0, Number.MAX_SAFE_INTEGER);
  dictionary(raw.factions, '势力', v => { record(v, '势力'); identifier(v.id); text(v.name, '势力名', 100); assert(typeof v.color === 'string' && /^#[a-f\d]{6}$/i.test(v.color), '势力颜色需为六位十六进制'); });
  const ids = new Set<string>();
  dictionary(raw.armies, '军队', army, ids); dictionary(raw.cities, '城池', city, ids); dictionary(raw.actions, '行动', action, ids); dictionary(raw.decisions, '决策', decision, ids);
  const w = raw as unknown as WorldSnapshot, day = w.clock.elapsedDays;
  const same = (a: Point, b: Point) => Math.abs(a.x - b.x) < 1e-8 && Math.abs(a.y - b.y) < 1e-8;
  const active = new Set<string>();
  for (const c of Object.values(w.cities)) assert(Object.hasOwn(w.factions, c.ownerFactionId), '城市所属势力不存在');
  for (const a of Object.values(w.actions)) {
    assert(Object.hasOwn(w.armies, a.armyId) && Object.hasOwn(w.decisions, a.decisionId), '行动关联的军队或决策不存在');
    for (const e of [a.origin, a.target]) if (e.cityId !== null) assert(Object.hasOwn(w.cities, e.cityId) && same(e.point, w.cities[e.cityId].point), '路线端点与城市不一致');
    assert(same(a.route[0], a.origin.point) && same(a.route.at(-1)!, a.target.point), '路线首尾必须对应起点和目标');
    assert(a.route.some(p => !same(p, a.route[0])), '行动路线不能为零长度');
    if (a.startedDay !== null) assert(a.startedDay <= day, '出发时间不能在未来');
    if (a.endedDay !== null) assert(a.endedDay <= day && (a.startedDay === null || a.endedDay >= a.startedDay), '结束时间不正确');
    if (a.estimatedArrivalDay !== null && a.startedDay !== null) assert(a.estimatedArrivalDay >= a.startedDay, '预计抵达早于出发');
    if (a.status === 'planned') assert(a.startedDay === null && a.endedDay === null && a.progress === 0, '计划行动不能已有执行进度');
    if (a.status === 'active') {
      assert(!active.has(a.armyId), '同一军队不能同时执行两个行动'); active.add(a.armyId);
      assert(a.startedDay !== null && a.endedDay === null && w.armies[a.armyId].status !== 'destroyed', '执行中的行动或军队状态无效');
      assert(['issued','executing'].includes(w.decisions[a.decisionId].status), '终态决策不能仍有执行中的行动');
    }
    if (['completed','failed','cancelled'].includes(a.status)) assert(a.endedDay !== null, '已结束的行动需要实际结束日期');
    if (a.status === 'completed') assert(a.progress === 1 && a.startedDay !== null, '完成的行动必须有完整进度和出发时间');
  }
  for (const a of Object.values(w.armies)) {
    assert(Object.hasOwn(w.factions, a.factionId), '军队所属势力不存在');
    if (a.location.kind === 'city') { const c = w.cities[a.location.cityId]; assert(c && c.ownerFactionId === a.factionId, '军队不能驻扎在未控制的城市'); assert(['stationed','resting','fighting','destroyed'].includes(a.status), '城内军队状态不正确'); }
    if (a.location.kind === 'route') { const task = w.actions[a.location.actionId]; assert(task && task.armyId === a.id && task.status === 'active' && a.status === 'marching', '在途军队必须对应自己的执行中行动'); }
    if (a.status === 'marching') assert(a.location.kind === 'route', '行军军队必须在路线中');
  }
  for (const d of Object.values(w.decisions)) {
    assert(d.issuedDay <= day, '下令日期不能在未来');
    for (const r of d.related) assert(Object.hasOwn(r.type === 'army' ? w.armies : r.type === 'city' ? w.cities : w.actions, r.id), '决策关联对象不存在');
  }
  validateSimulation(w);
}

export function validateSettlement(raw: unknown): asserts raw is SettlementInput {
  record(raw, '结算'); identifier(raw.settlementId); number(raw.expectedRevision, '预期版本', 0, Number.MAX_SAFE_INTEGER, true);
  if (raw.decisionId !== null) identifier(raw.decisionId);
  oneOf(raw.source, ['referee','rules','demo'], '结算来源'); number(raw.elapsedDays, '推进天数', 0, 3650, true);
  text(raw.title, '事件标题', 200); text(raw.summary, '事件摘要', 5000);
  assert(Array.isArray(raw.mutations) && raw.mutations.length <= 200, '变化清单无效');
  assert(raw.mutations.length > 0 || (raw.elapsedDays as number) > 0, '结算必须产生变化或推进时间');
  for (const m of raw.mutations) {
    record(m, '变化'); text(m.reason, '变化原因');
    switch (m.kind) {
      case 'army.adjust': identifier(m.armyId); assert(['troopsDelta','foodKgDelta','moraleDelta'].some(k => m[k] !== undefined), '缺少军队变化'); for (const k of ['troopsDelta','foodKgDelta','moraleDelta']) if (m[k] !== undefined) number(m[k], k, -Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER, k === 'troopsDelta'); break;
      case 'city.adjust': identifier(m.cityId); assert(['foodKgDelta','defenseDelta'].some(k => m[k] !== undefined), '缺少城市变化'); for (const k of ['foodKgDelta','defenseDelta']) if (m[k] !== undefined) number(m[k], k, -Number.MAX_SAFE_INTEGER); break;
      case 'army.move': identifier(m.armyId); location(m.location); oneOf(m.status, armyStatuses, '军队状态'); break;
      case 'army.create': army(m.army); break;
      case 'city.capture': identifier(m.cityId); identifier(m.ownerFactionId); if (m.governor !== null) person(m.governor); break;
      case 'action.create': action(m.action); break;
      case 'decision.create': decision(m.decision); break;
      case 'decision.update': identifier(m.decisionId); oneOf(m.status, decisionStatuses, '决策状态'); break;
      case 'action.update': identifier(m.actionId); record(m.patch, '行动变化'); assert(Object.keys(m.patch).length > 0 && Object.keys(m.patch).every(k => ['status','progress','startedDay','estimatedArrivalDay','endedDay'].includes(k)), '行动变化字段无效'); break;
      case 'resource.transfer': oneOf(m.resource, ['foodKg','troops'], '转移资源'); number(m.amount, '调拨数量', 0.000001, Number.MAX_SAFE_INTEGER, m.resource === 'troops'); for (const r of [m.from,m.to]) { record(r, '调拨对象'); identifier(r.id); oneOf(r.type, m.resource === 'troops' ? ['army'] : ['army','city'], '调拨对象类型'); } assert(JSON.stringify(m.from) !== JSON.stringify(m.to), '不能向自身调拨'); break;
      default: throw new AgentError('不支持的世界变化操作');
    }
  }
}

const transitions: Record<string, string[]> = {planned:['planned','active','cancelled'],active:['active','completed','failed','cancelled'],completed:['completed'],failed:['failed'],cancelled:['cancelled']};
const decisionTransitions: Record<string, string[]> = {issued:['issued','executing','cancelled'],executing:['executing','completed','failed','cancelled'],completed:['completed'],failed:['failed'],cancelled:['cancelled']};
export function reduceWorld(before: WorldSnapshot, input: SettlementInput): {world: WorldSnapshot; event: WorldEvent} {
  validateSettlement(input); assert(input.expectedRevision === before.revision, '世界版本已变化，请读取最新状态再提交', 409);
  const world = structuredClone(before); world.clock.elapsedDays += input.elapsedDays;
  const changes: FieldChange[] = [], related = new Map<string, EntityRef>();
  function add(type: 'army'|'city'|'action'|'decision', id: string, old: unknown, next: unknown, reason: string) {
    if (type !== 'decision') related.set(type+id, {type,id});
    const prev = old as Record<string,JsonValue> | undefined, current = next as Record<string,JsonValue>;
    const units: Record<string, FieldChange['unit']> = {troops:'人',foodKg:'kg',morale:'分',defense:'分'};
    for (const [field, after] of Object.entries(current)) if (JSON.stringify(prev?.[field]) !== JSON.stringify(after)) changes.push({entity:{type,id},field,before:prev?.[field] ?? null,after:structuredClone(after),unit:units[field],reason});
  }
  const armyById = (id: string) => { assert(Object.hasOwn(world.armies,id), '军队不存在',404); return world.armies[id]; };
  const cityById = (id: string) => { assert(Object.hasOwn(world.cities,id), '城市不存在',404); return world.cities[id]; };
  for (const mutation of input.mutations) {
    const m: Mutation = mutation;
    if (m.kind === 'resource.transfer') {
      const from = m.from.type === 'army' ? armyById(m.from.id) : cityById(m.from.id);
      const to = m.to.type === 'army' ? armyById(m.to.id) : cityById(m.to.id);
      assert(m.from.id !== m.to.id, '不能向自身调拨');
      const owner = (v: Army|City) => 'factionId' in v ? v.factionId : v.ownerFactionId;
      assert(owner(from) === owner(to), '跨势力资源转移需由上游另行结算');
      const a = structuredClone(from), b = structuredClone(to);
      if (m.resource === 'troops') { assert((from as Army).status !== 'destroyed' && (to as Army).status !== 'destroyed', '覆灭军队不能调兵'); (from as Army).troops -= m.amount; (to as Army).troops += m.amount; }
      else { from.foodKg -= m.amount; to.foodKg += m.amount; }
      assert((m.resource === 'troops' ? (from as Army).troops : from.foodKg) >= 0, '资源不足，调拨未执行');
      add(m.from.type,m.from.id,a,from,m.reason); add(m.to.type,m.to.id,b,to,m.reason); continue;
    }
    if (m.kind === 'army.create') { assert(!Object.hasOwn(world.armies,m.army.id), '军队已存在',409); world.armies[m.army.id] = structuredClone(m.army); add('army',m.army.id,undefined,m.army,m.reason); continue; }
    if (m.kind === 'army.adjust' || m.kind === 'army.move') {
      const a = armyById(m.armyId), old = structuredClone(a); assert(a.status !== 'destroyed', '覆灭军队不能继续更新或行动');
      if (m.kind === 'army.adjust') { a.troops += m.troopsDelta ?? 0; a.foodKg += m.foodKgDelta ?? 0; a.morale += m.moraleDelta ?? 0; assert(a.troops >= 0 && a.foodKg >= 0, '兵力或粮草不足，整笔结算未执行'); }
      else { a.location = structuredClone(m.location); a.status = m.status; }
      add('army',a.id,old,a,m.reason); continue;
    }
    if (m.kind === 'city.adjust' || m.kind === 'city.capture') {
      const c = cityById(m.cityId), old = structuredClone(c);
      if (m.kind === 'city.adjust') { c.foodKg += m.foodKgDelta ?? 0; c.defense += m.defenseDelta ?? 0; assert(c.foodKg >= 0, '城池库存不足'); }
      else { c.ownerFactionId = m.ownerFactionId; c.governor = structuredClone(m.governor); }
      add('city',c.id,old,c,m.reason); continue;
    }
    if (m.kind === 'decision.create') { assert(!Object.hasOwn(world.decisions,m.decision.id), '决策已存在',409); world.decisions[m.decision.id] = structuredClone(m.decision); add('decision',m.decision.id,undefined,m.decision,m.reason); continue; }
    if (m.kind === 'decision.update') { assert(Object.hasOwn(world.decisions,m.decisionId), '决策不存在',404); const d = world.decisions[m.decisionId], old = structuredClone(d); assert(decisionTransitions[d.status].includes(m.status), '不允许恢复已结束决策'); d.status=m.status; add('decision',d.id,old,d,m.reason); continue; }
    if (m.kind === 'action.create') { assert(!Object.hasOwn(world.actions,m.action.id), '行动已存在',409); world.actions[m.action.id] = structuredClone(m.action); add('action',m.action.id,undefined,m.action,m.reason); continue; }
    if (m.kind === 'action.update') {
      assert(Object.hasOwn(world.actions,m.actionId), '行动不存在',404); const a = world.actions[m.actionId], old = structuredClone(a);
      assert(['planned','active'].includes(a.status), '已结束行动不能改写');
      if (m.patch.status !== undefined) assert(transitions[a.status].includes(m.patch.status), '行动状态转换无效');
      if (a.startedDay !== null && m.patch.startedDay !== undefined) assert(m.patch.startedDay === a.startedDay, '实际出发时间不能改写');
      if (m.patch.progress !== undefined) assert(m.patch.progress >= a.progress, '行军进度不能倒退；撤退需新建行动');
      Object.assign(a, structuredClone(m.patch)); add('action',a.id,old,a,m.reason);
    }
  }
  if (input.decisionId !== null) assert(Object.hasOwn(world.decisions,input.decisionId), '事件所属决策不存在');
  world.revision++; validateWorld(world);
  for (const r of [...related.values()]) if (r.type === 'action') { const a=world.actions[r.id]; related.set('army'+a.armyId,{type:'army',id:a.armyId}); for (const e of [a.origin,a.target]) if(e.cityId) related.set('city'+e.cityId,{type:'city',id:e.cityId}); }
  if (input.elapsedDays) changes.push({entity:{type:'clock',id:world.worldId},field:'elapsedDays',before:before.clock.elapsedDays,after:world.clock.elapsedDays,unit:'日',reason:'上游确认推进时间'});
  return {world,event:{id:input.settlementId,worldId:world.worldId,settlementId:input.settlementId,decisionId:input.decisionId,revision:world.revision,fromDay:before.clock.elapsedDays,toDay:world.clock.elapsedDays,source:input.source,title:input.title,summary:input.summary,related:[...related.values()],changes}};
}
