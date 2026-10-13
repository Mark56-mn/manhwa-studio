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
  AiMessage,
  AiStructuredOutput,
  AiStreamChunk,
  AiToolCall,
  AiUsage,
  DiscoveredModel,
  ProviderAdapter,
  ProviderCapabilities,
  ProviderConfig,
} from './types'

/**
 * Google Gemini through the official Generative Language API — not the OpenAI
 * shape. The API key travels in a header, never in the URL (URLs get logged).
 */
const TIMEOUT_MS = 120_000
const DEFAULT_BASE_URL = 'https://generativelanguage.googleapis.com/v1beta'

const GOOGLE_CAPABILITIES: ProviderCapabilities = {
  streaming: true,
  structuredOutput: 'json_schema',
  tools: true,
  vision: true,
}

function baseUrl(config: ProviderConfig): string {
  return (config.baseUrl ?? DEFAULT_BASE_URL).trim().replace(/\/+$/, '')
}

function headers(apiKey: string): Record<string, string> {
  return { 'x-goog-api-key': apiKey, accept: 'application/json' }
}

/** Gemini's responseSchema is an OpenAPI subset; drop anything it rejects. */
const SCHEMA_KEYS = new Set([
  'type',
  'format',
  'description',
  'nullable',
  'enum',
  'items',
  'properties',
  'required',
  'minimum',
  'maximum',
  'minItems',
  'maxItems',
  'minLength',
  'maxLength',
  'pattern',
  'anyOf',
  'propertyOrdering',
])

function sanitizeSchema(value: unknown, depth = 0): Record<string, unknown> {
  if (depth > 8 || typeof value !== 'object' || value === null || Array.isArray(value)) {
    return { type: 'string' }
  }
  const source = value as Record<string, unknown>
  const out: Record<string, unknown> = {}
  for (const key of Object.keys(source)) {
    if (!SCHEMA_KEYS.has(key)) continue
    const entry = source[key]
    if (key === 'properties' && typeof entry === 'object' && entry !== null && !Array.isArray(entry)) {
      out.properties = Object.fromEntries(
        Object.entries(entry as Record<string, unknown>).map(([name, schema]) => [name, sanitizeSchema(schema, depth + 1)]),
      )
    } else if (key === 'items') {
      out.items = sanitizeSchema(entry, depth + 1)
    } else if (key === 'anyOf' && Array.isArray(entry)) {
      out.anyOf = entry.map((schema) => sanitizeSchema(schema, depth + 1))
    } else {
      out[key] = entry
    }
  }
  return out
}

/** Gemini splits the system prompt out of the conversation and calls roles differently. */
function toContents(messages: AiMessage[]): { system: string; contents: Array<{ role: string; parts: Array<{ text: string }> }> } {
  const systemParts: string[] = []
  const contents: Array<{ role: string; parts: Array<{ text: string }> }> = []
  for (const message of messages) {
    if (message.role === 'system') {
      systemParts.push(message.content)
      continue
    }
    // Tool results are folded into a user turn: this build never runs a tool loop.
    const role = message.role === 'assistant' ? 'model' : 'user'
    contents.push({ role, parts: [{ text: message.content }] })
  }
  if (contents.length === 0) contents.push({ role: 'user', parts: [{ text: '' }] })
  return { system: systemParts.join('\n\n'), contents }
}

function generationConfig(request: AiChatRequest): Record<string, unknown> {
  const config: Record<string, unknown> = {}
  if (typeof request.maxOutputTokens === 'number') config.maxOutputTokens = request.maxOutputTokens
  if (typeof request.temperature === 'number') config.temperature = request.temperature
  const format = request.responseFormat
  if (format) {
    if ('type' in format && format.type === 'json_object') {
      config.responseMimeType = 'application/json'
    } else {
      config.responseMimeType = 'application/json'
      config.responseSchema = sanitizeSchema((format as AiStructuredOutput).schema)
    }
  }
  return config
}

function requestBody(request: AiChatRequest): Record<string, unknown> {
  const { system, contents } = toContents(request.messages)
  const body: Record<string, unknown> = { contents, generationConfig: generationConfig(request) }
  if (system.trim().length > 0) body.systemInstruction = { parts: [{ text: system }] }
  if (request.tools && request.tools.length > 0) {
    body.tools = [
      {
        functionDeclarations: request.tools.map((tool) => ({
          name: tool.name,
          ...(tool.description ? { description: tool.description } : {}),
          parameters: sanitizeSchema(tool.parameters),
        })),
      },
    ]
    if (request.toolChoice === 'none') {
      body.toolConfig = { functionCallingConfig: { mode: 'NONE' } }
    } else if (typeof request.toolChoice === 'object') {
      body.toolConfig = { functionCallingConfig: { mode: 'ANY', allowedFunctionNames: [request.toolChoice.name] } }
    } else {
      body.toolConfig = { functionCallingConfig: { mode: 'AUTO' } }
    }
  }
  return body
}

type GeminiPart = { text?: unknown; functionCall?: { name?: unknown; args?: unknown } }

function partsText(parts: unknown): string {
  if (!Array.isArray(parts)) return ''
  return parts
    .map((part) => {
      const record = part as GeminiPart
      return typeof record?.text === 'string' ? record.text : ''
    })
    .join('')
}

function functionCalls(parts: unknown): AiToolCall[] {
  if (!Array.isArray(parts)) return []
  return parts
    .map((part): AiToolCall | null => {
      const call = (part as GeminiPart)?.functionCall
      const name = typeof call?.name === 'string' ? call.name : null
      if (!name) return null
      return { id: null, name, arguments: JSON.stringify(call?.args ?? {}) }
    })
    .filter((call): call is AiToolCall => call !== null)
}

function usageFromMetadata(meta: unknown): AiUsage {
  if (typeof meta !== 'object' || meta === null) return emptyUsage()
  const record = meta as { promptTokenCount?: unknown; candidatesTokenCount?: unknown; totalTokenCount?: unknown }
  const num = (value: unknown) => (typeof value === 'number' ? value : null)
  return {
    inputTokens: num(record.promptTokenCount),
    outputTokens: num(record.candidatesTokenCount),
    totalTokens: num(record.totalTokenCount),
  }
}

function parseModels(body: unknown): DiscoveredModel[] {
  const record = body as { models?: unknown } | null
  const list = Array.isArray(record?.models) ? record.models : []
  const models = list
    .map((entry) => {
      if (typeof entry !== 'object' || entry === null) return null
      const item = entry as {
        name?: unknown
        displayName?: unknown
        inputTokenLimit?: unknown
        supportedGenerationMethods?: unknown
      }
      const name = typeof item.name === 'string' ? item.name.replace(/^models\//, '') : null
      if (!name) return null
      const methods = Array.isArray(item.supportedGenerationMethods) ? item.supportedGenerationMethods : null
      if (methods && !methods.includes('generateContent')) return null
      const model: DiscoveredModel = {
        id: name,
        contextLength: typeof item.inputTokenLimit === 'number' ? item.inputTokenLimit : null,
        // Gemini's model list carries no pricing, so cost stays unknown until
        // the owner marks it or authorises paid use.
        free: 'unknown',
      }
      if (typeof item.displayName === 'string') model.label = item.displayName
      return model
    })
    .filter((model): model is DiscoveredModel => model !== null)
  if (models.length === 0) {
    throw new ProviderError('provider_bad_response', 'The provider returned an empty model list.')
  }
  return models.sort((a, b) => a.id.localeCompare(b.id))
}


/** Google Gemini (Generative Language API). Plain fetch — no SDK. */
export const googleAdapter: ProviderAdapter = {
  id: 'google',
  label: 'Google Gemini',
  docsUrl: 'https://ai.google.dev/gemini-api/docs',
  keyEnvVars: ['GEMINI_API_KEY', 'GOOGLE_API_KEY', 'SCRIPT_API_KEY'],
  baseUrlEnvVars: ['GEMINI_BASE_URL'],
  defaultBaseUrl: DEFAULT_BASE_URL,
  needsBaseUrl: false,
  defaultModel: 'gemini-2.0-flash',
  suggestedModels: ['gemini-2.0-flash', 'gemini-2.5-flash', 'gemini-2.5-pro'],
  capabilities: GOOGLE_CAPABILITIES,

  async checkAuth(config, signal) {
    const response = await providerFetch(
      `${baseUrl(config)}/models?pageSize=1`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
  },

  async listModels(config, signal) {
    const response = await providerFetch(
      `${baseUrl(config)}/models?pageSize=200`,
      { method: 'GET', headers: headers(config.apiKey), signal },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))
    return parseModels(await response.json().catch(() => null))
  },

  async chat(config, request): Promise<AiChatResult> {
    const response = await providerFetch(
      `${baseUrl(config)}/models/${encodeURIComponent(config.model)}:generateContent`,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(request)),
        signal: request.signal,
      },
      TIMEOUT_MS,
    )
    if (!response.ok) throw toProviderError(response, await providerErrorMessage(response))

    const body = (await response.json().catch(() => null)) as {
      candidates?: Array<{ content?: { parts?: unknown }; finishReason?: unknown }>
      usageMetadata?: unknown
      modelVersion?: unknown
    } | null

    const candidate = body?.candidates?.[0]
    const text = partsText(candidate?.content?.parts)
    const toolCalls = functionCalls(candidate?.content?.parts)
    if (text.trim().length === 0 && toolCalls.length === 0) {
      throw new ProviderError(
        'provider_bad_response',
        'The provider returned no text. Nothing was saved, so this attempt produced no artifact.',
      )
    }
    const finishReason = candidate?.finishReason
    return {
      provider: 'google',
      model: typeof body?.modelVersion === 'string' ? body.modelVersion : config.model,
      text,
      requestId: null,
      usage: usageFromMetadata(body?.usageMetadata),
      finishReason: typeof finishReason === 'string' ? finishReason : null,
      toolCalls,
    }
  },


  async *chatStream(config, request): AsyncGenerator<AiStreamChunk> {
    const response = await providerFetch(
      `${baseUrl(config)}/models/${encodeURIComponent(config.model)}:streamGenerateContent?alt=sse`,
      {
        method: 'POST',
        headers: { ...headers(config.apiKey), 'content-type': 'application/json' },
        body: JSON.stringify(requestBody(request)),
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
            candidates?: Array<{ content?: { parts?: unknown }; finishReason?: unknown }>
            usageMetadata?: unknown
          }
          const candidate = record.candidates?.[0]
          const delta = partsText(candidate?.content?.parts)
          const finishReason = candidate?.finishReason
          if (delta.length === 0 && !finishReason) continue
          yield {
            delta,
            done: false,
            model: config.model,
            requestId: null,
            finishReason: typeof finishReason === 'string' ? finishReason : null,
            usage: record.usageMetadata ? usageFromMetadata(record.usageMetadata) : null,
          }
        }
      }
      yield { delta: '', done: true }
    } finally {
      reader.releaseLock()
    }
  },
}

