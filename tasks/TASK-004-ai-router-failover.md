# TASK-004 — Central AI router, bounded failover, and Baseten provider

**Priority:** Next task  
**Timebox:** One agent session of approximately one hour. This is a target, not a promise; if unfinished, write an honest handoff and stop.  
**Repository:** `Mark56-mn/manhwa-studio` only. Do not modify the separate Ostra Studio repository.

## 1. Objective

Make text/script generation resilient without silently spending money. Introduce one central provider router that can choose among compatible, configured providers and automatically fail over after retryable failures. Add Baseten as an OpenAI-compatible inference provider using:

- Base URL: `https://inference.baseten.co/v1`
- Backend secret: `BASETEN_API_KEY`

Preserve the completed object-storage work in TASK-003. Do not reuse or overwrite its task number.

## 2. Read before editing

Read `docs/MASTER_BLUEPRINT.md`, `AGENT_HANDOFF.md`, `tasks/ROADMAP.md`, `tasks/TASK-002-provider-and-script.md`, `tasks/TASK-003-object-storage.md`, the latest handoff, `worker/providers/*`, `worker/scripting/*`, `worker/env.ts`, `.env.example`, and the existing tests/scripts. Confirm the current branch and working tree before making changes. Create a dated handoff for this task.

## 3. Provider/router behavior

1. Add a central router module (for example `worker/providers/router.ts`) and route script generation through it. Keep provider-specific HTTP details inside adapters.
2. Preserve OpenRouter, Google Gemini, Anthropic, OpenAI, and custom OpenAI-compatible integrations that already exist.
3. Add Baseten as an OpenAI-compatible adapter with configurable `BASETEN_API_KEY` and default base URL above. Confirm the current official Baseten documentation for endpoint, authentication header, model catalog/discovery, request parameters, and error behavior before implementing. Baseten's authentication examples can vary across documentation/model generations; use the current contract, not an assumption.
4. Add NVIDIA NIM as an OpenAI-compatible candidate if it fits the current adapter contract: base URL `https://integrate.api.nvidia.com/v1`, key `NVIDIA_API_KEY`. Verify the current official NVIDIA API documentation. Do not invent model IDs.
5. Support per-task candidate ordering and task capability declarations. Text/script generation may fail over only to models verified as compatible with that text task. A text model must never be treated as an image, speech, or video generator merely because it uses an OpenAI-compatible endpoint.
6. Discover models from the provider's authenticated model catalog when supported; otherwise use explicit owner configuration and label discovery as unsupported. Never claim a model was verified merely because it appears in a static list.
7. Store the actual successful provider/model and safe usage metadata with each script version. Do not store keys or sensitive authorization headers.

## 4. Bounded failover rules

- Maximum of **3 total provider attempts per script-generation request**, configurable only within a safe upper bound.
- Never repeat the same provider/model pair during one request.
- Fail over on timeouts/network errors, HTTP 429, retryable 5xx responses, or empty/unusable output.
- Do not repeatedly retry invalid credentials, invalid model IDs, malformed requests, or other permanent 4xx errors unless a different candidate/request can plausibly resolve the failure.
- Preserve the same story bible, episode brief, output contract, and relevant context across attempts. Validate every response before persistence.
- Persist only the final validated result from the successful attempt. Do not create duplicate script versions or partial scenes on failed attempts. Preserve immutable versions and append-only approvals.
- Return a useful final error including safe per-attempt diagnostics, without leaking credentials or sensitive prompts.
- Add request timeout and cancellation behavior. Avoid unbounded loops and uncontrolled parallel provider calls.

## 5. Cost guardrails — non-negotiable

The default behavior must be **zero-cost-only**. A model is not free just because its name includes “free,” it is open-weight, or its API is OpenAI-compatible.

- Do not infer free usage from a model name, marketing label, or the existence of signup credits.
- Baseten's API is usage-priced; do not assume a permanent free tier or assume trial credits exist or remain available. The owner must explicitly confirm available credits and authorize their use before Baseten becomes an eligible candidate.
- Add server-side configuration/documentation for owner-authorized use of Baseten promotional credits separately from authorization to incur paid charges. Defaults must deny both.
- Paid inference must remain disabled unless the owner explicitly enables it. No silent paid fallback under any circumstance.
- Where current cost/eligibility cannot be verified, treat the candidate as ineligible under zero-cost-only policy and explain why.
- Never make a live provider request during tests or deployment verification that could incur charges unless the owner explicitly authorizes that exact check.
- Keep all provider keys server-side; no `VITE_*` or `NEXT_PUBLIC_*` secret variables.

Suggested environment names (adapt to repository conventions, document clearly, never set secrets in git):
```env
BASETEN_API_KEY=
BASETEN_BASE_URL=https://inference.baseten.co/v1
BASETEN_ALLOW_CREDIT_USAGE=false
BASETEN_ALLOW_PAID_USAGE=false
NVIDIA_API_KEY=
NVIDIA_BASE_URL=https://integrate.api.nvidia.com/v1
```
If a configuration design is safer or simpler, use it, but preserve the default-deny policy.

## 6. Tests

Add mocked tests proving at least:

- preferred candidate succeeds and records the correct provider/model;
- Baseten success with correct request URL/auth format (mock only);
- timeout, 429 and 5xx move to a different eligible candidate;
- empty/unusable output moves to a different candidate;
- invalid credentials/model errors do not cause a retry storm;
- the same candidate is never attempted twice;
- maximum attempt count is respected;
- no eligible zero-cost candidates means a clear failure;
- Baseten credits are excluded by default and become eligible only after explicit owner authorization;
- paid candidates are blocked by default and cannot be reached by fallback;
- all providers failing creates no duplicate/partial script version;
- secrets are absent from logs and responses;
- existing ownership, script-version immutability and approval-history tests remain green.

Clearly label all mocked checks. A mock passing is not a live provider test.

## 7. Scope limits

Do not implement image generation, narration, video rendering, durable job queues, YouTube, or a UI redesign in this task. Do not alter or recreate TASK-003 object storage. Avoid unrelated infrastructure changes.

## 8. Acceptance criteria

- Script generation uses the central router.
- Baseten and NVIDIA can be configured as compatible text candidates after documentation-backed adapter work.
- Bounded automatic failover works and is covered by tests.
- Zero-cost-only/default-deny cost policy is enforced by code, not just documentation.
- Successful script versions record the provider/model that actually succeeded.
- Existing behavior and security tests remain green.
- `.env.example`, README and provider settings/capability reporting are accurate.
- `AGENT_HANDOFF.md`, `tasks/ROADMAP.md`, this task file, and a dated `handoffs/HANDOFF-004-ai-router.md` agree on the next task.

## 9. Verification and finish protocol

Run the repository's available checks, at minimum:
```sh
npm run typecheck
npm run lint
npm run test
npm run build
npm run verify:local
npm run verify:deployed -- <preview-origin>
```
Use the actual script syntax from `package.json`; do not invent commands. If deployed verification is unavailable, say why. Never claim tests or live calls you did not run.

At the end, report passed / failed / not run; update the roadmap and handoff; commit and push if the environment supports it. If the task is not finished in the timebox, record the exact remaining work and make the next run a focused continuation/repair task. Stop at the task boundary.

## 10. Next task

After this task is verified and handed off, execute **TASK-005 — real image-generation adapter and asset persistence** from `tasks/PHASE-B-TO-E-EXECUTION-PLAN.md`.
