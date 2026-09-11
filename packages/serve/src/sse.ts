/**
 * SSE hub（docs/05 §4）—— 全站事件出口：
 * publish(channel, event, data) → 先落库（events 表拿全局 seq）再推给订阅者；
 * subscribe 支持 Last-Event-ID 断线续拉：订阅时回放 seq 之后的历史事件。
 */
import type { FastifyReply } from 'fastify';
import type { SseEnvelope, SseEventName } from '@sim/contracts';
import type { Store } from './store.ts';
import { appendEvent, listEvents } from './store.ts';

interface Subscriber {
  res: FastifyReply;
  timer?: NodeJS.Timeout;
}

export class SseHub {
  private readonly channels = new Map<string, Subscriber[]>();
  private readonly store: Store;

  constructor(store: Store) {
    this.store = store;
  }

  /** 推送事件给某频道（topicId / gameId）的所有订阅者；返回全局 seq。 */
  publish(channel: string, event: SseEventName, data: unknown): number {
    const seq = appendEvent(this.store, channel, event, data);
    const envelope: SseEnvelope = { event, data, ts: new Date().toISOString(), seq };
    const wire = [
      `id: ${envelope.seq}`,
      `event: ${envelope.event}`,
      `data: ${JSON.stringify(data)}`,
      '',
      '',
    ].join('\n');
    for (const sub of this.channels.get(channel) ?? []) {
      sub.res.raw.write(wire);
    }
    return seq;
  }

  /**
   * 订阅频道，返回取消函数（连接关闭/超时时调用）。
   * afterSeq = 客户端 Last-Event-ID：先回放该频道 seq 之后的历史，再进实时流。
   */
  subscribe(
    channel: string,
    res: FastifyReply,
    opts: { afterSeq?: number } = {},
    heartbeatMs = 30_000,
  ): () => void {
    res.raw.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-cache',
      connection: 'keep-alive',
      'x-accel-buffering': 'no',
    });
    res.raw.write('retry: 3000\n\n');
    const sub: Subscriber = { res };
    sub.timer = setInterval(() => res.raw.write(': ping\n\n'), heartbeatMs);

    // 断线续拉：回放 afterSeq 之后的历史（events 表为持久化源）
    if (opts.afterSeq !== undefined) {
      for (const ev of listEvents(this.store, { channel, afterSeq: opts.afterSeq })) {
        const wire = [
          `id: ${ev.seq}`,
          `event: ${ev.event}`,
          `data: ${ev.data}`,
          '',
          '',
        ].join('\n');
        res.raw.write(wire);
      }
    }

    const list = this.channels.get(channel) ?? [];
    list.push(sub);
    this.channels.set(channel, list);
    return () => {
      clearInterval(sub.timer);
      const cur = this.channels.get(channel) ?? [];
      this.channels.set(
        channel,
        cur.filter((s) => s !== sub),
      );
    };
  }

  /** 服务关闭时清掉全部心跳定时器（否则进程挂住） */
  dispose(): void {
    for (const subs of this.channels.values()) {
      for (const sub of subs) clearInterval(sub.timer);
    }
    this.channels.clear();
  }
}