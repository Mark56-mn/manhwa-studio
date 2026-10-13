import { Hono } from 'hono'

import { capabilityStatuses } from '../capabilities'
import type { AppBindings } from '../app'

export const integrationRoutes = new Hono<AppBindings>()

integrationRoutes.get('/integrations', (c) => {
  return c.json({
    // Every state below is derived from the deployment's real configuration,
    // never from a hard-coded "connected" flag.
    capabilities: capabilityStatuses(c.env),
    secretsPolicy: {
      detail:
        'Provider keys are stored as deployment secrets (Sites → Secrets or Worker environment bindings) and are never sent to the browser.',
      envVarNamesOnly: true,
    },
  })
})
