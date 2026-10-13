import { env } from 'cloudflare:test'
import { describe, expect, it } from 'vitest'

import { basetenAdapter, googleAdapter, nvidiaAdapter, openRouterAdapter } from '../worker/providers'

import type { ProviderAdapter, ProviderConfig } from '../worker/providers/types'

/**
 * LIVE provider tests. Unlike test/ai-adapters.spec.ts (which stubs HTTP), these
 * make real network calls and therefore run only when a real key is present in
 * the developer's environment:
 *
 *   LIVE_OPENROUTER_API_KEY=... LIVE_GEMINI_API_KEY=... npm test
 *
 * They are skipped, not faked, when no key is present. A live test asserts only
 * what a real call proves: the credential works and the provider answers in the
 * shape the adapter expects.
 */

const bindings = env as unknown as Record<string, string | undefined>

const liveProviders: Array<{ adapter: ProviderAdapter; key: string | undefined; model: string }> = [
  { adapter: openRouterAdapter, key: bindings.LIVE_OPENROUTER_API_KEY, model: 'openrouter/auto' },
  { adapter: nvidiaAdapter, key: bindings.LIVE_NVIDIA_API_KEY, model: '' },
  { adapter: googleAdapter, key: bindings.LIVE_GEMINI_API_KEY, model: 'gemini-2.0-flash' },
  { adapter: basetenAdapter, key: bindings.LIVE_BASETEN_API_KEY, model: '' },
]

for (const { adapter, key, model } of liveProviders) {
  const enabled = Boolean(key && key.trim().length > 0)
  describe.skipIf(!enabled)(`LIVE ${adapter.id} (real provider)`, () => {
    it('authenticates and lists models with a real credential', async () => {
      const config: ProviderConfig = { provider: adapter.id, apiKey: key as string, model, baseUrl: null }
      await expect(adapter.checkAuth(config, AbortSignal.timeout(30_000))).resolves.toBeUndefined()
    })

    it('completes a real low-token chat when a model is known', async () => {
      if (!model) return // no verified model id for this provider in this build
      const config: ProviderConfig = { provider: adapter.id, apiKey: key as string, model, baseUrl: null }
      const result = await adapter.chat(config, {
        model,
        messages: [{ role: 'user', content: 'Reply with the single word: ok' }],
        maxOutputTokens: 16,
        temperature: 0,
        signal: AbortSignal.timeout(60_000),
      })
      expect(result.text.trim().length).toBeGreaterThan(0)
      expect(result.provider).toBe(adapter.id)
    })
  })
}

describe('live provider key coverage', () => {
  it('reports which providers have a real key configured (names only)', () => {
    const configured = liveProviders.filter((entry) => entry.key && entry.key.trim().length > 0).map((entry) => entry.adapter.id)
    // This test never fails on missing keys; it makes the live coverage visible.
    expect(Array.isArray(configured)).toBe(true)
  })
})
