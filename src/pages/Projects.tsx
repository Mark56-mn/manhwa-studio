import { useCallback, useState } from 'react'

import {
  Button,
  Card,
  EmptyState,
  ErrorNote,
  Label,
  ProjectStatusPill,
  Prompt,
  Spinner,
  TextInput,
} from '../components/ui'
import { ApiError, api, fieldErrors } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useResource } from '../lib/useResource'

import type { Project } from '../lib/api'

const GENRES = ['Action', 'Fantasy', 'Romance', 'Thriller', 'Sci-fi', 'Drama', 'Comedy', 'Historical']

export function Projects({ navigate }: { navigate: (to: string) => void }) {
  const projects = useResource(useCallback(() => api<{ projects: Project[] }>('/api/projects'), []))
  const [formOpen, setFormOpen] = useState(false)
  const [title, setTitle] = useState('')
  const [logline, setLogline] = useState('')
  const [genre, setGenre] = useState('')
  const [saving, setSaving] = useState(false)
  const [formError, setFormError] = useState<string | null>(null)

  async function create(event: React.FormEvent) {
    event.preventDefault()
    setSaving(true)
    setFormError(null)
    try {
      const created = await api<{ project: Project }>('/api/projects', {
        method: 'POST',
        body: JSON.stringify({ title, logline, genre }),
      })
      setTitle('')
      setLogline('')
      setGenre('')
      setFormOpen(false)
      navigate(`/projects/${created.project.id}`)
    } catch (cause) {
      const details = fieldErrors(cause)
      setFormError(
        details.length > 0
          ? details.join(' · ')
          : cause instanceof ApiError
            ? cause.message
            : 'Could not create the project',
      )
    } finally {
      setSaving(false)
    }
  }

  if (projects.error) {
    return (
      <Card title="Projects unavailable">
        <ErrorNote>{projects.error instanceof Error ? projects.error.message : 'Could not load projects'}</ErrorNote>
      </Card>
    )
  }

  const list = projects.data?.projects ?? null

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Projects</h1>
          <Prompt>Each project holds its story bible, seasons, episodes and production history.</Prompt>
        </div>
        <Button type="button" onClick={() => setFormOpen((open) => !open)}>
          {formOpen ? 'Cancel' : 'New project'}
        </Button>
      </div>

      {formOpen && (
        <Card title="New project">
          <form className="form" onSubmit={create}>
            <Label text="Title">
              <TextInput
                value={title}
                onChange={(event) => setTitle(event.target.value)}
                placeholder="The Crimson Pact"
                maxLength={200}
                required
                autoFocus
              />
            </Label>
            <Label text="Logline">
              <TextInput
                value={logline}
                onChange={(event) => setLogline(event.target.value)}
                placeholder="One sentence that sells the series"
                maxLength={2000}
              />
            </Label>
            <Label text="Genre">
              <TextInput
                value={genre}
                onChange={(event) => setGenre(event.target.value)}
                placeholder={GENRES.slice(0, 3).join(', ')}
                list="genre-options"
                maxLength={80}
              />
              <datalist id="genre-options">
                {GENRES.map((option) => (
                  <option key={option} value={option} />
                ))}
              </datalist>
            </Label>
            <ErrorNote>{formError}</ErrorNote>
            <div className="form-actions">
              <Button type="submit" disabled={saving || title.trim().length === 0}>
                {saving ? 'Creating…' : 'Create project'}
              </Button>
            </div>
          </form>
        </Card>
      )}

      {list === null ? (
        <Spinner label="Loading projects…" />
      ) : list.length === 0 ? (
        <Card>
          <EmptyState
            title="No projects yet"
            hint="Create a project to store its story bible, characters and episodes in the studio database."
          />
        </Card>
      ) : (
        <ul className="card-list">
          {list.map((project) => (
            <li key={project.id}>
              <button className="project-card" type="button" onClick={() => navigate(`/projects/${project.id}`)}>
                <div className="project-card-head">
                  <h2>{project.title}</h2>
                  <ProjectStatusPill status={project.status} />
                </div>
                <p className="project-card-logline">{project.logline || 'No logline yet.'}</p>
                <p className="project-card-meta">
                  {project.episodeCount ?? 0} episode{(project.episodeCount ?? 0) === 1 ? '' : 's'}
                  {project.genre ? ` · ${project.genre}` : ''} · updated {relativeTime(project.updatedAt)}
                </p>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  )
}
