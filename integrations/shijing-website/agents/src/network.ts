import {execFileSync} from 'node:child_process';
import {lookup} from 'node:dns/promises';
import {Agent,EnvHttpProxyAgent,setGlobalDispatcher} from 'undici';
import {AgentError} from './contracts.js';
/**
 * 拒绝指向本机/内网的地址：凭据只能发给公网上的生成服务。
 * 环回、链路本地、私有段与保留段一律不接受——否则一个把地址改写成
 * 127.0.0.1 的配置就能把密钥送到本机端口上（SSRF 的常见入口）。
 */
export function isPrivateOrReserved(hostname:string):boolean{
 const host=hostname.replace(/^\[|\]$/g,'').toLowerCase();
 if(host==='localhost'||host.endsWith('.localhost'))return true;
 // IPv6：整串判断。别拆段——'::1'.split(':') 过滤空段后只剩 ['1']，前缀判断会永远落空。
 if(host.includes(':')){
  if(host==='::1'||host==='::')return true;
  if(/^f[cd]/.test(host))return true;      // fc00::/7 唯一本地地址
  if(/^fe[89ab]/.test(host))return true;   // fe80::/10 链路本地
  return false;
 }
 if(/^127\./.test(host)||/^0\./.test(host)||/^10\./.test(host)||/^192\.168\./.test(host)||/^169\.254\./.test(host)||/^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)||/^172\.(1[6-9]|2\d|3[01])\./.test(host)||/^(192\.0\.0|192\.0\.2|198\.18|198\.51\.100|203\.0\.113|224|240)\./.test(host))return true;
 return false;
}
/**
 * 下载生成服务返回的图片地址。公网 HTTPS 之外一律不发，且不跟随重定向：
 * 返回的 URL 与 base 一样是不可信输入，环回/私有/元数据地址要在这里挡掉。
</
 */
export async function fetchImageBytes(rawUrl:string,timeoutMs=600000):Promise<Buffer>{
  let url:URL;try{url=new URL(rawUrl);}catch{throw new AgentError('图片地址格式不正确',502);}
  if(url.protocol!=='https:'||url.username||url.password)throw new AgentError('图片地址必须是不含账号信息的 HTTPS 地址',502);
  if(isPrivateOrReserved(url.hostname))throw new AgentError('图片地址不允许指向本机、环回、私有或保留网段',502);
  let addresses:string[];try{addresses=(await lookup(url.hostname,{all:true})).map(r=>r.address);}catch{throw new AgentError('图片域名无法解析',502);}
  for(const ip of addresses)if(isPrivateOrReserved(ip))throw new AgentError('图片域名解析到本机、环回、私有或保留网段',502);
  const res=await fetch(url,{signal:AbortSignal.timeout(timeoutMs),redirect:'error'});
  if(!res.ok)throw new AgentError(`图片下载失败（${res.status}）`,502);
  const buf=Buffer.from(await res.arrayBuffer());
  if(buf.length<256)throw new AgentError('图片内容为空',502);
  return buf;
}
/** Never infer approval for a third-party credential destination. */export function openAIBase(env:NodeJS.ProcessEnv=process.env):string {
  let url:URL;try{url=new URL(env.OPENAI_BASE_URL||'https://api.openai.com/v1');}catch{throw new AgentError('生图服务地址格式不正确',503);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new AgentError('生图服务必须使用不含账号或查询参数的 HTTPS 地址',503);
  if(isPrivateOrReserved(url.hostname))throw new AgentError('生图服务地址不允许指向本机、环回、私有或保留网段',503);
  if(url.hostname!=='api.openai.com'&&env.OPENAI_COMPATIBLE_CONFIRMED!=='true')throw new AgentError('当前配置为第三方兼容服务，请先确认密钥属于该服务并授权连接。',503);
  const path=url.pathname.replace(/\/+$/,'');url.pathname=path||'/v1';return url.toString().replace(/\/$/,'');
}
export function systemProxy(text:string):string|undefined {
  const enabled=/HTTPSEnable\s*:\s*1\b/.test(text);
  const host=text.match(/HTTPSProxy\s*:\s*([^\s]+)/)?.[1];const port=text.match(/HTTPSPort\s*:\s*(\d+)/)?.[1];
  if(enabled&&host&&port&&/^(127\.0\.0\.1|localhost|::1)$/.test(host)&&Number(port)>0&&Number(port)<65536)return `http://${host==='::1'?'[::1]':host}:${port}`;
}
export function configureNetwork(){
  const explicit=process.env.HTTPS_PROXY||process.env.HTTP_PROXY;
  if(explicit){setGlobalDispatcher(new EnvHttpProxyAgent({headersTimeout:600000,bodyTimeout:600000,noProxy:process.env.NO_PROXY||'localhost,127.0.0.1,::1'}));return 'environment';}
  if(process.platform==='darwin'&&process.env.OPENAI_USE_SYSTEM_PROXY!=='false'){
    let proxy:string|undefined;try{proxy=systemProxy(execFileSync('/usr/sbin/scutil',['--proxy'],{encoding:'utf8',timeout:2000}));}catch{}
    if(proxy){setGlobalDispatcher(new EnvHttpProxyAgent({headersTimeout:600000,bodyTimeout:600000,httpProxy:proxy,httpsProxy:proxy,noProxy:'localhost,127.0.0.1,::1'}));return 'system';}
  }
  setGlobalDispatcher(new Agent({headersTimeout:600000,bodyTimeout:600000}));return 'direct';
}
