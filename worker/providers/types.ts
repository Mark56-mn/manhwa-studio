/**
 * One narrow interface every script provider implements.
 *
 * The studio never hard-codes a provider or a model: an adapter is selected by
 * configuration and the concrete model id always travels with the artifact that
 * was produced, so a script can be traced back to what really generated it.
 */

export interface ProviderConfig {
  /** Adapter id, e.g. "openai". */
  provider: string
  apiKey: string
  model: string
  /** Only used by adapters that accept a custom OpenAI-compatible endpoint. */
  baseUrl: string | null
}

export interface GenerationRequest {
  system: string
  prompt: string
  maxOutputTokens: number
  temperature: number
  signal?: AbortSignal
}

export interface GenerationResult {
  text: string
  model: string
  usage: { inputTokens: number | null; outputTokens: number | null }
  finishReason: string | null
}

export interface ProviderAdapter {
  id: string
  label: string
  docsUrl: string
  /** Environment variable names that can hold this adapter's API key. */
  keyEnvVars: string[]
  /** True when the adapter cannot work without SCRIPT_BASE_URL. */
  needsBaseUrl: boolean
  defaultModel: string
  suggestedModels: string[]
  /** A real, authenticated call that proves the credential works. */
  checkAuth(config: ProviderConfig, signal?: AbortSignal): Promise<void>
  /** Models this credential can actually use, straight from the provider. */
  listModels(config: ProviderConfig, signal?: AbortSignal): Promise<string[]>
  generate(config: ProviderConfig, request: GenerationRequest): Promise<GenerationResult>
}

export type ProviderErrorCode =
  | 'provider_not_configured'
  | 'provider_unknown'
  | 'provider_unauthorized'
  | 'provider_http_error'
  | 'provider_timeout'
  | 'provider_bad_response'

/** An error that carries enough detail to be reported to the owner verbatim. */
export class ProviderError extends Error {
  readonly code: ProviderErrorCode
  readonly status: number

  constructor(code: ProviderErrorCode, message: string, status = 0) {
    super(message)
    this.name = 'ProviderError'
    this.code = code
    this.status = status
  }
}

export function isProviderError(error: unknown): error is ProviderError {
  return error instanceof ProviderError
}

/** Reads an error message out of a provider's own JSON error envelope. */
export async function providerErrorMessage(response: Response): Promise<string> {
  const text = await response.text().catch(() => '')
  if (!text) return `HTTP ${response.status}`
  try {
    const body = JSON.parse(text) as {
      error?: { message?: string } | string
      message?: string
    }
    const nested = typeof body.error === 'object' && body.error !== null ? body.error.message : body.error
    const message = nested ?? body.message
    if (typeof message === 'string' && message.trim().length > 0) {
      return `${message.trim()} (HTTP ${response.status})`
    }
  } catch {
    // Not JSON; fall through to the raw body.
  }
  return `${text.slice(0, 300)} (HTTP ${response.status})`
}

export function toProviderError(response: Response, message: string): ProviderError {
  if (response.status === 401 || response.status === 403) {
    return new ProviderError('provider_unauthorized', message, response.status)
  }
  return new ProviderError('provider_http_error', message, response.status)
}

/** Runs a fetch, translating aborts and network failures into ProviderError. */
export async function providerFetch(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
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
        'provider_http_error',
        `Could not reach the provider: ${error instanceof Error ? error.message : 'network error'}`,
      ),
    )
  }
}
