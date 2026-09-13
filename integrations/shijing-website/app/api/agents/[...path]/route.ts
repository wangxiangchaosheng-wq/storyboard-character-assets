import {checkOrigin,ServiceError,failure} from '../../../lib/ai-server';
async function proxy(request:Request,{params}:{params:Promise<{path:string[]}>}){
  try{
    checkOrigin(request);const {path}=await params;
    if(request.method==='POST'&&path[0]==='runs'&&['world','world-events'].includes(path[2]))throw new ServiceError('世界写入仅供可信服务端调用，网页只能查询或运行独立演示。',403);
    if(!path.length||path.length>3||path.some(p=>!p||p==='..'||p.includes('/')||p.includes('\\')))throw new ServiceError('接口路径无效',400);
    const base=(process.env.AGENT_SERVICE_URL||'http://127.0.0.1:4318').replace(/\/$/,'');
    const headers:Record<string,string>={'Content-Type':'application/json'};if(process.env.AGENT_SERVICE_TOKEN)headers.Authorization=`Bearer ${process.env.AGENT_SERVICE_TOKEN}`;
    const body=request.method==='GET'?undefined:await request.text();if(body&&body.length>200000)throw new ServiceError('请求内容过大',413);
    let response:Response;try{response=await fetch(`${base}/${path.map(encodeURIComponent).join('/')}${new URL(request.url).search}`,{method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(300000)});}catch{throw new ServiceError('后台 Agent 服务尚未启动，请先启动本机 Agent 服务。',503);}
    return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch(e){return failure(e);}
}
export const GET=proxy;export const POST=proxy;
