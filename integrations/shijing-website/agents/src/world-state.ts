import {validateSimulation} from './simulation-state.js';
import {AgentError, assert} from './contracts.js';
import type {Action, Army, ArmyLocation, City, Decision, DiplomaticState, EntityRef, FieldChange, FiscalState, JsonValue, Mutation, Point, Province, PoliticalState, SettlementInput, WorldEvent, WorldSnapshot} from './world-contracts.js';
import {validateProvinces,PROVINCE_MODES} from './province.js';
import {validatePolitics} from './politics.js';
import {validateDiplomacy} from './diplomacy.js';
import {validateFiscal} from './treasury.js';
import {validateFocusState} from './focuses.js';
import {TECH_CATEGORIES,MAX_ACTIVE_TECHS,type TechState} from './techs.js';

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
function province(x: unknown): asserts x is Province {
  record(x, '省'); identifier(x.id); text(x.name, '省名', 100); identifier(x.seatCityId); identifier(x.ownerFactionId);
  oneOf(x.mode, PROVINCE_MODES, '治政模式'); if (x.governor !== null) person(x.governor);
  if (x.policy !== null) text(x.policy, '年度方针', 2000);
  assert(Array.isArray(x.memberCityIds) && x.memberCityIds.length <= 50, '属城数量不正确'); x.memberCityIds.forEach(identifier);
  assert(Array.isArray(x.specialties) && x.specialties.length <= 12, '特产数量不正确'); x.specialties.forEach(v => text(v, '特产', 50));
  for (const [label, value] of [['农业', x.agriculture], ['商业', x.commerce], ['兵役', x.manpower]] as const) number(value, `${label}底数`, 0, 1e12);
  text(x.source, '省设定依据', 500);
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
/** 决策字典上限。世界快照里的 decisions 只服务于「近期回看」，权威流水是 world_events
 *  （史官志从中成文，historian.ts 也按事件反查 decisions）。留 500 是硬上限，但在那之前
 *  就该开始淘汰最旧的例行代决，否则长局会突然全线 400。 */
const DECISION_HARD_LIMIT = 500;
const DECISION_SOFT_LIMIT = 400;

function dictionary(x: unknown, label: string, validate: (v: unknown) => void, allIds?: Set<string>) {
  record(x, label); assert(Object.keys(x).length <= DECISION_HARD_LIMIT, `${label}数量超过${DECISION_HARD_LIMIT}`);
  for (const [key, value] of Object.entries(x)) { identifier(key); record(value, label); assert(key === value.id, `${label}编号与字典键不一致`); validate(value); if (allIds) { assert(!allIds.has(key), '军队、城池、行动和决策编号不能重复'); allIds.add(key); } }
}

/**
 * 决策数逼近上限时淘汰最旧的**已完成例行代决**。
 *
 * 为什么必须有：AI 代决（自动补给）每约 2.3 天就记一条决策，实测纯挂机的对局会在
 * 第 ~1150 天触到 500 硬顶，此后**所有跳转与下令全部 400「决策数量超过500」**——
 * 对局永久冻结，而玩家事先看不到任何预兆。这等于一局有隐形的三年寿命。
 *
 * 淘汰口径（保守，逐条都有理由）：
 *   - 只淘汰 `status==='completed'`：还在执行中的不能动；
 *   - 只淘汰自动代决（issuerId 为 ai-marshal / local-defender）：**玩家的战略决策一条不删**，
 *     他们要在策略库与起居注里回看自己的决断；
 *   - 按 issuedDay 从旧到新淘汰：先丢最旧的。
 * 被淘汰的决策并不是历史丢了——它的事件仍在 world_events 里，史官志照旧成文。
 */
export function pruneDecisions(world: WorldSnapshot): number {
  const decisions = (world as unknown as { decisions?: Record<string, unknown> }).decisions;
  if (!decisions) return 0;
  // 正在被 action 引用的决策不能删：validateWorld 会断言 action.decisionId 必须在决策簿里
  // （「行动关联的军队或决策不存在」）。AI 代决的撤退令建了 action，它的 decision 会被
  // stopOrder 标成 completed，下一轮 prune 就可能误删——那时 action 还活着，直接炸。
  const referenced = new Set<string>();
  for (const a of Object.values((world as unknown as { actions?: Record<string, { decisionId?: string }> }).actions ?? {})) {
    if (a?.decisionId) referenced.add(a.decisionId);
  }
  type Entry = { id: string; status: string; issuerId: string; issuedDay: number; title?: string; related?: Array<{ type: string; id: string }> };
  const entries = Object.values(decisions) as Entry[];
  if (entries.length <= DECISION_SOFT_LIMIT) return 0;
  const autoIssuers = new Set(['ai-marshal', 'local-defender']);
  // 例行补给令是玩家自己下的（「每天把部队喂满」是最自然的玩法），却也是唯一能刷满决策簿的
  // 东西：每天一条，470 天就撞 500 硬顶，此后**所有**军令抛「决策数量超过500」——整局冻成
  // 电影。实测 day 522 起一条令都下不去（decisions 500 里 498 条是调拨补给）。
  // 所以「同一支部队从同一座城调粮」只留最近几条：更早的那些被更新的同一条令取代，
  // 玩家回看时看最新的就够，旧的纯属噪声。战略库侧由 world_strategy_snapshots 兜底
  // （strategyMap 见到活决策没了就改读快照表），史官志照旧从 world_events 成文。
  const routineKey = (d: Entry): string | null => {
    if (d.issuerId !== 'player' || d.title !== '调拨补给') return null;
    const army = d.related?.find((r) => r.type === 'army')?.id;
    const city = d.related?.find((r) => r.type === 'city')?.id;
    return army && city ? `${army}|${city}` : null;
  };
  const keepRoutine = new Set<string>();
  const newestPerPair = new Map<string, Entry[]>();
  for (const d of entries) {
    const key = routineKey(d);
    if (!key) continue;
    const list = newestPerPair.get(key) ?? [];
    list.push(d);
    newestPerPair.set(key, list);
  }
  for (const list of newestPerPair.values()) {
    for (const d of list.sort((a, b) => b.issuedDay - a.issuedDay).slice(0, 3)) keepRoutine.add(d.id);
  }
  const droppable = entries
    .filter((d) => d.status === 'completed' && !referenced.has(d.id)
      && (autoIssuers.has(d.issuerId) || (routineKey(d) !== null && !keepRoutine.has(d.id))))
    .sort((a, b) => a.issuedDay - b.issuedDay);
  // 只需要降到软上限以下；能淘汰的候选不够时就尽量删（硬上限仍由 validateWorld 兜底）
  const need = entries.length - DECISION_SOFT_LIMIT;
  let removed = 0;
  for (const d of droppable) {
    if (removed >= need) break;
    delete decisions[d.id];
    removed++;
  }
  return removed;
}
export function validateWorld(raw: unknown): asserts raw is WorldSnapshot {
  record(raw, '世界'); assert(raw.schemaVersion === 'world-state/v1', '不支持的世界格式');
  identifier(raw.worldId); identifier(raw.scenarioId); assert(raw.mapId === 'event-map-v1', '当前仅支持事件地图 event-map-v1');
  number(raw.revision, '世界版本', 0, Number.MAX_SAFE_INTEGER, true);
  record(raw.clock, '时间'); text(raw.clock.startLabel, '起始年代', 200); number(raw.clock.elapsedDays, '经过天数', 0, Number.MAX_SAFE_INTEGER);
  dictionary(raw.factions, '势力', v => { record(v, '势力'); identifier(v.id); text(v.name, '势力名', 100); assert(typeof v.color === 'string' && /^#[a-f\d]{6}$/i.test(v.color), '势力颜色需为六位十六进制'); });
  const ids = new Set<string>();
  dictionary(raw.armies, '军队', army, ids); dictionary(raw.cities, '城池', city, ids); dictionary(raw.actions, '行动', action, ids); dictionary(raw.decisions, '决策', decision, ids);
  if (raw.provinces !== undefined) { dictionary(raw.provinces, '省', province); validateProvinces(raw as unknown as WorldSnapshot); }
  // 剧本题目的终局条件：可选（旧存档没有），有就必须自洽，否则终局判定会被脏数据带偏
  if (raw.scenarioGoal !== undefined) {
    const g = raw.scenarioGoal as { years?: unknown; premise?: unknown };
    record(g, '剧本目标');
    assert(typeof g.years === 'number' && Number.isFinite(g.years) && g.years > 0 && g.years <= 1000, '剧本目标年数无效');
    text(g.premise, '剧本张力', 2000);
  }
  if (raw.politics !== undefined) { record(raw.politics, '朝政'); validatePolitics(raw.politics as unknown as PoliticalState); }
  if (raw.diplomacy !== undefined) { record(raw.diplomacy, '外交'); validateDiplomacy(raw.diplomacy as unknown as DiplomaticState, Object.keys(raw.factions as Record<string,unknown>)); }
  if (raw.fiscal !== undefined) { record(raw.fiscal, '国库'); validateFiscal(raw.fiscal as unknown as FiscalState); }
  if (raw.focuses !== undefined) { record(raw.focuses, '国策'); validateFocusState(raw.focuses); }
  if (raw.techs !== undefined) { record(raw.techs, '科技'); validateTechState(raw.techs as unknown as TechState); }
  validateInTransit(raw);
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

/** 终局判定 v0：仅按城池归属。州郡规模的胜负要等派系/国策系统上线后再扩展，这里先让一局能结束。 */
/** 终局判定的返回值。`reason` 说明是哪条判据促成的，收尾呈现与测试都要用它。 */
export interface WorldVerdict{over:boolean;outcome:'victory'|'defeat'|null;summary:string;reason:VerdictReason}
/** 判据优先级从高到低：覆灭 > 统一 > 剧本年限。旧的「未终局」返回 over:false 且 reason:'ongoing'。 */
export type VerdictReason='ongoing'|'annihilated'|'unified'|'scenario-complete'
/** 剧本建议年数换算成天数。与 economy.ts 的 DAYS_PER_YEAR 同口径（365），避免两边漂移。 */
const DAYS_PER_YEAR=365;
export function worldVerdict(w:WorldSnapshot):WorldVerdict{
 const factions=[...new Set(Object.values(w.cities).map(c=>c.ownerFactionId))];
 const player=w.simulation?.playerFactionId;
 const total=Object.keys(w.cities).length;
 const mine=player?Object.values(w.cities).filter(c=>c.ownerFactionId===player).length:0;
 // 剧本终局只对「声明了目标的剧本」生效：scenarioVerdict 早就以 scenarioGoal 为前提，
 // 胜负线同属剧本契约，手搓世界与旧存档不受这两条提前收尾影响。
 const scripted=!!w.scenarioGoal;
 // 尽失州郡不必等剧本年限：家底没了就没有下一步可走，立刻收尾。
 if(scripted&&player&&total>0&&mine===0)return{over:true,outcome:'defeat',summary:'尽失州郡，社稷倾覆',reason:'annihilated'};
 // 城池过半即战略已定，不必空转到年限才看到结局：一条打得通的北伐线约四个月就能过半，
 // 却要玩家再挂机九年才结算——收尾必须跟着形势走。剧本上限留给「师老无功」那条线。
 if(scripted&&player&&total>0&&mine*2>=total&&factions.length>1)return{over:true,outcome:'victory',summary:`城池过半（${mine}/${total}），北伐之势已成`,reason:'scenario-complete'};
 // 只剩一个势力时才谈得上统一；多个势力并存时先看剧本年限。
 if(factions.length>1)return scenarioVerdict(w);
 if(!player)return{over:false,outcome:null,summary:'',reason:'ongoing'};
 return{over:true,outcome:'victory',summary:'天下一统，四海归心',reason:'unified'};
}
/**
 * 剧本年限终局：推进到剧本建议年数即收尾，按当时占城多少判胜败。
 *
 * 为什么需要：只有「统一/覆灭」两条判据时，本剧本实测三种打法都到不了终局——可扩张方向
 * 只有一个（汉中→长安）、又没有攻城器械，玩家玩到「推不动」为止，从未见过收尾。按
 * targetYears 收尾让「一局」有明确边界，玩家的时间和决策才有落点。
 */
function scenarioVerdict(w:WorldSnapshot):WorldVerdict{
 const goal=w.scenarioGoal;
 if(!goal||!Number.isFinite(goal.years)||goal.years<=0)return{over:false,outcome:null,summary:'',reason:'ongoing'};
 if(w.clock.elapsedDays<goal.years*DAYS_PER_YEAR)return{over:false,outcome:null,summary:'',reason:'ongoing'};
 const player=w.simulation?.playerFactionId;
 const total=Object.keys(w.cities).length;
 const mine=player?Object.values(w.cities).filter(c=>c.ownerFactionId===player).length:0;
 const held=total?mine/total:0;
 // 过半是「守住了这一局争的东西」，不过半是「劳而无功」——都不算输，只是收尾不同。
 if(held>=.5)return{over:true,outcome:'victory',summary:`${goal.years}年之期已满：城池过半，粮道未绝。${goal.premise}`,reason:'scenario-complete'};
 return{over:true,outcome:'defeat',summary:`${goal.years}年之期已满：所据不足半数，师老无功。${goal.premise}`,reason:'scenario-complete'};
}

/** 科技层校验：点数界内、清单 4 类分层、前置只指更低层、同时在研不超过两项。 */
export function validateTechState(raw:unknown):void {
 if(raw===undefined||raw===null)return;
 const s=raw as import('./techs.js').TechState;
 if(!s||typeof s!=='object')throw new AgentError('科技层格式无效',500);
 if(s.version!==1)throw new AgentError('不支持的科技层版本',500);
 if(typeof s.points!=='number'||!Number.isFinite(s.points)||s.points<0||s.points>s.pointsCap+1e-9)throw new AgentError('科技点越界',500);
 if(!Number.isFinite(s.pointsPerDay)||!Number.isFinite(s.pointsCap)||s.pointsPerDay<0||s.pointsCap<1)throw new AgentError('科技点累积参数无效',500);
 if(!Array.isArray(s.available)||s.available.length>40)throw new AgentError('科技清单无效',500);
 if(!Array.isArray(s.active)||s.active.length>MAX_ACTIVE_TECHS)throw new AgentError('在研科技过多',500);
 if(!Array.isArray(s.completed))throw new AgentError('科技完成记录无效',500);
 const known=new Map(s.available.map(t=>[t.id,t]));
 for(const t of s.available){
  if(!TECH_CATEGORIES.includes(t.category))throw new AgentError('科技类别无效',500);
  if(![1,2,3].includes(t.tier))throw new AgentError('科技分层无效',500);
  for(const r of t.requires){
   const pre=known.get(r);
   if(!pre)throw new AgentError(`前置 ${r} 不在清单内`,500);
   if(pre.tier>=t.tier)throw new AgentError(`前置 ${pre.title} 不低于 ${t.title} 一层`,500);
  }
 }
 for(const a of s.active){
  if(typeof a.techId!=='string'||!Number.isFinite(a.startedDay)||!Number.isFinite(a.endsDay))throw new AgentError('在研科技格式无效',500);
  if(a.endsDay<a.startedDay)throw new AgentError('科技完成日早于立项日',500);
 }
}

/** 在途层校验：驿报与诏令的到达日都不能早于发生日/下发日，否则「未发先至」。 */
export function validateInTransit(raw:unknown):void{
 if(raw===undefined||raw===null)return;
 const w=raw as {incomingEvents?:unknown[];pendingEdicts?:unknown[]};
 if(w.incomingEvents!==undefined){
  for(const e of w.incomingEvents as import('./courier.js').IncomingEvent[]){
   if(typeof e.eventId!=='string'||!Number.isFinite(e.happenedDay)||!Number.isFinite(e.arrivalDay))throw new AgentError('在途驿报格式无效',500);
   if(e.arrivalDay<e.happenedDay)throw new AgentError('驿报早于事发之日',500);
   if(e.kind!=='decision'&&e.kind!=='news')throw new AgentError('驿报类别无效',500);
  }
 }
 if(w.pendingEdicts!==undefined){
  for(const e of w.pendingEdicts as import('./courier.js').PendingEdict[]){
   if(typeof e.id!=='string'||typeof e.armyId!=='string'||typeof e.kind!=='string')throw new AgentError('在途诏令格式无效',500);
   if(!Number.isFinite(e.issuedDay)||!Number.isFinite(e.arrivalDay))throw new AgentError('在途诏令日期无效',500);
   if(e.arrivalDay<e.issuedDay)throw new AgentError('诏令早于下发之日',500);
  }
 }
}
