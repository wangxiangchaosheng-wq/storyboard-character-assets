import test from 'node:test';
import assert from 'node:assert/strict';
import {Worker} from '../dist/worker.js';
test('only the opened run triggers generation; unrelated backlog stays queued',async()=>{
 const jobs=['old','opened'].map(runId=>({id:runId,runId,kind:'storyboard',status:'queued',attempts:0,trace:[]}));
 const store={jobs:id=>jobs.filter(j=>!id||j.runId===id),saveJob(){},step(j,status){j.status=status;}};
 const called=[];const provider={async plan(j){called.push(j.runId);throw new Error('fixture');}};
 const worker=new Worker(store,provider);await worker.drain('opened');
 assert.deepEqual(called,['opened']);assert.equal(jobs[0].status,'queued');
});
