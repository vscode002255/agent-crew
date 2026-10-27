# Agent Crew manager protocol

Reference for the manager agent driving `scripts/crew.js`. The CLI is
zero-dependency CommonJS and requires Node.js 20 or newer.

```bash
CREW="node <skill>/scripts/crew.js"
```

Every command accepts `--root <dir>` (default: current directory) and prints
concise single-line results. State-changing commands exit `0` on success and
non-zero on validation or execution failure, with the reason on stderr.

## 1. Durable state

`init` creates:

```text
<root>/.agent-crew/
  project.json
  runs/
  handoffs/
```

`project.json` is the source of truth and is written atomically (temporary file
plus rename). Its shape:

```json
{
  "version": 1,
  "name": "example",
  "activeManager": "codex",
  "managers": { "codex": { "id": "codex", "label": "Codex" } },
  "agents": {
    "pi": {
      "id": "pi",
      "label": "Pi",
      "role": "implementer",
      "command": ["pi", "-p", "{prompt}"],
      "timeoutSeconds": 600,
      "env": {}
    }
  },
  "tasks": {
    "build": {
      "id": "build",
      "title": "Build the parser",
      "description": "optional",
      "assignee": "pi",
      "needs": [],
      "writes": ["src/parser"],
      "acceptance": {
        "command": ["node", "--test", "test/parser.test.js"],
        "timeoutSeconds": 60
      },
      "status": "pending",
      "attempts": 0,
      "runs": [],
      "verifications": [],
      "rejections": [],
      "assignments": []
    }
  },
  "handoffs": []
}
```

Statuses: `pending`, `running`, `review`, `rework`, `accepted`, `failed`.

Each `runs[]` entry carries `dir`, `exitCode`, `startedAt`, `finishedAt`,
`durationMs`, `attempt`, `agentId`, `command`, `promptFile`, `stdoutFile`,
`stderrFile`, and `timedOut`. Each `verifications[]` entry carries `manager`,
`command`, `exitCode`, `passed`, `dir`, `logFile`, `startedAt`, `finishedAt`,
`durationMs`, and `timedOut`.

An accepted task additionally holds `acceptedBy`, `acceptedAt`, `acceptedNote`,
`evidence`, and `acceptanceRecord`.

Each `assignments[]` entry carries `from`, `to`, `note`, and `at`. The array is
created on the first reassignment and is exposed by `task list --json` when
present.

Run directories are unique per attempt (`runs/<task>-XXXXXX/`) and contain
`prompt.md`, `stdout.log`, and `stderr.log`. Verification directories are
`runs/verify-<task>-XXXXXX/` and contain `acceptance.log`.

## 2. Commands

### Initialization

```bash
$CREW init --root <dir> --name <name>
```

Creates `.agent-crew/`, the default manager `codex`, `runs/`, and `handoffs/`.
If `project.json` already exists the command fails instead of overwriting.

### Managers

```bash
$CREW manager add --id <id> --label <label>
$CREW manager use --id <id>
$CREW manager list
$CREW handoff --to <id> [--note <text>]
```

- `manager use` is allowed only when no task is `running`, `review`, or
  `rework`; otherwise it fails and points at `handoff`.
- `handoff` writes `.agent-crew/handoffs/<timestamp>-<from>-to-<to>.md`, appends
  a record to `project.handoffs`, then sets `activeManager`. The snapshot
  contains the transfer metadata, the full task table, and an incoming-manager
  checklist. Authority moves at the moment the snapshot is written.

### Workers

```bash
$CREW agent add --id <id> --label <label> --role <role> \
  --command-json '["pi","-p","{prompt}"]' \
  [--timeout <seconds>] [--env-json '{"KEY":"value"}']
$CREW agent list
```

- The command is a JSON array of argv tokens; it is spawned directly with
  `shell: false`. Never pass a shell string.
- Placeholders: `{prompt}`, `{promptFile}`, `{projectRoot}`, `{taskId}`,
  `{runDir}`, `{stateDir}`, `{agentId}`. Substitution happens per token, so a
  token may mix literal text and placeholders.
- Any other `{...}` token fails validation before spawning.
- `--timeout` defaults to 600 seconds.
- `--env-json` merges into the child environment. The CLI also injects
  `AGENT_CREW_TASK_ID`, `AGENT_CREW_AGENT_ID`, `AGENT_CREW_RUN_DIR`, and
  `AGENT_CREW_PROMPT_FILE`.

### Tasks

```bash
$CREW task add --id <id> --title <title> [--description <text>] \
  --assignee <agent-id> [--needs <id>]... [--writes <path>]... \
  --accept-json '["node","--test"]' [--accept-timeout <seconds>]
$CREW task list [--json]
$CREW task assign <task-id> --assignee <agent-id> [--note <text>]
$CREW task reset --id <id> [--note <text>]
```

`task add` rejects duplicate ids, unknown assignees, unknown or self
dependencies, dependency cycles, absolute or escaping write scopes, and
missing, empty, or unknown-placeholder acceptance commands. `--needs` and
`--writes` are repeatable. `--accept-timeout` defaults to 60 seconds.

`task assign` moves a task to another worker. It validates the task id and the
new assignee, and only accepts tasks in `pending`, `rework`, or `failed`.
Tasks in `running`, `review`, or `accepted` are refused with a message that
points at the reject/reset step needed first. On success it sets `assignee`,
appends `{from, to, note, at}` to `assignments`, and leaves the status alone
except for `failed`, which becomes `pending` so the replacement worker can run.
`rework` stays `rework`, so the next `run` picks the task up immediately.
Reassigning to the current assignee is refused. `task list --json` includes the
`assignments` array when a task has history.

`task reset` is the only transition out of `failed`. It requires a failed task
and sets it back to `pending`; use `reject` for tasks in `review`.

Write scopes are path prefixes or globs relative to the project root.
Normalization strips a trailing `/*` or `/**` and trailing slashes. Two scopes
conflict when they are equal or one is a path-prefix ancestor of the other
(`src` overlaps `src/parser`).

### Execution

```bash
$CREW run [--max-parallel <n>] [--task <id>] [--dry-run] [--json]
```

Eligibility: status is `pending` or `rework` **and** every dependency is
`accepted`. Tasks in `review`, `running`, `accepted`, or `failed` are never
picked up; a rejected task must go through `reject` to become `rework`.

Scheduling:

- Up to `--max-parallel` (default `1`) tasks run at once.
- A task whose write scopes overlap any active task is deferred, so a later
  non-conflicting task may start ahead of it.
- The scheduler loops until the eligible set is drained, re-evaluating after
  each completion, so a task deferred by a scope conflict runs once the
  conflicting task finishes.
- `--dry-run` prints the plan and changes nothing.

Per task the CLI writes `prompt.md`, spawns the worker with the project root as
cwd, captures stdout/stderr to the run directory, and records exit code and
timing. Exit `0` → `review`; any other exit → `failed`. A timeout is recorded
as exit `124`; a spawn failure as `127`.

If a task is found in `running` when a new `run` starts, the previous process
died without recording a completion. The CLI marks such tasks `failed` and
warns on stderr rather than silently re-running them or letting their write
scopes block the whole queue. Use `task reset` to retry.

`--task <id>` restricts the run to one task and fails when that task is not
eligible.

### Verification and sign-off

```bash
$CREW verify <task-id> [--manager <id>]
$CREW accept <task-id> [--manager <id>] [--note <text>] [--evidence <path>]...
$CREW reject <task-id> --manager <id> --note <text>
```

- `verify` requires status `review`, a configured acceptance command, and a
  valid manager. It runs the command from the project root, writes
  `acceptance.log`, appends a verification record, and leaves the status at
  `review`. A non-zero exit fails the command and the task stays in `review`.
- `accept` requires status `review`, a valid manager, the most recent
  verification to have passed, and every `--evidence` path to exist inside the
  project root. It records manager, note, evidence, timestamp, and sets
  `accepted`.
- `reject` requires status `review`, a valid manager, and a non-empty note. It
  appends a rejection, clears acceptance metadata, and sets `rework`.
- All three use `activeManager`. `--manager` must match it, or the command
  fails; the fix is `handoff`, not a silent switch.
- A manager that is also the task assignee cannot accept or reject that task.

### Inspection

```bash
$CREW status [--json]
$CREW validate [--json]
```

`status --json` emits compact JSON:

```json
{"project":"example","activeManager":"codex","agents":1,"tasks":{"build":{"status":"pending","assignee":"pi"}}}
```

`run --dry-run --json`:

```json
{"dryRun":true,"plan":[{"task":"build","assignee":"pi"}]}
```

`run --json`:

```json
{"dryRun":false,"results":[{"task":"build","assignee":"pi","exitCode":0,"status":"review"}]}
```

`validate --json`:

```json
{"valid":true,"errors":[]}
```

`validate` checks JSON parseability, version, name, manager definitions and the
active manager, agent shape and command templates, task shape, statuses,
assignees, dependency existence and cycles, write-scope declarations, and
acceptance commands. It never mutates state. Without `--json` it prints `valid`
or each error to stderr with exit code `1`.

## 3. Worker prompt contract

`prompt.md` always includes:

- project root and task id
- assigned worker id, label, and role
- task title and description
- accepted dependencies with their statuses
- write scopes, plus the instruction to change nothing outside them
- the acceptance command and its timeout
- a reporting checklist: changed files, commands run, tests and results,
  limitations
- an explicit statement that self-tests and a zero exit code are not manager
  acceptance, and that `.agent-crew/` must not be edited by the worker

## 4. Worked example

```bash
$CREW init --root ./demo --name demo
$CREW manager add --root ./demo --id pi --label Pi

$CREW agent add --root ./demo --id pi-worker --label "Pi Worker" \
  --role implementer --command-json '["pi","-p","{prompt}"]' --timeout 900

$CREW agent add --root ./demo --id codex-worker --label "Codex Worker" \
  --role reviewer --command-json '["codex","exec","--full-auto","{prompt}"]'

$CREW task add --root ./demo --id schema --title "Define schema" \
  --assignee codex-worker --writes docs/schema.md \
  --accept-json '["node","-e","require(\"fs\").accessSync(\"docs/schema.md\")"]'

$CREW task add --root ./demo --id api --title "Implement API" \
  --assignee pi-worker --needs schema --writes src/api \
  --accept-json '["node","--test","test/api.test.js"]'

$CREW run --root ./demo --dry-run --json
$CREW run --root ./demo --max-parallel 2 --json
$CREW verify --root ./demo schema
$CREW accept --root ./demo schema --note "Schema reviewed" --evidence docs/schema.md
$CREW run --root ./demo --json
$CREW verify --root ./demo api
$CREW accept --root ./demo api --note "Tests green, reviewed diff"

$CREW handoff --root ./demo --to pi --note "Pi owns delivery from here"
$CREW status --root ./demo --json
$CREW validate --root ./demo --json
```

Typical loop when a deliverable falls short:

```bash
$CREW verify --root ./demo api          # exits non-zero, task stays in review
$CREW reject --root ./demo api --manager pi --note "Missing error-path tests"
$CREW run --root ./demo --task api --json   # attempts increments
```

Recovering from a crashed worker process:

```bash
$CREW run --root ./demo --json          # marks orphaned `running` tasks failed
$CREW task reset --root ./demo --id api --note "Retry after crash"
$CREW run --root ./demo --task api --json
```

Handing a task to a different worker:

```bash
# pending task: assign directly
$CREW task assign --root ./demo schema --assignee pi-worker --note "Pi owns the schema"

# review/rework work: close the review loop first, then reassign
$CREW reject --root ./demo api --manager pi --note "Try the other worker"
$CREW task assign --root ./demo api --assignee codex-worker --note "Needs a fresh pass"
$CREW run --root ./demo --task api --json

# failed task: assign moves it back to pending in one step
$CREW task assign --root ./demo api --assignee pi-worker --note "Replace the failing worker"
```

## 5. Failure handling

| Symptom | Meaning | Action |
| --- | --- | --- |
| `Project already initialized` | `project.json` exists | Do not re-init; use the existing project |
| `Cannot switch manager while tasks are ...` | Live work needs an owner | `handoff --to <id>` |
| `Manager X is not the active manager` | `--manager` disagrees with state | Hand off first, or drop `--manager` |
| `not eligible to run (status failed)` | Failed tasks are terminal | `task reset --id <id>` or `task assign` to retry |
| `cannot be reassigned` | Task is `running`, `review`, or `accepted` | `reject` (review) or `task reset` (failed) first |
| `already assigned to <agent>` | No-op reassignment | Pick a different `--assignee` |
| `Independent verification failed` | Acceptance command exited non-zero | Read `acceptance.log`, fix, re-run worker |
| `has no passing verification` | `accept` before `verify` | Run `verify` first |
| `Path is outside the project root` | Evidence path escapes the root | Move evidence inside the project |
| exit `124` in a run record | Worker exceeded its timeout | Raise `--timeout` or fix the worker command |

## 6. Safety rules

- Child processes are always spawned from argv arrays; `shell: true` is never
  used, so tokens containing `;`, `&&`, or spaces stay literal arguments.
- Unknown placeholders are rejected at `agent add`, `task add`, `verify`, and
  `validate` time — before anything spawns.
- Evidence paths are resolved and must stay inside the project root.
- A zero worker exit code means "ready for review", nothing more.
- `validate` is read-only and safe to run at any time.
- Nothing outside the target project root is read or written.
