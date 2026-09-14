import type {FastifyInstance} from 'fastify';
import {z} from 'zod';
import {runDebateRound,initMemory,type Persona} from '@sim/engine-core';
import type {ProviderSet} from '@sim/llm';
import {asLlm} from '../gamesflow.ts';
const input=z.object({persona:z.object({id:z.string().max(100),name:z.string().max(100),role:z.string().max(200),description:z.string().max(4000)}),topic:z.string().max(200),background:z.string().max(20000),text:z.string().min(1).max(2000),history:z.string().max(16000),currentScene:z.string().max(2000).optional(),observation:z.unknown()});
export function registerLocalWorldRoutes(app:FastifyInstance,providers:ProviderSet){
 app.post('/api/local-world/reply',async(req,reply)=>{
  const parsed=input.safeParse(req.body);if(!parsed.success)return reply.code(400).send({error:{message:'角色输入格式无效'}});
  const b=parsed.data;
  const p:Persona={...b.persona,stance:'依据自身立场',influence:50,traits:{competence:50,loyalty:50,ambition:50,power:50},prompt:b.persona.description+'\n你只提供意见，不宣告命令已经执行，不创造胜负、伤亡或资源变动。未知敌方情报保持未知。'};
  const cast=[p],memory=initMemory(cast);memory[p.id].history=[b.history];
  const messages=await runDebateRound(cast,{round:1,topic:b.topic,context:b.background+'\n用户本次问题：'+b.text},asLlm(providers.chat),memory,{passes:1,maxRounds:1,maxTokens:600,stateBlock:JSON.stringify(b.observation)});
  let scene:{changed:boolean;summary:string}={changed:false,summary:''};
  try{
    const raw=await providers.chat.generate([{role:'system',content:'判断用户最新消息是否明确改变故事主题或事件阶段，需要更新场景图。普通问答、细节追问、否定画某场景、仅提及类比均为false。只返回JSON {changed:boolean,summary:string}；summary是当前新主题与阶段，最多100字。讨论方案不能写成已发生结果。'},{role:'user',content:JSON.stringify({currentScene:b.currentScene||b.topic,history:b.history.slice(-4000),message:b.text})}],{jsonMode:true,maxTokens:200});
    const v=JSON.parse(raw);if(typeof v.changed==='boolean'&&typeof v.summary==='string'&&v.summary.length<=100)scene=v;
  }catch{/* Scene routing cannot discard a successful character reply. */}
  return {reply:messages[0]?.content||'',speaker:p.id,scene};
 });
}
