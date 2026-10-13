# TASK-003 — Unified AI provider adapter + autonomous task router (Phase B)

## 1. Objective

Replace the single-provider `SCRIPT_*` script path with a **unified, server-side AI
provider adapter layer** (OpenRouter, NVIDIA NIM, Google Gemini, Baseten, plus the
existing OpenAI / Anthropic / custom endpoints) behind **one interface**, and a
**central AI Task Router** that every AI workflow (Director AI, Script AI, …)
calls instead of touching a provider directly.

The router treats providers as interchangeable: any compatible model from any
configured provider can serve Director AI or Script AI. When the selected
provider/model fails, times out, is rate-limited, is out of quota, or returns an
unusable result, the router automatically moves to the next **eligible** model,
subject to strict attempt/time limits and a **free-budget policy**. Paid models
are only used when the owner explicitly authorises paid use.

## 2. Current verified repository state (before this task)

- Phase A + TASK-002 are complete and deployed to the preview environment.
  `npm run verify` = typecheck + lint + 40 vitest specs + build, all green.
- A provider registry exists in `worker/providers/` (`openai`, `openrouter`,
  `anthropic`, `google`, `custom`) behind a narrow `ProviderAdapter` interface,
  but it is resolved from a single `SCRIPT_*` configuration and is used only by
  the script path. There is no Director AI, no router, no failover, no per-role
  settings, no capability verification beyond "can this key list models".
- `provider_checks` records the result of a real authenticated call.
- Migration `0002_phase_b_scripts.sql` adds `script_versions`, `scenes`,
  `script_approvals`, `provider_checks`.

## 3. User-facing outcome

- Settings shows every provider with: configured / not configured, the exact
  environment-variable **names** it reads (never values), base URL, selected
  model, connection-test status and last-test time, and a **Test connection**
  action that makes a real low-token request.
- Separate **Director AI** and **Script AI** defaults, each with an independent
  provider + model and an optional fallback order. No provider or model is
  hard-coded in the frontend; model lists are discovered dynamically and a
  manual model id can be entered when discovery is unavailable.
- A router status panel: eligible models, preferred model, last active
  provider/model, recent failures and failover events, and why a model was
  excluded (e.g. "not free, paid use not authorised").
- On an episode: **Director AI → plan episode** produces a real, validated
  production plan; **Generate script** runs through the router. Both record the
  exact provider/model that completed the task and every failover attempt.
- Free use is never assumed, and a paid fallback is never taken silently.

## 4. Relevant files and components

New:

- `migrations/0003_ai_router.sql` — `ai_settings`, `ai_model_catalog`,
  `ai_provider_state`, `ai_route_events`, `director_plans`.
- `worker/providers/types.ts` (rewritten) — the unified request/result contract,
  capability model, error taxonomy, timeout/cancellation helpers.
- `worker/providers/openaiCompatible.ts`, `google.ts`, `anthropic.ts` —
  provider-specific translation of the shared request shape.
- `worker/providers/index.ts` — the registry: `openrouter`, `nvidia`, `google`,
  `baseten`, `openai`, `anthropic`, `custom`.
- `worker/ai/policy.ts`, `catalog.ts`, `state.ts`, `settings.ts`, `tasks.ts`,
  `router.ts`, `service.ts` — the router.
- `worker/director/prompt.ts`, `worker/director/service.ts` — Director AI.
- `worker/routes/ai.ts` — provider/settings/router routes.
- `test/ai-adapters.spec.ts`, `test/ai-router.spec.ts`, `test/ai-settings.spec.ts`,
  `test/ai-live.spec.ts` — mocked adapter/router specs plus key-gated live specs.

Changed:

- `worker/env.ts`, `worker/lib/constants.ts`, `worker/migrations.ts`,
  `worker/capabilities.ts`, `worker/routes/integrations.ts`, `worker/app.ts`,
  `worker/scripting/service.ts`, `src/pages/Integrations.tsx`,
  `src/pages/EpisodeWorkspace.tsx`, `src/lib/api.ts`, `src/components/Shell.tsx`,
  `src/styles.css`, `.env.example`, `README.md`, `docs/MASTER_BLUEPRINT.md`,
  `tasks/ROADMAP.md`, `AGENT_HANDOFF.md`.

## 5. Required implementation

1. **One adapter interface.** Adapters normalize text, streaming, usage, model
   id, provider request id, errors, timeouts and cancellation. Provider-specific
   capabilities (streaming, structured output, tools, vision) are declared and
   reported; anything unsupported raises an explicit capability error.
2. **Official endpoints.** OpenRouter `https://openrouter.ai/api/v1` +
   `/chat/completions`; NVIDIA `https://integrate.api.nvidia.com/v1` +
   `/chat/completions`; Google Gemini via the official Generative Language API
   (`generateContent` / `streamGenerateContent`, `generationConfig`,
   `functionDeclarations`) — **not** the OpenAI shape; Baseten
   `https://inference.baseten.co/v1` + `/chat/completions`.
3. **Central router.** Every workflow calls the router. Tasks declare
   requirements (structured JSON, tools, streaming, context length). The router
   maintains a discovered pool of provider/model combinations with capability,
   health, rate-limit, latency and free/paid policy, and fails over
   automatically within strict attempt and time limits with backoff.
4. **Free-budget protection.** Default is free-only. A model is eligible only if
   it is verified zero-cost or the owner explicitly authorised paid use. If no
   eligible model remains, the task stops with a clear, actionable error.
5. **Honest verification.** A provider/model moves to "verified" only after a
   real low-token call. Capabilities such as tool calling are never claimed
   unless a real probe confirmed them.
6. **Settings & UI.** Provider configuration status, provider/model selectors,
   test-connection actions, and separate Director/Script defaults with fallback
   order. API key values are never shown after saving (keys live only in the
   deployment environment).
7. **Logging & redaction.** Per-provider/model request logging with sanitized
   error codes; no secrets and no full private story content in logs.
8. **Idempotency.** AI generation may fail over freely; irreversible actions are
   guarded separately by task id / idempotency key so a retry cannot double-run
   a side effect.

## 6. Explicit non-goals

- Image generation, narration, video rendering and YouTube publishing
  (TASK-004/005/006 and Phase D). Their capabilities stay honest.
- No redesign of unrelated UI or infrastructure, no new dependencies.
- No live paid API calls. Live tests run only when real free keys are present.

## 7. Acceptance criteria

1. `npm run typecheck`, `npm run lint`, `npm run build` all pass.
2. `npm run test` passes, including new specs covering: each adapter against
   mocked HTTP (success, invalid key, model not found, quota/rate limit,
   timeout, malformed response, streaming, provider outage); router failover to
   a different compatible model; free-policy blocking a paid fallback; the
   all-providers-fail case; and capability gating for tools/JSON.
3. The existing 40 specs stay green.
4. No secret value is committed, logged or returned to the browser.
5. `POST /api/bootstrap` upgrades an existing Phase-B database by applying only
   `0003_ai_router.sql`.
6. `npm run verify:local` passes against the built Worker in workerd.

## 8. Commands and tests to run

```
npm run typecheck
npm run lint
npm run test
npm run build
node scripts/verify-local.mjs
```

## 9. Deployment or environment dependencies

- Provider keys are deployment secrets. Names (values never committed):
  `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `BASETEN_API_KEY`,
  optional `OPENROUTER_BASE_URL`, `NVIDIA_BASE_URL`, `BASETEN_BASE_URL`.
- Optional role defaults: `DIRECTOR_PROVIDER`, `DIRECTOR_MODEL`,
  `SCRIPT_PROVIDER`, `SCRIPT_MODEL`, `AI_ALLOW_PAID`, `AI_MAX_ATTEMPTS`.
- The owner supplies credentials; the software must work, and report honestly,
  without them.

## 10. Risks and fallback decisions

- **Model ids change frequently.** Models are discovered from each provider's
  own `/models` endpoint and cached; a manual model id is always allowed.
- **Free tiers change.** Free eligibility is never assumed from price alone; it
  is verified or explicitly authorised, and the router re-checks on use.
- **A provider call can hang.** Every request carries an `AbortSignal` timeout
  and the timeout is reported as such.
- **Retry storms.** Retries are bounded, only for transient errors, with
  backoff; invalid requests and quota exhaustion are not retried.

