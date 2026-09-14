import type {Job} from './contracts.js';
export function preparationReady(peopleIds:string[],jobs:Job[],loaded:string[],error='',paused=false){
 const required=[...peopleIds.map(id=>jobs.filter(j=>j.kind==='portrait'&&j.subjectId===id).at(-1)),jobs.filter(j=>j.kind==='storyboard'&&!j.majorEvent&&!j.majorCandidate).at(-1)];
 // Offline mode waits for available images, not for generation that is disabled.
 const available=paused?required.filter(j=>j?.status==='succeeded'):required;
 return peopleIds.length>0&&!error&&available.every(j=>j?.status==='succeeded'&&!!j.asset&&loaded.includes('/api/agents/assets/'+j.asset));
}
