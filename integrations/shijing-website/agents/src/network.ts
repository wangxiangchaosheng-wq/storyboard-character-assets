import {execFileSync} from 'node:child_process';
import {Agent,EnvHttpProxyAgent,setGlobalDispatcher} from 'undici';
import {AgentError} from './contracts.js';
/** Never infer approval for a third-party credential destination. */
export function openAIBase(env:NodeJS.ProcessEnv=process.env):string {
  let url:URL;try{url=new URL(env.OPENAI_BASE_URL||'https://api.openai.com/v1');}catch{throw new AgentError('生图服务地址格式不正确',503);}
  if(url.protocol!=='https:'||url.username||url.password||url.search||url.hash)throw new AgentError('生图服务必须使用不含账号或查询参数的 HTTPS 地址',503);
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
