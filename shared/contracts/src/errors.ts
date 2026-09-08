/**
 * 全局唯一错误码（docs/05 §6）—— 所有服务端错误、CLI 错误共用。
 * 100x 输入校验 / 200x 引擎 / 300x 任务 / 400x LLM / 500x 存储
 */
export const ERROR_CODES = {
  /** 输入校验 */
  BAD_INPUT: '1001',
  INVALID_URL_PROTOCOL: '1002', // 非 http/https
  UNSAFE_URL_HOST: '1003',      // localhost/私网/保留地址（docs/11）
  UNKNOWN_METRIC_REF: '1004',
  BAD_SCENARIO_SPEC: '1005',
  /** 引擎 */
  SAVE_CORRUPTED: '2001',
  TURN_REGRESSION: '2002',
  INVALID_ACTION: '2003',
  DETERMINISM_CONFLICT: '2004',
  /** 任务 */
  TASK_NOT_FOUND: '3001',
  TASK_RUNNING: '3002',
  TASK_TIMEOUT: '3003',
  /** LLM */
  PROVIDER_NOT_CONFIGURED: '4001',
  LLM_TIMEOUT: '4002',
  LLM_RATE_LIMITED: '4003',
  LLM_CONTENT_REJECTED: '4004', // 含泄密 deny
  IMAGE_GEN_FAILED: '4005',
  /** 存储 */
  DB_WRITE_FAILED: '5001',
} as const;
export type ErrorCode = (typeof ERROR_CODES)[keyof typeof ERROR_CODES];

/** 统一错误类型：服务端错误响应 / 业务错误都长这样 */
export class AppError extends Error {
  readonly code: ErrorCode;
  readonly details?: unknown;
  constructor(code: ErrorCode, message: string, details?: unknown) {
    super(message);
    this.name = 'AppError';
    this.code = code;
    this.details = details;
  }
}

export interface ApiErrorBody {
  error: { code: ErrorCode; message: string; details?: unknown };
}