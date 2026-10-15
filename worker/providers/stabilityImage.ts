/**
 * Stability AI image provider adapter.
 * Uses the Stable Diffusion API at https://api.stability.ai
 */

import type { ImageGenerationRequest, ImageGenerationResult, ImageProviderAdapter, ImageProviderConfig } from './imageTypes'
import { ImageProviderError, imageProviderFetch, imageProviderErrorMessage, toImageProviderError } from './imageTypes'

interface StabilityResponse {
  artifacts: Array<{
    seed: number
    base64?: string
    finishReason: string
  }>
}

/**
 * Stability AI adapter for Stable Diffusion.
 */
const stabilityAdapter: ImageProviderAdapter = {
  id: 'stability',
  label: 'Stability AI (Stable Diffusion)',
  docsUrl: 'https://platform.stability.ai/docs/api-reference#tag/v1generation/operation/StableDiffusion_generateImage',
  keyEnvVars: ['IMAGE_API_KEY', 'STABILITY_API_KEY'],
  needsBaseUrl: false,
  defaultModel: 'stable-diffusion-xl-1024-v1-0',
  suggestedModels: [
    'stable-diffusion-xl-1024-v1-0',
    'stable-diffusion-xl-1024-v0-9',
    'stable-diffusion-768-v2-1',
    'stable-diffusion-512-v2-1',
  ],
  defaultWidth: 1024,
  defaultHeight: 1024,
  supportedQuality: ['standard'],
  supportedStyles: ['none', '3d-model', 'analog-film', 'anime', 'cinematic', 'comic-book', 'digital-art', 'enhance', 'fantasy-art', 'isometric', 'line-art', 'low-poly', 'neon-punk', 'origami', 'photographic', 'pixel-art', 'tile-texture'],

  async checkAuth(config: ImageProviderConfig, signal?: AbortSignal): Promise<void> {
    const url = `${config.baseUrl ?? 'https://api.stability.ai/v1'}/generation/stable-diffusion-xl-1024-v1-0/text-to-image`
    const response = await imageProviderFetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          text_prompts: [{ text: 'A white square on a black background' }],
          cfg_scale: 7,
          steps: 50,
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

  async listModels(): Promise<string[]> {
    // Stability doesn't have a models endpoint that returns all available models
    // We return the suggested models as a fallback
    return this.suggestedModels
  },

  async generate(config: ImageProviderConfig, request: ImageGenerationRequest): Promise<ImageGenerationResult> {
    const width = request.width || this.defaultWidth
    const height = request.height || this.defaultHeight
    const quality = request.quality
    const style = request.style

    // Map quality to Stability parameters
    const steps = quality === 'hd' ? 150 : 50
    const cfg_scale = quality === 'hd' ? 12 : 7

    const url = `${config.baseUrl ?? 'https://api.stability.ai/v1'}/generation/${config.model}/text-to-image`
    const response = await imageProviderFetch(
      url,
      {
        method: 'POST',
        headers: {
          Authorization: `Bearer ${config.apiKey}`,
          'Content-Type': 'application/json',
          Accept: 'application/json',
        },
        body: JSON.stringify({
          text_prompts: [{ text: request.prompt, weight: 1.0 }],
          cfg_scale,
          steps,
          width,
          height,
          samples: request.n || 1,
          style_preset: style && this.supportedStyles.includes(style) ? style : undefined,
        }),
        signal: request.signal,
      },
      120_000,
    )

    if (!response.ok) {
      const message = await imageProviderErrorMessage(response)
      throw toImageProviderError(response, message)
    }

    const body = (await response.json()) as StabilityResponse
    const artifact = body.artifacts[0]

    if (!artifact) {
      throw new ImageProviderError(
        'provider_bad_response',
        'The provider returned no artifacts in its response.',
      )
    }

    if (artifact.base64) {
      return {
        base64Image: artifact.base64,
        model: config.model,
        width,
        height,
      }
    }

    throw new ImageProviderError(
      'provider_bad_response',
      'The provider returned no image data in its response.',
    )
  },
}

export { stabilityAdapter }
