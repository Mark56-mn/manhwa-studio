import {
  ProviderError,
  emptyUsage,
  providerErrorMessage,
  providerFetch,
  toProviderError,
} from './types'

import type {
  AiChatRequest,
  AiChatResult,
  AiStructuredOutput,
  AiStreamChunk,
  AiToolCall,
  AiUsage,
  DiscoveredModel,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConfig,
} from './types'

/** Every provider request is bounded; a hung call must never hang the studio. */
export const PROVIDER_TIMEOUT_MS = 120_000

export interface OpenAiCompatibleOptions {
  id: string
  label: string
  docsUrl: string
  /** `null` means this adapter cannot work without a configured base URL. */
  defaultBaseUrl: string | null
  keyEnvVars: string[]
  baseUrlEnvVars?: string[]
  defaultModel: string
  suggestedModels: string[]
  capabilities: ProviderCapabilities
  /** Which max-tokens field this provider's API expects. */
  maxTokensField?: 'max_tokens' | 'max_completion_tokens'
  modelsPath?: string
  authCheckPath?: string
  /** Static attribution headers, e.g. OpenRouter's HTTP-Referer / X-Title. */
  attributionHeaders?: Record<string, string>
  /** Ask for usage in the final streaming chunk when the provider supports it. */
  streamUsage?: boolean
}

function baseUrlFor(config: ProviderConfig, fallback: string | null): string {
  const raw = (config.baseUrl ?? fallback ?? '').trim().replace(/\/+$/, '')
  if (!raw) {
    throw new ProviderError(
      'provider_not_configured',
      'This provider needs an OpenAI-compatible base URL (set its *_BASE_URL variable).',
    )
  }
  return raw
}

function authHeaders(config: ProviderConfig, extra?: Record<string, string>): Record<string, string> {
  return {
    authorization: `Bearer ${config.apiKey}`,
    accept: 'application/json',
    ...extra,
  }
}

/** Chat-completion text can be a string or an array of typed parts. */
function textFromContent(content: unknown): string {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((part) => {
        if (typeof part === 'object' && part !== null && 'text' in part) {
          const value = (part as { text?: unknown }).text
          return typeof value === 'string' ? value : ''
        }
        return ''
      })
      .join('')
  }
  return ''
}

function usageFrom(raw: unknown): AiUsage {
  if (typeof raw !== 'object' || raw === null) return emptyUsage()
  const usage = raw as { prompt_tokens?: unknown; completion_tokens?: unknown; total_tokens?: unknown }
  const num = (value: unknown) => (typeof value === 'number' ? value : null)
  const input = num(usage.prompt_tokens)
  const output = num(usage.completion_tokens)
  const total = num(usage.total_tokens) ?? (input !== null && output !== null ? input + output : null)
  return { inputTokens: input, outputTokens: output, totalTokens: total }
}

function normalizeToolCalls(raw: unknown): AiToolCall[] {
  if (!Array.isArray(raw)) return []
  return raw
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null
      const record = entry as { id?: unknown; function?: { name?: unknown; arguments?: unknown } }
      const name = typeof record.function?.name === 'string' ? record.function.name : null
      if (!name) return null
      return {
        id: typeof record.id === 'string' ? record.id : null,
        name,
        arguments: typeof record.function?.arguments === 'string' ? record.function.arguments : '',
      }
    })
    .filter((entry): entry is AiToolCall => entry !== null)
}

/** JSON-mode translation, with an explicit capability error when unsupported. */
function responseFormatBody(
  request: AiChatRequest,
  options: OpenAiCompatibleOptions,
): Record<string, unknown> | null {
  const format = request.responseFormat
  if (!format) return null
  if ('type' in format && format.type === 'json_object') {
    if (options.capabilities.structuredOutput === 'none') {
      throw new ProviderError(
        'provider_capability_unsupported',
        `${options.label} does not support a JSON response format.`,
      )
    }
    return { type: 'json_object' }
  }
  const structured = format as AiStructuredOutput
  if (options.capabilities.structuredOutput === 'json_schema') {
    return {
      type: 'json_schema',
      json_schema: { name: structured.name, schema: structured.schema, strict: structured.strict ?? true },
    }
  }
  if (options.capabilities.structuredOutput === 'json_object') {
    // Validated fallback: JSON mode plus the schema in the prompt.
    return { type: 'json_object' }
  }
  throw new ProviderError(
    'provider_capability_unsupported',
    `${options.label} does not support structured JSON output.`,
  )
}

function requestBody(
  config: ProviderConfig,
  request: AiChatRequest,
  options: OpenAiCompatibleOptions,
  stream: boolean,
): Record<string, unknown> {
  const body: Record<string, unknown> = {
    model: config.model,
    messages: request.messages.map((message) => ({
      role: message.role,
      content: message.content,
      ...(message.name ? { name: message.name } : {}),
      ...(message.toolCallId ? { tool_call_id: message.toolCallId } : {}),
    })),
  }
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  if (typeof request.maxOutputTokens === 'number') {
    body[options.maxTokensField ?? 'max_tokens'] = request.maxOutputTokens
  }
  if (stream) {
    body.stream = true
    if (options.streamUsage) body.stream_options = { include_usage: true }
  }
  const responseFormat = responseFormatBody(request, options)
  if (responseFormat) body.response_format = responseFormat
  if (request.tools && request.tools.length > 0) {
    if (!options.capabilities.tools) {
      throw new ProviderError('provider_capability_unsupported', `${options.label} does not support tool calling.`)
    }
    body.tools = request.tools.map((tool) => ({
      type: 'function',
      function: {
        name: tool.name,
        ...(tool.description ? { description: tool.description } : {}),
        parameters: tool.parameters,
      },
    }))
    if (request.toolChoice === 'none') body.tool_choice = 'none'
    else if (typeof request.toolChoice === 'object') {
      body.tool_choice = { type: 'function', function: { name: request.toolChoice.name } }
    } else body.tool_choice = 'auto'
  }
  return body
}

/** Free only when the provider's own pricing metadata says zero cost. */
function modelFree(pricing: unknown): DiscoveredModel['free'] {
  if (typeof pricing !== 'object' || pricing === null) return 'unknown'
  const record = pricing as { prompt?: unknown; completion?: unknown }
  const asNumber = (value: unknown) => (typeof value === 'string' ? Number(value) : typeof value === 'number' ? value : null)
  const prompt = asNumber(record.prompt)
  const completion = asNumber(record.completion)
  if (prompt === null || completion === null) return 'unknown'
  return prompt === 0 && completion === 0 ? 'free' : 'paid'
}

function parseModels(body: unknown): DiscoveredModel[] {
  const record = body as { data?: unknown; models?: unknown } | null
  const list = Array.isArray(record?.data) ? record.data : Array.isArray(record?.models) ? record.models : []
  const models = list
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null
      const item = entry as { id?: unknown; name?: unknown; context_length?: unknown; pricing?: unknown }
      const id = typeof item.id === 'string' ? item.id : null
      if (!id) return null
      const model: DiscoveredModel = {
        id,
        contextLength: typeof item.context_length === 'number' ? item.context_length : null,
        free: modelFree(item.pricing),
      }
      if (typeof item.name === 'string') model.label = item.name
      return model
    })
    .filter((model): model is DiscoveredModel => model !== null)
  if (models.length === 0) {
    throw new ProviderError('provider_bad_response', 'The provider returned an empty model list.')
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}

/** Parses an SSE chat-completion stream into normalized deltas. */
async function* streamChunks(response: Response, fallbackModel: string): AsyncGenerator<AiStreamChunk> {
  const body = response.body
  if (!body) throw new ProviderError('provider_bad_response', 'The provider returned an empty stream.')
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  let model = fallbackModel
  try {
    for (;;) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf('\n')
      while (index !== -1) {
        const line = buffer.slice(0, index).trim()
        buffer = buffer.slice(index + 1)
        index = buffer.indexOf('\n')
        if (!line.startsWith('data:')) continue
        const payload = line.slice(5).trim()
        if (payload === '[DONE]') {
          yield { delta: '', done: true }
          return
        }
        let chunk: unknown
        try {
          chunk = JSON.parse(payload)
        } catch {
          continue
        }
        const record = chunk as {
          id?: unknown
          model?: unknown
          choices?: Array<{ delta?: { content?: unknown }; finish_reason?: unknown }>
          usage?: unknown
        }
        if (typeof record.model === 'string') model = record.model
        const delta = textFromContent(record.choices?.[0]?.delta?.content)
        const finishReason = record.choices?.[0]?.finish_reason
        const usage = record.usage ? usageFrom(record.usage) : null
        if (delta.length === 0 && !finishReason && !usage) continue
        yield {
          delta,
          done: false,
          model,
          requestId: typeof record.id === 'string' ? record.id : null,
          finishReason: typeof finishReason === 'string' ? finishReason : null,
          usage,
        }
      }
    }
    yield { delta: '', done: true }
  } finally {
    reader.releaseLock()
  }
}


/**
 * Builds an adapter for any provider that speaks the OpenAI chat-completions
 * shape. OpenRouter, NVIDIA NIM, Baseten, OpenAI and self-hosted compatible
 * endpoints all do; only the base URL, headers and a few field names differ.
 */
export function createOpenAiCompatibleAdapter(options: OpenAiCompatibleOptions): ProviderAdapter {
  const modelsPath = options.modelsPath ?? '/models'
  const authCheckPath = options.authCheckPath ?? modelsPath
  const staticHeaders = { ...options.attributionHeaders }

  function requestHeaders(config: ProviderConfig, extra?: Record<string, string>): Record<string, string> {
    return { ...authHeaders(config, staticHeaders), ...config.headers, ...extra }
  }

  async function postChat(config: ProviderConfig, request: AiChatRequest, stream: boolean): Promise<Response> {
    const base = baseUrlFor(config, options.defaultBaseUrl)
    return providerFetch(
      `${base}/chat/completions`,
      {
        method: 'POST',
        headers: requestHeaders(config, { 'content-type': 'application/json' }),
        body: JSON.stringify(requestBody(config, request, options, stream)),
        signal: request.signal,
      },
      PROVIDER_TIMEOUT_MS,
    )
  }

  return {
    id: options.id,
    label: options.label,
    docsUrl: options.docsUrl,
    keyEnvVars: options.keyEnvVars,
    baseUrlEnvVars: options.baseUrlEnvVars ?? [],
    defaultBaseUrl: options.defaultBaseUrl,
    needsBaseUrl: options.defaultBaseUrl === null,
    defaultModel: options.defaultModel,
    suggestedModels: options.suggestedModels,
    capabilities: options.capabilities,

    async checkAuth(config, signal) {
      const base = baseUrlFor(config, options.defaultBaseUrl)
      const response = await providerFetch(
        `${base}${authCheckPath}`,
        { method: 'GET', headers: requestHeaders(config), signal },
        PROVIDER_TIMEOUT_MS,
      )
      if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    },

    async listModels(config, signal) {
      const base = baseUrlFor(config, options.defaultBaseUrl)
      const response = await providerFetch(
        `${base}${modelsPath}`,
        { method: 'GET', headers: requestHeaders(config), signal },
        PROVIDER_TIMEOUT_MS,
      )
      if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
      const body = (await response.json().catch(() => null)) as unknown
      return parseModels(body)
    },

    async chat(config, request): Promise<AiChatResult> {
      const response = await postChat(config, request, false)
      if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))

      const body = (await response.json().catch(() => null)) as {
        id?: unknown
        model?: unknown
        choices?: Array<{ message?: { content?: unknown; tool_calls?: unknown }; finish_reason?: unknown }>
        usage?: unknown
      } | null

      const choice = body?.choices?.[0]
      const text = textFromContent(choice?.message?.content)
      const toolCalls = normalizeToolCalls(choice?.message?.tool_calls)
      if (text.trim().length === 0 && toolCalls.length === 0) {
        throw new ProviderError(
          'provider_bad_response',
          'The provider returned no text. Nothing was saved, so this attempt produced no artifact.',
        )
      }
      const finishReason = choice?.finish_reason
      return {
        provider: options.id,
        model: typeof body?.model === 'string' ? body.model : config.model,
        text,
        requestId: typeof body?.id === 'string' ? body.id : null,
        usage: usageFrom(body?.usage),
        finishReason: typeof finishReason === 'string' ? finishReason : null,
        toolCalls,
      }
    },

    async *chatStream(config, request): AsyncGenerator<AiStreamChunk> {
      if (!options.capabilities.streaming) {
        throw new ProviderError('provider_capability_unsupported', `${options.label} does not support streaming.`)
      }
      const response = await postChat(config, request, true)
      if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
      yield* streamChunks(response, config.model)
    },
  }
}

