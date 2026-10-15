# Roadmap

Phase A is complete. Phase B has a verified script-generation foundation and R2 asset-storage implementation. The next priority is making provider selection safe and resilient, then completing a real media pipeline before automation and publishing.

## Completed foundation

- [x] **Phase A:** Responsive studio shell, Freebuff authentication, private routes, D1-backed projects/seasons/episodes/characters/story bible, activity history, health/integration status, migrations and preview deployment.
- [x] **TASK-002:** Provider adapters and versioned script generation. Provider registry currently includes OpenAI-compatible, OpenRouter, Anthropic, Google and custom adapters; scripts are versioned and approvals append-only. See `handoffs/HANDOFF-002-provider-and-script.md`.
- [x] **TASK-003:** R2 object storage and asset metadata/API. Binary media belongs in R2, not D1. See `tasks/TASK-003-object-storage.md` and `handoffs/HANDOFF-003-object-storage.md`.

## Next task

- [ ] **TASK-004 — Central AI router, bounded failover, Baseten and NVIDIA candidates.** Route script generation through one router; preserve existing providers; add Baseten at `https://inference.baseten.co/v1` and NVIDIA NIM where verified; use live documentation and verified model IDs; enforce bounded retries and a zero-cost-only/default-deny policy. Baseten is usage-priced; do not assume trial credits or free inference. Owner must explicitly authorize credit consumption or paid use. Full instructions: `tasks/TASK-004-ai-router-failover.md`.

## Remaining tasks — execute one task per agent run

The full acceptance criteria and handoff requirements are in `tasks/PHASE-B-TO-E-EXECUTION-PLAN.md`.

- [ ] **TASK-005 — Real image-generation adapter and asset persistence.** Generate a real scene image through a verified compatible model; validate bytes/dimensions; store in R2 and record provenance. No placeholder images.
- [ ] **TASK-006 — Character continuity and scene-image workflow.** Use story bible/character references; preserve image versions; let owner select/regenerate scene art.
- [ ] **TASK-007 — Voice/narration adapter and audio assets.** Verify price/rights/limits; generate or import real narration; validate and store audio in R2; owner preview.
- [ ] **TASK-008 — Video assembly worker.** Use an external FFmpeg worker, not a Cloudflare request; assemble images, narration and captions into a validated playable motion-comic video.
- [ ] **TASK-009 — Durable job orchestration and recovery.** Add idempotent jobs, dependency graph, bounded retries/timeouts/cancellation, worker logs and restart recovery.
- [ ] **TASK-010 — Director/showrunner planning.** Produce structured episode plans grounded in the story bible; immutable plan versions; owner approval before downstream generation.
- [ ] **TASK-011 — YouTube OAuth and private/unlisted upload.** Secure OAuth, resumable upload, real video ID and processing state; private/unlisted by default.
- [ ] **TASK-012 — Explicit publication approval.** Public visibility requires a separate authenticated owner confirmation and an append-only audit record; automation cannot publish by itself.
- [ ] **TASK-013 — Editing, continuity, accessibility and polish.** Versioned edits, continuity warnings, captions, mobile accessibility, usage transparency and audit history.
- [ ] **TASK-014 — End-to-end release rehearsal and security review.** Verify each real artifact through the pipeline, document cost/licensing/quota/security/recovery evidence, and keep public release disabled until the owner authorizes it.

## Required task-loop protocol

1. Read `AGENT_HANDOFF.md`, this roadmap, `docs/MASTER_BLUEPRINT.md`, the active task and latest dated handoff.
2. Verify the current repository/branch state and inspect existing code before editing.
3. Work on **one task only**. The one-hour session is a target, not a completion guarantee.
4. Run actual checks and report passed, failed and not run. Mocked provider tests are not live provider tests.
5. Update the task, this roadmap and `AGENT_HANDOFF.md`; write a dated handoff with exact next task, blockers and evidence.
6. Commit/push when possible. If incomplete or failing, stop with an honest handoff and make the next session a focused continuation/repair task.
7. Never expose keys, silently fall back to paid services, claim a stage complete without a validated artifact, or publish production/public YouTube content without explicit owner authorization.
