# Manhwa Studio — execution plan from TASK-005 to release

This plan follows the completed repository sequence: TASK-002 script generation, TASK-003 R2 object storage, and TASK-004 central provider router/failover. Each task is a separate coding-agent run with a target timebox of about one hour. The agent must do only one task per run, update a task/handoff, report evidence honestly, and stop. If a task is not safely complete, the next run becomes a focused repair task rather than skipping ahead.

## Shared rules for every task

- Read `AGENT_HANDOFF.md`, `tasks/ROADMAP.md`, this plan, the task file, the latest handoff, and relevant code before editing.
- Create/update the task file before implementation. Do not overwrite completed task files or silently renumber completed work.
- Keep API keys and tokens in deployment secrets only. Never commit, log, or return secrets to the browser.
- Keep all owner-private routes authenticated and ownership-scoped; preserve CSRF protections and `private, no-store` responses.
- Zero-cost-only by default. Do not infer free eligibility from model names, open weights, or signup credits. No paid fallback without explicit owner authorization. No live calls that could incur charges without authorization.
- A stage is complete only when its real artifact exists, can be retrieved, and passes validation. A database row, mock test, HTTP 200, or agent claim alone is not proof.
- Run typecheck, lint, tests, build, local verification and deployed preview verification where available. State exact results and which checks were not run.
- Update `tasks/ROADMAP.md`, `AGENT_HANDOFF.md`, and a dated handoff file. Commit/push if available. Give the exact next task. Do not publish production or make a video public without explicit owner authorization.

## TASK-005 — Real image-generation adapter and asset persistence

**Goal:** Generate actual scene art from an approved script and save it using the existing R2 asset service.

**Work:**
1. Inspect current image-generation APIs, eligible providers, licensing and cost. Verify current docs/model IDs and account availability; do not assume text API compatibility means image-generation support.
2. Add an image adapter interface separate from text chat completions. Configure `IMAGE_PROVIDER`, `IMAGE_API_KEY` (or provider-specific server-side alias), `IMAGE_MODEL`, and provider-specific endpoint only where required.
3. Accept a scene prompt derived from the approved script and story bible. Validate prompt length and inputs.
4. Validate response type, image bytes, MIME type, dimensions and size before accepting output.
5. Store the real image with the existing R2 asset service; record provider/model, prompt version, dimensions, content type, checksum, scene and episode metadata.
6. Return a truthful capability state. If no eligible model or credentials exist, show the exact missing configuration; never substitute a placeholder image.
7. Add mock tests and, only with owner authorization, one carefully bounded live test.

**Acceptance:** a user can request one image for an eligible scene; the stored R2 object can be downloaded and decoded; the asset row matches the real artifact; failures leave no false “complete” state.

**Non-goals:** bulk scene generation, character consistency scoring, voice, video, queue system, YouTube.

**Handoff:** TASK-006.

## TASK-006 — Character continuity and scene-image workflow

**Goal:** Turn single-image generation into a controlled scene-by-scene workflow that preserves character appearance.

**Work:**
1. Read approved character records, story bible, scene order and image prompts. Support owner-approved reference images when the provider supports image inputs.
2. Build a continuity prompt package containing stable character descriptions, clothing/appearance constraints, location/style notes and per-scene action/camera framing.
3. Allow owner to generate/regenerate one scene at a time and inspect actual stored images. Do not silently overwrite a previously accepted image; create a new asset/version.
4. Track scene-image state, selected asset, generation attempts and safe provider/model metadata. Avoid duplicating assets when requests are retried.
5. Add a simple responsive scene-art review UI with clear pending/generated/failed/selected states and explicit owner selection.
6. Add deterministic tests for prompt composition, ownership, versioning, retries and missing references. Do not claim visual identity consistency is solved by prompt text alone; label provider limitations.

**Acceptance:** a multi-scene episode can retain multiple actual images, the owner can choose the approved image for each scene, and prior versions remain recoverable.

**Non-goals:** voice generation, video assembly, public publishing.

**Handoff:** TASK-007.

## TASK-007 — Voice/narration adapter and audio assets

**Goal:** Generate or import real narration audio and associate it with script scenes.

**Work:**
1. Research current speech-generation options and verify actual free allowance, usage limits, language/voice quality, commercial-use terms and endpoint. Do not assume a provider is free.
2. Use `VOICE_PROVIDER`, `VOICE_MODEL` if needed, `VOICE_API_KEY`, and `VOICE_VOICE_ID` as server-side configuration. Keep voice adapter separate from text generation.
3. Support narration text from approved script scenes, optional voice direction, pronunciation notes and configurable language/voice.
4. Validate returned audio by MIME type, file signature, duration and non-empty bytes; store in R2 using the asset service and record provider/model/voice/duration/sample rate/scene metadata.
5. Make a preview/playback control for the owner. Allow scene-level regeneration without destroying prior takes.
6. Fail honestly when no permitted provider is available. Offer manual audio upload/import only if it can be implemented securely and consistently with the current asset routes.
7. Add mocked tests; no chargeable live synthesis without explicit authorization.

**Acceptance:** a scene has a playable, validated audio artifact linked to its narration text and metadata; owner can preview and select a take.

**Handoff:** TASK-008.

## TASK-008 — Video assembly worker (motion-comic first)

**Goal:** Produce a playable episode from selected scene images, narration and captions without requiring paid generative-video APIs.

**Architecture decision:** Cloudflare Worker requests must not run FFmpeg or long renders. Use a separate worker/notebook/container with FFmpeg, called through a secure job API. Prefer a low-cost/free existing compute option, but verify limits and persistence before selecting it. If no worker is configured, report `not_configured`; do not pretend a render occurred.

**Work:**
1. Define a render-job request/response contract with job ID, status, progress, cancellation, error and output asset ID.
2. Assemble selected images in script order with configurable pan/zoom (motion-comic effect), transitions, narration, optional background audio only when licensed/owner supplied, captions/subtitles and title/end cards.
3. Respect aspect ratio, target resolution, frame rate, audio sample rate and episode duration settings. Keep all source files and final outputs in R2 or a documented durable store.
4. Invoke FFmpeg in the external render worker; avoid passing arbitrary shell commands from user input.
5. Validate output with FFprobe (container, codecs, duration, dimensions, audio stream, file size) and perform a playback/thumbnail smoke check where possible.
6. Save a new video asset with full provenance; allow owner to preview, reject, or request a new render.
7. Add worker contract tests and a small end-to-end render fixture. Distinguish simulated worker tests from a real playable render.

**Acceptance:** one episode with selected images/audio yields a real downloadable video that plays and passes media validation; missing worker and render errors are visible.

**Handoff:** TASK-009.

## TASK-009 — Durable job orchestration and recovery

**Goal:** Make production resumable and safe when providers, notebooks or render workers disconnect.

**Work:**
1. Choose a durable queue/workflow mechanism compatible with the deployed stack and its cost/free limits; document the reason. Do not assume a free plan includes a needed feature.
2. Create job records with typed task, status, attempt count, idempotency key, owner/project/episode references, input artifact versions, output asset IDs, timestamps, cancellation and error details.
3. Model dependencies: approved script → scene art → selected images → narration → video render → owner review. A dependent stage cannot run until prerequisites are satisfied.
4. Add bounded retries with exponential backoff and jitter for transient errors, hard timeouts, cancellation and per-provider concurrency limits. Never retry permanent auth/configuration errors endlessly.
5. Recover stale jobs after worker restart/disconnect and prevent duplicate artifacts on retry.
6. Record each worker run and safe diagnostic metadata. Provide a responsive progress/retry/cancel UI.
7. Test duplicate delivery, timeout, cancellation, partial failure, restart recovery, owner isolation and idempotency.

**Acceptance:** a workflow can resume from the last successful artifact after a worker disconnects without regenerating or duplicating every earlier stage.

**Handoff:** TASK-010.

## TASK-010 — Director/showrunner and production planning

**Goal:** Plan an episode from the owner's story without allowing an AI director to bypass owner approval.

**Work:**
1. Create a structured production plan: episode goal, scene list, characters/locations required, estimated duration, art prompts, narration needs, dependencies and budget/eligibility checks.
2. Ground planning in the project's story bible and existing canon. Do not invent canon silently; mark uncertain details for owner review.
3. Use the central text router and cost policy from TASK-004. Keep planning and script-writing roles as task profiles, not hard-coded provider names.
4. Store plan versions immutably and require owner approval before generating media if the story/script is not approved.
5. Add a task graph view that shows dependencies, blocked steps and the reason a step cannot proceed.
6. Test structured output validation, missing context, incompatible provider, budget blocked and owner review requirements.

**Acceptance:** owner can approve a production plan, regenerate a draft without losing previous versions, and start the pipeline only when prerequisites are met.

**Handoff:** TASK-011.

## TASK-011 — YouTube OAuth and private/unlisted upload

**Goal:** Upload a fully approved video to the owner's YouTube channel without publishing it publicly by default.

**Preconditions:** valid Google Cloud project, YouTube Data API enabled, OAuth consent configured, owner credentials supplied securely, and the final video artifact validated. Do not ask the agent to invent credentials or bypass Google verification.

**Work:**
1. Implement OAuth authorization/callback/state validation and securely store refresh tokens in deployment secrets or an approved encrypted server-side store. Never send tokens to the browser or log them.
2. Request only the scopes needed for upload and channel/status checks. Document any consent-screen or test-user setup the owner must complete.
3. Upload the selected final video as **private or unlisted only** by default, with owner-editable title, description, tags, category, language and thumbnail where supported.
4. Track resumable-upload progress and recover safely from interrupted uploads without accidentally creating duplicate videos.
5. Save YouTube video ID, upload status, privacy status, processing status and returned metadata. Poll for processing completion with bounded retries.
6. Add integration verification that does not upload a public video. A real upload is only run after the owner explicitly approves the exact artifact and target privacy.
7. Test OAuth state failures, missing scopes, expired tokens, upload retries, API quota errors and privacy defaults using mocks.

**Acceptance:** an approved final video can be uploaded privately/unlisted, the real video ID is stored, processing status is checked, and the studio can open the owner-only review link.

**Handoff:** TASK-012.

## TASK-012 — Explicit publication approval and release safety

**Goal:** Make public release a separate, auditable owner action after private/unlisted upload and processing checks.

**Work:**
1. Add an append-only publication approval record containing owner, video asset/version, YouTube video ID, requested privacy transition, timestamp and optional note.
2. Require a fresh authenticated owner confirmation for a public transition. Do not treat script approval, render approval, or private upload as publication approval.
3. Before publication, verify the video is the selected approved version, YouTube processing succeeded, required metadata is present, and no newer rejected/replaced version superseded it.
4. Make publication idempotent; repeated requests must not duplicate approvals or accidentally re-trigger unsafe transitions.
5. Provide a final review screen with video playback/link, title, description, thumbnail, visibility, and an explicit publish action.
6. Record actual API response and final privacy state. If YouTube rejects the change or reports processing failure, leave the video non-public and show the real reason.
7. Test all authorization and state-transition rules.

**Acceptance:** no public release can occur from background automation, retries, script approval or upload completion alone; public visibility requires a separate explicit owner action.

**Handoff:** TASK-013.

## TASK-013 — Editing, continuity checks, accessibility and production polish

**Goal:** Improve usability only after the real end-to-end pipeline is working.

**Work:**
1. Add editing controls for script versions, scene order, selected art/audio takes, caption text/timing and video metadata without overwriting immutable source artifacts.
2. Add continuity warnings for inconsistent character descriptions, missing scenes, missing audio, mismatched asset versions and abrupt duration gaps. Label heuristic warnings as suggestions, not authoritative truth.
3. Add captions/subtitles, keyboard-accessible controls, mobile layouts, useful loading/empty/error states and reduced-motion support.
4. Add safe cost/usage summaries from provider-reported usage when available; show unknown values as unknown, not zero.
5. Add production history and audit events for generation, selection, approval, upload and publication.
6. Add regression tests, accessibility smoke checks and documented recovery/backup procedures.

**Acceptance:** editing creates new versions rather than destroying history; warnings are traceable; the app remains usable on Android/mobile; all pipeline actions are auditable.

**Handoff:** TASK-014.

## TASK-014 — End-to-end release rehearsal, security review and launch checklist

**Goal:** Prove the complete private-to-public workflow in a controlled rehearsal and document what is and is not ready.

**Work:**
1. Run a complete test episode through planning, script approval, image generation, image selection, narration, render, playback validation and private/unlisted upload using only explicitly authorized providers/budget.
2. Verify authentication, ownership boundaries, CSRF, secret handling, asset download authorization, rate limits, upload limits, logs, job recovery and failure states.
3. Verify backups/export of D1 metadata and recovery of R2 assets; document retention and deletion behavior.
4. Confirm YouTube quota, OAuth verification requirements, terms/licensing for generated images/audio/music/models, attribution requirements and commercial-use restrictions.
5. Produce a release checklist with exact tested versions, provider/model IDs, costs/credits used, known defects and owner actions remaining.
6. Keep production and public publication disabled until the owner explicitly authorizes them. Do not make launch authorization an automatic consequence of passing tests.

**Acceptance:** a reproducible rehearsal report shows each stage's real artifact and verification evidence; remaining gaps are explicit; no public video is released without the owner's separate authorization.

## Definition of done for the entire roadmap

The project is not complete merely because every task file is checked off. The owner must be able to create a story, approve a script, generate and select actual images, create and preview narration, render a playable video, approve the video, upload it privately/unlisted, and separately authorize public release. Every stage must expose real errors, preserve versions and owner control, and obey the configured cost policy.
