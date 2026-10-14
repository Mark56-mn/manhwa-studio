# HANDOFF-003 — Unified AI provider adapter + autonomous task router (Phase B)

Date: 2026-10-13 · Task: [`tasks/TASK-003-ai-provider-router.md`](../tasks/TASK-003-ai-provider-router.md)
Status: **implemented, verified by automated tests and the local HTTP suite; not deployed from this environment and no live provider call was made (no keys)**

## Outcome

The studio now speaks one internal AI request shape and translates it to each
provider's real API through a single adapter interface:

- **OpenRouter** — `https://openrouter.ai/api/v1` + `/chat/completions`
- **NVIDIA NIM** — `https://integrate.api.nvidia.com/v1` + `/chat/completions`
- **Google Gemini** — the official Generative Language API
  (`generateContent` / `streamGenerateContent`), not the OpenAI shape
- **Baseten** — `https://inference.baseten.co/v1` + `/chat/completions`
- plus the existing **OpenAI**, **Anthropic** and **custom** OpenAI-compatible
  adapters.

Every AI workflow (Director AI, Script AI) calls a **central task router**
instead of a provider directly. The router picks the owner's preferred model,
then the configured fallback order, then any other reachable provider, with:

- automatic **failover** to another compatible model when one fails, times out,
  is rate-limited, is out of quota, or returns an unusable result;
- **bounded retries** for transient errors only (invalid requests and quota
  exhaustion are never retried), with backoff;
- **circuit breakers / cooldowns** per provider/model (never the whole provider);
- **free-budget protection**: free-only by default; a fallback is used only when
  the model is verified zero-cost, unless the owner explicitly allows paid use;
- a **bounded repair** attempt on malformed structured output, then a reroute;
- an honest **routing log** (`ai_route_events`) with no keys and no story content.

Settings gains a full **AI providers** panel: per-provider configured/verified
state, the variable *names* it reads (never values), base URL, last test time,
**Test connection** (a real low-token call), **Discover models**, zero-cost
marking, independent **Director AI** and **Script AI** provider/model selectors
with an optional fallback order and a paid-fallback switch, and a router status
view. The episode workspace gains **Plan with Director AI**, which stores a
validated, immutable plan version.

## Files changed

New:

- `migrations/0003_ai_router.sql` — `ai_settings`, `ai_model_catalog`,
  `ai_provider_state`, `ai_route_events`, `director_plans`.
- `worker/providers/types.ts` (rewritten) — the unified request/result contract,
  capability model, error taxonomy, timeout/cancellation helpers, redaction.
- `worker/providers/openaiCompatible.ts`, `google.ts`, `anthropic.ts` —
  provider-specific translation of the shared request shape.
- `worker/providers/index.ts` — the registry (OpenRouter, NVIDIA, Google,
  Baseten, OpenAI, Anthropic, custom) and credential/config resolution.
- `worker/ai/{types,policy,catalog,state,settings,router,service}.ts` — the router.
- `worker/director/{prompt,service}.ts`, `worker/routes/{ai,director}.ts`.
- `test/ai-adapters.spec.ts`, `test/ai-router.spec.ts`,
  `test/ai-settings.spec.ts`, `test/ai-live.spec.ts`.
- `src/components/AiProviders.tsx` — the Settings panel.

Changed:

- `worker/env.ts`, `worker/lib/{constants,rows}.ts`, `worker/migrations.ts`,
  `worker/app.ts`, `worker/scripting/service.ts` (now routed),
  `test/{helpers,bootstrap,scripts}.spec.ts`, `vitest.config.ts`, `test/env.d.ts`,
  `scripts/verify-{local,deployed}.mjs`, `src/lib/api.ts`,
  `src/pages/{Integrations,EpisodeWorkspace}.tsx`, `src/components/Shell.tsx`,
  `src/styles.css`, `.env.example`, `README.md`, `docs/MASTER_BLUEPRINT.md`,
  `tasks/ROADMAP.md`.

## Decisions taken

1. **Credentials are resolved separately from models.** A provider test or model
   discovery needs no preselected model, so `resolveProviderCredentials` is
   distinct from `resolveProviderConfig`. A test with no model discovers one
   first; if discovery fails with a real credential/permission error, that error
   is reported rather than masked as "no model".
2. **Cost is never assumed.** A model is `free` only when the provider's own
   metadata says zero cost (OpenRouter pricing) or the owner explicitly marks it
   so; otherwise it is `unknown`. An automatic fallback to a non-free model
   requires explicit authorisation; an explicitly selected model is not a silent
   fallback and is allowed.
3. **Tool calling is gated on a real probe.** Adapters declare tool support from
   the provider's docs, but the router will only run a tools task against a model
   whose `ai_provider_state.capabilities_json.tools` was set by an actual probe.
4. **Structured output uses the native mode when available, otherwise a validated
   prompt-level fallback** (Anthropic, or any adapter declaring `none`). The
   caller still validates the output; nothing is faked.
5. **The script artifact still stores raw text + `parse_state`.** Script
   validation therefore only requires non-empty text, so an unparsed answer is
   stored honestly instead of being discarded — preserving TASK-002 behaviour.
6. **`SCRIPT_API_KEY` is honoured only for the explicitly selected
   `SCRIPT_PROVIDER`**, so one shared key can never silently configure every
   provider and add hidden fallback candidates.

## Tests actually run

```
npm run typecheck     OK (app + worker)
npm run lint          OK (0 problems)
npm run test          100 passed / 8 skipped (live) across 8 files
npm run build         OK (dist/ + dist-worker/index.js 289.1 kB)
npm run verify:local  66 passed / 0 failed (built Worker in workerd, fresh D1)
```

New coverage:

- `ai-adapters.spec.ts` (44): each OpenAI-compatible adapter plus Google —
  success normalization (text, model, usage, request id, finish reason),
  provider-correct max-tokens field, invalid key, model not found, 429, 402
  quota, 5xx outage, timeout/abort, malformed/empty response, SSE streaming, and
  model discovery with a cost policy.
- `ai-router.spec.ts` (8): failover to a *different* compatible model over HTTP;
  a paid fallback blocked until paid use is authorised (and the paid provider
  never called); a clear 503 when nothing is configured; the exact provider/model
  recorded; bounded retry of a transient outage then failover; no retry of a
  permanent invalid request; tool-capability gating with zero HTTP calls; and a
  cooldown skipping a failed model on the next attempt.
- `ai-settings.spec.ts` (6): honest `not_configured`, `configured_unverified`
  until a real test, `failed` for a rejected key with no key leakage in the
  response, model discovery + cost policy, independent Director/Script settings
  with a manual model id, unknown-role rejection, and a capability probe.
- `ai-live.spec.ts` (8, **skipped**): real-provider tests gated on `LIVE_*` keys.

One TASK-002 assertion was intentionally updated: a 429 quota failure is now
reported as `provider_quota_exhausted` with HTTP 429 (plus retry guidance) rather
than a generic `provider_http_error`, which is the behaviour this task requires.

## Not tested / blocked

- **No live provider call was made.** No `OPENROUTER_API_KEY`, `NVIDIA_API_KEY`,
  `GEMINI_API_KEY` or `BASETEN_API_KEY` exists in this environment, so the live
  specs are skipped (not faked) and no real model id was verified against a live
  vendor. Model discovery, connection tests and capability probes are exercised
  against mocked HTTP only.
- **Not deployed from this environment.** The preview deployment still runs the
  previous bundle and its database has not had `0003_ai_router.sql` applied.
  `npm run verify:deployed` was **not** run.
- **No browser/Android pass.** The new Settings panel and the Director AI card
  compile and are covered by types/lint, but were not clicked through in a
  browser.

## Blocked / required from the owner

Nothing blocks the software. To make the providers live:

1. Set one or more provider keys as **deployment secrets**
   (`OPENROUTER_API_KEY`, `NVIDIA_API_KEY`, `GEMINI_API_KEY`, `BASETEN_API_KEY`).
2. Apply the pending migration on the deployed database (`POST /api/bootstrap`).
3. Open Settings → Integrations → AI providers → **Test connection** and
   **Discover models**, then choose Director/Script defaults.

## Known limitations

- Free-model availability, quotas and model ids change; the studio re-checks on
  use and never caches a "free" label the provider did not state.
- NVIDIA/Google/Baseten model lists carry no pricing, so their models stay
  `unknown` until the owner marks them zero-cost or authorises paid use.
- Tool calling is available only after a capability probe confirms it; no task
  currently requires tools (the gate exists so it can never be faked).
- Streaming is implemented and unit-tested per adapter, but no workflow consumes
  a stream yet (script and Director AI are single-shot requests).

## Exact next task

**`TASK-004` — object storage + assets (Phase B).** Create
`tasks/TASK-004-object-storage.md` before starting. The next agent must:
(1) provision R2 for the environment and add an `assets` migration (id +
project/episode/type/storage-key/status/metadata, never binaries in D1);
(2) add a real upload/read path with the bucket binding, verified end to end;
(3) keep the media-storage capability honest (it currently reports
`not_configured`); (4) keep every existing spec green and add specs for the new
paths. Image generation (`scenes.image_prompt` already exists) is TASK-005 and
must not start before TASK-004's handoff is written.

