# Manhwa Studio — master blueprint

## 1. Product

A single-owner web studio that turns an original written story into manhwa
video episodes. The owner keeps control of story and publication; the studio
coordinates specialised workers (script, image, voice, video, YouTube).

Intended flow:

```
OWNER CREATES STORY
  -> DIRECTOR PLANS EPISODE        (Phase C)
  -> SCRIPT AI WRITES SCRIPT       (Phase B)
  -> OWNER REVIEWS/APPROVES SCRIPT
  -> IMAGE AI GENERATES SCENE ART  (Phase B)
  -> VOICE AI GENERATES AUDIO      (Phase B)
  -> VIDEO WORKER ASSEMBLES EPISODE(Phase C)
  -> OWNER PREVIEWS AND APPROVES
  -> YOUTUBE UPLOAD                (Phase D, private/unlisted first)
  -> OWNER AUTHORISES PUBLICATION
```

A stage is only "complete" when its expected artifact exists and validates —
never because an agent replied, a row was written, or a request returned 200.

## 2. Chosen architecture (Phase A)

```
Browser (React SPA, responsive)
        |  same origin: /api/*, /auth/freebuff/*
        v
Cloudflare Worker (Hono)
  - @freebuff/auth wrapper (OIDC + PKCE, server session, no secrets)
  - Hono API routes with CSRF + auth middleware
  - static assets binding for the SPA (run_worker_first: true)
        |
        v
D1 (SQLite)  — projects, seasons, episodes, characters, activity, users
R2           — reserved for media artifacts from Phase B
```

### Why this and not Vercel + Render + Supabase

The master instructions listed Vercel (frontend), Render (API) and Supabase
(Postgres/storage) as preferences, subject to availability. In this environment
none of those accounts are connected, and requiring three sign-ups plus secrets
before anything is online contradicts "get the product online as quickly as
possible".

The Worker stack:

- is one artifact to build, deploy and verify, on one origin;
- needs no secrets at all for authentication;
- runs the same runtime locally (workerd) as in production, so tests prove
  production behaviour instead of approximating it;
- keeps the database relational with real SQL migrations.

Trade-offs, stated honestly:

- SQLite (D1) rather than Postgres: fine for a single-owner studio; if you later
  need Postgres, the data layer is isolated in `worker/db.ts` and `worker/routes/*`
  behind prepared statements.
- CPU and memory limits per request: fine for the API, but AI generation and
  FFmpeg rendering must run in workers/notebooks, never inside a request
  (see Phase B/C). That is a requirement of the design, not an accident.

## 3. Boundaries and non-negotiables

1. **No fake production.** No sample media presented as generated, no
   "connected" badge without a real check, no completed job without a validated
   artifact.
2. **Server-side authorization.** Every private route resolves the account from
   the session; ownership is always `user.sub`, never a request parameter.
3. **State changes are same-origin only** (CSRF), and personalized responses are
   `Cache-Control: private, no-store`.
4. **Secrets live in the deployment**, never in git, never in the browser bundle.
5. **Free use is never assumed.** A model is eligible for automatic failover
   only when it is verified zero-cost, unless the owner explicitly authorises
   paid use for that role. A paid model is never chosen silently, and a provider
   is never shown as "online" because a key merely exists.
6. **YouTube stays private/unlisted and disabled** until the owner authorises
   publication.
6. **Honest status vocabulary**, used consistently everywhere:
   `connected_verified`, `configured_unverified`, `unavailable`,
   `not_configured`, `failed`.

## 4. Data model (migration 0001)

- `users` — one row per Freebuff account (`sub`), refreshed on sign-in.
- `projects` — story + story bible + status, owned by `users.id`.
- `seasons` — ordered seasons inside a project.
- `episodes` — season, number, status stage, target duration.
- `characters` — approved continuity references (description + appearance).
- `activity_events` — production history: who did what, when.

Versioned artifacts (assets, jobs, worker runs, uploads) arrive with the phases
that create them, so no empty tables ship before they are used.

Migration 0002 (Phase B) adds the first real production artifacts:

- `script_versions` — immutable script artifacts: version per episode, provider,
  model, the exact prompt, the raw model output, the parsed structure and an
  honest `parse_state`. Rows are inserted, never rewritten; approving only
  changes `status`.
- `script_approvals` — append-only review decisions (approved / rejected /
  changes requested) with the note and who decided.
- `scenes` — the ordered scene breakdown of a parsed script, which the image and
  voice stages in later tasks read.
- `provider_checks` — the recorded result of real authenticated provider calls,
  which is the only thing that can move a capability to `connected_verified`.

Migration 0003 (Phase B, TASK-003) adds the AI router's state:

- `ai_settings` — per-owner, per-role (Director AI / Script AI) preferred
  provider and model, an ordered fallback list, and the paid-use switch.
- `ai_model_catalog` — models discovered from each provider's own endpoint, with
  a cost policy that is only `free` when the provider's metadata says zero cost.
- `ai_provider_state` — per provider/model health (circuit breaker, cooldown) and
  the capabilities a real probe actually confirmed.
- `ai_route_events` — the sanitized routing log: which model was tried, why it
  was skipped, and which one completed the task. No keys, no story content.
- `director_plans` — immutable Director AI plan versions per episode.

Migrations are applied either by `wrangler d1 migrations apply` or by
`POST /api/bootstrap`, which now applies whichever migrations are pending (each
in one atomic batch) and refuses an inconsistent schema instead of guessing.

## 5. Phases

- **Phase A (done, this repo):** online foundation — responsive studio,
  authentication, persistent projects/episodes, real health endpoint, honest
  integration status, deployment.
- **Phase B (in progress):** first real production.
  - TASK-002 (done): provider adapter layer (`openai`, `openrouter`,
    `anthropic`, `google`, `custom`), real provider verification, versioned
    scripts with append-only approvals, parsed scenes, and an episode workspace.
  - TASK-003 (done): the unified AI provider adapter (OpenRouter, NVIDIA NIM,
    Google Gemini, Baseten, plus OpenAI/Anthropic/custom) and a central AI task
    router with automatic failover, circuit breakers, free-budget protection and
    per-role Director/Script settings.
  - TASK-004+ (next): object storage (R2) + `assets` rows, image generation,
    narration audio, then video assembly and owner review.
- **Phase C:** durable jobs, retries, timeouts, cancellation, logs, remote GPU
  worker for rendering.
- **Phase D:** YouTube OAuth, private/unlisted test upload with verified video
  id and status, explicit approval before public.
- **Phase E:** editing tools, continuity improvements, scheduling, analytics.

## 6. Deployment topology

One site (preview + production environments) holding a prebuilt Worker bundle
and the SPA assets, plus a D1 database per environment. Preview and production
are isolated: separate databases, separate secrets, and the auth callback
registered per origin. Production publication is only done on explicit
authorisation.
