import type { AiMessage, AiToolCall, AiToolDefinition, AiUsage, AiChatRequest } from '../providers/types'
import type { AiRole, AiTask } from '../lib/constants'

/** What a task needs from a model, so the router can filter candidates. */
export interface TaskRequirements {
  /** The caller asks for structured JSON output. */
  structured: boolean
  /** The caller needs tool calling. Gated on a *verified* capability. */
  tools: boolean
  /** The caller needs streaming. */
  streaming: boolean
  /** Minimum context length, when the caller knows it. */
  minContext: number | null
}

/** A provider/model combination the router may try, in preference order. */
export interface ResolvedCandidate {
  provider: string
  model: string
  source: 'preferred' | 'fallback' | 'default'
  /** Extra key variables to consult, e.g. the legacy SCRIPT_API_KEY. */
  extraKeyEnvVars: string[]
}

export interface RouteAttempt {
  provider: string
  model: string
  attempt: number
  outcome: 'ok' | 'failed' | 'skipped' | 'blocked'
  errorCode: string | null
  latencyMs: number
  detail: string
}

export interface RouteResult {
  provider: string
  model: string
  text: string
  requestId: string | null
  usage: AiUsage
  finishReason: string | null
  toolCalls: AiToolCall[]
  attempts: RouteAttempt[]
  failovers: number
}

export interface RunTaskParams {
  role: AiRole
  task: AiTask
  ownerId: string
  /** Correlates routing events and guards side effects. */
  taskId?: string
  requirements: TaskRequirements
  messages: AiMessage[]
  temperature?: number
  maxOutputTokens?: number
  responseFormat?: AiChatRequest['responseFormat']
  tools?: AiToolDefinition[]
  /** Validates the model output before the task is marked successful. */
  validate: (text: string) => { ok: boolean; detail: string }
  /** Bounded repair: builds extra messages after a validation failure. */
  repairPrompt?: (failureDetail: string, previousText: string) => AiMessage[]
  signal?: AbortSignal
}
