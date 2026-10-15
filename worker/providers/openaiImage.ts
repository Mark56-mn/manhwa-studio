/**
 * OpenAI DALL-E image provider adapter.
 */

import type { ImageGenerationRequest, ImageGenerationResult, ImageProviderAdapter, ImageProviderConfig } from './imageTypes'
import { ImageProviderError, imageProviderFetch, imageProviderErrorMessage, toImageProviderError } from './imageTypes'

const DALL_E_MODELS = [
  'dall-e-3',
  'dall-e-2',
] as const

type DallEModel = (typeof DALL_E_MODELS)[number]

interface OpenAIImageResponse {
  created: number
  data: Array<{
    base64?: string
    url?: string
    revised_prompt?: string
  }>
}

interface OpenAIModelResponse {
  data: Array<{ id: string; created: number; description: string }>
}

/**
 * Creates an OpenAI-compatible image adapter.
 * For OpenAI DALL-E, this uses the images endpoint.
 */
export function createOpenAIImageAdapter(config: {
  id: string
  label: string
  docsUrl: string
  defaultBaseUrl: string | null
  keyEnvVars: string[]
  defaultModel: string
  suggestedModels: string[]
  needsBaseUrl: boolean
  defaultWidth: number
  defaultHeight: number
  supportedQuality: string[]
  supportedStyles: string[]
}): ImageProviderAdapter {
  return {
    id: config.id,
    label: config.label,
    docsUrl: config.docsUrl,
    keyEnvVars: config.keyEnvVars,
    needsBaseUrl: config.needsBaseUrl,
    defaultModel: config.defaultModel,
    suggestedModels: config.suggestedModels,
    defaultWidth: config.defaultWidth,
    defaultHeight: config.defaultHeight,
    supportedQuality: config.supportedQuality,
    supportedStyles: config.supportedStyles,

    async checkAuth(providerConfig: ImageProviderConfig, signal?: AbortSignal): Promise<void> {
      const url = `${providerConfig.baseUrl}/images/generations`
      const response = await imageProviderFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: providerConfig.model,
            prompt: 'A white square on a black background',
            n: 1,
            size: `${config.defaultWidth ?? 1024}x${config.defaultHeight ?? 1024}`,
          }),
          signal,
        },
        30_000,
      )

      if (!response.ok) {
        const message = await imageProviderErrorMessage(response)
        throw toImageProviderError(response, message)
      }
    },

    async listModels(providerConfig: ImageProviderConfig, signal?: AbortSignal): Promise<string[]> {
      const url = `${providerConfig.baseUrl}/models`
      const response = await imageProviderFetch(
        url,
        {
          method: 'GET',
          headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
          },
          signal,
        },
        30_000,
      )

      if (!response.ok) {
        const message = await imageProviderErrorMessage(response)
        throw toImageProviderError(response, message)
      }

      const body = (await response.json()) as OpenAIModelResponse
      return body.data.map((entry) => entry.id).filter((id) => DALL_E_MODELS.includes(id as DallEModel))
    },

    async generate(providerConfig: ImageProviderConfig, request: ImageGenerationRequest): Promise<ImageGenerationResult> {
      const width = request.width || config.defaultWidth || 1024
      const height = request.height || config.defaultHeight || 1024
      const quality = request.quality || 'standard'
      const style = request.style || 'vivid'

      const url = `${providerConfig.baseUrl}/images/generations`
      const response = await imageProviderFetch(
        url,
        {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${providerConfig.apiKey}`,
            'Content-Type': 'application/json',
          },
          body: JSON.stringify({
            model: providerConfig.model,
            prompt: request.prompt,
            n: request.n || 1,
            size: `${width}x${height}`,
            quality,
            style,
          }),
          signal: request.signal,
        },
        120_000,
      )

      if (!response.ok) {
        const message = await imageProviderErrorMessage(response)
        throw toImageProviderError(response, message)
      }

      const body = (await response.json()) as OpenAIImageResponse
      const result = body.data[0]

      if (!result) {
        throw new ImageProviderError('provider_bad_response', 'No image data returned from provider')
      }

      if (result.base64) {
        return {
          base64Image: result.base64,
          model: providerConfig.model,
          width,
          height,
          revisedPrompt: result.revised_prompt,
        }
      }

      if (result.url) {
        return {
          url: result.url,
          model: providerConfig.model,
          width,
          height,
          revisedPrompt: result.revised_prompt,
        }
      }

      throw new ImageProviderError(
        'provider_bad_response',
        'The provider returned no image data or URL in its response.',
      )
    },
  }
}

// Pre-built adapters
export const openAIImageAdapter = createOpenAIImageAdapter({
  id: 'openai',
  label: 'OpenAI (DALL-E)',
  docsUrl: 'https://platform.openai.com/docs/api-reference/images',
  defaultBaseUrl: 'https://api.openai.com/v1',
  keyEnvVars: ['IMAGE_API_KEY', 'OPENAI_API_KEY'],
  defaultModel: 'dall-e-3',
  suggestedModels: ['dall-e-3', 'dall-e-2'],
  needsBaseUrl: false,
  defaultWidth: 1024,
  defaultHeight: 1024,
  supportedQuality: ['standard', 'hd'],
  supportedStyles: ['vivid', 'natural'],
})

export const customImageAdapter = createOpenAIImageAdapter({
  id: 'custom',
  label: 'Custom OpenAI-compatible image endpoint',
  docsUrl: 'https://platform.openai.com/docs/api-reference/images',
  defaultBaseUrl: null,
  keyEnvVars: ['IMAGE_API_KEY'],
  defaultModel: '',
  suggestedModels: [],
  needsBaseUrl: true,
  defaultWidth: 1024,
  defaultHeight: 1024,
  supportedQuality: ['standard', 'hd'],
  supportedStyles: ['vivid', 'natural'],
})
