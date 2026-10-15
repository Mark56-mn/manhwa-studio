# TASK-004  Image generation (Phase B)

## 1. Objective

Implement real image generation for the studio: the owner can request scene or
character art, a configured image provider is called with the prompt (built from
the story bible, cast and scene context), the generated image is stored in R2
(via TASK-003's asset service), and metadata is recorded in the `assets` table.
The Image AI capability reports honestly from real configuration and real calls.

## 2. Current verified repository state (before this task)

- Phase A deployed and verified: Worker (Hono) + React 19 SPA + D1 + Sign in
  with Freebuff. See `handoffs/HANDOFF-001-online-foundation.md`.
- Phase B TASK-002 complete: multi-provider adapter layer for script generation.
  See `handoffs/HANDOFF-002-provider-and-script.md`.
- Phase B TASK-003 complete: R2 object storage, `assets` table, upload/download/
  delete endpoints, media-storage capability. See
  `handoffs/HANDOFF-003-object-storage.md`.
- `npm run verify` = typecheck + lint + test + build, all green (40 specs).
- The `FILES` binding exists but no bucket is attached in this environment.
- `scenes.image_prompt` already exists from TASK-002 and is ready to be used.
- No image provider adapter exists yet; `IMAGE_*` variables are declared but
  unused.

## 3. User-facing outcome

- On a scene: **Generate image** button uses the scene's `image_prompt` (or
  generates one from the scene description if empty) to produce an image.
- On a character: **Generate portrait** button uses the character's description
  and appearance to produce a character portrait.
- Generated images are stored in R2 and metadata recorded in `assets` with
  `type = 'image'`.
- Settings  Integrations: Image AI capability shows `connected_verified` only
  after a real authenticated call was made and recorded.
- The studio never pretends an image was generated when it was not; failures
  are surfaced with the provider's own error message.

## 4. Relevant files and components

New:

- `worker/providers/imageTypes.ts`  image provider adapter interface.
- `worker/providers/imageAdapters.ts`  adapters for image providers
  (`openai` for DALL-E, `stability` for Stable Diffusion, `replicate` for
  Replicate-hosted models, `custom` for any OpenAI-compatible image endpoint).
- `worker/imageService.ts`  prompt construction from scenes/characters,
  provider selection, image generation, R2 storage via asset service, metadata
  recording.
- `worker/routes/images.ts`  generate scene image, generate character
  portrait, list images.
- `src/pages/SceneDetail.tsx` or extend `EpisodeWorkspace.tsx`  image
  generation UI.
- `test/images.spec.ts`  specs for image generation pipeline.

Changed:

- `worker/env.ts`  no change (IMAGE_* already declared).
- `worker/capabilities.ts`  add `imageStatus` for Image AI capability.
- `worker/routes/integrations.ts`  add image verification endpoint.
- `worker/lib/constants.ts`  no change.
- `worker/app.ts`  mount image routes.
- `src/App.tsx`, `src/lib/api.ts`, `src/lib/router.tsx`  client-side routes.
- `tasks/ROADMAP.md`, `AGENT_HANDOFF.md`, `tasks/README.md`.

## 5. Required implementation

1. **Image provider adapters.** Support at least:
   - `openai` for DALL-E 2/3 (via the same OpenAI-compatible adapter pattern as
     TASK-002)
   - `stability` for Stable Diffusion API
   - `replicate` for Replicate
   - `custom` for any OpenAI-compatible image endpoint
   Selected by `IMAGE_PROVIDER`; key by `IMAGE_API_KEY`; model by `IMAGE_MODEL`;
   base URL by `IMAGE_BASE_URL` (custom only).

2. **Prompt construction.**
   - Scene image: use `scenes.image_prompt` if present, otherwise build from
     `scenes.heading`, `scenes.description`, and the project's story bible.
   - Character portrait: build from `characters.name`, `characters.description`,
     `characters.appearance`, and the project's story bible.
   Include style guidance: "manhwa style, vibrant colors, dynamic composition".

3. **Image storage.** Use `uploadAsset` from TASK-003 with `type = 'image'` and
   metadata including provider, model, dimensions, and the prompt used.

4. **Image routes.**
   - `POST /api/scenes/:sceneId/images/generate`  generate scene image
   - `POST /api/characters/:characterId/images/generate`  generate character
     portrait
   - `GET /api/projects/:projectId/images`  list images for project

5. **Capability verification.** `POST /api/integrations/image/verify` performs
   a real authenticated call to the configured image provider and records the
   result in `provider_checks` (capability = 'image', provider = the chosen
   provider).

6. **Honest failure.** Every provider failure is surfaced with the provider's
   own error; if generation fails, no asset row is created and the scene's
   `image_prompt` is not modified.

7. **Ownership enforcement.** All image operations are scoped to the owner's
   projects; cross-owner reads/generation return 404/403.

## 6. Explicit non-goals

- Voice generation (TASK-005).
- Video assembly (TASK-006).
- Image editing (Phase E).
- Multiple images per scene/character (one at a time is sufficient; the asset
  service already supports multiple).
- Style transfer or reference images.
- Public image URLs (all images stay private in R2).

## 7. Acceptance criteria

1. `npm run typecheck`, `npm run lint`, `npm run build` all pass.
2. `npm run test` passes, including new specs covering:
   - scene image generation with a stubbed provider
   - character portrait generation with a stubbed provider
   - image stored in assets table with type='image' and metadata
   - cross-owner isolation on image endpoints
   - 503 when no image provider is configured
   - image capability reports `not_configured` without IMAGE_* variables,
     `configured_unverified` with variables set but not yet verified,
     `connected_verified` after a real call
   - generation failure does not create an asset row
3. Deployed preview: `/api/health` reports `ready` with all 11 required tables
   present; `/api/integrations` reports Image AI as `connected_verified` once a
   real verification call succeeds.
4. Existing 40 specs stay green.
5. No secret value is committed, logged or returned to the browser.
6. `POST /api/bootstrap` still applies only pending migrations.

## 8. Commands and tests to run

```
npm run typecheck
npm run lint
npm run test
npm run build
node scripts/verify-local.mjs
```

## 9. Deployment or environment dependencies

- An image provider key set as deployment secrets:
  `IMAGE_PROVIDER` (`openai` | `stability` | `replicate` | `custom`),
  `IMAGE_API_KEY`, and optionally `IMAGE_MODEL` (`IMAGE_BASE_URL` for custom).
- The R2 bucket from TASK-003 must be attached for image storage.
- No additional secrets are required beyond the provider's API key.

## 10. Risks and fallback decisions

- **Image providers have different APIs.** Mitigation: each provider has its
  own adapter behind a common interface; the studio logic only uses the
  interface, never the concrete provider.
- **Image generation can be slow or expensive.** Mitigation: generation is
  synchronous for now; Phase C will add a job queue with retries and
  cancellation.
- **Generated images may not match the manhwa style.** Mitigation: prompts
  explicitly request "manhwa style, vibrant colors, dynamic composition"; the
  owner can refine the prompt and regenerate.
- **Provider rate limits.** Mitigation: errors are surfaced honestly; Phase C
  will add retries with backoff.
- **Large images.** Mitigation: default to 1024x1024 or the provider's native
  resolution; the asset service already handles large files.
