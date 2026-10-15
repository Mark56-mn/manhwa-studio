# AGENT HANDOFF

**Current state:** Phase A, TASK-002 (versioned script generation), and TASK-003 (R2 asset storage) are recorded as complete in prior handoffs. Do not recreate or renumber these completed tasks. The next planned work is TASK-004, the central AI router and bounded failover.

## Read first

1. `docs/MASTER_BLUEPRINT.md`
2. `tasks/ROADMAP.md`
3. `tasks/PHASE-B-TO-E-EXECUTION-PLAN.md`
4. `tasks/TASK-004-ai-router-failover.md`
5. Latest dated file under `handoffs/`
6. Current provider, scripting, asset-service, environment, migration and test code.

## What the repository has

- One Cloudflare Worker (Hono) serving `/api/*`, `/auth/freebuff/*` and the built SPA.
- Freebuff authentication, server-side authorization, same-origin checks on state changes, and `private, no-store` for personalized responses.
- D1-backed projects, seasons, episodes, characters, story bible and activity history.
- Script provider adapters and script-generation/review pipeline; script versions are immutable and approvals are append-only.
- R2 asset service and metadata table from TASK-003.
- Health and integration reporting intended to reflect actual configuration and verification.

## Evidence inherited from previous handoff

The earlier handoff reported these checks as passing: typecheck, lint, 40/40 Vitest specs, build, 54/54 local HTTP checks and 40/40 deployed-origin checks. It also stated that live provider use was not tested because no provider key was configured, and that R2 operations require an attached bucket. These are inherited report claims; the next agent must not imply it reran them unless it actually did.

## Immediate next action — TASK-004

Execute only `tasks/TASK-004-ai-router-failover.md`.

- Add the central script-provider router and bounded failover.
- Preserve existing OpenRouter, Google, Anthropic, OpenAI and custom adapters.
- Add Baseten using `https://inference.baseten.co/v1` and `BASETEN_API_KEY`; verify current official auth/model/API details before implementation.
- Add NVIDIA NIM as a candidate only after checking current official docs.
- Enforce zero-cost-only/default-deny behavior. Baseten inference is usage-priced; do not assume trial credits or free use. Credit consumption and paid inference need separate explicit owner authorization.
- Test provider failover with mocks; do not make chargeable live calls without authorization.
- Update `tasks/ROADMAP.md`, `AGENT_HANDOFF.md` and a dated `handoffs/HANDOFF-004-ai-router.md`.
- Run the actual checks available and state passed/failed/not run. Stop at the task boundary.

## Remaining sequence

See `tasks/PHASE-B-TO-E-EXECUTION-PLAN.md` for full scopes and acceptance criteria:

- TASK-005 image generation + R2 assets
- TASK-006 character continuity + scene-art review
- TASK-007 voice/narration + audio assets
- TASK-008 external FFmpeg video assembly
- TASK-009 durable jobs/recovery
- TASK-010 director/showrunner planning
- TASK-011 YouTube OAuth and private/unlisted upload
- TASK-012 separate explicit publication approval
- TASK-013 editing, continuity, accessibility and polish
- TASK-014 end-to-end release rehearsal and security review

## Rules for every agent run

- One task per run. The approximately one-hour timebox is a target, not a promise.
- Read before writing; inspect current code and branch state; do not overwrite completed work.
- Secrets remain server-side and never enter git, logs or browser responses.
- Never silently fall back to paid inference. Never treat a mock, row, HTTP 200 or claimed output as a validated artifact.
- Public YouTube publication and production release require explicit owner authorization.
- If incomplete, write the exact remaining steps and make the next run a focused continuation/repair task.
