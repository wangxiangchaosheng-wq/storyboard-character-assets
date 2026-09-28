export class ServiceError extends Error { constructor(message: string, public status = 502) { super(message); } }
/** Same gate as the agent sidecar: with generation off, no route may reach a paid service. */
export function generationEnabled(): boolean {
  return process.env.AGENT_ALLOW_API_GENERATION !== 'false';
}
/** 凭据只发公网服务：环回、链路本地、私有与保留网段一律拒绝（SSRF 入口）。 */
function isPrivateOrReserved(hostname: string): boolean {
  const host = hostname.replace(/^\[|\]$/g, '').toLowerCase();
  if (host === 'localhost' || host.endsWith('.localhost')) return true;
  if (host.includes(':')) {
    // 整串判断：'::1'.split(':') 过滤空段后只剩 ['1']，按段比前缀会永远落空
    if (host === '::1' || host === '::') return true;
    return /^f[cd]/.test(host) || /^fe[89ab]/.test(host);
  }
  return /^127\./.test(host) || /^0\./.test(host) || /^10\./.test(host) || /^192\.168\./.test(host)
    || /^169\.254\./.test(host) || /^100\.(6[4-9]|[7-9]\d|1[01]\d|12[0-7])\./.test(host)
    || /^172\.(1[6-9]|2\d|3[01])\./.test(host)
    || /^(192\.0\.0|192\.0\.2|198\.18|198\.51\.100|203\.0\.113|224|240)\./.test(host);
}
export function credentials() {
  if (!generationEnabled()) throw new ServiceError('本次部署已关闭在线生成（AGENT_ALLOW_API_GENERATION=false），仅使用本地素材库。', 503);
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ServiceError('尚未连接生成服务，本次图片未生成。请先在服务端配置 OPENAI_API_KEY，再点击重试。', 503);
  let raw: string; try { raw = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, ''); } catch { throw new ServiceError('生图服务地址格式不正确', 503); }
  let url: URL; try { url = new URL(raw); } catch { throw new ServiceError('生图服务地址格式不正确', 503); }
  if (url.protocol !== 'https:') throw new ServiceError('生图服务必须使用 HTTPS 地址', 503);
  if (url.username || url.password) throw new ServiceError('生图服务地址不能包含账号信息', 503);
  if (url.search || url.hash) throw new ServiceError('生图服务地址不能带查询参数', 503);
  if (isPrivateOrReserved(url.hostname)) throw new ServiceError('生图服务地址不允许指向本机、环回、私有或保留网段', 503);
  const allowedHosts = ['api.openai.com'];
  if (!allowedHosts.includes(url.hostname) && process.env.OPENAI_COMPATIBLE_CONFIRMED !== 'true') {
    throw new ServiceError('当前配置为第三方兼容服务，请先确认密钥属于该服务并授权连接。', 503);
  }
  return { key, base: url.origin + url.pathname };
}
type AIResponse = { data?: { b64_json?: string }[]; output_text?: string; output?: { content?: { type: string; text?: string }[] }[] };
export async function aiRequest(path: string, body: Record<string, unknown> | FormData, signal?: AbortSignal) {
  const { key, base } = credentials();
  try {
    const response = await fetch(`${base}/${path}`, { method: 'POST', headers: { Authorization: `Bearer ${key}`, ...(body instanceof FormData ? {} : { 'Content-Type': 'application/json' }) }, body: body instanceof FormData ? body : JSON.stringify(body), signal: signal ? AbortSignal.any([signal, AbortSignal.timeout(240000)]) : AbortSignal.timeout(240000) });
    if (!response.ok) {
      console.error('AI service error', path, response.status, response.headers.get('x-request-id'));
      throw new ServiceError(response.status === 429 ? '生成服务额度或并发已达限制，请稍后重试。' : response.status === 401 ? '生成服务密钥无效，请检查服务端配置。' : `生成服务暂时不可用（${response.status}），请重试。`);
    }
    return await response.json() as AIResponse;
  } catch (error) {
    if (error instanceof ServiceError) throw error;
    throw new ServiceError('生成连接中断或等待超时，请重试。');
  }
}
export function responseText(data: { output_text?: string; output?: { content?: { type: string; text?: string }[] }[] }) {
  return data.output_text || (data.output ?? []).flatMap(item => item.content ?? []).filter(item => item.type === 'output_text').map(item => item.text || '').join('');
}
export async function structured<T>(name: string, instructions: string, input: unknown, schema: Record<string, unknown>, options: { research?: boolean; signal?: AbortSignal; tokens?: number } = {}): Promise<T> {
  const data = await aiRequest('responses', { model: process.env.OPENAI_CHAT_MODEL || 'gpt-5.6-luna', instructions, input, max_output_tokens: options.tokens ?? 5000, ...(options.research && process.env.OPENAI_WEB_SEARCH !== 'false' ? { tools: [{ type: 'web_search' }] } : {}), text: { format: { type: 'json_schema', name, strict: true, schema } } }, options.signal);
  try { return JSON.parse(responseText(data)); } catch { throw new ServiceError('生成结果不完整，请重试。'); }
}
export function failure(error: unknown) { return Response.json({ error: error instanceof ServiceError ? error.message : '请求格式不正确或生成失败，请重试。', status: 'failed' }, { status: error instanceof ServiceError ? error.status : 400, headers: { 'Cache-Control': 'no-store' } }); }
export function checkOrigin(request: Request) {
  const origin = request.headers.get('origin');
  if (origin && origin !== new URL(request.url).origin) throw new ServiceError('请从本站发起生成。', 403);
}
