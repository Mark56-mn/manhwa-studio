/**
 * The one narrow interface every AI provider implements, and the shared request
 * and result shapes the studio speaks internally.
 *
 * The studio never hard-codes a provider or a model: an adapter is selected by
 * configuration, the concrete model id always travels with the artifact that
 * was produced, and provider-specific differences are translated here so the
 * router and the workflows only ever see the normalized shape below.
 */

export type ChatRole = 'system' | 'user' | 'assistant' | 'tool'

export interface AiMessage {
  role: ChatRole
  content: string
  /** Optional speaker/name for multi-party prompts. */
  name?: string
  /** Set on `tool` messages so a provider can correlate a result. */
  toolCallId?: string
}

/** A tool the model may call, described with a JSON schema. */
export interface AiToolDefinition {
  name: string
  description?: string
  parameters: Record<string, unknown>
}

export interface AiStructuredOutput {
  name: string
  schema: Record<string, unknown>
  strict?: boolean
}

/**
 * The shared internal request format. Every workflow builds this; each adapter
 * translates it into that provider's real API shape.
 */
export interface AiChatRequest {
  model: string
  messages: AiMessage[]
  temperature?: number
  maxOutputTokens?: number
  /** Ask the provider to stream. Adapters that cannot stream reject this. */
  stream?: boolean
  /** Optional structured-output request (JSON schema or JSON object mode). */
  responseFormat?: AiStructuredOutput | { type: 'json_object' }
  /** Optional tool definitions. Only used when the task requires tools. */
  tools?: AiToolDefinition[]
  toolChoice?: 'auto' | 'none' | { name: string }
  /** Cancellation and timeout travel with the request. */
  signal?: AbortSignal
  /** Studio-side correlation id, echoed into routing logs (not a secret). */
  requestId?: string
}

export interface AiUsage {
  inputTokens: number | null
  outputTokens: number | null
  totalTokens: number | null
}

export interface AiToolCall {
  id: string | null
  name: string
  /** Raw JSON string of arguments exactly as the provider returned them. */
  arguments: string
}

/** The normalized result of one non-streaming completion. */
export interface AiChatResult {
  provider: string
  model: string
  text: string
  /** The provider's own request/generation id, when it exposes one. */
  requestId: string | null
  usage: AiUsage
  finishReason: string | null
  toolCalls: AiToolCall[]
}

/** One normalized streaming delta. */
export interface AiStreamChunk {
  delta: string
  done: boolean
  model?: string
  requestId?: string | null
  usage?: AiUsage | null
  finishReason?: string | null
  toolCalls?: AiToolCall[]
}

export type StructuredOutputMode = 'json_schema' | 'json_object' | 'none'

export interface ProviderCapabilities {
  streaming: boolean
  structuredOutput: StructuredOutputMode
  tools: boolean
  vision: boolean
}

export type ModelCostPolicy = 'free' | 'paid' | 'unknown'

export interface DiscoveredModel {
  id: string
  label?: string
  contextLength: number | null
  /** Only 'free' when the provider's own metadata says zero cost. */
  free: ModelCostPolicy
  capabilities?: Partial<ProviderCapabilities>
}

export interface ProviderConfig {
  provider: string
  apiKey: string
  model: string
  /** Resolved base URL (adapter default or an override from the environment). */
  baseUrl: string | null
  /** Optional static headers a provider wants, e.g. OpenRouter attribution. */
  headers?: Record<string, string>
}

export interface ProviderAdapter {
  id: string
  label: string
  docsUrl: string
  /** Environment variable names that can hold this adapter's API key. */
  keyEnvVars: string[]
  /** Environment variable names that can override the base URL. */
  baseUrlEnvVars: string[]
  defaultBaseUrl: string | null
  /** True when the adapter cannot work without a configured base URL. */
  needsBaseUrl: boolean
  defaultModel: string
  suggestedModels: string[]
  /** Capabilities declared by the provider's own documentation. */
  capabilities: ProviderCapabilities
  /** A real, authenticated call that proves the credential works. */
  checkAuth(config: ProviderConfig, signal?: AbortSignal): Promise<void>
  /** Models this credential can actually use, straight from the provider. */
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<DiscoveredModel[]>
  chat(config: ProviderConfig, request: AiChatRequest): Promise<AiChatResult>
  /** Yields normalized deltas. Adapters without streaming reject the request. */
  chatStream(config: ProviderConfig, request: AiChatRequest): AsyncGenerator<AiStreamChunk>
}

export type ProviderErrorCode =
  | 'provider_not_configured'
  | 'provider_unknown'
  | 'provider_unauthorized'
  | 'provider_forbidden'
  | 'provider_rate_limited'
  | 'provider_quota_exhausted'
  | 'provider_model_not_found'
  | 'provider_invalid_request'
  | 'provider_timeout'
  | 'provider_outage'
  | 'provider_bad_response'
  | 'provider_capability_unsupported'
  | 'provider_http_error'

/** An error that carries enough detail to be reported to the owner verbatim. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status: number
  /** Whether trying the *same* model again could plausibly succeed. */
  readonly retryable: boolean
  /** Suggested wait before retrying, in milliseconds, when the provider said. */
  readonly retryAfterMs: number | null

  constructor(
    code: ProviderErrorCode,
    message: string,
    status = 0,
    options: { retryable?: boolean; retryAfterMs?: number | null } = {},
  ) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
    this.retryable = options.retryable ?? isRetryableCode(code)
    this.retryAfterMs = options.retryAfterMs ?? null
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError
}

/** Codes worth retrying on the *same* model (transient infrastructure). */
export function isRetryableCode(code: ProviderErrorCode): boolean {
  return code === 'provider_timeout' || code === 'provider_outage' || code === 'provider_http_error'
}

/** Codes that should pause this model but let the router try another. */
export function isFailoverCode(code: ProviderErrorCode): boolean {
  return (
    code === 'provider_rate_limited' ||
    code === 'provider_quota_exhausted' ||
    code === 'provider_outage' ||
    code === 'provider_timeout' ||
    code === 'provider_model_not_found' ||
    code === 'provider_invalid_request' ||
    code === 'provider_bad_response' ||
    code === 'provider_capability_unsupported' ||
    code === 'provider_forbidden'
  )
}

function looksLikeQuota(message: string): boolean {
  return /quota|insufficient|out of credits|billing|credit balance|exceeded your current/i.test(message)
}

function looksLikeRateLimit(message: string): boolean {
  return /rate limit|too many requests|requests per|tokens per|try again later/i.test(message)
}

/**
 * Maps an HTTP status (and the provider's own message) onto our error taxonomy.
 * The provider's message is preserved so the owner sees the real reason.
 */
export function classifyHttpStatus(status: number, message: string): ProviderErrorCode {
  if (status === 401) return 'provider_unauthorized'
  if (status === 402) return 'provider_quota_exhausted'
  if (status === 403) return 'provider_forbidden'
  if (status === 404) return 'provider_model_not_found'
  if (status === 408 || status === 504) return 'provider_timeout'
  if (status === 429) return looksLikeQuota(message) ? 'provider_quota_exhausted' : 'provider_rate_limited'
  if (status === 400 || status === 409 || status === 422) {
    return looksLikeQuota(message) ? 'provider_quota_exhausted' : 'provider_invalid_request'
  }
  if (status >= 500) return looksLikeRateLimit(message) ? 'provider_rate_limited' : 'provider_outage'
  if (status === 0) return looksLikeQuota(message) ? 'provider_quota_exhausted' : 'provider_http_error'
  return 'provider_http_error'
}


/** Reads an error message out of a provider's own JSON error envelope. */
export async function providerErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `HTTP ${response.status}`
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string } | string
      message?: string
      detail?: string
    }
    const nested = typeof body.error === 'object' && body.error !== null ? body.error.message : body.error
    const message = nested ?? body.message ?? body.detail
    if (typeof message === 'string' && message.trim().length > 0) {
      return `${message.trim()} (HTTP ${response.status})`
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return `${text.slice(0, 300)} (HTTP ${response.status})`
}

function retryAfterFrom(response: Response): number | null {
  const raw = response.headers.get('retry-after')
  if (!raw) return null
  const seconds = Number(raw)
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 60_000)
  const date = Date.parse(raw)
  if (Number.isFinite(date)) return Math.min(Math.max(date - Date.now(), 0), 60_000)
  return null
}

export function toProviderError(response: Response, message: string): ProviderError {
  const code = classifyHttpStatus(response.status, message)
  return new ProviderError(code, message, response.status, { retryAfterMs: retryAfterFrom(response) })
}

/**
 * Runs a fetch, translating aborts and network failures into ProviderError.
 * Cancellation and timeout are normalized so every caller sees the same thing.
 */
export async function providerFetch(url: string, init: RequestInit, timeoutMs: number): Promise<Response> {
  const signal = init.signal ?? AbortSignal.timeout(timeoutMs)
  try {
    return await fetch(url, { ...init, signal })
  } catch (error) {
    const name = error instanceof Error ? error.name : ''
    if (name === 'TimeoutError' || name === 'AbortError') {
      return Promise.reject(
        new ProviderError('provider_timeout', `The provider did not answer within ${Math.round(timeoutMs / 1000)}s.`),
      )
    }
    return Promise.reject(
      new ProviderError(
        'provider_outage',
        `Could not reach the provider: ${error instanceof Error ? error.message : 'network error'}`,
      ),
    )
  }
}

/** Removes an API key from any string before it can reach a log or a response. */
export function redactSecrets(text: string, secret: string | null | undefined): string {
  if (!secret || secret.length < 6) return text
  return text.split(secret).join('[redacted]')
}

export function emptyUsage(): AiUsage {
  return { inputTokens: null, outputTokens: null, totalTokens: null }
}

export function toCapabilities(partial: Partial<ProviderCapabilities>): ProviderCapabilities {
  return {
    streaming: partial.streaming ?? false,
    structuredOutput: partial.structuredOutput ?? 'none',
    tools: partial.tools ?? false,
    vision: partial.vision ?? false,
  }
}

