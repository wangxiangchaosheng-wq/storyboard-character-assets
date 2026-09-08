/**
 * 话题管线 DTO（docs/01）—— 从「用户输入」到「可消费 spec」的跨模块形态。
 * 引擎侧类型仍以 @sim/engine-core 为准；此处只管管线与服务层交换。
 */
export type TopicInput = { kind: 'url'; url: string } | { kind: 'text'; text: string };

export interface TopicBrief {
  id: string;
  title: string;
  body: string;
  sections: { heading: string; text: string }[];
  asks: string[]; // 话题想回答/争论的核心问题
  entities: EntityRef[];
  sourceUrl?: string;
  takenAt: string;
}

export interface EntityRef {
  name: string;
  kind: 'person' | 'place' | 'era' | 'event' | 'other';
}

/** 史实/估算条目（docs/07 §2）—— 估算必标注 */
export interface Fact {
  id: string;
  claim: string;
  entity: string;
  source: 'top' | 'search' | 'rag' | 'ai_estimate';
  estimated: boolean;
  confidence: number; // 0..1
  basis?: string; // 估算推理链
  url?: string; // 出处
  tags?: string[]; // 检索标签（内部库维护）
}

export type FillResult = {
  facts: Fact[];
  gaps: { topic: string; whyMissing: string }[];
};

export type PipelineState =
  | 'idle'
  | 'ingesting'
  | 'analyzing'
  | 'filling'
  | 'generating'
  | 'validating'
  | 'revising'
  | 'ready'
  | 'failed';

export interface PipelineStatus {
  topicId: string;
  state: PipelineState;
  progress: number; // 0..1 估算进度
  round: number; // 生成-校验轮次（≤3）
  lastRevision?: string[];
  specId?: string;
  estimatedRate?: number; // 估算项占比（docs/01 §6 展示）
}