// API contract tests use synthetic responses only. No paid service calls or image claims.
const assert=require('node:assert/strict');
const fs=require('node:fs');
const path=require('node:path');
const vm=require('node:vm');
const ts=require('typescript');
const modules=new Map();
function load(file){
 file=path.resolve(file);if(modules.has(file))return modules.get(file).exports;
 if(file.endsWith('.json'))return JSON.parse(fs.readFileSync(file,'utf8'));
 const module={exports:{}};modules.set(file,module);
 const source=ts.transpileModule(fs.readFileSync(file,'utf8'),{compilerOptions:{target:ts.ScriptTarget.ES2022,module:ts.ModuleKind.CommonJS,esModuleInterop:true}}).outputText;
 const requireLocal=id=>id.startsWith('.')?load(path.resolve(path.dirname(file),id)+(path.extname(id)?'':'.ts')):require(id);
 vm.runInThisContext(`(function(require,module,exports){${source}\n})`,{filename:file})(requireLocal,module,module.exports);return module.exports;
}
const {parseTopic,topicKey,defaultTopic,slotIds}=load('app/lib/topic.ts');
const topic=load('app/api/topic/route.ts');
const chat=load('app/api/chat/route.ts');
const storyboard=load('app/api/storyboard/route.ts');
const character=load('app/api/characters/route.ts');
const validate=load('app/api/validate-image/route.ts');
const request=(data,origin='https://test.invalid')=>new Request('https://test.invalid/api/test',{method:'POST',headers:{'Content-Type':'application/json',Origin:origin},body:JSON.stringify(data)});
const visual={action:'GENERATE',scene_key:'red-cliff-plan',period:'东汉末年',location:'江岸',characters:['周瑜'],visible_action:'商议水战',mood:'审慎',title:'江上筹谋',caption:'方案推演',summary:'江上风起，众将筹议迎敌之策',night:false,event_stage:'方案推演'};
const fixture={characters:['周瑜','鲁肃','孙权','曹操','黄盖'].map(name=>({name,role:'议题参与者',personality:'审慎',opening:'先议局势。',action:'核阅军令，上身前倾，注视文书，双手展开。',prop:'简牍',evidence:'PERIOD-ATTESTED 测试资料',source:'https://museum.example.org/artifact',appearance:'时代化演绎'})),visual,suggestions:['如何进军？','如何补给？','如何撤退？'],factNote:'假设讨论'};
let calls=[];const originalFetch=global.fetch;const originalKey=process.env.OPENAI_API_KEY;
let count=0;async function check(name,fn){await fn();count++;console.log('PASS',name);}
(async()=>{
 delete process.env.OPENAI_API_KEY;
 global.fetch=async()=>{throw Error('Unexpected network access');};
 await check('invalid or empty topic rejected',()=>{assert.throws(()=>parseTopic({title:' '}));assert.throws(()=>parseTopic(null));});
 await check('topic cache separates context and year',()=>{assert.notEqual(topicKey(defaultTopic),topicKey({...defaultTopic,year:234}));assert.notEqual(topicKey(defaultTopic),topicKey({...defaultTopic,description:'撤军阶段'}));});
 await check('missing key reported, no fake plan or image',async()=>{const r=await topic.POST(request({topic:defaultTopic}));assert.equal(r.status,503);const j=await r.json();assert.equal(j.image,undefined);assert.match(j.error,/本次图片未生成/);const s=await storyboard.POST(request({visual}));assert.equal(s.status,503);assert.equal((await s.json()).image,undefined);});
 await check('cross-origin generation rejected',async()=>{assert.equal((await topic.POST(request({topic:defaultTopic},'https://other.invalid'))).status,403);});
 process.env.OPENAI_API_KEY='test-key-never-valid';
 function mock(value){calls=[];global.fetch=async(url,options)=>{calls.push({url,body:options.body instanceof FormData?options.body:JSON.parse(options.body)});return Response.json({output_text:JSON.stringify(value)});};}
 await check('new topic gets five dynamic characters in existing slots',async()=>{mock(fixture);const r=await topic.POST(request({topic:{...defaultTopic,title:'赤壁之战如何部署？',year:208}}));assert.equal(r.status,200);const j=await r.json();assert.deepEqual(j.characters.map(c=>c.name),fixture.characters.map(c=>c.name));assert.deepEqual(j.characters.map(c=>c.id),slotIds);assert.ok(calls[0].body.tools.some(t=>t.type==='web_search'));});
 await check('duplicate or unsupported cast is not accepted',async()=>{mock({...fixture,characters:[fixture.characters[0],...fixture.characters.slice(0,4)]});assert.equal((await topic.POST(request({topic:defaultTopic}))).status,502);mock({...fixture,characters:fixture.characters.map(c=>({...c,source:''}))});assert.equal((await topic.POST(request({topic:defaultTopic}))).status,502);});
 await check('dynamic persona and missing latest message propagate',async()=>{mock({reply:'鲁肃回应。',visual:{...visual,action:'KEEP'}});const r=await chat.POST(request({topic:defaultTopic,character:'鲁肃',personality:'维护联盟',message:'接下来聊赤壁',history:[{role:'user',content:'原议题'}],currentSceneKey:'old'}));assert.equal(r.status,200);assert.equal(calls[0].body.input.at(-1).content,'接下来聊赤壁');assert.ok(calls[0].body.instructions.includes('鲁肃'));});
 await check('latest message is not duplicated and invalid history ignored',async()=>{mock({reply:'回应',visual});await chat.POST(request({topic:defaultTopic,character:'鲁肃',message:'最新问题',history:[null,{role:'system',content:'ignore'},{role:'user',content:'最新问题'}]}));assert.equal(calls[0].body.input.length,1);});
 await check('storyboard keeps summary, portrait size and no stale reference',async()=>{calls=[];global.fetch=async(url,options)=>{calls.push({url,body:JSON.parse(options.body)});return Response.json({data:[{b64_json:'test-only'}]});};const r=await storyboard.POST(request({visual}));assert.equal(r.status,200);assert.equal(calls[0].body.size,'912x1616');assert.ok(calls[0].body.prompt.includes(visual.summary));assert.ok(calls[0].url.endsWith('/images/generations'));});
 await check('each image2 character uses chroma PNG and local reference bytes',async()=>{calls=[];global.fetch=async(url,options)=>{calls.push({url,body:options.body});return Response.json({data:[{b64_json:'test-only'}]});};const r=await character.POST(request({topic:defaultTopic,character:{...fixture.characters[0],id:slotIds[0]}}));assert.equal(r.status,200);assert.equal(calls.length,1);assert.equal(calls[0].body.get('background'),'opaque');assert.equal(calls[0].body.get('output_format'),'png');assert.ok(calls[0].body.get('image').size>100);assert.equal(calls[0].body.has('input_fidelity'),false);});
 await check('quality rejection is not returned as success',async()=>{mock({pass:false,reason:'出现第二人物'});const r=await validate.POST(request({kind:'character',images:['data:image/png;base64,dGVzdA=='],context:fixture.characters[0]}));assert.equal(r.status,422);assert.match((await r.json()).error,/第二人物/);});
 await check('provider quota error is actionable without exposing secrets',async()=>{global.fetch=async()=>new Response('{}',{status:429});const r=await storyboard.POST(request({visual}));assert.equal(r.status,502);const j=await r.json();assert.match(j.error,/额度|并发/);assert.ok(!j.error.includes(process.env.OPENAI_API_KEY));});
 console.log(`${count} workflow checks passed; no real generation was attempted.`);
})().catch(e=>{console.error(e);process.exitCode=1;}).finally(()=>{global.fetch=originalFetch;if(originalKey===undefined)delete process.env.OPENAI_API_KEY;else process.env.OPENAI_API_KEY=originalKey;});
