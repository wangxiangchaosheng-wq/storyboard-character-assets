/**
 * 管线编排（docs/01）：状态机跑通全链路，阶段切换经 hook 上报（服务端转发 SSE）。
 *
 *   idle → ingesting → analyzing → filling → generating → validating
 *        →（revising 至多 3 回）→ ready | failed
 *
 * 任意一步抛错 → failed（带 message）；mock 模式下全程离线确定性。
 */
import type { ChatProvider, ProviderSet } from '@sim/llm';
import { MockChatProvider } from '@sim/llm';
import type { TopicInput, PipelineStatus } from '@sim/contracts';
import { ingestTopic } from './ingest.ts';
import { collectFacts } from './facts.ts';
import type { FactCollectOpts } from './facts.ts';
import { generateSpec } from './generate.ts';
import { checkAlignment } from './validate.ts';
import type { PipelineHook, PipelineResult } from './types.ts';

export interface PipelineOpts {
  chat?: ChatProvider;           // 缺省取 providers.chat
  providers?: ProviderSet;
  onStatus?: PipelineHook;       // 阶段切换上报（服务层转 SSE）
  facts?: FactCollectOpts;       // 历史检索/估算（docs/07）；缺省 = 离线不检索
}

function makeStatus(
  topicId: string,
  state: PipelineStatus['state'],
  progress: number,
  round: number,
  extra: Partial<PipelineStatus> = {},
): PipelineStatus {
  return { topicId, state, progress, round, ...extra };
}

export async function runPipeline(
  input: TopicInput,
  opts: PipelineOpts = {},
): Promise<PipelineResult> {
  // 缺省回退 mock：全链路离线可跑（与 createProviders 语义一致）；URL 分支仍受 safeFetch 门禁
  const chat = opts.chat ?? opts.providers?.chat ?? new MockChatProvider();
  const emit = (s: PipelineStatus) => opts.onStatus?.(s);
  let status!: PipelineStatus;
  const topicId = input.kind === 'url' ? input.url : input.text;

  try {
    status = makeStatus(topicId, 'ingesting', 0.05, 0);
    await emit(status);
    const brief = await ingestTopic(input);
    status = makeStatus(topicId, 'analyzing', 0.2, 0);
    await emit(status);

    status = makeStatus(topicId, 'filling', 0.35, 0);
    await emit(status);
    const fill = await collectFacts(brief, chat, opts.facts);
    status = makeStatus(topicId, 'generating', 0.55, 0);
    await emit(status);

    let spec;
    let meta;
    try {
      ({ spec, meta } = await generateSpec(brief, chat, { fill, facts: opts.facts }));
    } catch (e) {
      status = makeStatus(topicId, 'failed', 0.7, 0, {
        lastRevision: [e instanceof Error ? e.message : String(e)],
      });
      await emit(status);
      return { status };
    }
    void meta;

    // 校验 + 至多 3 轮收敛
    status = makeStatus(topicId, 'validating', 0.7, 0);
    await emit(status);
    let issues: string[] = [];
    let check: Awaited<ReturnType<typeof checkAlignment>> | undefined;
    for (let round = 1; round <= 3; round++) {
      check = await checkAlignment(spec, brief, fill);
      if (check.ok) {
        status = makeStatus(topicId, 'ready', 1, round, {
          specId: spec.domain,
          estimatedRate: check.estimatedRate,
          lastRevision: issues.length ? issues : undefined,
        });
        await emit(status);
        return { status, brief, fill, spec, issues: [] };
      }
      issues = check.issues;
      status = makeStatus(topicId, 'revising', 0.75 + round * 0.08, round, {
        lastRevision: issues,
      });
      await emit(status);
      // 修正信号：把校验问题回灌给生成器再生成一次（真实模式下收敛）
      try {
        ({ spec, meta } = await generateSpec(brief, chat, { fill, facts: opts.facts }));
      } catch (e) {
        status = makeStatus(topicId, 'failed', 0.8, round, {
          lastRevision: [e instanceof Error ? e.message : String(e)],
        });
        await emit(status);
        return { status };
      }
    }
    status = makeStatus(topicId, 'ready', 1, 3, {
      specId: spec.domain,
      estimatedRate: check?.estimatedRate ?? 0,
      lastRevision: issues,
    });
    await emit(status);
    return { status, brief, fill, spec, issues };
  } catch (e) {
    status = makeStatus(topicId, 'failed', 1, 0, {
      lastRevision: [e instanceof Error ? e.message : String(e)],
    });
    await emit(status);
    return { status };
  }
}