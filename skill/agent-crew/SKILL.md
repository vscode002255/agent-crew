---
name: agent-crew
description: Run a durable manager/worker workflow with task DAGs, isolated worker runs, independent verification, and explicit accept/reject sign-off. Use when a project needs repeatable delegation, a replaceable manager, or auditable acceptance gates across CLI agents.
metadata:
  short-description: Manager/worker task orchestration
---

# Agent Crew

Act as a project manager over replaceable worker agents. All coordination goes
through `scripts/crew.js`, a zero-dependency Node.js CLI that persists state in
`<project>/.agent-crew/`. Nothing depends on a specific agent's sub-agent API:
workers and acceptance checks are argv command templates, so any compatible CLI
binary can fill a slot.

## Operating invariants

- Exactly one active manager holds sign-off authority at a time.
- A worker exit code of `0` moves a task to `review` — never to `accepted`.
- Acceptance requires a separate verification run plus an explicit `accept`.
- A worker must never sign off its own task; hand off if the assignee is also
  the active manager.
- Task `writes` scopes must not overlap between tasks running at the same time.
- State is the source of truth. Read it with `status`/`task list`, never by
  guessing, and never edit `.agent-crew/` by hand.

## Workflow

1. **Initialize once.** `crew.js init --name <project>`. It refuses to overwrite
   an existing project, so a second call is a real error, not a no-op.
2. **Register workers** with `agent add`. The command is a JSON argv array such
   as `["pi","-p","{prompt}"]`; it is spawned directly, never through a shell.
   Supported placeholders: `{prompt}`, `{promptFile}`, `{projectRoot}`,
   `{taskId}`, `{runDir}`, `{stateDir}`, `{agentId}`.
   Use `agent list --json` to see the selectable worker pool.
3. **Decompose work** with `task add`: one assignee, explicit `--needs`
   dependencies, `--writes` scopes, and a real `--accept-json` command.
   Reassign pending, rework, or failed work with `task assign <task-id>
   --assignee <agent-id>`. A running, review, or accepted task must be rejected
   or reset first so old evidence cannot be mistaken for the new worker's work.
4. **Plan before running.** `run --dry-run --json` shows eligibility; state is
   untouched.
5. **Execute.** `run --max-parallel <n> --json` schedules eligible tasks in
   dependency order and serializes overlapping write scopes.
6. **Verify independently.** `verify <task-id>` runs the acceptance command
   from the project root and records the log and exit code.
7. **Sign off or send back.** `accept <task-id>` requires a passing
   verification and existing in-project evidence paths. `reject <task-id>
   --manager <id> --note <text>` returns the task to `rework` for another run.
8. **Transfer the project.** `handoff --to <manager> --note <text>` writes a
   Markdown snapshot to `.agent-crew/handoffs/` before switching the active
   manager. Use `manager use` only when nothing is running or awaiting review.

Read [references/workflow.md](references/workflow.md) for the full manager
protocol, state schema, prompt contract, scheduling rules, and worked command
examples.

For an optional ready-to-run local Pi worker configuration, read
[references/local-pi-example.md](references/local-pi-example.md).

## Reporting to the user

After a cycle, report which tasks were dispatched, each run directory, each
verification exit code, and what you accepted or rejected with the reason.
Never describe a worker's self-test as acceptance.
