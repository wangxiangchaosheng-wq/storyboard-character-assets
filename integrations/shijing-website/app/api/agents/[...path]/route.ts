import {checkOrigin,ServiceError,failure} from '../../../lib/ai-server';
async function proxy(request:Request,{params}:{params:Promise<{path:string[]}>}){
  try{
    checkOrigin(request);const {path}=await params;
    if(request.method==='POST'&&path[0]==='runs'&&['world','world-events'].includes(path[2]))throw new ServiceError('世界写入仅供可信服务端调用，网页只能查询或运行独立演示。',403);
    if(!path.length||path.length>3||path.some(p=>!p||p==='..'||p.includes('/')||p.includes('\\')))throw new ServiceError('接口路径无效',400);
    const rawBase=(process.env.AGENT_SERVICE_URL||'http://127.0.0.1:4318').replace(/\/$/,'');
    let base:URL; try{base=new URL(rawBase);}catch{throw new ServiceError('AGENT_SERVICE_URL 地址格式无效',503);}
    if(!/^(127\.0\.0\.1|localhost|::1)$/.test(base.hostname))throw new ServiceError('AGENT_SERVICE_URL 仅允许指向本地服务',503);
    const headers:Record<string,string>={'Content-Type':'application/json'};if(process.env.AGENT_SERVICE_TOKEN)headers.Authorization=`Bearer ${process.env.AGENT_SERVICE_TOKEN}`;
    const body=request.method==='GET'?undefined:await request.text();if(body&&body.length>200000)throw new ServiceError('请求内容过大',413);
    // 拼接目标 URL 时**不能**直接用 URL 对象做模板字符串：`${base}` 取 toString()，
    // 它永远带一个尾斜杠（连根路径也是 http://127.0.0.1:4318/），再手工补一个 '/' 就成
    // 「//health」。而 sidecar 那头 `new URL('//health','http://localhost')` 会把
    // health 当成主机名、pathname 变成 '/'——路由表全落空，网页侧每一个接口都 404
    // 「接口不存在」（实测：整站 API 不可用）。这里改为 origin + 自己拼的路径段，
    // 保留 AGENT_SERVICE_URL 可能带的路径前缀，与 electron/server.mts 的反代同口径。
    const prefix=base.pathname.replace(/\/+$/,'');
    const target=base.origin+prefix+path.map(p=>'/'+encodeURIComponent(p)).join('')+new URL(request.url).search;
    let response:Response;try{response=await fetch(target,{method:request.method,headers,body,redirect:'error',signal:AbortSignal.timeout(300000)});}catch{throw new ServiceError('后台 Agent 服务尚未启动，请先启动本机 Agent 服务。',503);}
    return new Response(response.body,{status:response.status,headers:{'Content-Type':response.headers.get('content-type')||'application/json','Cache-Control':'no-store','X-Content-Type-Options':'nosniff'}});
  }catch(e){return failure(e);}
}
export const GET=proxy;export const POST=proxy;export const DELETE=proxy;
