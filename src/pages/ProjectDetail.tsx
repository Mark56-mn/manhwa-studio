import { useCallback, useState } from 'react'

import {
  Button,
  Card,
  EmptyState,
  EpisodeStatusPill,
  ErrorNote,
  Label,
  Pill,
  ProjectStatusPill,
  Prompt,
  Select,
  Spinner,
  Tabs,
  TextArea,
  TextInput,
} from '../components/ui'
import { ApiError, api, fieldErrors } from '../lib/api'
import { duration, relativeTime, titleCase } from '../lib/format'
import { useResource } from '../lib/useResource'

import type { Character, Episode, EpisodeStatus, ProjectDetail as Detail, ProjectStatus } from '../lib/api'

const PROJECT_STATUSES: ProjectStatus[] = ['development', 'in_production', 'paused', 'completed']
const EPISODE_STATUSES: EpisodeStatus[] = [
  'planned',
  'script_drafting',
  'script_review',
  'script_approved',
  'art_generating',
  'art_review',
  'audio_generating',
  'video_assembling',
  'video_review',
  'approved',
  'published',
  'failed',
]
const ROLES: Character['role'][] = ['protagonist', 'antagonist', 'supporting', 'minor']

type TabId = 'episodes' | 'story' | 'cast' | 'history'

export function ProjectDetail({
  projectId,
  navigate,
}: {
  projectId: string
  navigate: (to: string) => void
}) {
  const detail = useResource(useCallback(() => api<Detail>(`/api/projects/${projectId}`), [projectId]))
  const [tab, setTab] = useState<TabId>('episodes')
  const [notice, setNotice] = useState<string | null>(null)

  const error = detail.error
    ? errorText(detail.error)
    : null

  async function mutate<T>(action: () => Promise<T>, message: string): Promise<boolean> {
    try {
      await action()
      await detail.reload()
      setNotice(message)
      detail.setError(null)
      return true
    } catch (cause) {
      const details = fieldErrors(cause)
      setNotice(null)
      detail.setError(new Error(details.length > 0 ? details.join(' · ') : errorText(cause)))
      return false
    }
  }

  if (error && !detail.data) {
    return (
      <div className="stack">
        <Card title="Project unavailable">
          <ErrorNote>{error}</ErrorNote>
          <Button variant="ghost" type="button" onClick={() => navigate('/projects')}>
            Back to projects
          </Button>
        </Card>
      </div>
    )
  }

  if (!detail.data) return <Spinner label="Loading project…" />

  const { project, episodes, characters, activity, seasons } = detail.data

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <button className="crumb" type="button" onClick={() => navigate('/projects')}>
            ← Projects
          </button>
          <h1>{project.title}</h1>
          <Prompt>
            {project.logline || 'No logline yet.'} · Updated {relativeTime(project.updatedAt)}
          </Prompt>
        </div>
        <div className="head-actions">
          <ProjectStatusPill status={project.status} />
          <Select
            aria-label="Project status"
            value={project.status}
            onChange={(event) =>
              void mutate(
                () =>
                  api(`/api/projects/${project.id}`, {
                    method: 'PATCH',
                    body: JSON.stringify({ status: event.target.value }),
                  }),
                `Project status set to ${titleCase(event.target.value)}.`,
              )
            }
          >
            {PROJECT_STATUSES.map((status) => (
              <option key={status} value={status}>
                {titleCase(status)}
              </option>
            ))}
          </Select>
          <Button
            variant="danger"
            type="button"
            onClick={() => {
              if (!window.confirm(`Delete “${project.title}” and all of its episodes? This cannot be undone.`)) return
              void mutate(() => api(`/api/projects/${project.id}`, { method: 'DELETE' }), '').then((ok) => {
                if (ok) navigate('/projects')
              })
            }}
          >
            Delete
          </Button>
        </div>
      </div>

      <ErrorNote>{error}</ErrorNote>
      {notice && <p className="note note-ok">{notice}</p>}

      <Tabs
        tabs={[
          { id: 'episodes', label: 'Episodes', badge: episodes.length },
          { id: 'story', label: 'Story bible' },
          { id: 'cast', label: 'Cast', badge: characters.length },
          { id: 'history', label: 'History', badge: activity.length },
        ]}
        active={tab}
        onChange={setTab}
      />

      {tab === 'episodes' && (
        <EpisodesTab
          projectId={project.id}
          episodes={episodes}
          onMutate={mutate}
          navigate={navigate}
          seasons={seasons}
        />
      )}
      {tab === 'story' && <StoryTab project={project} onMutate={mutate} />}
      {tab === 'cast' && <CastTab projectId={project.id} characters={characters} onMutate={mutate} />}
      {tab === 'history' && (
        <Card title="Production history" subtitle="Recorded actions for this project">
          {activity.length === 0 ? (
            <EmptyState title="No activity yet" />
          ) : (
            <ul className="timeline">
              {activity.map((event) => (
                <li key={event.id}>
                  <span className="timeline-dot" />
                  <div>
                    <p className="timeline-text">{event.summary}</p>
                    <p className="timeline-meta">
                      {event.actorType} · {event.eventType} · {relativeTime(event.createdAt)}
                    </p>
                  </div>
                </li>
              ))}
            </ul>
          )}
        </Card>
      )}
    </div>
  )
}

function EpisodesTab({
  projectId,
  episodes,
  seasons,
  onMutate,
  navigate,
}: {
  projectId: string
  episodes: Episode[]
  seasons: Detail['seasons']
  onMutate: (action: () => Promise<unknown>, message: string) => Promise<boolean>
  navigate: (to: string) => void
}) {
  const [title, setTitle] = useState('')
  const [summary, setSummary] = useState('')
  const [target, setTarget] = useState('')

  return (
    <div className="stack">
      <Card title="Add an episode" subtitle="Episodes are numbered automatically inside the project">
        <form
          className="form form-inline"
          onSubmit={(event) => {
            event.preventDefault()
            const seconds = target.trim() === '' ? undefined : Number(target)
            void onMutate(
              () =>
                api(`/api/projects/${projectId}/episodes`, {
                  method: 'POST',
                  body: JSON.stringify({ title, summary, targetDurationSeconds: seconds }),
                }),
              `Episode “${title}” created.`,
            ).then((ok) => {
              if (ok) {
                setTitle('')
                setSummary('')
                setTarget('')
              }
            })
          }}
        >
          <Label text="Episode title">
            <TextInput value={title} onChange={(event) => setTitle(event.target.value)} required maxLength={200} />
          </Label>
          <Label text="Target length (seconds, optional)">
            <TextInput
              value={target}
              onChange={(event) => setTarget(event.target.value)}
              inputMode="numeric"
              placeholder="480"
            />
          </Label>
          <Label text="Summary (optional)">
            <TextInput value={summary} onChange={(event) => setSummary(event.target.value)} maxLength={20000} />
          </Label>
          <div className="form-actions">
            <Button type="submit" disabled={title.trim().length === 0}>
              Create episode
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Episodes" subtitle={`${episodes.length} in this project`}>
        {episodes.length === 0 ? (
          <EmptyState title="No episodes yet" hint="Add the first episode above; it starts in the Planned stage." />
        ) : (
          <ul className="rows">
            {episodes.map((episode) => (
              <li className="row" key={episode.id}>
                <div className="row-main">
                  <span className="row-title">
                    #{episode.episodeNumber} · {episode.title}
                  </span>
                  <small>
                    {episode.summary || 'No summary'}
                    {episode.targetDurationSeconds ? ` · target ${duration(episode.targetDurationSeconds)}` : ''}
                    {seasons.length > 0 && episode.seasonId
                      ? ` · season ${seasons.find((season) => season.id === episode.seasonId)?.seasonNumber ?? '—'}`
                      : ''}
                  </small>
                </div>
                <div className="row-side">
                  <EpisodeStatusPill status={episode.status} />
                  <Select
                    aria-label={`Status for ${episode.title}`}
                    value={episode.status}
                    onChange={(event) =>
                      void onMutate(
                        () =>
                          api(`/api/episodes/${episode.id}`, {
                            method: 'PATCH',
                            body: JSON.stringify({ status: event.target.value }),
                          }),
                        `${episode.title} set to ${titleCase(event.target.value)}.`,
                      )
                    }
                  >
                    {EPISODE_STATUSES.map((status) => (
                      <option key={status} value={status}>
                        {titleCase(status)}
                      </option>
                    ))}
                  </Select>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      void onMutate(
                        () => api(`/api/episodes/${episode.id}`, { method: 'DELETE' }),
                        `Episode ${episode.episodeNumber} deleted.`,
                      )
                    }
                  >
                    Delete
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
        <p className="hint">
          Script, art, audio and video generation are not implemented in this build, so statuses are set manually by
          you.{' '}
          <button className="link" type="button" onClick={() => navigate('/projects')}>
            Back to projects
          </button>
        </p>
      </Card>
    </div>
  )
}

function StoryTab({
  project,
  onMutate,
}: {
  project: Detail['project']
  onMutate: (action: () => Promise<unknown>, message: string) => Promise<boolean>
}) {
  const [form, setForm] = useState({
    logline: project.logline,
    synopsis: project.synopsis,
    genre: project.genre,
    tone: project.tone,
    language: project.language,
    storyBible: project.storyBible,
  })

  return (
    <Card
      title="Story bible"
      subtitle="Continuity reference the script worker will read: world rules, naming, character notes and previous events"
    >
      <form
        className="form"
        onSubmit={(event) => {
          event.preventDefault()
          void onMutate(
            () => api(`/api/projects/${project.id}`, { method: 'PATCH', body: JSON.stringify(form) }),
            'Story bible saved.',
          )
        }}
      >
        <div className="form-row">
          <Label text="Logline">
            <TextInput value={form.logline} onChange={(event) => setForm({ ...form, logline: event.target.value })} />
          </Label>
          <Label text="Genre">
            <TextInput value={form.genre} onChange={(event) => setForm({ ...form, genre: event.target.value })} />
          </Label>
        </div>
        <div className="form-row">
          <Label text="Tone">
            <TextInput value={form.tone} onChange={(event) => setForm({ ...form, tone: event.target.value })} />
          </Label>
          <Label text="Language">
            <TextInput value={form.language} onChange={(event) => setForm({ ...form, language: event.target.value })} />
          </Label>
        </div>
        <Label text="Synopsis">
          <TextArea
            rows={4}
            value={form.synopsis}
            onChange={(event) => setForm({ ...form, synopsis: event.target.value })}
          />
        </Label>
        <Label text="Continuity notes">
          <TextArea
            rows={10}
            value={form.storyBible}
            placeholder={'World rules\nNaming conventions\nCharacter descriptions that must stay consistent\nPrevious events'}
            onChange={(event) => setForm({ ...form, storyBible: event.target.value })}
          />
        </Label>
        <div className="form-actions">
          <Button type="submit">Save story bible</Button>
          <Pill tone="slate">v1 · no version history yet</Pill>
        </div>
      </form>
    </Card>
  )
}

function CastTab({
  projectId,
  characters,
  onMutate,
}: {
  projectId: string
  characters: Character[]
  onMutate: (action: () => Promise<unknown>, message: string) => Promise<boolean>
}) {
  const [form, setForm] = useState({ name: '', role: 'supporting', description: '', appearance: '' })

  return (
    <div className="stack">
      <Card title="Add a character" subtitle="Approved descriptions become the image worker's continuity reference">
        <form
          className="form"
          onSubmit={(event) => {
            event.preventDefault()
            void onMutate(
              () => api(`/api/projects/${projectId}/characters`, { method: 'POST', body: JSON.stringify(form) }),
              `Character “${form.name}” added.`,
            ).then((ok) => {
              if (ok) setForm({ name: '', role: 'supporting', description: '', appearance: '' })
            })
          }}
        >
          <div className="form-row">
            <Label text="Name">
              <TextInput
                value={form.name}
                onChange={(event) => setForm({ ...form, name: event.target.value })}
                required
                maxLength={120}
              />
            </Label>
            <Label text="Role">
              <Select value={form.role} onChange={(event) => setForm({ ...form, role: event.target.value })}>
                {ROLES.map((role) => (
                  <option key={role} value={role}>
                    {titleCase(role)}
                  </option>
                ))}
              </Select>
            </Label>
          </div>
          <Label text="Description">
            <TextArea
              rows={3}
              value={form.description}
              onChange={(event) => setForm({ ...form, description: event.target.value })}
            />
          </Label>
          <Label text="Visual reference (hair, build, clothing, palette)">
            <TextArea
              rows={3}
              value={form.appearance}
              onChange={(event) => setForm({ ...form, appearance: event.target.value })}
            />
          </Label>
          <div className="form-actions">
            <Button type="submit" disabled={form.name.trim().length === 0}>
              Add character
            </Button>
          </div>
        </form>
      </Card>

      <Card title="Cast" subtitle={`${characters.length} character${characters.length === 1 ? '' : 's'}`}>
        {characters.length === 0 ? (
          <EmptyState title="No characters yet" />
        ) : (
          <ul className="rows">
            {characters.map((character) => (
              <li className="row" key={character.id}>
                <div className="row-main">
                  <span className="row-title">{character.name}</span>
                  <small>
                    {character.description || 'No description'}
                    {character.appearance ? ` · ${character.appearance}` : ''}
                  </small>
                </div>
                <div className="row-side">
                  <Pill tone="violet">{titleCase(character.role)}</Pill>
                  <Button
                    variant="ghost"
                    type="button"
                    onClick={() =>
                      void onMutate(
                        () => api(`/api/characters/${character.id}`, { method: 'DELETE' }),
                        `${character.name} removed.`,
                      )
                    }
                  >
                    Remove
                  </Button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </Card>
    </div>
  )
}

function errorText(cause: unknown): string {
  if (cause instanceof ApiError && cause.status === 404) {
    return 'This project does not exist, or it belongs to another account.'
  }
  if (cause instanceof Error) return cause.message
  return 'Something went wrong'
}
