/**
 * 话题管线包内共享类型。跨包 DTO 一律从 @sim/contracts 走（docs/05）。
 */
import type {
  TopicBrief,
  FillResult,
  PipelineStatus,
  TopicInput,
} from '@sim/contracts';
import type { ScenarioSpec } from '@sim/engine-core';

export type { TopicBrief, FillResult, PipelineStatus, TopicInput, ScenarioSpec };

/** reviver：管线阶段切换时触发（服务端据此转发 SSE） */
export type PipelineHook = (status: PipelineStatus) => void | Promise<void>;

export interface PipelineResult {
  status: PipelineStatus;
  brief?: TopicBrief;
  fill?: FillResult;
  spec?: ScenarioSpec;
  /** 生成-校验不通过的具体点（展示给用户可手动修） */
  issues?: string[];
}