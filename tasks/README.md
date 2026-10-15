# Tasks

One file per unit of work, small enough to implement and verify in roughly
3050 minutes of agent time. If a task is bigger than that, split it before
starting.

Order: `TASK-001`, `TASK-002`, ... Each file contains: objective; verified
repository state at the start; user-facing outcome; files and components
involved; required implementation; explicit non-goals; acceptance criteria;
commands and tests to run; deployment/environment dependencies; risks and
fallback decisions.

Rules:

- Do not start a task before the previous task's handoff exists.
- Only mark acceptance criteria that were actually run and observed.
- A build, an upload receipt or an HTTP 200 is not proof of behaviour; test the
  interface the owner will use.

| Task | Title | Status |
| --- | --- | --- |
| [TASK-001](TASK-001-online-foundation.md) | Online foundation (Phase A) | Complete, preview deployed |
| [TASK-002](TASK-002-provider-and-script.md) | Provider selection + real script generation (Phase B start) | Complete, preview deployed |
| [TASK-003](TASK-003-object-storage.md) | Object storage + assets (Phase B) | Complete, preview deployed |
| [TASK-004](TASK-004-ai-router-failover.md) | Central AI router, bounded failover and Baseten/NVIDIA candidates | Next |
| TASK-005 | Real image-generation adapter + R2 persistence | Planned |
| TASK-006 | Character continuity + scene-art workflow | Planned |
| TASK-007 | Voice/narration adapter + audio assets | Planned |
| TASK-008 | External FFmpeg video assembly | Planned |
| TASK-009 | Durable job orchestration + recovery | Planned |
| TASK-010 | Director/showrunner planning | Planned |
| TASK-011 | YouTube OAuth + private/unlisted upload | Planned |
| TASK-012 | Separate explicit publication approval | Planned |
| TASK-013 | Editing, continuity, accessibility and polish | Planned |
| TASK-014 | End-to-end release rehearsal and security review | Planned |


Full acceptance criteria for TASK-005 through TASK-014 live in
[PHASE-B-TO-E-EXECUTION-PLAN.md](PHASE-B-TO-E-EXECUTION-PLAN.md). The next
agent must read `AGENT_HANDOFF.md` and execute only the next task. The
approximately one-hour timebox is a target, not a guarantee. If work is
incomplete or tests fail, write an honest handoff and make the next run a
focused continuation/repair task. Never silently fall back to paid AI usage
or publish publicly without the owner's explicit authorization.
