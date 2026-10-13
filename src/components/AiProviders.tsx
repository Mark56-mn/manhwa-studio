import { useCallback, useState } from 'react'

import { Button, Card, ErrorNote, IntegrationStatePill, InfoNote, Label, Pill, Select, Spinner, TextInput } from './ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { describeError, useResource } from '../lib/useResource'

import type { AiProvider, AiProviderTestResult, AiRole, AiRoleSetting, AiRouterStatus, AiSettingsResponse } from '../lib/api'

type Draft = {
  provider: string
  model: string
  manual: string
  fallbacks: string
  allowPaid: boolean
}

const ROLE_LABEL: Record<AiRole, string> = { director: 'Director AI', script: 'Script AI' }

function emptyRole(role: AiRole): AiRoleSetting {
  return { role, provider: null, model: null, allowPaid: false, fallbacks: [], updatedAt: null }
}

function toDraft(role: AiRoleSetting): Draft {
  return {
    provider: role.provider ?? '',
    model: role.model ?? '',
    manual: '',
    fallbacks: role.fallbacks.map((fallback) => `${fallback.provider}:${fallback.model ?? ''}`).join('\n'),
    allowPaid: role.allowPaid,
  }
}

function parseFallbacks(text: string): Array<{ provider: string; model: string | null }> {
  return text
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => {
      const [provider, ...rest] = line.split(':')
      return { provider: (provider ?? '').trim(), model: rest.join(':').trim() || null }
    })
    .filter((entry) => entry.provider.length > 0)
}

/**
 * Provider configuration, connection tests, model selection and router status.
 * API keys are never shown: they live only in the deployment environment, and
 * this panel only ever receives variable names.
 */
export function AiProviders() {
  const resource = useResource(
    useCallback(async () => {
      const [settings, router] = await Promise.all([
        api<AiSettingsResponse>('/api/ai/settings'),
        api<AiRouterStatus>('/api/ai/router'),
      ])
      return { settings, router }
    }, []),
  )
  const [busy, setBusy] = useState<string | null>(null)
  const [testResult, setTestResult] = useState<AiProviderTestResult | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  const [edits, setEdits] = useState<Partial<Record<AiRole, Partial<Draft>>>>({})

  if (resource.error && !resource.data) {
    return (
      <Card title="AI providers unavailable">
        <ErrorNote>{describeError(resource.error, 'Could not load AI settings')}</ErrorNote>
      </Card>
    )
  }
  if (!resource.data) return <Spinner label="Loading AI providers…" />

  const { settings, router } = resource.data
  const providers = settings.providers

  function draftFor(role: AiRole): Draft {
    const base = toDraft(settings.roles.find((entry) => entry.role === role) ?? emptyRole(role))
    return { ...base, ...edits[role] }
  }

  function updateDraft(role: AiRole, patch: Partial<Draft>): void {
    setEdits((current) => ({ ...current, [role]: { ...current[role], ...patch } }))
  }

  async function run(label: string, action: () => Promise<void>): Promise<void> {
    setBusy(label)
    setActionError(null)
    try {
      await action()
    } catch (cause) {
      setActionError(cause instanceof Error ? cause.message : 'The action failed')
    } finally {
      setBusy(null)
    }
  }

  async function saveRole(role: AiRole): Promise<void> {
    const draft = draftFor(role)
    const model = draft.manual.trim() || draft.model.trim()
    await api('/api/ai/settings', {
      method: 'PUT',
      body: JSON.stringify({
        role,
        provider: draft.provider || null,
        model: model || null,
        fallbacks: parseFallbacks(draft.fallbacks),
        allowPaid: draft.allowPaid,
      }),
    })
    setNotice(`${ROLE_LABEL[role]} saved.`)
    setEdits((current) => ({ ...current, [role]: {} }))
    await resource.reload()
  }

  return (
    <div className="stack">
      <Card
        title="AI providers"
        subtitle="OpenRouter, NVIDIA NIM, Google Gemini and Baseten behind one adapter. Keys live only in the deployment environment."
      >
        <InfoNote>{settings.secretsPolicy.detail}</InfoNote>
        <InfoNote>{settings.costPolicy.detail}</InfoNote>
        {notice && <p className="note note-ok">{notice}</p>}
        {actionError && <ErrorNote>{actionError}</ErrorNote>}
        <ul className="rows">
          {providers.map((provider) => (
            <ProviderRow
              key={provider.id}
              provider={provider}
              busy={busy}
              onTest={() =>
                run(`test:${provider.id}`, async () => {
                  const body = await api<{ result: AiProviderTestResult }>(`/api/ai/providers/${provider.id}/test`, {
                    method: 'POST',
                    body: JSON.stringify({ model: provider.defaultModel || undefined }),
                  })
                  setTestResult(body.result)
                  await resource.reload()
                })
              }
              onDiscover={() =>
                run(`models:${provider.id}`, async () => {
                  await api(`/api/ai/providers/${provider.id}/models`, { method: 'POST', body: '{}' })
                  setNotice(`Model list refreshed for ${provider.label}.`)
                  await resource.reload()
                })
              }
              onMarkFree={(model) =>
                run(`cost:${provider.id}:${model}`, async () => {
                  await api('/api/ai/models/cost', {
                    method: 'POST',
                    body: JSON.stringify({ provider: provider.id, model, free: 'free' }),
                  })
                  setNotice(`${model} marked as verified zero-cost.`)
                  await resource.reload()
                })
              }
            />
          ))}
        </ul>
        {testResult && (
          <p className={testResult.ok ? 'note note-ok' : 'note note-error'}>
            {testResult.providerLabel}: {testResult.detail}
            {testResult.code ? ` (${testResult.code})` : ''} · {testResult.latencyMs} ms
          </p>
        )}
      </Card>

      {(['director', 'script'] as AiRole[]).map((role) => (
        <RoleEditor
          key={role}
          role={role}
          draft={draftFor(role)}
          providers={providers}
          busy={busy === `save:${role}`}
          onChange={(patch) => updateDraft(role, patch)}
          onSave={() => run(`save:${role}`, () => saveRole(role))}
        />
      ))}

      <Card title="Task router" subtitle="What the router can use right now, and why anything was excluded.">
        <div className="grid-2">
          {router.roles.map((role) => (
            <div key={role.role}>
              <h3 className="card-subtitle">{ROLE_LABEL[role.role]} candidates</h3>
              {role.candidates.length === 0 ? (
                <p className="hint">
                  {role.detail} {role.missing.length > 0 && `Missing: ${role.missing.join(', ')}`}
                </p>
              ) : (
                <ol className="bullets">
                  {role.candidates.map((candidate) => (
                    <li key={`${candidate.provider}:${candidate.model}`}>
                      <code className="chip">
                        {candidate.provider} · {candidate.model}
                      </code>{' '}
                      <span className="hint">{candidate.source}</span>
                    </li>
                  ))}
                </ol>
              )}
            </div>
          ))}
        </div>
        <p className="hint">
          Last active:{' '}
          {router.lastActive
            ? `${router.lastActive.provider} · ${router.lastActive.model} (${router.lastActive.task})`
            : 'none yet'}
        </p>
        {router.cooldowns.length > 0 && (
          <details className="hint">
            <summary>{router.cooldowns.length} model(s) cooling down</summary>
            <ul className="bullets">
              {router.cooldowns.map((cooldown) => (
                <li key={`${cooldown.provider}:${cooldown.model}`}>
                  {cooldown.provider} · {cooldown.model} until {new Date(cooldown.until).toLocaleTimeString()} (
                  {cooldown.reason})
                </li>
              ))}
            </ul>
          </details>
        )}
        {router.recentFailures.length > 0 && (
          <details className="hint">
            <summary>{router.recentFailures.length} recent failure/failover event(s)</summary>
            <ul className="bullets">
              {router.recentFailures.map((failure, index) => (
                <li key={`${failure.provider}:${index}`}>
                  {failure.provider} · {failure.model ?? 'unknown'} · {failure.errorCode ?? 'error'} — {failure.detail}
                </li>
              ))}
            </ul>
          </details>
        )}
      </Card>
    </div>
  )
}


function ProviderRow({
  provider,
  busy,
  onTest,
  onDiscover,
  onMarkFree,
}: {
  provider: AiProvider
  busy: string | null
  onTest: () => void
  onDiscover: () => void
  onMarkFree: (model: string) => void
}) {
  return (
    <li className="row">
      <span className="row-main">
        {provider.label}
        <small>
          {provider.configured
            ? provider.baseUrl ?? 'default endpoint'
            : `Not configured — set ${provider.keyEnvVars.join(' or ')} as a deployment secret`}
          {provider.lastTestAt ? ` · last test ${relativeTime(provider.lastTestAt)}` : ' · never tested'}
        </small>
        <small className="mono">
          {provider.keyEnvVars.join(', ')}
          {provider.baseUrlEnvVars.length > 0 ? ` · ${provider.baseUrlEnvVars.join(', ')}` : ''}
        </small>
        <span>
          <Pill tone={provider.capabilities.streaming ? 'blue' : 'slate'}>stream</Pill>{' '}
          <Pill tone={provider.capabilities.structuredOutput === 'none' ? 'slate' : 'violet'}>
            json:{provider.capabilities.structuredOutput}
          </Pill>{' '}
          <Pill tone={provider.capabilities.tools ? 'violet' : 'slate'}>tools*</Pill>
        </span>
        {provider.models.length > 0 && (
          <details>
            <summary>{provider.models.length} discovered model(s)</summary>
            <ul className="bullets model-list">
              {provider.models.slice(0, 40).map((model) => (
                <li key={model.id}>
                  <code className="chip">{model.id}</code> <span className="hint">{model.free}</span>{' '}
                  {model.free !== 'free' && (
                    <Button variant="ghost" type="button" onClick={() => onMarkFree(model.id)}>
                      Mark zero-cost
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          </details>
        )}
      </span>
      <span className="verify">
        <IntegrationStatePill state={provider.state} />
        <Button variant="ghost" type="button" disabled={busy !== null} onClick={onDiscover}>
          {busy === `models:${provider.id}` ? 'Discovering…' : 'Discover models'}
        </Button>
        <Button variant="ghost" type="button" disabled={busy !== null || !provider.configured} onClick={onTest}>
          {busy === `test:${provider.id}` ? 'Testing…' : 'Test connection'}
        </Button>
      </span>
    </li>
  )
}

function RoleEditor({
  role,
  draft,
  providers,
  busy,
  onChange,
  onSave,
}: {
  role: AiRole
  draft: Draft
  providers: AiProvider[]
  busy: boolean
  onChange: (patch: Partial<Draft>) => void
  onSave: () => void
}) {
  const selected = providers.find((provider) => provider.id === draft.provider)
  const models = selected?.models ?? []
  return (
    <Card title={`${ROLE_LABEL[role]} defaults`} subtitle="Independent provider and model. Fallbacks are tried in order.">
      <div className="grid-2">
        <Label text="Provider">
          <Select value={draft.provider} onChange={(event) => onChange({ provider: event.target.value, model: '' })}>
            <option value="">Router chooses automatically</option>
            {providers.map((provider) => (
              <option key={provider.id} value={provider.id}>
                {provider.label}
                {provider.configured ? '' : ' (not configured)'}
              </option>
            ))}
          </Select>
        </Label>
        <Label text="Model (discovered)">
          <Select value={draft.model} onChange={(event) => onChange({ model: event.target.value })}>
            <option value="">(none selected)</option>
            {models.map((model) => (
              <option key={model.id} value={model.id}>
                {model.id} — {model.free}
              </option>
            ))}
            {draft.model && !models.some((model) => model.id === draft.model) && (
              <option value={draft.model}>{draft.model} (manual)</option>
            )}
          </Select>
        </Label>
      </div>
      <Label text="Manual model id (when discovery is unavailable)">
        <TextInput
          value={draft.manual}
          placeholder="e.g. openai/gpt-oss-120b"
          onChange={(event) => onChange({ manual: event.target.value })}
        />
      </Label>
      <Label text="Fallback order (one per line, provider:model)">
        <textarea
          className="input textarea"
          rows={3}
          value={draft.fallbacks}
          placeholder={'openrouter:openrouter/free\nnvidia:some-model'}
          onChange={(event) => onChange({ fallbacks: event.target.value })}
        />
      </Label>
      <label className="field checkbox">
        <input
          type="checkbox"
          checked={draft.allowPaid}
          onChange={(event) => onChange({ allowPaid: event.target.checked })}
        />
        <span>Allow a paid fallback for this role (off by default — free-only)</span>
      </label>
      <Button type="button" disabled={busy} onClick={onSave}>
        {busy ? 'Saving…' : 'Save'}
      </Button>
      <p className="hint">* Tool calling is only used when a real capability probe confirmed it for the model.</p>
    </Card>
  )
}

