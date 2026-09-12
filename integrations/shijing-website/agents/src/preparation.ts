import type {Job} from './contracts.js';
export function preparationReady(peopleIds:string[],jobs:Job[],loaded:string[],error=''){
 const required=[...peopleIds.map(id=>jobs.filter(j=>j.kind==='portrait'&&j.subjectId===id).at(-1)),jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate).at(-1)];
 return peopleIds.length>0&&!error&&required.every(j=>j?.status==='succeeded'&&!!j.asset&&loaded.includes('/api/agents/assets/'+j.asset));
}
