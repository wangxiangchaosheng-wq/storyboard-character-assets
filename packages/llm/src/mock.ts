/**
 * 确定性 Mock（离线开发 / 演示 / 测试护栏）：
 * chat / embed / image 全部不联网、可复现。
 */
import type { ChatMessage, ChatProvider, CompletionOpts, StreamChunk } from './providers.ts';
import type { EmbedProvider, ImageGenReq, ImageGenResult, ImageProvider } from './providers.ts';

/** mulberry32 种子伪随机（任一可能产生随机性的分支都有它垫底） */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** FNV-1a 32 位字符串哈希：让不同文本落到不同随机轨道（直接 >>> 0 会把字符串变 0） */
function hashText(s: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < s.length; i++) {
    h ^= s.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 确定性假 chat：可挂剧本（prompt -> 固定返回），否则按种子生成可复现回复。 */
export class MockChatProvider implements ChatProvider {
  readonly name = 'mock';
  private readonly script: Record<string, string>;
  constructor(script: Record<string, string> = {}) {
    this.script = script;
  }
  isReal(): boolean {
    return false;
  }

  async generate(messages: ChatMessage[], opts: CompletionOpts = {}): Promise<string> {
    const last = messages.at(-1)?.content ?? '';
    const hit = this.script[last];
    if (hit) return hit;
    const rnd = seeded(hashText(last));
    if (opts.jsonMode) {
      return JSON.stringify({
        reply: `（模拟回复）${last.slice(0, 24)}`,
        ok: true,
        tick: Math.floor(rnd() * 100),
      });
    }
    return `（模拟回复：${last.slice(0, 48)}）`;
  }

  async *stream(_messages: ChatMessage[], _opts: CompletionOpts = {}): AsyncIterable<StreamChunk> {
    yield { delta: '（', finished: false };
    yield { delta: '模拟', finished: false };
    yield { delta: '流式）', finished: true };
  }
}

/** 确定性假 embedding：文本 -> 32 维单位向量（同一文本永远同向量） */
export class MockEmbedProvider implements EmbedProvider {
  async embed(texts: string[]): Promise<number[][]> {
    return texts.map((t) => {
      const rnd = seeded(hashText(t));
      const v = Array.from({ length: 32 }, () => rnd() * 2 - 1);
      const norm = Math.sqrt(v.reduce((s, x) => s + x * x, 0));
      return v.map((x) => x / (norm || 1));
    });
  }
}

/** 确定性假生图：返回内嵌 SVG data URI（不联网），key 由 prompt 决定 */
export class MockImageProvider implements ImageProvider {
  isReal(): boolean {
    return false;
  }

  async gen(req: ImageGenReq): Promise<ImageGenResult> {
    const { prompt, style = '水墨' } = req;
    const rnd = seeded(hashText(prompt + style));
    const tone = `hsl(${Math.floor(rnd() * 360)}, 30%, ${55 + Math.floor(rnd() * 20)}%)`;
    const svg =
      `<svg xmlns='http://www.w3.org/2000/svg' width='512' height='640'>` +
      `<rect width='100%' height='100%' fill='${tone}'/>` +
      `<text x='50%' y='50%' fill='#f5efe0' font-size='30' text-anchor='middle' ` +
      `font-family='serif'>${style} · 占位</text></svg>`;
    return { kind: 'b64', data: Buffer.from(svg).toString('base64'), mime: 'image/svg+xml' };
  }
}