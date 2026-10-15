/**
 * Image provider types and interfaces.
 *
 * Similar to script providers, image providers implement a narrow interface
 * so the studio can support multiple providers without hard-coding any one.
 */

export interface ImageProviderConfig {
  /** Adapter id, e.g. "openai" for DALL-E, "stability" for Stable Diffusion. */
  provider: string
  apiKey: string
  model: string
  /** Only used by adapters that accept a custom endpoint. */
  baseUrl: string | null
}

export interface ImageGenerationRequest {
  /** The text prompt for the image. */
  prompt: string
  /** Width in pixels. */
  width: number
  /** Height in pixels. */
  height: number
  /** Number of images to generate (usually 1). */
  n: number
  /** Quality setting if supported by the provider. */
  quality?: string
  /** Style setting if supported by the provider. */
  style?: string
  signal?: AbortSignal
}

export interface ImageGenerationResult {
  /** Base64-encoded image data (for providers that return it directly). */
  base64Image?: string
  /** URL to the generated image (for providers that host it temporarily). */
  url?: string
  /** The model that generated the image. */
  model: string
  /** Dimensions of the generated image. */
  width: number
  height: number
  /** Revision or version identifier if provided by the provider. */
  revisedPrompt?: string
}

export interface ImageProviderAdapter {
  id: string
  label: string
  docsUrl: string
  /** Environment variable names that can hold this adapter's API key. */
  keyEnvVars: string[]
  /** True when the adapter cannot work without IMAGE_BASE_URL. */
  needsBaseUrl: boolean
  defaultModel: string
  suggestedModels: string[]
  /** Default width for generated images. */
  defaultWidth: number
  /** Default height for generated images. */
  defaultHeight: number
  /** Supported quality values for this provider. */
  supportedQuality: string[]
  /** Supported style values for this provider. */
  supportedStyles: string[]
  /** A real, authenticated call that proves the credential works. */
  checkAuth(config: ImageProviderConfig, signal?: AbortSignal): Promise<void>
  /** Models this credential can actually use, straight from the provider. */
  listModels(config: ImageProviderConfig, signal?: AbortSignal): Promise<string[]>
  generate(config: ImageProviderConfig, request: ImageGenerationRequest): Promise<ImageGenerationResult>
}

export type ImageProviderErrorCode =
  | 'provider_not_configured'
  | 'provider_unknown'
  | 'provider_unauthorized'
  | 'provider_http_error'
  | 'provider_timeout'
  | 'provider_bad_response'
  | 'provider_rate_limited'

/** An error that carries enough detail to be reported to the owner verbatim. */
export class ImageProviderError extends Error {
  readonly code: ImageProviderErrorCode
  readonly status: number

  constructor(code: ImageProviderErrorCode, message: string, status = 0) {
    super(message)
    this.name = 'ImageProviderError'
    this.code = code
    this.status = status
  }
}

export function isImageProviderError(error: unknown): error is ImageProviderError {
  return error instanceof ImageProviderError
}

/** Reads an error message out of a provider's own JSON error envelope. */
export async function imageProviderErrorMessage(response: Response): Promise<string> {
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

export function toImageProviderError(response: Response, message: string): ImageProviderError {
  if (response.status === 429) {
    return new ImageProviderError('provider_rate_limited', message, response.status)
  }
  if (response.status === 401 || response.status === 403) {
    return new ImageProviderError('provider_unauthorized', message, response.status)
  }
  return new ImageProviderError('provider_http_error', message, response.status)
}

/** Runs a fetch, translating aborts and network failures into ImageProviderError. */
export async function imageProviderFetch(
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
        new ImageProviderError('provider_timeout', `The provider did not answer within ${Math.round(timeoutMs / 1000)}s.`),
      )
    }
    return Promise.reject(
      new ImageProviderError(
        'provider_http_error',
        `Could not reach the provider: ${error instanceof Error ? error.message : 'network error'}`,
      ),
    )
  }
}
