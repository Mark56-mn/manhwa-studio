import { resolveProviderConfig } from '../providers'
import { isProviderError } from '../providers/types'
import { resolveCost } from './catalog'
import { backoffMs, costEligibility, maxAttempts, readAllowPaid, taskTimeoutMs } from './policy'
import { loadRoleSettings, resolveCandidates } from './settings'
import {
  cooldownRemainingMs,
  loadProviderState,
  logRouteEvent,
  recordFailure,
  recordSuccess,
  verifiedCapabilities,
} from './state'

import type { AiChatRequest, AiStructuredOutput } from '../providers/types'
import type { Env } from '../env'
import type { ResolvedCandidate, RouteAttempt, RouteResult, RunTaskParams } from './types'

/**
 * The central AI task router. Every workflow calls this instead of a provider.
 *
 * It tries the owner's preferred model first, then the configured fallback
 * order, then any other reachable provider, within strict attempt and time
 * limits. Failover to a model that is not verified free requires explicit
 * authorisation, so a paid model is never chosen silently.
 */

export class AiRoutingError extends Error {
  readonly code: string
  readonly status: number
  readonly attempts: RouteAttempt[]
  readonly missingEnvVars: string[]

  constructor(code: string, message: string, attempts: RouteAttempt[], missingEnvVars: string[] = [], status = 502) {
    super(message)
    this.name = 'AiRoutingError'
    this.code = code
    this.status = status
    this.attempts = attempts
    this.missingEnvVars = missingEnvVars
  }
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function structuredInstruction(format: NonNullable<AiChatRequest['responseFormat']>): string {
  if ('type' in format && format.type === 'json_object') {
    return 'Respond with a single JSON object and nothing else: no markdown, no code fences, no commentary.'
  }
  const schema = (format as AiStructuredOutput).schema
  return `Respond with a single JSON object and nothing else. The JSON must validate against this schema:\n${JSON.stringify(
    schema,
  )}`
}

export interface RouterResolution {
  candidates: Array<{ provider: string; model: string; source: string }>
  detail: string
  missing: string[]
}

export async function describeCandidates(
  db: D1Database,
  env: Env,
  ownerId: string,
  role: RunTaskParams['role'],
): Promise<RouterResolution> {
  const resolution = await resolveCandidates(db, env, ownerId, role)
  return {
    candidates: resolution.candidates.map((candidate) => ({
      provider: candidate.provider,
      model: candidate.model,
      source: candidate.source,
    })),
    detail: resolution.detail,
    missing: resolution.missing,
  }
}

async function recordSkip(
  db: D1Database,
  params: RunTaskParams,
  candidate: ResolvedCandidate,
  attempt: number,
  code: string,
  detail: string,
  attempts: RouteAttempt[],
): Promise<void> {
  const outcome = code === 'paid_not_authorised' ? 'blocked' : 'skipped'
  attempts.push({
    provider: candidate.provider,
    model: candidate.model,
    attempt,
    outcome,
    errorCode: code,
    latencyMs: 0,
    detail,
  })
  await logRouteEvent(db, {
    ownerId: params.ownerId,
    role: params.role,
    task: params.task,
    taskId: params.taskId,
    attempt,
    provider: candidate.provider,
    model: candidate.model,
    outcome,
    errorCode: code,
    detail,
  })
}

export async function runAiTask(env: Env, db: D1Database, params: RunTaskParams): Promise<RouteResult> {
  const resolution = await resolveCandidates(db, env, params.ownerId, params.role)
  if (resolution.candidates.length === 0) {
    throw new AiRoutingError('provider_not_configured', resolution.detail, [], resolution.missing, 503)
  }

  const settings = await loadRoleSettings(db, params.ownerId, params.role)
  const policy = readAllowPaid(env, (settings?.allow_paid ?? 0) === 1)
  const limit = maxAttempts(env)
  const timeout = taskTimeoutMs(env)

  const attempts: RouteAttempt[] = []
  let used = 0
  let failovers = 0

  for (const candidate of resolution.candidates) {
    if (used >= limit) break
    const resolved = resolveProviderConfig(env, candidate.provider, candidate.model, candidate.extraKeyEnvVars)
    const label = resolved.adapter?.label ?? candidate.provider

    if (!resolved.adapter || !resolved.config) {
      await recordSkip(db, params, candidate, used + 1, 'provider_not_configured', resolved.detail, attempts)
      continue
    }

    const state = await loadProviderState(db, candidate.provider, candidate.model)

    if (params.requirements.tools) {
      const verified = verifiedCapabilities(state)
      if (!resolved.adapter.capabilities.tools || verified.tools !== true) {
        await recordSkip(
          db,
          params,
          candidate,
          used + 1,
          'provider_capability_unsupported',
          `${label} · ${candidate.model} is not verified for tool calling, so it was not asked to run a tool.`,
          attempts,
        )
        continue
      }
    }

    const cooling = cooldownRemainingMs(state, Date.now())
    if (cooling > 0) {
      await recordSkip(
        db,
        params,
        candidate,
        used + 1,
        'cooldown',
        `${label} · ${candidate.model} is cooling down for another ${Math.ceil(cooling / 1000)}s after ${
          state?.last_error_code ?? 'a failure'
        }.`,
        attempts,
      )
      continue
    }

    const cost = await resolveCost(db, candidate.provider, candidate.model)
    const eligibility = costEligibility(cost, candidate.source, policy)
    if (!eligibility.eligible) {
      await recordSkip(
        db,
        params,
        candidate,
        used + 1,
        'paid_not_authorised',
        `${label} · ${candidate.model} excluded: ${eligibility.reason}.`,
        attempts,
      )
      continue
    }

    // Structured-output translation: use the provider's native mode when it has
    // one, otherwise a validated prompt-level fallback (never a fake success).
    let messages = params.messages
    let responseFormat: AiChatRequest['responseFormat']
    if (params.requirements.structured && params.responseFormat) {
      if (resolved.adapter.capabilities.structuredOutput !== 'none') {
        responseFormat = params.responseFormat
      } else {
        messages = [...messages, { role: 'system', content: structuredInstruction(params.responseFormat) }]
      }
    }

    const baseRequest: AiChatRequest = {
      model: candidate.model,
      messages,
      responseFormat,
      tools: params.requirements.tools ? params.tools : undefined,
      requestId: params.taskId,
    }
    if (typeof params.temperature === 'number') baseRequest.temperature = params.temperature
    if (typeof params.maxOutputTokens === 'number') baseRequest.maxOutputTokens = params.maxOutputTokens


    let repaired = false
    for (let modelAttempt = 1; modelAttempt <= 2; modelAttempt += 1) {
      if (used >= limit) break
      used += 1
      const attemptNumber = used
      const attemptStart = Date.now()
      const signal = params.signal ?? AbortSignal.timeout(timeout)

      try {
        const result = await resolved.adapter.chat(resolved.config, { ...baseRequest, signal })
        const latencyMs = Date.now() - attemptStart
        const validation = params.validate(result.text)

        if (validation.ok) {
          await recordSuccess(db, candidate.provider, candidate.model, latencyMs)
          attempts.push({
            provider: candidate.provider,
            model: result.model,
            attempt: attemptNumber,
            outcome: 'ok',
            errorCode: null,
            latencyMs,
            detail: validation.detail,
          })
          await logRouteEvent(db, {
            ownerId: params.ownerId,
            role: params.role,
            task: params.task,
            taskId: params.taskId,
            attempt: attemptNumber,
            provider: candidate.provider,
            model: result.model,
            outcome: 'ok',
            latencyMs,
            detail: validation.detail,
          })
          return {
            provider: candidate.provider,
            model: result.model,
            text: result.text,
            requestId: result.requestId,
            usage: result.usage,
            finishReason: result.finishReason,
            toolCalls: result.toolCalls,
            attempts,
            failovers,
          }
        }

        // Bounded repair on the same model, then move on to the next candidate.
        if (!repaired && params.repairPrompt) {
          repaired = true
          const repairMessages = params.repairPrompt(validation.detail, result.text)
          const repairedResult = await resolved.adapter.chat(resolved.config, {
            ...baseRequest,
            messages: repairMessages,
            signal,
          })
          const repairValidation = params.validate(repairedResult.text)
          if (repairValidation.ok) {
            const repairLatency = Date.now() - attemptStart
            await recordSuccess(db, candidate.provider, candidate.model, repairLatency)
            attempts.push({
              provider: candidate.provider,
              model: repairedResult.model,
              attempt: attemptNumber,
              outcome: 'ok',
              errorCode: null,
              latencyMs: repairLatency,
              detail: `repaired: ${repairValidation.detail}`,
            })
            await logRouteEvent(db, {
              ownerId: params.ownerId,
              role: params.role,
              task: params.task,
              taskId: params.taskId,
              attempt: attemptNumber,
              provider: candidate.provider,
              model: repairedResult.model,
              outcome: 'ok',
              latencyMs: repairLatency,
              detail: `repaired: ${repairValidation.detail}`,
            })
            return {
              provider: candidate.provider,
              model: repairedResult.model,
              text: repairedResult.text,
              requestId: repairedResult.requestId,
              usage: repairedResult.usage,
              finishReason: repairedResult.finishReason,
              toolCalls: repairedResult.toolCalls,
              attempts,
              failovers,
            }
          }
          validation.detail = `repair failed: ${repairValidation.detail}`
        }

        await recordFailure(
          db,
          candidate.provider,
          candidate.model,
          'provider_bad_response',
          validation.detail,
          Date.now() - attemptStart,
        )
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          attempt: attemptNumber,
          outcome: 'failed',
          errorCode: 'provider_bad_response',
          latencyMs: Date.now() - attemptStart,
          detail: validation.detail,
        })
        await logRouteEvent(db, {
          ownerId: params.ownerId,
          role: params.role,
          task: params.task,
          taskId: params.taskId,
          attempt: attemptNumber,
          provider: candidate.provider,
          model: candidate.model,
          outcome: 'failed',
          errorCode: 'provider_bad_response',
          latencyMs: Date.now() - attemptStart,
          detail: validation.detail,
        })
        break
      } catch (error) {
        const latencyMs = Date.now() - attemptStart
        const code = isProviderError(error) ? error.code : 'provider_http_error'
        const message = isProviderError(error)
          ? error.message
          : error instanceof Error
            ? error.message
            : 'unknown error'
        const retryable = isProviderError(error) ? error.retryable : false
        await recordFailure(db, candidate.provider, candidate.model, code, message, latencyMs)
        attempts.push({
          provider: candidate.provider,
          model: candidate.model,
          attempt: attemptNumber,
          outcome: 'failed',
          errorCode: code,
          latencyMs,
          detail: message,
        })
        await logRouteEvent(db, {
          ownerId: params.ownerId,
          role: params.role,
          task: params.task,
          taskId: params.taskId,
          attempt: attemptNumber,
          provider: candidate.provider,
          model: candidate.model,
          outcome: 'failed',
          errorCode: code,
          latencyMs,
          detail: message,
        })
        if (retryable && modelAttempt === 1 && used < limit) {
          await sleep(backoffMs(modelAttempt))
          continue
        }
        break
      }
    }

    failovers += 1
  }

  const lastFailure = [...attempts].reverse().find((attempt) => attempt.outcome === 'failed')
  const code = lastFailure?.errorCode ?? 'no_eligible_provider'
  const status =
    code === 'provider_timeout'
      ? 504
      : code === 'provider_rate_limited' || code === 'provider_quota_exhausted'
        ? 429
        : 502
  const message = lastFailure
    ? `No eligible AI provider completed this task. Last failure (${lastFailure.provider} · ${lastFailure.model}): ${lastFailure.detail}`
    : 'No eligible AI provider is available for this task.'
  throw new AiRoutingError(code, message, attempts, [], status)
}


