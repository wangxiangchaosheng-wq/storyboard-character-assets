export class ServiceError extends Error { constructor(message: string, public status = 502) { super(message); } }
export function credentials() {
  const key = process.env.OPENAI_API_KEY;
  if (!key) throw new ServiceError('尚未连接生成服务，本次图片未生成。请先在服务端配置 OPENAI_API_KEY，再点击重试。', 503);
  const base = (process.env.OPENAI_BASE_URL || 'https://api.openai.com/v1').replace(/\/$/, '');
  return { key, base };
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
