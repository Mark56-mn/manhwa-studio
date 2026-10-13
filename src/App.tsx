import { useCallback, useEffect, useState } from 'react'

import { Shell } from './components/Shell'
import { Button, Card, Prompt, Spinner } from './components/ui'
import { fetchHealth, fetchSession } from './lib/api'
import { matchRoute, useRoute } from './lib/router'
import { Bootstrap } from './pages/Bootstrap'
import { Dashboard } from './pages/Dashboard'
import { EpisodeWorkspace } from './pages/EpisodeWorkspace'
import { Integrations } from './pages/Integrations'
import { ProjectDetail } from './pages/ProjectDetail'
import { Projects } from './pages/Projects'

import type { HealthReport, User } from './lib/api'
import { useResource } from './lib/useResource'

export function App() {
  const { path, navigate } = useRoute()
  const [user, setUser] = useState<User | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let active = true
    fetchSession()
      .then((session) => {
        if (!active) return
        setUser(session)
        setLoading(false)
      })
      .catch(() => {
        if (active) setLoading(false)
      })
    return () => {
      active = false
    }
  }, [])

  const route = matchRoute(path)
  // Health is public, so it can tell us a database with no schema yet — before
  // any session exists.
  const health = useResource(useCallback(() => fetchHealth(), []))
  const healthReport: HealthReport | null = health.data
  const needsInitialization = healthReport?.checks.database?.state === 'failed'

  let page: React.ReactNode
  if (loading) {
    page = <Spinner label="Checking your session…" />
  } else if (healthReport && needsInitialization) {
    page = <Bootstrap health={healthReport} onInitialized={() => window.location.reload()} />
  } else if (!user) {
    page = <SignInPrompt path={path} />
  } else if (route.name === 'dashboard') {
    page = <Dashboard user={user} navigate={navigate} />
  } else if (route.name === 'projects') {
    page = <Projects navigate={navigate} />
  } else if (route.name === 'project' && route.projectId) {
    page = <ProjectDetail key={route.projectId} projectId={route.projectId} navigate={navigate} />
  } else if (route.name === 'episode' && route.episodeId) {
    page = <EpisodeWorkspace key={route.episodeId} episodeId={route.episodeId} navigate={navigate} />
  } else if (route.name === 'integrations') {
    page = <Integrations user={user} />
  } else {
    page = (
      <Card title="Page not found">
        <Prompt>That route does not exist in the studio.</Prompt>
        <Button type="button" onClick={() => navigate('/')}>
          Back to the dashboard
        </Button>
      </Card>
    )
  }

  return (
    <Shell user={user} path={path} navigate={navigate}>
      {page}
    </Shell>
  )
}

function SignInPrompt({ path }: { path: string }) {
  const returnTo = path === '/' ? '/' : path
  return (
    <Card title="Sign in to Manhwa Studio" subtitle="Your stories, episodes and progress stay private to your account">
      <Prompt>
        Manhwa Studio uses Sign in with Freebuff: your existing Google, GitHub or Apple account through Freebuff. The
        studio never sees your password, and no secret is stored in this project.
      </Prompt>
      <a className="btn btn-primary" href={`/auth/freebuff/signin?returnTo=${encodeURIComponent(returnTo)}`}>
        Sign in with Freebuff
      </a>
    </Card>
  )
}
