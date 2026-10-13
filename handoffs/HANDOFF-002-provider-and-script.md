# HANDOFF-002 — Provider adapters + real script generation (Phase B start)

Date: 2026-10-13 · Task: [`tasks/TASK-002-provider-and-script.md`](../tasks/TASK-002-provider-and-script.md)
Status: **complete, deployed to the preview environment, and verified on the real origin**

## Outcome

The studio's first production stage is real. The owner picks a provider, sets its
key as a deployment secret, presses **Verify** in Settings and sees the capability
become `connected_verified` only after an actual authenticated call was made and
recorded. On an episode they press **Generate script** and the studio builds a
prompt from the project's story bible, cast and episode brief, calls the provider,
validates and parses the answer into ordered scenes, and stores it as an immutable
numbered version. **Approve / Request changes / Reject** append a decision record;
an approved script is never rewritten in place.

When no provider is configured the studio still works: it names the exact
environment variables that are missing and never pretends a capability is
connected.

## Files changed

New:

- `migrations/0002_phase_b_scripts.sql` — `script_versions`, `script_approvals`,
  `scenes`, `provider_checks` (all `IF NOT EXISTS`, idempotent).
- `worker/providers/` — `types.ts` (adapter contract, `ProviderError`, timeout /
  error mapping), `openaiCompatible.ts`, `anthropic.ts`, `google.ts`, `index.ts`
  (registry, `resolveScriptConfig`, `runScriptProviderCheck`).
- `worker/scripting/` — `prompt.ts` (system + user prompt and the JSON contract),
  `parse.ts` (tolerant extraction, strict validation), `service.ts` (generation,
  persistence, review decisions, provider-failure → HTTP mapping).
- `worker/routes/scripts.ts` — version list, generate, fetch one, review decision.
- `src/pages/EpisodeWorkspace.tsx` — the episode production view.
- `scripts/verify-local.mjs`, `scripts/verify-deployed.mjs` — committed, repeatable
  HTTP verification suites (`npm run verify:local`, `npm run verify:deployed`).
- `test/scripts.spec.ts` — 12 specs covering the whole pipeline.

Changed:

- `worker/migrations.ts` — `POST /api/bootstrap` now applies **pending** migrations
  (one atomic batch each, recorded in `d1_migrations`) instead of only initialising
  an empty database, and still refuses an inconsistent schema.
- `worker/capabilities.ts` — now database-aware and async; the Script AI state is
  derived from configuration plus recorded real calls.
- `worker/routes/integrations.ts` — adds `POST /api/integrations/:capability/verify`.
- `worker/routes/{health,overview}.ts`, `worker/lib/{constants,input,rows}.ts`,
  `worker/env.ts`, `worker/app.ts`.
- `src/lib/{api,router}.tsx`, `src/App.tsx`, `src/pages/{Integrations,ProjectDetail}.tsx`,
  `src/styles.css`.
- `test/{helpers,bootstrap}.spec.ts`, `package.json`, `.env.example`, `README.md`,
  `docs/MASTER_BLUEPRINT.md`, `tasks/ROADMAP.md`, `AGENT_HANDOFF.md`.

## Decisions taken

1. **A provider registry, not a provider.** The catalog search for a single LLM
   service returned only a paid gateway, and the master instructions forbid
   hard-coding one provider. Adapters for OpenAI, OpenRouter, Anthropic, Google
   and any OpenAI-compatible endpoint were implemented behind one interface; the
   chosen provider and model are configuration, and the concrete model travels
   with every artifact.
2. **Verification is the only path to "connected".** `provider_checks` stores the
   result of a real authenticated call. Listing models is what proves the
   credential; a configured model the credential cannot use is reported as
   `model_not_available` instead of being silently swapped.
3. **Parsing is validation, not formatting.** Output that is not the contract is
   stored verbatim with `parse_state = 'unparsed'` and a `parse_detail`; no scene
   is ever invented to fill the gap.
4. **Migrations must be safe to apply from the deployed app.** The deployed D1
   cannot be reached with the wrangler CLI here, so `POST /api/bootstrap` applies
   pending migrations. This needed the migration statements to stay idempotent and
   the endpoint to keep refusing ambiguous states.
5. **Secrets stay out of the project.** Key resolution accepts `SCRIPT_API_KEY` or
   a provider alias (`OPENAI_API_KEY`, …). Only variable *names* are ever returned
   to the browser.

## Commands actually run and their results

| Command | Result |
| --- | --- |
| `npm run typecheck` | passes (app + worker, TS strict) |
| `npm run lint` | passes, 0 problems |
| `npm run test` | **40 passed / 40**, 4 files, inside workerd against a real D1 (was 27) |
| `npm run build` | `dist/` 261.39 kB js (79.36 kB gz) + 12.28 kB css; `dist-worker/index.js` 206.4 kB |
| `npm run verify:local` (built Worker in workerd, fresh D1) | **54 passed / 0 failed** |
| `POST /api/bootstrap` on the deployed preview | `200 upgraded`, applied `["0002_phase_b_scripts.sql"]` |
| `npm run verify:deployed` (real origin, real HTTPS) | **40 passed / 0 failed** |

Test coverage added by `test/scripts.spec.ts`: generation refused with named
missing variables; parsed version persisted with provider/model/usage and the
episode moved to `script_review`; unparsed output stored verbatim; provider 429
reported as `provider_http_error` with nothing stored; approved script untouched
by a later draft and its decision list preserved; invalid decisions rejected;
cross-owner isolation on read, review and list; 401 and cross-origin 403;
verification flipping the capability to `connected_verified`; a rejected key
recording `failed`; `configured_unverified` before any call; and a capability with
no adapter refusing verification.
`test/bootstrap.spec.ts` gained a spec that rewinds a database to a Phase-A-only
state and asserts bootstrap applies **only** `0002_phase_b_scripts.sql`.

## Passed

- Build, typecheck and lint clean.
- 40/40 automated specs, including the five acceptance-critical behaviours above.
- 54/54 local HTTP checks against the built Worker in workerd on a fresh database
  (shell, assets, empty-DB honesty, bootstrap, readiness, 401s, no-store, CSRF,
  auth redirect parameters).
- 40/40 deployed-origin checks over real HTTPS, including the Phase B routes being
  closed without a session and the deployed callback being the exact origin.
- The deployed database was genuinely upgraded through the app itself
  (`upgraded`, `0002_phase_b_scripts.sql`) and `/api/health` reports `ready` with
  all 10 required tables.

## Failed / not tested

- **Not tested: a real provider call with a real key.** No key exists on this
  deployment, so `/api/integrations` correctly reports `not_configured` and
  generation is unexercised against a live vendor. The adapters are exercised
  against stubbed HTTP only.
- **Not tested: a browser sign-in → callback → session → sign-out**, and rendering
  on an Android device. There is no browser automation here. Everything up to and
  including the redirect is verified; the round trip needs one click by the owner.
- **Not tested: two accounts in a browser.** The equivalent isolation is covered
  by automated specs with two identities.
- Two expectations in my first draft of the verification scripts were wrong (a
  foreign `Origin` on a **GET** is unauthenticated, not CSRF-rejected, and the
  deployed CDN omits `charset` from asset content types). The scripts were fixed
  and re-run; both suites now pass in full.

## Blocked / required from the owner

Nothing blocks the software. To make script generation live, one action is needed:

1. Set these as **deployment secrets** on the preview site (Sites → Secrets):
   `SCRIPT_PROVIDER` (`openai` | `openrouter` | `anthropic` | `google` | `custom`),
   the provider key as `SCRIPT_API_KEY`, and optionally `SCRIPT_MODEL`
   (`SCRIPT_BASE_URL` too when `custom`).
2. Open Settings → Integrations → **Verify Script AI now**.

## Live deployment

- Preview: `https://site-fa13ddd475e047ffb22b1a17dfc984c9.freebuff.page`
  (site `6f0c1d2a-3b4e-4c5d-8a91-7e2f4b6c8d01`, environment `preview`),
  code deployed and the database upgraded through `POST /api/bootstrap`.
- Production is still **not deployed and not published**; that needs explicit
  owner authorisation.

## Exact next task

**`TASK-003` — object storage + assets (Phase B, second slice).** Create
`tasks/TASK-003-object-storage.md` before starting. The next agent must:
(1) provision R2 for the environment and add an `assets` migration (id +
project/episode/type/storage-key/status/metadata, never binaries in D1);
(2) add a real upload/read path with the bucket binding, verified end to end;
(3) keep the media-storage capability honest (it currently reports
`not_configured`); (4) keep all 40 specs green and add specs for the new paths.
Image generation (`scenes.image_prompt` already exists) is TASK-004 and must not
start before TASK-003's handoff is written.
