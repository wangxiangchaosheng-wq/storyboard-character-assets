/**
 * 抓取/规整（docs/01 §2）：TopicInput → TopicBrief。
 * URL 一律经 safeFetch（拒绝私网/本地，防 SSRF——docs/11），正文提取 H1/P 文本。
 */
import { AppError, ERROR_CODES, type TopicBrief, type TopicInput } from '@sim/contracts';
import { safeFetch } from '@sim/llm';

function stripHtml(src: string): string {
  return src
    .replace(/<script[\s\S]*?<\/script>/gi, ' ')
    .replace(/<style[\s\S]*?<\/style>/gi, ' ')
    .replace(/<title[^>]*>([\s\S]*?)<\/title>/i, (_, t: string) => `\n${t.trim()}\n`)
    .replace(/<h1[^>]*>([\s\S]*?)<\/h1>/gi, '\n$1\n')
    .replace(/<h2[^>]*>([\s\S]*?)<\/h2>/gi, '\n$1\n')
    .replace(/<p[^>]*>([\s\S]*?)<\/p>/gi, '\n$1\n')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/\s+\n/g, '\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

export async function ingestTopic(input: TopicInput): Promise<TopicBrief> {
  const takenAt = new Date().toISOString();
  if (input.kind === 'text') {
    const text = input.text.trim();
    if (!text) throw new AppError('1001', '文本话题为空');
    return {
      id: `t_${hashId(text)}`,
      title: text.slice(0, 32),
      body: text,
      sections: [],
      asks: [text.slice(0, 120)],
      entities: [],
      takenAt,
    };
  }
  // URL 分支：safeFetch 校验后再抓（发请求前已拒绝私网/环回）
  const res = await safeFetch(input.url, {
    timeoutMs: 15_000,
    // 知乎/百科等公开页面会拦裸 UA：带浏览器 UA 抓正文
    headers: {
      'user-agent':
        'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
    },
  });
  if (!res.ok) throw new AppError(ERROR_CODES.BAD_INPUT, `抓取失败 ${res.status}`);
  const html = await res.text();
  const clean = stripHtml(html).slice(0, 20_000);
  if (!clean) throw new AppError(ERROR_CODES.BAD_INPUT, '页面无可提取正文');
  return {
    id: `t_${Date.now().toString(36)}`,
    title: clean.split('\n')[0]?.slice(0, 64) ?? input.url,
    body: clean,
    sections: [],
    asks: [],
    entities: [],
    sourceUrl: input.url,
    takenAt,
  };
}

// 本地文本指纹：内容相同 → 相同 topicId（去重）
function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}