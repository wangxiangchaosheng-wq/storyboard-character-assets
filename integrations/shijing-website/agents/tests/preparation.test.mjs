import test from 'node:test';
import assert from 'node:assert/strict';
import {preparationReady} from '../dist/preparation.js';
const portrait={id:'p',kind:'portrait',subjectId:'person',status:'succeeded',asset:'p.png'};
const story={id:'s',kind:'storyboard',status:'succeeded',asset:'s.png'};
const loaded=['/api/agents/assets/p.png','/api/agents/assets/s.png'];
test('transition waits for latest story and every actual image, including errors and missing tasks',()=>{
 assert.equal(preparationReady(['person'],[portrait],loaded),false);
 for(const status of ['queued','planning','generating','checking','failed','interrupted'])assert.equal(preparationReady(['person'],[portrait,{...story,status}],loaded),false);
 assert.equal(preparationReady(['person'],[portrait,story],loaded.slice(0,1)),false);
 assert.equal(preparationReady(['person','missing'],[portrait,story],loaded),false);
 assert.equal(preparationReady(['person'],[portrait,story],loaded,'connection error'),false);
 assert.equal(preparationReady(['person'],[portrait,story,{...story,id:'new',status:'queued'}],loaded),false);
 assert.equal(preparationReady(['person'],[portrait,story],loaded),true);
});
