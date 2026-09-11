/** @sim/topic-pipeline —— 从话题到可玩 spec（docs/01）。 */
export { runPipeline } from './pipeline.ts';
export type { PipelineOpts } from './pipeline.ts';
export { ingestTopic } from './ingest.ts';
export { collectFacts } from './facts.ts';
export type { FactCollectOpts } from './facts.ts';
export { generateSpec } from './generate.ts';
export type { GenMeta, SpecWithMeta } from './generate.ts';
export { deriveNumbers, deriveNumbersOffline, parseNumbers, valuesPrompt } from './values.ts';
export type { DerivedNumbers } from './values.ts';
export { composeDrama } from './drama.ts';
export type { DramaDraft } from './drama.ts';
export { topicSearchTerms } from './facts.ts';
export { checkAlignment } from './validate.ts';
export type { AlignmentCheck } from './validate.ts';
export type { PipelineHook, PipelineResult } from './types.ts';

// 跨包 DTO 便利转发（权威在 @sim/contracts）
export type {
  TopicInput,
  TopicBrief,
  EntityRef,
  Fact,
  FillResult,
  PipelineState,
  PipelineStatus,
} from '@sim/contracts';