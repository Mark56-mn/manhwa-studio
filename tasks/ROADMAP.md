# Roadmap

Phase A is complete: the studio is online, authenticated, and persists real
project data. The roadmap below is ordered by "what unblocks the owner next".

## Phase A  online foundation (complete)

- [x] Responsive studio shell, dark blue/violet theme, usable on a phone.
- [x] Sign in with Freebuff, enforced on the server for every private route.
- [x] Project create/list/detail/edit/delete, persisted in D1.
- [x] Seasons, episodes (auto-numbered, staged status), characters, story bible.
- [x] Production history feed recording real actions.
- [x] `/api/health` readiness from real checks (database, assets, auth config).
- [x] `/api/integrations` honest capability status.
- [x] SQL migration + documented apply steps.
- [x] Tests: API/authorization/CSRF integration specs against real D1 in workerd.
- [x] Deployment on one origin with preview/production environments.

## Phase B  first real production (next)

Order matters: provider choice, then artifacts, then assembly.

1. **TASK-002  provider adapters + real script generation. (done)**
   Multi-provider adapter layer behind `SCRIPT_*` (`openai`, `openrouter`,
   `anthropic`, `google`, `custom`), real authenticated verification recorded in
   `provider_checks`, immutable `script_versions` with parsed `scenes`, an
   append-only `script_approvals` review trail, and an episode workspace UI.
   See `handoffs/HANDOFF-002-provider-and-script.md`.
2. **TASK-003  object storage. (done)** Provision R2, add the `assets` table, and
   store generated media as objects with metadata rows (never binaries in D1).
   See `handoffs/HANDOFF-003-object-storage.md`.
3. **TASK-004  image generation.** Scene + character art with continuity
   references from the story bible and the `scenes.image_prompt` written by
   TASK-002; store real files, record provider/model/dimensions.
4. **TASK-005  voice generation.** Narration audio per scene; store artifact +
   voice settings.
5. **TASK-006  video assembly.** Render scenes + narration + captions into a
   playable file; validate with media tools; owner plays it before approval.

## Phase C  reliable automation

Durable job queue with retries/timeouts/cancellation, director task graph with
dependencies, worker run logs, remote GPU/notebook render worker, and recovery
after a worker disconnects.

## Phase D  publishing

YouTube OAuth, private/unlisted upload, verified video id + processing status,
per-episode approval record, public publication only after explicit
authorisation.

## Phase E  polish

Editing tools, continuity checking, character consistency scoring, scheduling,
analytics, advanced automation.
