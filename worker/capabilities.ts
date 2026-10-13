import { PROJECT_STATUSES, EPISODE_STATUSES } from './lib/constants'
import type { Env } from './env'

export type IntegrationState =
  | 'connected_verified'
  | 'configured_unverified'
  | 'unavailable'
  | 'not_configured'
  | 'failed'

export interface CapabilityStatus {
  id: string
  label: string
  phase: 'B' | 'C' | 'D'
  state: IntegrationState
  detail: string
  /** Environment variable NAMES the adapter will read once it exists. */
  requiredEnvVars: string[]
  /** Which of those names are currently set on this deployment. */
  presentEnvVars: string[]
}

interface CapabilityDefinition {
  id: string
  label: string
  phase: 'B' | 'C' | 'D'
  envVars: string[]
  planned: string
}

const CAPABILITIES: CapabilityDefinition[] = [
  {
    id: 'script',
    label: 'Script AI',
    phase: 'B',
    envVars: ['SCRIPT_PROVIDER', 'SCRIPT_API_KEY', 'SCRIPT_MODEL'],
    planned: 'LLM script generation',
  },
  {
    id: 'image',
    label: 'Image AI',
    phase: 'B',
    envVars: ['IMAGE_PROVIDER', 'IMAGE_API_KEY', 'IMAGE_MODEL'],
    planned: 'Scene and character art generation',
  },
  {
    id: 'voice',
    label: 'Voice AI',
    phase: 'B',
    envVars: ['VOICE_PROVIDER', 'VOICE_API_KEY', 'VOICE_VOICE_ID'],
    planned: 'Narration and dialogue audio',
  },
  {
    id: 'video',
    label: 'Video renderer',
    phase: 'C',
    envVars: ['RENDER_WORKER_URL', 'RENDER_WORKER_TOKEN'],
    planned: 'FFmpeg assembly of scenes, narration and captions',
  },
  {
    id: 'youtube',
    label: 'YouTube publishing',
    phase: 'D',
    envVars: ['YOUTUBE_CLIENT_ID', 'YOUTUBE_CLIENT_SECRET', 'YOUTUBE_REFRESH_TOKEN'],
    planned: 'Private/unlisted uploads, public only with owner approval',
  },
]

const STORAGE_CAPABILITY: CapabilityStatus = {
  id: 'media-storage',
  label: 'Media storage (R2)',
  phase: 'B',
  state: 'not_configured',
  detail:
    'No object-storage bucket is attached to this deployment yet. Generated images, audio and video arrive in Phase B.',
  requiredEnvVars: [],
  presentEnvVars: [],
}

function configuredNames(env: Env, names: string[]): string[] {
  return names.filter((name) => {
    const value = (env as unknown as Record<string, unknown>)[name]
    return typeof value === 'string' && value.trim().length > 0
  })
}

/**
 * Honest integration reporting. A capability is only ever marked
 * `connected_verified` after a real call succeeded; nothing here is
 * configured for real AI providers yet, and the states say so.
 */
export function capabilityStatuses(env: Env): CapabilityStatus[] {
  const capabilities = CAPABILITIES.map<CapabilityStatus>((capability) => {
    const present = configuredNames(env, capability.envVars)
    if (present.length === 0) {
      return {
        id: capability.id,
        label: capability.label,
        phase: capability.phase,
        state: 'not_configured',
        detail: `${capability.planned} is not configured. No provider has been selected or connected yet.`,
        requiredEnvVars: capability.envVars,
        presentEnvVars: [],
      }
    }
    return {
      id: capability.id,
      label: capability.label,
      phase: capability.phase,
      state: 'unavailable',
      detail:
        'Variables are set on this deployment, but this build has no provider adapter for them yet — nothing is using them.',
      requiredEnvVars: capability.envVars,
      presentEnvVars: present,
    }
  })

  return [...capabilities, STORAGE_CAPABILITY]
}

export const CATALOG = { PROJECT_STATUSES, EPISODE_STATUSES }
