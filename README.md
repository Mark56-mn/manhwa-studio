# Manhwa Studio

A web studio for turning original stories into publishable manhwa video episodes.
This repository currently contains **Phase A — the online foundation**: a real,
deployed, single-user studio with authentication, persistent projects, seasons,
episodes, characters, a story bible, and an honest production-history feed.

Nothing in this build fakes AI work. Script, art, voice, video and YouTube
capabilities are listed in the app as *not configured*, because no provider is
connected yet — see "What is not built yet".

## What works today

| Area | Status |
| --- | --- |
| Sign in with Freebuff (Google/GitHub/Apple) | Working, protected on the server |
| Projects: create, list, open, edit, delete | Working, stored in D1 |
| Seasons, episodes, characters per project | Working |
| Story bible (logline, synopsis, genre, tone, continuity) | Working |
| Episode production stages (planned → approved → published) | Manual status, real states |
| Production history / activity feed | Working, records real actions |
| Health & readiness endpoint `/api/health` | Working, queries the database |
| Integration status per capability | Honest: reports "not configured" |
| One-shot database initialization (`POST /api/bootstrap`) | Working, guarded |
| Director AI (episode planning) | Working through the AI task router |
| Script AI (versioned script generation) | Working through the AI task router |
| Unified AI providers: OpenRouter, NVIDIA NIM, Google Gemini, Baseten, OpenAI, Anthropic, custom | Adapters + router implemented; live only when a key is set |
| Per-provider connection tests, model discovery, capability probes | Working (real low-token calls) |
| Image / voice / video workers | **Not built (Phase B/C)** |
| YouTube publishing | **Not built (Phase D)** |

## Architecture (and why)

One deployable: a Cloudflare Worker (Hono) that serves the JSON API and the
built React single-page app, backed by a D1 SQLite database.

- **One origin** means no CORS, no cross-site cookie problems, and one thing to
  deploy and verify.
- **Sign in with Freebuff** is standard OIDC with a server-side session and
  **no secrets** in this repository.
- **D1** is the persistent project database; migrations live in `migrations/`.
- **Providers stay behind adapters.** No AI provider is hard-coded. Capability
  configuration is read from environment variables (names in `.env.example`)
  and reported honestly by `/api/integrations`.

The master instructions suggested Vercel + Render + Supabase. That stack needs
three accounts and secrets before anything is online, and it was not available
in this build environment. Cloudflare Workers + D1 + Freebuff auth is the
smallest stack that could actually be deployed and verified here; it is
documented in `docs/MASTER_BLUEPRINT.md` together with how to move later if
you want a different host.

## Layout

```
worker/           Worker API: Hono app, routes, D1 access, capabilities
  index.ts        entrypoint, wraps everything in @freebuff/auth
  app.ts          middleware (CSRF + auth), error handling, SPA fallback
  routes/         health, account, overview, projects, episodes, seasons,
                  characters, activity, integrations
migrations/       SQL migrations (apply in order)
src/              React studio (pages, components, api client)
test/             vitest specs running inside workerd against a real D1
scripts/          worker bundle step for deployment
docs/ tasks/ handoffs/  plans, task files and handoff records
```

## Local development

```sh
npm install
npm run db:migrate:local      # apply migrations to the local D1 database
npm run dev:worker            # API + built assets on http://localhost:8787
npm run build:web             # build the SPA into ./dist (needed by the Worker)
npm run dev                   # optional: Vite on :3000 proxying /api to :8787
```

`npm run dev:worker` serves the built `./dist` assets, so run `npm run build:web`
first (or `npm run build`). The local Worker uses the **development** Freebuff
client id from `wrangler.jsonc`, which accepts `http://localhost:8787`.

Checks:

```sh
npm run typecheck    # tsc for the app and the worker
npm run lint         # eslint
npm run test         # vitest inside workerd, real D1
npm run build        # SPA + single-file Worker bundle
npm run verify       # all of the above
```

## Configuration

| Variable | Purpose | Where to set it |
| --- | --- | --- |
| `FREEBUFF_CLIENT_ID` | Public OIDC client id | Injected by the site deployment; dev value in `wrangler.jsonc` |
| `FREEBUFF_ISSUER` | OIDC issuer (`https://freebuff.com/oidc`) | same |
| `APP_ORIGIN` | Canonical site origin, used for callbacks and CSRF | same |
| `APP_VERSION` | Shown by `/api/health` | same |
| `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `BASETEN_API_KEY` (+ optional `OPENAI_API_KEY`, `ANTHROPIC_API_KEY`, `CUSTOM_API_KEY`) | Provider keys for the unified adapter | Set as deployment secrets |
| `OPENROUTER_BASE_URL`, `NVIDIA_BASE_URL`, `BASETEN_BASE_URL`, `GEMINI_BASE_URL` | Override a provider endpoint | Optional; sensible defaults are built in |
| `DIRECTOR_PROVIDER`, `DIRECTOR_MODEL`, `SCRIPT_PROVIDER`, `SCRIPT_MODEL`, `SCRIPT_API_KEY` | Default role choices / legacy single-provider config | Optional; the Settings UI stores per-role choices in the database |
| `AI_ALLOW_PAID`, `AI_MAX_ATTEMPTS`, `AI_TASK_TIMEOUT_MS`, `SCRIPT_MAX_OUTPUT_TOKENS` | Router safety limits | Optional |
| `IMAGE_*`, `VOICE_*`, `RENDER_*`, `YOUTUBE_*` | Later phases — no adapter in this build | Not read; the studio reports them honestly as not built |

There are **no secrets in this repository**, and there is no client secret for
sign-in. Provider API keys, when they exist, go into the deployment's secret
store (never into the repo, never into the browser).

### Enabling the AI providers (Phase B)

The studio speaks one internal request shape and translates it to each provider's
real API. Providers are interchangeable: Director AI and Script AI each choose
their own provider and model, and the **AI task router** fails over to another
compatible model when one fails.

1. Set any of these as **deployment secrets** (Sites → Secrets, or
   `wrangler secret put` when deploying with wrangler). Each adapter reads only
   its own key:

   | Provider | Endpoint | Key variable |
   | --- | --- | --- |
   | OpenRouter | `https://openrouter.ai/api/v1` + `/chat/completions` | `OPENROUTER_API_KEY` |
   | NVIDIA NIM | `https://integrate.api.nvidia.com/v1` + `/chat/completions` | `NVIDIA_API_KEY` |
   | Google Gemini | official Generative Language API (`generateContent`) | `GEMINI_API_KEY` (or `GOOGLE_API_KEY`) |
   | Baseten | `https://inference.baseten.co/v1` + `/chat/completions` | `BASETEN_API_KEY` |
   | OpenAI / Anthropic / custom | provider-native | `OPENAI_API_KEY` / `ANTHROPIC_API_KEY` / `CUSTOM_API_KEY` |

2. Open **Settings → Integrations → AI providers**. Every provider shows its
   configuration state, the variable *names* it reads (never values), the base
   URL, and the last connection-test time. Press **Test connection** to make a
   real low-token request; only then does a provider become `connected_verified`.
   Press **Discover models** to read the provider's own model list, and mark a
   model **zero-cost** once you have verified it is free for your account.
3. Choose separate **Director AI** and **Script AI** providers/models, add an
   optional fallback order, and decide whether that role may use a paid model.
4. Open an episode: **Plan with Director AI** produces a validated plan, and
   **Generate script** produces a new immutable script version. The exact
   provider/model that completed each task is recorded.

**Cost safety.** Free use is never assumed. The router is free-only by default:
a fallback is used only when the model is verified zero-cost, unless you
explicitly allow paid use for that role. A provider is never shown as "online"
just because a key exists.

No key is needed for the studio to run: without one, `/api/ai/providers` reports
`not_configured` for every provider, task requests name the exact variable that
is missing, and everything else keeps working.

## Deploying


This project is deployed from the workspace as a prebuilt Worker plus static
assets:

1. `npm run build` — produces `dist/` (SPA) and `dist-worker/index.js` (one
   bundled Worker module).
2. Deploy using `deploy.manifest.json`, which points `entrypoint` at the
   bundled worker and `assetsDirectory` at `./dist` with SPA fallback.
3. The deployment injects `FREEBUFF_CLIENT_ID`, `FREEBUFF_ISSUER` and
   `APP_ORIGIN`; the auth callback registered for the site must be
   `<site origin>/auth/freebuff/callback`. Preview and production have separate
   databases and separate callbacks.
4. **Initialize the database once.** A fresh database is empty, so the first
   visit shows an "Initialize the studio database" screen — press the button,
   or call the endpoint directly:

   ```sh
   curl -X POST https://<site-origin>/api/bootstrap -H "Origin: https://<site-origin>"
   ```

   It creates the studio tables from the same migrations in `migrations/`,
   records them in `d1_migrations`, is safe to run twice, and refuses to touch a
   database that already has part of the schema. If you have wrangler access to
   the deployed database you can use `npm run db:migrate:remote` instead.

`/api/health` reports `status: ready` once the schema exists and the built
shell is served; otherwise it reports `degraded` and names exactly what is
missing. Open it any time to see the real state of the deployment.

## What is not built yet

Phase A deliberately stops short of AI production. Phase B (real script, image
and voice generation), Phase C (durable jobs, retries, render worker) and
Phase D (YouTube upload with explicit approval) are described in
`tasks/ROADMAP.md`. The next task file is listed there and in
`AGENT_HANDOFF.md`.
