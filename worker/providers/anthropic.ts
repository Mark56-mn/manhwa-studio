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

const TIMEOUT_MS = 120_000
const API_VERSION = '2023-06-01'
const DEFAULT_BASE_URL = 'https://api.anthropic.com/v1'

const ANTHROPIC_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  // Anthropic has no response_format; JSON is requested through tools or a
  // prompt-level validated fallback (see requestBody).
  structuredOutput: 'none',
  tools: true,
  vision: true,
}

function baseUrl(config: ProviderConfig): string {
  return (config.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
}

function headers(apiKey: string): Record<string, string> {
  return {
    'x-api-key': apiKey,
    'anthropic-version': API_VERSION,
    accept: 'application/json',
  }
}

/** Anthropic takes the system prompt as a top-level field, not a message. */
function toMessages(request: AiChatRequest): { system: string; messages: Array<{ role: string; content: string }> } {
  const systemParts: string[] = []
  const messages: Array<{ role: string; content: string }> = []
  for (const message of request.messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    const role = message.role === 'assistant' ? 'assistant' : 'user'
    messages.push({ role, content: message.content })
  }
  if (messages.length === 0) messages.push({ role: 'user', content: '' })
  return { system: systemParts.join('\n\n'), messages }
}

function usageFrom(raw: unknown): AiUsage {
  if (typeof raw !== 'object' || raw === null) return emptyUsage()
  const record = raw as { input_tokens?: unknown; output_tokens?: unknown }
  const num = (value: unknown) => (typeof value === 'number' ? value : null)
  return { inputTokens: num(record.input_tokens), outputTokens: num(record.output_tokens), totalTokens: null }
}

function requestBody(request: AiChatRequest): Record<string, unknown> {
  const { system, messages } = toMessages(request)
  const body: Record<string, unknown> = {
    model: request.model,
    max_tokens: request.maxOutputTokens ?? 4096,
    messages,
  }
  if (typeof request.temperature === 'number') body.temperature = request.temperature
  let systemText = system
  const format = request.responseFormat
  if (format) {
    // Validated fallback: Anthropic has no JSON mode, so the schema is stated in
    // the system prompt and the caller still validates the result.
    const schema = 'type' in format && format.type === 'json_object' ? null : (format as AiStructuredOutput).schema
    systemText = [
      systemText,
      'Respond with a single JSON object and nothing else: no markdown, no code fences, no commentary.',
      schema ? `The JSON must validate against this schema:\n${JSON.stringify(schema)}` : '',
    ]
      .filter((line) => line.trim().length > 0)
      .join('\n\n')
  }
  if (systemText.trim().length > 0) body.system = systemText
  if (request.tools && request.tools.length > 0) {
    body.tools = request.tools.map((tool) => ({
      name: tool.name,
      ...(tool.description ? { description: tool.description } : {}),
      input_schema: tool.parameters,
    }))
    if (request.toolChoice === 'none') body.tool_choice = { type: 'none' }
    else if (typeof request.toolChoice === 'object') {
      body.tool_choice = { type: 'tool', name: request.toolChoice.name }
    } else body.tool_choice = { type: 'auto' }
  }
  return body
}

function toolCallsFrom(content: unknown): AiToolCall[] {
  if (!Array.isArray(content)) return []
  return content
    .map((block) => {
      const record = block as { type?: unknown; id?: unknown; name?: unknown; input?: unknown }
      if (record?.type !== 'tool_use' || typeof record.name !== 'string') return null
      return {
        id: typeof record.id === 'string' ? record.id : null,
        name: record.name,
        arguments: JSON.stringify(record.input ?? {}),
      }
    })
    .filter((call): call is AiToolCall => call !== null)
}

function textFrom(content: unknown): string {
  if (!Array.isArray(content)) return ''
  return content
    .map((block) => {
      const record = block as { type?: unknown; text?: unknown }
      return record?.type === 'text' && typeof record.text === 'string' ? record.text : ''
    })
    .join('')
}

/** Anthropic Messages API. Plain fetch — no SDK, no Node built-ins. */
export const anthropicAdapter: ProviderAdapter = {
  id: 'anthropic',
  label: 'Anthropic (Claude)',
  docsUrl: 'https://platform.claude.com/docs/en/api/messages/create',
  keyEnvVars: ['ANTHROPIC_API_KEY', 'SCRIPT_API_KEY'],
  baseUrlEnvVars: ['ANTHROPIC_BASE_URL'],
  defaultBaseUrl: DEFAULT_BASE_URL,
  needsBaseUrl: false,
  defaultModel: 'claude-sonnet-4-5',
  suggestedModels: ['claude-sonnet-4-5', 'claude-haiku-4-5', 'claude-opus-4-1'],
  capabilities: ANTHROPIC_CAPABILITIES,

  async checkAuth(config, signal) {
    const response = await providerFetch(
      `${baseUrl(config)}/models`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
  },

  async listModels(config, signal) {
    const response = await providerFetch(
      `${baseUrl(config)}/models`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    const body = (await response.json().catch(() => null)) as {
      data?: Array<{ id?: unknown; display_name?: unknown }>
    } | null
    const models = (body?.data ?? [])
      .map((entry) => {
        if (typeof entry?.id !== 'string') return null
        const model: DiscoveredModel = { id: entry.id, contextLength: null, free: 'unknown' }
        if (typeof entry.display_name === 'string') model.label = entry.display_name
        return model
      })
      .filter((model): model is DiscoveredModel => model !== null)
    if (models.length === 0) {
      throw new ProviderError('provider_bad_response', 'The provider returned an empty model list.')
    }
    return models.sort((a, b) => a.id.localeCompare(b.id))
  },

  async chat(config, request): Promise<AiChatResult> {
    const response = await providerFetch(
      `${baseUrl(config)}/messages`,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody(request), model: config.model }),
        signal: request.signal,
      },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))

    const body = (await response.json().catch(() => null)) as {
      model?: unknown
      content?: unknown
      usage?: unknown
      stop_reason?: unknown
    } | null

    const text = textFrom(body?.content)
    const toolCalls = toolCallsFrom(body?.content)
    if (text.trim().length === 0 && toolCalls.length === 0) {
      throw new ProviderError(
        'provider_bad_response',
        'The provider returned no text. Nothing was saved, so this attempt produced no artifact.',
      )
    }
    return {
      provider: 'anthropic',
      model: typeof body?.model === 'string' ? body.model : config.model,
      text,
      requestId: null,
      usage: usageFrom(body?.usage),
      finishReason: typeof body?.stop_reason === 'string' ? body.stop_reason : null,
      toolCalls,
    }
  },


  async *chatStream(config, request): AsyncGenerator<AiStreamChunk> {
    const response = await providerFetch(
      `${baseUrl(config)}/messages`,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify({ ...requestBody(request), model: config.model, stream: true }),
        signal: request.signal,
      },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    const body = response.body
    if (!body) throw new ProviderError('provider_bad_response', 'The provider returned an empty stream.')

    const reader = body.getReader()
    const decoder = new TextDecoder()
    let buffer = ''
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
          if (payload.length === 0 || payload === '[DONE]') continue
          let chunk: unknown
          try {
            chunk = JSON.parse(payload)
          } catch {
            continue
          }
          const record = chunk as {
            type?: unknown
            delta?: { type?: unknown; text?: unknown; stop_reason?: unknown }
            usage?: unknown
          }
          if (record.type === 'content_block_delta' && typeof record.delta?.text === 'string') {
            yield { delta: record.delta.text, done: false, model: config.model, requestId: null }
          } else if (record.type === 'message_delta') {
            yield {
              delta: '',
              done: false,
              model: config.model,
              requestId: null,
              finishReason: typeof record.delta?.stop_reason === 'string' ? record.delta.stop_reason : null,
              usage: record.usage ? usageFrom(record.usage) : null,
            }
          }
        }
      }
      yield { delta: '', done: true }
    } finally {
      reader.releaseLock()
    }
  },
}

