import { useCallback, useEffect, useState } from 'react'

import {
  Button,
  Card,
  EmptyState,
  EpisodeStatusPill,
  ErrorNote,
  InfoNote,
  IntegrationStatePill,
  Label,
  Pill,
  Prompt,
  Select,
  Spinner,
  TextArea,
} from '../components/ui'
import { ApiError, api, fieldErrors } from '../lib/api'
import { relativeTime, titleCase } from '../lib/format'
import { useResource } from '../lib/useResource'

import type {
  Capability,
  EpisodeDetail,
  ReviewDecision,
  ScriptDetail,
  ScriptList,
  ScriptSummary,
} from '../lib/api'

const SCENE_COUNTS = ['', '4', '6', '8', '12']

const DECISION_LABELS: Record<ReviewDecision, string> = {
  approved: 'Approve script',
  changes_requested: 'Request changes',
  rejected: 'Reject draft',
}

export function EpisodeWorkspace({ episodeId, navigate }: { episodeId: string; navigate: (to: string) => void }) {
  const detail = useResource(useCallback(() => api<EpisodeDetail>(`/api/episodes/${episodeId}`), [episodeId]))
  const scripts = useResource(useCallback(() => api<ScriptList>(`/api/episodes/${episodeId}/scripts`), [episodeId]))
  const integrations = useResource(useCallback(() => api<{ capabilities: Capability[] }>('/api/integrations'), []))

  const [pickedId, setPickedId] = useState<string | null>(null)
  const [selected, setSelected] = useState<ScriptDetail | null>(null)
  const [instructions, setInstructions] = useState('')
  const [sceneCount, setSceneCount] = useState('')
  const [note, setNote] = useState('')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)

  const versions: ScriptSummary[] = scripts.data?.scripts ?? []
  const scriptCapability = integrations.data?.capabilities.find((capability) => capability.id === 'script') ?? null

  // The newest version is shown until the owner explicitly picks another one.
  // This is derived rather than stored, so no effect has to synchronise it.
  const selectedId = pickedId ?? versions[0]?.id ?? null
  const loadingSelected = selectedId !== null && selected?.script.id !== selectedId

  useEffect(() => {
    if (!selectedId) return
    let active = true
    api<ScriptDetail>(`/api/scripts/${selectedId}`)
      .then((value) => {
        if (!active) return
        setSelected(value)
        setError(null)
      })
      .catch((cause: unknown) => {
        if (active) setError(describe(cause))
      })
    return () => {
      active = false
    }
  }, [selectedId])

  async function generate() {
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      const parsed = sceneCount ? Number(sceneCount) : undefined
      const created = await api<{ script: ScriptDetail['script']; providerLabel: string }>(
        `/api/episodes/${episodeId}/scripts`,
        {
          method: 'POST',
          body: JSON.stringify({
            instructions,
            ...(parsed ? { maxScenes: parsed } : {}),
          }),
        },
      )
      await scripts.reload()
      await detail.reload()
      setPickedId(created.script.id)
      setInstructions('')
      setNotice(
        created.script.parseState === 'parsed'
          ? `${created.providerLabel} produced script v${created.script.version}: ${created.script.sceneCount} scene(s).`
          : `${created.providerLabel} produced v${created.script.version}, but it could not be parsed into scenes. The raw text is stored below.`,
      )
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  async function decide(decision: ReviewDecision) {
    if (!selected) return
    setBusy(true)
    setError(null)
    setNotice(null)
    try {
      await api(`/api/scripts/${selected.script.id}/approve`, {
        method: 'POST',
        body: JSON.stringify({ decision, note }),
      })
      await Promise.all([scripts.reload(), detail.reload()])
      setNote('')
      setNotice(`Recorded: ${titleCase(decision)} on script v${selected.script.version}.`)
    } catch (cause) {
      setError(describe(cause))
    } finally {
      setBusy(false)
    }
  }

  if (detail.error && !detail.data) {
    return (
      <div className="stack">
        <Card title="Episode unavailable">
          <ErrorNote>{describe(detail.error)}</ErrorNote>
          <Button variant="ghost" type="button" onClick={() => navigate('/projects')}>
            Back to projects
          </Button>
        </Card>
      </div>
    )
  }

  if (!detail.data) return <Spinner label="Loading episode…" />

  const { episode, project } = detail.data

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <button className="crumb" type="button" onClick={() => navigate(project ? `/projects/${project.id}` : '/projects')}>
            ← {project ? project.title : 'Projects'}
          </button>
          <h1>
            #{episode.episodeNumber} · {episode.title}
          </h1>
          <Prompt>
            {episode.summary || 'No episode brief yet.'}
            {episode.targetDurationSeconds ? ` · target ${episode.targetDurationSeconds}s` : ''}
          </Prompt>
        </div>
        <div className="head-actions">
          <EpisodeStatusPill status={episode.status} />
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="note note-ok">{notice}</p>}

      <ScriptCapabilityBanner capability={scriptCapability} onOpenSettings={() => navigate('/integrations')} />

      <Card
        title="Script AI"
        subtitle="Writes the next version from this project's story bible, cast and episode brief"
      >
        <div className="form">
          <Label text="Direction for this draft (optional)">
            <TextArea
              rows={3}
              value={instructions}
              maxLength={4000}
              placeholder="Keep the reunion scene quiet; end on the rooftop cliffhanger."
              onChange={(event) => setInstructions(event.target.value)}
            />
          </Label>
          <div className="form-row">
            <Label text="Approximate scene count (optional)">
              <Select value={sceneCount} onChange={(event) => setSceneCount(event.target.value)}>
                {SCENE_COUNTS.map((value) => (
                  <option key={value || 'auto'} value={value}>
                    {value === '' ? 'Let the provider decide' : `${value} scenes`}
                  </option>
                ))}
              </Select>
            </Label>
            {scriptCapability?.model && (
              <div className="field">
                <span className="field-label">Model that will be used</span>
                <p className="hint mono">{scriptCapability.model}</p>
              </div>
            )}
          </div>
          <div className="form-actions">
            <Button type="button" disabled={busy} onClick={() => void generate()}>
              {busy ? 'Working…' : 'Generate script'}
            </Button>
            <span className="hint">
              A new version is always created. An approved script is never overwritten.
            </span>
          </div>
        </div>
      </Card>

      <Card
        title="Script versions"
        subtitle={`${versions.length} version${versions.length === 1 ? '' : 's'} for this episode`}
      >
        {scripts.loading && versions.length === 0 ? (
          <Spinner label="Loading versions…" />
        ) : versions.length === 0 ? (
          <EmptyState
            title="No script yet"
            hint="Generate the first version above. Nothing is stored unless the provider returns usable text."
          />
        ) : (
          <ul className="rows">
            {versions.map((version) => (
              <li className={version.id === selectedId ? 'row row-click row-selected' : 'row row-click'} key={version.id}>
                <button type="button" className="row-button" onClick={() => setPickedId(version.id)}>
                  <span className="row-title">
                    v{version.version} · {version.parseState === 'parsed' ? `${version.sceneCount} scenes` : 'not parsed'}
                  </span>
                  <small>
                    {version.provider} · {version.model} · {relativeTime(version.createdAt)}
                  </small>
                </button>
                <div className="row-side">
                  <Pill tone={version.status === 'approved' ? 'green' : version.status === 'rejected' ? 'red' : 'slate'}>
                    {titleCase(version.status)}
                  </Pill>
                  {version.parseState === 'unparsed' && <Pill tone="amber">Unparsed</Pill>}
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>

      {loadingSelected && <Spinner label="Loading script…" />}
      {selected && !loadingSelected && (
        <ScriptViewer
          detail={selected}
          busy={busy}
          note={note}
          onNote={setNote}
          onDecide={decide}
        />
      )}
    </div>
  )
}

function ScriptCapabilityBanner({
  capability,
  onOpenSettings,
}: {
  capability: Capability | null
  onOpenSettings: () => void
}) {
  if (!capability) return null
  return (
    <Card title="Script provider" subtitle="State comes from this deployment's real configuration and real calls">
      <div className="capability-head">
        <p className="capability-detail">{capability.detail}</p>
        <IntegrationStatePill state={capability.state} />
      </div>
      {capability.requiredEnvVars.length > 0 && (
        <p className="hint">
          Deployment variables (names only, values stay secret):{' '}
          {capability.requiredEnvVars.map((name) => (
            <code key={name} className="chip">
              {name}
            </code>
          ))}
        </p>
      )}
      {capability.verifiedAt && <p className="hint">Last verified check: {relativeTime(capability.verifiedAt)}</p>}
      <div className="form-actions">
        <Button variant="ghost" type="button" onClick={onOpenSettings}>
          Open settings &amp; integrations
        </Button>
      </div>
    </Card>
  )
}

function ScriptViewer({
  detail,
  busy,
  note,
  onNote,
  onDecide,
}: {
  detail: ScriptDetail
  busy: boolean
  note: string
  onNote: (value: string) => void
  onDecide: (decision: ReviewDecision) => void
}) {
  const { script, scenes, approvals } = detail
  const parsed = script.parseState === 'parsed'

  return (
    <Card
      title={`Script v${script.version}`}
      subtitle={`${script.provider} · ${script.model} · created ${relativeTime(script.createdAt)}`}
      actions={
        <Pill tone={script.status === 'approved' ? 'green' : script.status === 'rejected' ? 'red' : 'slate'}>
          {titleCase(script.status)}
        </Pill>
      }
    >
      {script.structured?.title && <h3 className="script-title">{script.structured.title}</h3>}
      {script.structured?.logline && <p className="prompt">{script.structured.logline}</p>}

      {!parsed && (
        <InfoNote>
          The provider&rsquo;s answer could not be parsed into scenes, so it is stored exactly as it came back.{' '}
          {script.parseDetail ?? ''} Nothing was invented to fill the gap.
        </InfoNote>
      )}

      {parsed && scenes.length === 0 && (
        <EmptyState title="No scenes recorded" hint="This version parsed but produced no usable scene rows." />
      )}

      {parsed &&
        scenes.map((scene) => (
          <article className="script-scene" key={scene.id}>
            <header>
              <h4>{scene.heading}</h4>
              <span className="hint mono">scene {scene.index}</span>
            </header>
            {scene.description && (
              <p>
                <span className="script-label">Visual</span> {scene.description}
              </p>
            )}
            {scene.narration && (
              <p>
                <span className="script-label">Narration</span> {scene.narration}
              </p>
            )}
            {scene.dialogue.length > 0 && (
              <ul className="script-dialogue">
                {scene.dialogue.map((line, index) => (
                  <li key={`${scene.id}-${index}`}>
                    <span className="script-speaker">{line.speaker}</span> {line.line}
                  </li>
                ))}
              </ul>
            )}
            {scene.imagePrompt && (
              <p className="hint">
                <span className="script-label">Image prompt</span> {scene.imagePrompt}
              </p>
            )}
          </article>
        ))}

      {!parsed && (
        <pre className="script-raw" aria-label="Unparsed provider output">
          {script.rawText}
        </pre>
      )}

      {script.structured?.continuityNotes && (
        <p className="hint">
          <span className="script-label">Continuity notes</span> {script.structured.continuityNotes}
        </p>
      )}

      <p className="hint">
        {script.characterCount.toLocaleString()} characters
        {script.inputTokens !== null ? ` · ${script.inputTokens} input tokens` : ''}
        {script.outputTokens !== null ? ` · ${script.outputTokens} output tokens` : ''}
      </p>

      <div className="form">
        <Label text="Review note (optional)">
          <TextArea rows={2} value={note} maxLength={2000} onChange={(event) => onNote(event.target.value)} />
        </Label>
        <div className="form-actions">
          {(['approved', 'changes_requested', 'rejected'] as ReviewDecision[]).map((decision) => (
            <Button
              key={decision}
              type="button"
              variant={decision === 'approved' ? 'primary' : decision === 'rejected' ? 'danger' : 'ghost'}
              disabled={busy}
              onClick={() => onDecide(decision)}
            >
              {DECISION_LABELS[decision]}
            </Button>
          ))}
        </div>
      </div>

      {approvals.length > 0 && (
        <>
          <h4 className="script-subhead">Decisions</h4>
          <ul className="timeline">
            {approvals.map((approval) => (
              <li key={approval.id}>
                <span className="timeline-dot" />
                <div>
                  <p className="timeline-text">
                    {titleCase(approval.decision)}
                    {approval.note ? ` — ${approval.note}` : ''}
                  </p>
                  <p className="timeline-meta">{relativeTime(approval.createdAt)}</p>
                </div>
              </li>
            ))}
          </ul>
        </>
      )}
    </Card>
  )
}

function describe(cause: unknown): string {
  if (cause instanceof ApiError) {
    const fields = fieldErrors(cause)
    if (fields.length > 0) return `${cause.message}: ${fields.join(' · ')}`
    if (cause.status === 503 && cause.code === 'provider_not_configured') return cause.message
    if (cause.status === 404) return 'This episode does not exist, or it belongs to another account.'
    return cause.message
  }
  if (cause instanceof Error) return cause.message
  return 'Something went wrong'
}
