import { useCallback } from 'react'

import { Card, ErrorNote, IntegrationStatePill, Pill, Prompt, Spinner } from '../components/ui'
import { api, fetchHealth } from '../lib/api'
import { useResource } from '../lib/useResource'

import type { Capability, HealthReport, User } from '../lib/api'

export function Integrations({ user }: { user: User }) {
  const resource = useResource(
    useCallback(
      () =>
        Promise.all([api<{ capabilities: Capability[] }>('/api/integrations'), fetchHealth()]).then(
          ([integrations, report]) => ({ capabilities: integrations.capabilities, health: report }),
        ),
      [],
    ),
  )
  const capabilities: Capability[] | null = resource.data?.capabilities ?? null
  const health: HealthReport | null = resource.data?.health ?? null

  if (resource.error) {
    return (
      <Card title="Settings unavailable">
        <ErrorNote>
          {resource.error instanceof Error ? resource.error.message : 'Could not load integration status'}
        </ErrorNote>
      </Card>
    )
  }

  if (!capabilities || !health) return <Spinner label="Checking this deployment…" />

  return (
    <div className="stack">
      <div className="page-head">
        <div>
          <h1>Settings &amp; integrations</h1>
          <Prompt>
            Every state below comes from a real check or from what this deployment is actually configured with. Nothing
            is reported as connected until a real call has succeeded.
          </Prompt>
        </div>
      </div>

      <div className="grid-2">
        <Card title="Signed-in account" subtitle="Sign in with Freebuff · no password or client secret in this project">
          <ul className="rows">
            <li className="row">
              <span className="row-main">
                Name
                <small>{user.name ?? 'not shared'}</small>
              </span>
            </li>
            <li className="row">
              <span className="row-main">
                Email
                <small>{user.email ?? 'not shared'}</small>
              </span>
            </li>
            <li className="row">
              <span className="row-main">
                Account id
                <small className="mono">{user.sub}</small>
              </span>
            </li>
          </ul>
          <form method="post" action="/auth/freebuff/signout">
            <button className="btn btn-ghost" type="submit">
              Sign out
            </button>
          </form>
        </Card>

        <Card title="Deployment health" subtitle={`Runtime ${health.runtime} · version ${health.version}`}>
          <ul className="rows">
            {Object.entries(health.checks).map(([name, check]) => (
              <li className="row" key={name}>
                <span className="row-main">
                  {name}
                  <small>{check.detail}</small>
                </span>
                <IntegrationStatePill state={check.state} />
              </li>
            ))}
          </ul>
          <p className="hint">
            Migrations: <span className="mono">{health.migrations.current}</span>{' '}
            {health.migrations.applied ? 'applied' : 'not applied'} · checked {new Date(health.time).toLocaleTimeString()}
          </p>
        </Card>
      </div>

      <Card
        title="Production capabilities"
        subtitle="What still has to be connected before real episodes can be generated"
      >
        <ul className="capabilities">
          {capabilities.map((capability) => (
            <li key={capability.id} className="capability">
              <div className="capability-head">
                <h3>{capability.label}</h3>
                <div className="capability-tags">
                  <Pill tone="slate">Phase {capability.phase}</Pill>
                  <IntegrationStatePill state={capability.state} />
                </div>
              </div>
              <p className="capability-detail">{capability.detail}</p>
              {capability.requiredEnvVars.length > 0 && (
                <p className="hint">
                  Deployment variables (names only, values are stored as secrets):{' '}
                  {capability.requiredEnvVars.map((name) => (
                    <code key={name} className="chip">
                      {name}
                    </code>
                  ))}
                </p>
              )}
            </li>
          ))}
        </ul>
      </Card>

      <Card title="Secrets policy" subtitle="How provider keys will be handled">
        <ul className="bullets">
          <li>Provider keys are set as deployment secrets, never committed and never sent to the browser.</li>
          <li>This build reads no provider key, so none can leak from it.</li>
          <li>YouTube publishing stays disabled until you explicitly authorise it (Phase D).</li>
          <li>
            Sign in with Freebuff needs no secret: only the public client id and this site&rsquo;s own origin, both
            configured in the deployment.
          </li>
        </ul>
      </Card>
    </div>
  )
}
