export type Topic = { title: string; description: string; year: number; season: string; faction: string };
export type CastMember = { id: string; name: string; role: string; personality: string; opening: string; action: string; prop: string; evidence: string; source: string; appearance: string };
export type Visual = { action: 'KEEP' | 'GENERATE'; scene_key: string; period: string; location: string; characters: string[]; visible_action: string; mood: string; title: string; caption: string; summary: string; night: boolean; event_stage: string };
export type TopicPlan = { topic: Topic; characters: CastMember[]; visual: Visual; suggestions: string[]; factNote: string };
export const slotIds = ['zhuge', 'weiyan', 'yangyi', 'jiangwei', 'feiyi'];
export const defaultTopic: Topic = { title: '是否采纳魏延子午谷方案？', description: '讨论奇袭方案的可行性，权衡战机、险道、接应和后勤。方案推演，不视为已经实施。', year: 228, season: '春', faction: 'shu' };
export function parseTopic(value: unknown): Topic {
  if (!value || typeof value !== 'object') throw new Error('缺少议题');
  const v = value as Record<string, unknown>;
  if (typeof v.title !== 'string' || !v.title.trim() || v.title.length > 80) throw new Error('议题标题需为 1–80 字');
  return { title: v.title.trim(), description: typeof v.description === 'string' ? v.description.slice(0, 500) : '', year: typeof v.year === 'number' && Number.isInteger(v.year) && v.year >= 1 && v.year <= 2100 ? v.year : 228, season: ['春','夏','秋','冬'].includes(String(v.season)) ? String(v.season) : '春', faction: ['shu','wei','wu'].includes(String(v.faction)) ? String(v.faction) : 'shu' };
}
export function topicKey(topic: Topic) { return JSON.stringify([topic.title, topic.description, topic.year, topic.season, topic.faction]); }
export const visualSchema = { type: 'object', additionalProperties: false, required: ['action','scene_key','period','location','characters','visible_action','mood','title','caption','summary','night','event_stage'], properties: {
  action: { type: 'string', enum: ['KEEP','GENERATE'] }, scene_key: { type: 'string' }, period: { type: 'string' }, location: { type: 'string' }, characters: { type: 'array', items: { type: 'string' } }, visible_action: { type: 'string' }, mood: { type: 'string' }, title: { type: 'string' }, caption: { type: 'string' }, summary: { type: 'string' }, night: { type: 'boolean' }, event_stage: { type: 'string' }
} };
