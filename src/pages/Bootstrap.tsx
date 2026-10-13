import { useState } from 'react'

import { Button, Card, ErrorNote, InfoNote, Prompt } from '../components/ui'
import { ApiError, api } from '../lib/api'

import type { HealthReport } from '../lib/api'

interface BootstrapResult {
  status: 'already_initialized' | 'initialized' | 'refused' | 'failed'
  applied: string[]
  missing: string[]
  detail: string
}

/**
 * Shown when the deployment is reachable but its database has no studio
 * schema yet. Nothing is created behind the owner's back: the schema is only
 * written when this button is pressed (or the endpoint is called directly).
 */
export function Bootstrap({ health, onInitialized }: { health: HealthReport; onInitialized: () => void }) {
  const [busy, setBusy] = useState(false)
  const [result, setResult] = useState<BootstrapResult | null>(null)
  const [error, setError] = useState<string | null>(null)

  const database = health.checks.database

  async function run() {
    setBusy(true)
    setError(null)
    try {
      const response = await api<BootstrapResult>('/api/bootstrap', { method: 'POST' })
      setResult(response)
      if (response.status === 'initialized' || response.status === 'already_initialized') {
        onInitialized()
      }
    } catch (cause) {
      setError(cause instanceof ApiError ? cause.message : 'Initialization failed')
    } finally {
      setBusy(false)
    }
  }

  return (
    <Card
      title="Initialize the studio database"
      subtitle="This deployment is online, but its database has no schema yet"
    >
      <Prompt>
        The studio stores projects, episodes and history in a SQL database that ships empty. Initializing it creates the
        studio tables (projects, seasons, episodes, characters, activity, users). It is safe to run once, and it refuses
        to touch a database that already has part of the schema.
      </Prompt>
      {database && <InfoNote>{database.detail}</InfoNote>}
      {result && <InfoNote>{result.detail}</InfoNote>}
      <ErrorNote>{error}</ErrorNote>
      <div className="form-actions">
        <Button type="button" onClick={() => void run()} disabled={busy}>
          {busy ? 'Initializing…' : 'Initialize database'}
        </Button>
        <span className="hint">
          Or run <code className="chip">npm run db:migrate:remote</code> from the repository.
        </span>
      </div>
    </Card>
  )
}
