/**
 * 抓取/规整（docs/01 §2）：TopicInput → TopicBrief。
 * URL 一律经 safeFetch（拒绝私网/本地，防 SSRF——docs/11），正文提取 H1/P 文本。
 */
import { AppError, ERROR_CODES, type TopicBrief, type TopicInput } from '@sim/contracts';
import { safeFetch } from '@sim/llm';
import { readZhihuViaCli } from './zhihu.ts';

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
  const browserUA =
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
  const isZhihu = /zhihu\.com\//.test(input.url);

  // 策略 0：知乎链接 → 官方 zhihu-cli（Access Secret 由 CLI 自管；未装/未认证则静默跳过）
  let body = '';
  let title = '';
  if (isZhihu) {
    const viaCli = await readZhihuViaCli(input.url);
    if (viaCli?.body) {
      body = viaCli.body;
      title = viaCli.title;
    }
  }

  // 策略 1：直连抓正文（百科/新闻/博客等公开页面）
  let lastStatus = 0;
  if (!body) {
    try {
      const res = await safeFetch(input.url, {
        timeoutMs: 15_000,
        headers: { 'user-agent': browserUA },
      });
      lastStatus = res.status;
      if (res.ok) {
        const html = await res.text();
        const clean = stripHtml(html).slice(0, 20_000);
        if (clean) body = clean;
      }
    } catch (e) {
      // SSRF 门禁拒绝（私网/协议白名单）属于安全语义，必须立即上抛，不得回退
      if (e instanceof AppError) throw e;
      /* 其余网络错误 → 走回退 */
    }
  }

  // 策略 2：知乎等反爬站点 → Bing 精确检索该问题（链接须含同一 question id，防模糊匹配串题）
  if (!body) {
    const viaSearch = await fetchViaBing(input.url, browserUA);
    if (viaSearch) body = viaSearch;
  }

  if (!body) {
    // 给前端更明确的下一步指引：知乎反爬通常意味着 zhihu-cli 未认证 / 已触发限流；
    // 用户可以直接粘贴话题标题或正文，体验完全一致
    const hint = isZhihu
      ? '知乎拒绝了直连抓取。请先确认 zhihu-cli 已登录（运行 `zhihu-cli auth status`），或将话题标题/正文直接粘贴到输入框（效果完全相同）。'
      : `该站点拦截了服务端抓取（HTTP ${lastStatus || 'ERR'}）。请把话题标题/正文直接粘贴为文本开始，效果完全相同。`;
    throw new AppError(ERROR_CODES.BAD_INPUT, hint);
  }

  const firstLine = (title || body.split('\n')[0] || input.url).trim();
  return {
    id: `t_${Date.now().toString(36)}`,
    title: firstLine.slice(0, 64) || input.url,
    body,
    sections: [],
    asks: [],
    entities: [],
    sourceUrl: input.url,
    takenAt,
  };
}

/** Bing 精确检索回退：仅当结果链接包含同一 question id 时采用（防模糊匹配串题） */
async function fetchViaBing(url: string, browserUA: string): Promise<string | null> {
  const m = url.match(/question\/(\d+)/);
  if (!m) return null;
  const id = m[1];
  try {
    const res = await safeFetch(
      'https://www.bing.com/search?q=' + encodeURIComponent(url) + '&setlang=zh-CN',
      { timeoutMs: 12_000, headers: { 'user-agent': browserUA, 'accept-language': 'zh-CN,zh;q=0.9' } },
    );
    if (!res.ok) return null;
    const html = await res.text();
    const blockRe =
      /<li class="b_algo"[\s\S]*?<h2[^>]*><a[^>]+href="([^"]+)"[^>]*>([\s\S]*?)<\/a>[\s\S]*?<p[^>]*>([\s\S]*?)<\/p>/g;
    for (const mm of html.matchAll(blockRe)) {
      if (!mm[1].includes('/question/' + id)) continue;
      const title = mm[2].replace(/<[^>]+>/g, '').trim();
      const snippet = mm[3].replace(/<[^>]+>/g, '').trim();
      if (!title) continue;
      return `知乎问题：${title}\n${snippet}`;
    }
  } catch {
    /* 检索失败 → 按无结果处理 */
  }
  return null;
}

// 本地文本指纹：内容相同 → 相同 topicId（去重）
function hashId(s: string): string {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = (Math.imul(h, 31) + s.charCodeAt(i)) >>> 0;
  return h.toString(36);
}