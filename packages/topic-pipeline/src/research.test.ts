import {test} from 'node:test';
import assert from 'node:assert/strict';
import {runPipeline} from './pipeline.ts';
import {MockChatProvider} from '@sim/llm';
test('research import provides characters without producing another settlement system',async()=>{
 const result=await runPipeline({kind:'text',text:'诸葛亮和魏延讨论汉中北伐与子午谷奇袭长安，权衡粮草和接应。'},{chat:new MockChatProvider(),researchOnly:true});
 assert.equal(result.status.state,'ready');
 assert.ok(result.spec && result.spec.cast.length>=2);
 assert.deepEqual(result.spec.metrics,[]);
 assert.deepEqual(result.spec.rules,[]);
 assert.deepEqual(result.spec.formulaAudit,[]);
});
