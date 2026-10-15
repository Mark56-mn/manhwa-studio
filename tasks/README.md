# Tasks

One file per unit of work, small enough to implement and verify in roughly
30–50 minutes of agent time. If a task is bigger than that, split it before
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
| TASK-003 | Object storage + assets (Phase B) | Not started |
