import { useCallback } from 'react'

import { Card, EmptyState, ErrorNote, IntegrationStatePill, ProjectStatusPill, Prompt, Spinner, Stat } from '../components/ui'
import { api } from '../lib/api'
import { relativeTime } from '../lib/format'
import { useResource } from '../lib/useResource'

import type { Overview, User } from '../lib/api'

export function Dashboard({ user, navigate }: { user: User; navigate: (to: string) => void }) {
  const resource = useResource(useCallback(() => api<Overview>('/api/overview'), []))
  const overview = resource.data

  const firstName = (user.name ?? user.email ?? 'there').split(' ')[0]

  if (resource.error) {
    return (
      <Card title="Dashboard unavailable">
        <ErrorNote>{resource.error instanceof Error ? resource.error.message : 'Could not load the overview'}</ErrorNote>
      </Card>
    )
  }

  if (!overview) return <Spinner label="Loading studio overview…" />

  const unconfigured = overview.capabilities.filter((capability) => capability.state !== 'connected_verified')

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Studio overview</h1>
          <Prompt>
            Welcome back, {firstName}. Everything below is read from the project database — no placeholder numbers.
          </Prompt>
        </div>
        <button className="btn btn-primary" type="button" onClick={() => navigate('/projects')}>
          Manage projects
        </button>
      </div>

      <div className="stats">
        <Stat label="Projects" value={overview.projects.total} />
        <Stat label="Episodes" value={overview.episodes.total} />
        <Stat label="Awaiting review" value={overview.attention.awaitingReview} tone="amber" />
        <Stat label="Failed stages" value={overview.attention.failed} tone={overview.attention.failed > 0 ? 'red' : undefined} />
      </div>

      <div className="grid-2">
        <Card
          title="Needs attention"
          subtitle="Real episode states that are waiting on you or need a retry"
          actions={
            <button className="btn btn-ghost" type="button" onClick={() => navigate('/projects')}>
              Open projects
            </button>
          }
        >
          {overview.attention.failed + overview.attention.awaitingReview === 0 ? (
            <EmptyState
              title="Nothing is blocked"
              hint="No episode is in review and no stage has failed."
            />
          ) : (
            <ul className="rows">
              {overview.attention.failed > 0 && (
                <li className="row">
                  <span className="row-main">Failed production stages</span>
                  <span className="row-side row-side-red">{overview.attention.failed}</span>
                </li>
              )}
              {overview.attention.awaitingReview > 0 && (
                <li className="row">
                  <span className="row-main">Waiting for your approval</span>
                  <span className="row-side">{overview.attention.awaitingReview}</span>
                </li>
              )}
              {overview.attention.inDraft > 0 && (
                <li className="row">
                  <span className="row-main">Stages in progress</span>
                  <span className="row-side">{overview.attention.inDraft}</span>
                </li>
              )}
            </ul>
          )}
        </Card>

        <Card title="Production capability" subtitle="What this deployment can actually do right now">
          <ul className="rows">
            {overview.capabilities.map((capability) => (
              <li className="row" key={capability.id}>
                <span className="row-main">
                  {capability.label}
                  <small>{capability.detail}</small>
                </span>
                <IntegrationStatePill state={capability.state} />
              </li>
            ))}
          </ul>
          {unconfigured.length > 0 && (
            <button className="btn btn-ghost" type="button" onClick={() => navigate('/integrations')}>
              See what each capability needs
            </button>
          )}
        </Card>
      </div>

      <div className="grid-2">
        <Card title="Recent projects" subtitle="Newest work first">
          {overview.projects.recent.length === 0 ? (
            <EmptyState
              title="No projects yet"
              hint={
                <button className="btn btn-primary" type="button" onClick={() => navigate('/projects')}>
                  Create your first project
                </button>
              }
            />
          ) : (
            <ul className="rows">
              {overview.projects.recent.map((project) => (
                <li className="row row-click" key={project.id}>
                  <button className="row-button" type="button" onClick={() => navigate(`/projects/${project.id}`)}>
                    <span className="row-main">
                      {project.title}
                      <small>
                        {project.episodeCount} episode{project.episodeCount === 1 ? '' : 's'} · updated{' '}
                        {relativeTime(project.updatedAt)}
                      </small>
                    </span>
                    <ProjectStatusPill status={project.status} />
                  </button>
                </li>
              ))}
            </ul>
          )}
        </Card>

        <Card title="Production history" subtitle="Every entry is a recorded action, not a simulated event">
          {overview.recentActivity.length === 0 ? (
            <EmptyState title="No activity yet" hint="Creating a project or episode records the first entry." />
          ) : (
            <ul className="timeline">
              {overview.recentActivity.map((event) => (
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
      </div>
    </div>
  )
}
