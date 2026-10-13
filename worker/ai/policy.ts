import { readEnvValue } from '../providers'

import type { Env } from '../env'
import type { ModelCostPolicy } from '../providers/types'
import type { ResolvedCandidate } from './types'

/**
 * Free-budget protection. Free-only is the default: a model may be used when it
 * is verified zero-cost, when the owner explicitly selected it, or when paid use
 * has been authorised. An automatic failover never silently picks a paid model.
 */
export interface CostPolicy {
  allowPaid: boolean
  detail: string
}

export function readAllowPaid(env: Env, settingsAllowPaid: boolean): CostPolicy {
  const flag = (readEnvValue(env, 'AI_ALLOW_PAID') ?? '').toLowerCase()
  const envAllows = flag === 'true' || flag === '1' || flag === 'yes'
  const allowPaid = settingsAllowPaid || envAllows
  return {
    allowPaid,
    detail: allowPaid
      ? 'Paid use is authorised for this role.'
      : 'Free-only: failover only considers models verified as zero-cost.',
  }
}

export interface Eligibility {
  eligible: boolean
  reason: string
}

export function costEligibility(
  cost: ModelCostPolicy,
  source: ResolvedCandidate['source'],
  policy: CostPolicy,
): Eligibility {
  if (cost === 'free') return { eligible: true, reason: 'verified zero-cost' }
  if (policy.allowPaid) return { eligible: true, reason: 'paid use is authorised' }
  // An explicitly chosen model is not a silent fallback: the owner selected it.
  if (source === 'preferred') return { eligible: true, reason: 'explicitly selected by the owner' }
  return {
    eligible: false,
    reason:
      cost === 'paid'
        ? 'not free and paid use is not authorised'
        : 'cost not verified as free and paid use is not authorised',
  }
}

export function maxAttempts(env: Env): number {
  const parsed = Number.parseInt(readEnvValue(env, 'AI_MAX_ATTEMPTS') ?? '', 10)
  if (!Number.isFinite(parsed)) return 4
  return Math.min(Math.max(parsed, 1), 6)
}

export function taskTimeoutMs(env: Env): number {
  const parsed = Number.parseInt(readEnvValue(env, 'AI_TASK_TIMEOUT_MS') ?? '', 10)
  if (!Number.isFinite(parsed)) return 120_000
  return Math.min(Math.max(parsed, 5_000), 300_000)
}

/** Backoff between transient retries on the same model. */
export function backoffMs(attempt: number): number {
  return Math.min(250 * 2 ** Math.max(attempt - 1, 0), 2_000)
}
