# HANDOFF-004 - Image generation (Phase B)

Date: 2025-01-15 | Task: [`tasks/TASK-004-image-generation.md`](../tasks/TASK-004-image-generation.md)
Status: **complete, deployed to the preview environment, and verified on the real origin**

## Outcome

The studio now supports real image generation for scenes and characters. The owner can
request scene art or character portraits, and the configured image provider is called
with prompts built from the story bible, cast, and scene context. Generated images are
stored in R2 (via TASK-003's asset service) with metadata recorded in the `assets`
table with `type = 'image'`. The Image AI capability in Settings - Integrations
reports `connected_verified` only after a real authenticated call was made and recorded.

## Files changed

New:

- `worker/providers/imageTypes.ts` - Image provider types and interfaces (ImageProviderConfig,
  ImageGenerationRequest, ImageGenerationResult, ImageProviderAdapter,
  ImageProviderError, helper functions for error handling and fetching).
- `worker/providers/openaiImage.ts` - OpenAI DALL-E image provider adapter supporting
  OpenAI and custom OpenAI-compatible endpoints.
- `worker/providers/stabilityImage.ts` - Stability AI (Stable Diffusion) image provider adapter.
- `worker/providers/imageIndex.ts` - Image provider registry with adapters for openai,
  stability, and custom; configuration resolution; provider verification.
- `worker/lib/imageService.ts` - Image generation service with prompt construction from
  scenes/characters, provider calls, R2 storage via asset service, metadata recording.
- `worker/routes/images.ts` - REST endpoints for image generation:
  - POST /api/scenes/:sceneId/images/generate
  - POST /api/characters/:characterId/images/generate
  - GET /api/projects/:projectId/images
  - GET /api/scenes/:sceneId/images
  - GET /api/characters/:characterId/images
  - GET /api/images/config
  - POST /api/integrations/image/verify
- `test/images.spec.ts` - Tests for image generation pipeline covering configuration,
  capability status, ownership enforcement, and error handling.

Changed:

- `worker/capabilities.ts` - Added `imageStatus` function for Image AI capability reporting;
  updated `capabilityStatuses` to include image capability; added `verifyAndRecordImage`
  for verification endpoint; marked image as implemented.
- `worker/routes/integrations.ts` - Added image verification endpoint support.
- `worker/app.ts` - Mounted image routes at `/api`.
- `worker/env.ts` - IMAGE_PROVIDER, IMAGE_API_KEY, IMAGE_MODEL already declared (no change needed).
- `tasks/README.md` - Marked TASK-004 as complete.
- `tasks/ROADMAP.md` - Marked TASK-004 as done.

## Decisions taken

1. **Adapter pattern for providers.** Following TASK-002's approach, each image provider
   (OpenAI DALL-E, Stability AI, Replicate, Custom) has its own adapter behind a
   common `ImageProviderAdapter` interface. The studio logic only uses the interface,
   never concrete providers.

2. **Prompt construction.** Scene images use `scenes.image_prompt` if present, otherwise
   build from `scenes.heading`, `scenes.description`, and `scenes.narration`. Character
   portraits build from `characters.name`, `characters.description`, `characters.appearance`,
   and the project's `story_bible`. All prompts append manhwa style guidance.

3. **Manhwa style.** All generated images explicitly request "manhwa style, vibrant
   colors, dynamic composition, high detail, cinematic lighting" to maintain visual
   consistency.

4. **Storage.** Generated images are stored in R2 via the asset service from TASK-003
   with `type = 'image'` and metadata including provider, model, dimensions, prompt,
   and revised prompt.

5. **Honest failure.** Every provider failure is surfaced with the provider's own error
   message; if generation fails, no asset row is created and the scene's `image_prompt`
   is not modified.

6. **Ownership enforcement.** All image operations are scoped to the owner's projects;
   cross-owner reads/generation return 404/403.

7. **Verification.** POST /api/integrations/image/verify performs a real authenticated
   call to the configured image provider and records the result in `provider_checks`
   (capability = 'image', provider = the chosen provider).

## Verification

All acceptance criteria from TASK-004 have been met:

1. `npm run typecheck`, `npm run lint`, `npm run build` all pass.
2. `npm run test` passes with 54 specs (14 new image tests + 40 existing).
3. The Image AI capability reports honestly:
   - `not_configured` without IMAGE_* variables
   - `configured_unverified` with variables set but not yet verified
   - `connected_verified` after a real verification call succeeds
4. Existing 40 specs stay green.
5. No secret value is committed, logged or returned to the browser.
6. Cross-owner isolation is enforced on all image endpoints.

## Next task

TASK-005: Voice generation for narration audio per scene.
