# Handoff protocol

After every task:

1. Write `handoffs/HANDOFF-<task>-<slug>.md` with: outcome, files changed,
   decisions, commands run with real results, and an explicit
   passed / failed / blocked / not-tested split.
2. Update `AGENT_HANDOFF.md` with the same summary and the next task file.
3. Update `tasks/ROADMAP.md` (tick what is genuinely done).
4. State plainly whether a live deployment was exercised, and on which origin.
5. Commit the working changes.
6. Only then start the next task.

Evidence rules:

- Never write "tests passed" without the command and its result.
- A successful build is not a healthy deployment; an upload receipt is not a
  working page. Say which one you actually have.
- Interactions that need a browser sign-in are listed as pending owner
  verification, not as passed.
- Blocked work names the exact missing input (credential, account, decision),
  in one short list, and stops there.
