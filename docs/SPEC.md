# agent-crew MVP Specification

Status: FROZEN for implementation

## Product goal

Build an installable Codex skill named `agent-crew`. It gives a project manager
agent a durable, agent-agnostic way to plan work, dispatch it to replaceable
worker agents, supervise execution, independently verify deliverables, accept
or reject work, and hand the project to another manager.

The implementation must work offline and must not require third-party npm
packages. It must not depend on Codex-specific sub-agent APIs. Pi, Codex,
Claude Code, or another CLI agent can be used through command templates.

## Required deliverables

```text
agent-crew/
  skill/agent-crew/
    SKILL.md
    agents/openai.yaml
    scripts/crew.js
    references/workflow.md
  docs/SPEC.md
  test/acceptance.test.js
  package.json
```

The skill directory is the installable unit. `scripts/crew.js` is the
zero-dependency CLI. `references/workflow.md` documents the manager protocol
and command examples.

## Core model

- A project has exactly one active manager at a time.
- Managers are identities that can sign off or reject work. A manager can be
  replaced with `handoff`, which records the transfer before changing the
  active manager.
- Workers are configured independently from tasks. A worker has an id, label,
  role, command template, timeout, and optional environment variables.
- Tasks form a directed acyclic graph through `needs`.
- A task can be assigned to exactly one worker.
- A task declares write scopes. Two simultaneously running tasks with
  overlapping scopes are not allowed.
- Worker completion moves a task to `review`, never to `accepted`.
- A manager must run an independent verification command and explicitly accept
  the task. A passing worker exit code is not acceptance.
- Every run, verification, rejection, acceptance, and handoff is persisted in
  `.agent-crew/`.

## State layout

`init` creates this layout under the project root:

```text
.agent-crew/
  project.json
  runs/
  handoffs/
```

`project.json` must be valid JSON and contain at least:

```json
{
  "version": 1,
  "name": "example",
  "activeManager": "codex",
  "managers": {
    "codex": {
      "id": "codex",
      "label": "Codex"
    }
  },
  "agents": {},
  "tasks": {}
}
```

Task records must preserve:

- `id`, `title`, optional `description`
- `assignee`
- `needs` (array of task ids)
- `writes` (array of path prefixes or globs)
- `acceptance` with `command` (array of command tokens) and
  `timeoutSeconds`
- `status`: `pending`, `running`, `review`, `rework`, `accepted`, or `failed`
- `attempts`
- `runs` and `verifications` arrays
- acceptance metadata when accepted

## Command-line contract

All commands accept `--root <dir>`; the default is the current directory.
State-changing commands must return exit code `0` on success and non-zero on
validation or execution failure. `--json` is supported for `status`, `run`,
`task list`, and `validate`.

### Initialization

```text
crew.js init --root <dir> --name <name>
```

Creates `.agent-crew/`, the default manager `codex`, and the state directories.
Initialization must be idempotent only when the state file does not already
exist; do not silently overwrite an existing project.

### Managers

```text
crew.js manager add --id <id> --label <label>
crew.js manager use --id <id>
crew.js handoff --to <id> [--note <text>]
```

`manager use` changes the active manager without a handoff only when there is
no task in `review`, `running`, or `rework`. Otherwise it must fail and direct
the user to `handoff`. `handoff` writes a Markdown snapshot in
`.agent-crew/handoffs/`, changes `activeManager`, and records the transfer.

### Workers

```text
crew.js agent add --id <id> --label <label> --role <role> \
  --command-json '<json array>' [--timeout <seconds>] [--env-json '<json object>']
crew.js agent list
```

The command is an argv array, not a shell string. Supported placeholders:
`{prompt}`, `{promptFile}`, `{projectRoot}`, `{taskId}`, `{runDir}`,
`{stateDir}`, and `{agentId}`. Placeholders are replaced in each argv token.
Unknown placeholders must fail validation before spawning.

### Tasks

```text
crew.js task add --id <id> --title <title> [--description <text>] \
  --assignee <agent-id> [--needs <id>] [--writes <path>] \
  --accept-json '<json array>' [--accept-timeout <seconds>]
crew.js task list
```

`--needs` and `--writes` are repeatable. `task add` must reject unknown
dependencies, self-dependencies, and cycles. It must reject an unknown
assignee. A task without an acceptance command is invalid.

### Execution

```text
crew.js run [--max-parallel <n>] [--task <id>] [--dry-run] [--json]
```

`run` computes eligible tasks whose dependencies are all `accepted` and whose
status is `pending` or `rework`. It must not run tasks in `review`, `running`,
`accepted`, or `failed` without an explicit rejection/rework transition.

Eligible tasks are scheduled in dependency order, up to `--max-parallel`
(default 1). Tasks whose write scopes overlap must not run concurrently.
`--dry-run` returns the plan and does not change state.

Worker commands and manager acceptance commands run with the project root as
their working directory.

For each task, create a unique run directory, write the worker prompt, capture
stdout/stderr, and record exit code and timing. On exit code `0`, set status to
`review`; otherwise set status to `failed`. Worker completion must not accept a
task. Each run record must include `dir`, `exitCode`, `startedAt`, and
`finishedAt`.

### Verification and sign-off

```text
crew.js verify <task-id> [--manager <id>]
crew.js accept <task-id> [--manager <id>] [--note <text>] [--evidence <path>]
crew.js reject <task-id> --manager <id> --note <text>
```

`verify` requires a task in `review`, a valid manager, and a configured
acceptance command. It runs the command from the project root, stores the
acceptance log and exit code, and records the verification. A failed
verification must not accept the task.

`accept` requires a task in `review`, a valid manager, at least one passing
verification for the task, and all explicitly supplied evidence paths to exist
inside the project root. It records the manager, note, evidence, timestamp, and
sets status to `accepted`.

`reject` requires a task in `review`, a valid manager, and a non-empty note. It
sets status to `rework`, records the rejection, and makes the task eligible for
another run. A worker must not be able to accept or reject its own task through
the manager identity.

Verification, acceptance, and rejection must use the active manager. If
`--manager` is supplied, it must match `activeManager`; otherwise the command
fails.

### Inspection

```text
crew.js status [--json]
crew.js validate [--json]
```

`status` reports active manager, worker count, and task states. `validate`
checks JSON shape, dependency cycles, assignees, command templates, and write
scope declarations without mutating state.

Machine-readable JSON shapes:

```json
// run --dry-run --json
{"dryRun":true,"plan":[{"task":"build","assignee":"pi"}]}
```

```json
// run --json (non-dry-run)
{"dryRun":false,"results":[{"task":"build","assignee":"pi","exitCode":0,"status":"review"}]}
```

```json
// status --json
{"project":"example","activeManager":"codex","agents":1,
 "tasks":{"build":{"status":"pending","assignee":"pi"}}}
```

```json
// validate --json
{"valid":true,"errors":[]}
```

## Prompt contract for workers

The generated worker prompt must include:

- project root and task id
- assigned worker and role
- task title and description
- accepted dependencies
- write scopes
- acceptance command
- instruction to make changes only within declared write scopes
- instruction to report changed files, commands run, tests, and limitations
- instruction that self-tests do not constitute manager acceptance

## Safety and determinism

- Never use `shell: true`; spawn argv arrays directly.
- Reject command templates containing unknown placeholders.
- Resolve evidence paths and reject paths outside the project root.
- Treat a worker exit code of zero as completion for review only.
- Use atomic state writes where practical, or write to a temporary file and
  rename it.
- Do not modify unrelated projects.
- All human-readable output must be concise and deterministic enough for tests.

## Acceptance criteria

The implementation is accepted only when all of the following are true:

1. `init` creates the required state layout and is safe on repeat.
2. Managers and workers can be added and replaced.
3. Task graph validation rejects unknown dependencies, self-dependencies, and
   cycles.
4. A dependent task is not eligible before its dependency is accepted.
5. Write-scope conflicts prevent concurrent scheduling.
6. A real child process can complete a task and move it to `review`.
7. `verify` records a passing or failing independent check.
8. `accept` is blocked without a passing verification and evidence.
9. `reject` returns a task to `rework`, and a subsequent run is possible.
10. `handoff` writes a snapshot and transfers sign-off authority.
11. `validate` and `status` produce valid JSON with `--json`.
12. The skill validates with the skill-creator validator and contains no
    unfinished placeholders.

The project manager owns this specification and the acceptance test. The
implementation agent must not edit `test/acceptance.test.js`.
