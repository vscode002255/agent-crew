# agent-crew implementation report

Status: complete. All 14 acceptance tests pass (`node --test`, 0 fail, 0 skipped).
`docs/SPEC.md`, `test/acceptance.test.js`, `package.json`, and
`skill/agent-crew/SKILL.md` were not modified in any rework round.

## Changed files

Original build:

| File | Purpose |
| --- | --- |
| `skill/agent-crew/SKILL.md` | Skill entrypoint: purpose, operating invariants, manager workflow, progressive link to the reference |
| `skill/agent-crew/agents/openai.yaml` | UI metadata (`display_name`, `short_description`, `brand_color`, `default_prompt`) and implicit-invocation policy |
| `skill/agent-crew/scripts/crew.js` | Zero-dependency CommonJS CLI (single file, `node:*` builtins only) |
| `skill/agent-crew/references/workflow.md` | Full manager protocol: state schema, all commands, scheduling and scope rules, prompt contract, worked example, failure table, safety rules |
| `release/IMPLEMENTATION_REPORT.md` | This report |

Rework round touched exactly two files:

| File | Change |
| --- | --- |
| `skill/agent-crew/scripts/crew.js` | Defect 1 fix (`validate --json` exit status), Defect 2 fix (canonical evidence containment), plus the falsy-JSON guard found while re-probing |
| `release/IMPLEMENTATION_REPORT.md` | This rewrite |

Reassignment round touched exactly three files:

| File | Change |
| --- | --- |
| `skill/agent-crew/scripts/crew.js` | New `task assign` command, `assignments` history, `task list --json` exposure, usage text |
| `skill/agent-crew/references/workflow.md` | Task command reference, `assignments` schema, worked reassignment examples, failure table |
| `release/IMPLEMENTATION_REPORT.md` | This section and the refreshed test results |

## Defects found and fixed

### Defect 1 — `validate --json` exited 0 for invalid state

**Symptom.** `cmdValidate` printed `{"valid":false,"errors":[...]}` and then
returned without setting `process.exitCode`. A caller that gated on the exit
status — the normal shell/CI contract, and what `test/acceptance.test.js`
asserts — saw success on a project whose state was unparseable or structurally
invalid. The JSON body was right; the process contract was wrong.

**Fix.** `cmdValidate` now sets `process.exitCode = 1` whenever `valid` is
false, on both the `--json` and the human-readable path. The JSON body is still
written to stdout (and is still the only stdout on `--json`), so machine
callers can read `{valid, errors}` *and* branch on the status. The
human-readable path continues to write each error to stderr.

**Related hole found while re-probing.** The first version of the fix kept a
`if (project)` truthiness test around the parsed document. JSON literals that
parse successfully but are falsy — `null`, `false`, `0`, `""` — therefore
skipped structural validation entirely and were reported as
`{"valid":true,"errors":[]}` with exit 0. The parse step now tracks a separate
`parsed` boolean, so parse success and document truthiness are independent, and
every non-object document is reported as
`project.json must contain a JSON object` with exit 1.

**Probe (current behavior).**

```text
project.json=null      -> exit=1 {"valid":false,"errors":["project.json must contain a JSON object"]}
project.json=false     -> exit=1 {"valid":false,"errors":["project.json must contain a JSON object"]}
project.json=0         -> exit=1 {"valid":false,"errors":["project.json must contain a JSON object"]}
project.json=""        -> exit=1 {"valid":false,"errors":["project.json must contain a JSON object"]}
project.json=[]        -> exit=1 {"valid":false,"errors":["project.json must contain a JSON object"]}
project.json={bad json -> exit=1 {"valid":false,"errors":["project.json is not valid JSON: Expected property name or '}' in JSON at position 1 (line 1 column 2)"]}
project.json={}        -> exit=1 {"valid":false,"errors":["version must be 1","name must be a non-empty string",...]}
```

### Defect 2 — evidence containment was lexical only

**Symptom.** `accept --evidence` resolved the candidate with `path.resolve` and
compared the result to the root with `path.relative`. That rejects `../`
escapes and absolute paths, but a symlink *inside* the project pointing at a
file *outside* it passes the lexical check while the evidence actually lives
outside the project. The spec requires evidence paths to "exist inside the
project root", so the check was unsound: a worker could plant a link and have
out-of-project content signed off.

**Fix.** `resolveEvidence` performs two checks instead of one:

1. lexical containment of `path.resolve(root, candidate)` (unchanged, keeps the
   cheap `../` and absolute-path rejections with their specific messages), then
2. canonical containment: `fs.realpathSync` on both the project root and the
   candidate, and `isInside(canonicalRoot, canonicalTarget)`.

`realpathSync` resolves symlinks, junctions, and Windows short/long-name
aliases, so the comparison is between two fully resolved paths. Non-existent
paths are rejected first with `Evidence path does not exist`, so `realpathSync`
never runs on a missing target and a dangling link cannot be used to leak the
existence of outside files through a different error message.

**Probe (current behavior).** Every escape attempt fails closed; legitimate
in-project paths still succeed.

```text
A symlink file -> outside      exit=1  Evidence path resolves outside the project root: linked.txt (real path D:\Temp\crew-outside-*.txt)
B absolute outside             exit=1  Path is outside the project root: D:\Temp\crew-outside-*.txt
C lexical ../ escape           exit=1  Path is outside the project root: ../crew-outside-*.txt
D symlinked dir -> outside     exit=1  Evidence path resolves outside the project root: sub/link/crew-outside-*.txt (real path D:\Temp\crew-outside-*.txt)
E symlink inside root          exit=0  accepted build by codex
F plain inside root            exit=0  accepted build by codex
G chained symlink -> outside   exit=1  Evidence path resolves outside the project root: hop2.txt (real path D:\Temp\crew-out-*.txt)
H broken symlink               exit=1  Evidence path does not exist: broken.txt
L symlink dir then `..`        exit=1  Evidence path does not exist: ext/../secret.txt
N evidence "." (the root)      exit=0  accepted build by codex
O inside symlink recorded as   ["alias2.txt"]  (lexical, in-project name)
P symlink -> root itself       exit=0  accepted build by codex
```

Cases E, F, N, O, and P matter as much as the failures: the fix must not reject
evidence that legitimately lives inside the project, including through an
in-project alias, and it does not.

## Worker reassignment (`task assign`)

### Contract

```bash
crew.js task assign <task-id> --assignee <agent-id> [--note <text>]
```

The task id is a positional argument after the `assign` subcommand; `--id` is
also accepted so the command stays consistent with `task reset`. `--assignee`
is required, `--note` is optional and defaults to the empty string.

Validation order and behavior:

1. Load state and resolve the task. An unknown id fails with
   `Unknown task <id>`.
2. Resolve the assignee. A malformed id fails as `Invalid assignee <id>` and a
   well-formed but unconfigured id fails as `Unknown assignee <id>`, matching
   the wording `task add` already uses.
3. Refuse a no-op reassignment (`already assigned to <agent>`), so history is
   not polluted with zero-length moves.
4. Refuse any status outside `pending`, `rework`, `failed`.

### Status gating

| Status | Reassignment | Resulting status |
| --- | --- | --- |
| `pending` | allowed | stays `pending` |
| `rework` | allowed | stays `rework` (still eligible for the next `run`) |
| `failed` | allowed | becomes `pending` so the replacement worker can run |
| `running` | refused | — |
| `review` | refused | — |
| `accepted` | refused | — |

The refusal message is actionable and names the fix for the current state, for
example:

```text
crew: Task build is review and cannot be reassigned. Only pending, rework, or
failed tasks can be reassigned. If work is in review, reject or reset it first:
"crew.js reject build --note <text>" (review) or "crew.js task reset --id build"
(failed), then assign again.
```

This keeps the sign-off gate intact: a manager cannot swap the worker out from
under a deliverable that is awaiting verification, and cannot re-open accepted
work by reassignment. Closing the review loop (`reject` → `rework`) is the only
path from `review` to a reassignable state.

### History record

On success the task keeps its `assignee` field updated and appends to
`assignments[]`:

```json
{"from":"first","to":"second","note":"Second worker has the right context","at":"2026-01-01T00:00:00.000Z"}
```

`from` is the previous assignee, `to` the new one, `note` the raw `--note`
value (empty string when omitted), and `at` an ISO-8601 UTC timestamp. The
array is created lazily, so tasks that were never reassigned keep their
existing shape and `validate` sees no new required field.

`task list --json` adds an `assignments` key only when the array exists and is
non-empty. The default task-list JSON is therefore byte-identical to before for
untouched tasks, which keeps the existing deterministic-JSON expectations
valid.

### Interaction with the rest of the CLI

- `run` needs no change: `rework` was already eligible and `failed` → `pending`
  is exactly the transition `task reset` performs, so a reassigned failed task
  is scheduled on the next `run` and `attempts` increments normally.
- Write-scope scheduling, dependency gating, verification, and acceptance are
  unaffected; reassignment only changes who runs the task.
- `manager use` still blocks while a task is `running`, `review`, or `rework`;
  reassignment does not bypass the handoff requirement.
- The state write goes through `saveProject`, so the update is atomic.

### Probes

```text
pending  first -> second   exit=0  task assigned build: first -> second; status pending
rework   first -> second   exit=0  status stays rework; next run picks it up
failed   broken -> working exit=0  status pending; next run exits 0 -> review, attempts=2
review   first -> second   exit=1  ... reject or reset it first ...
running  first -> second   exit=1  same gate
accepted first -> second   exit=1  same gate
unknown assignee           exit=1  Unknown assignee missing
unknown task               exit=1  Unknown task nope
same assignee              exit=1  Task build is already assigned to first
```

## Test results

```text
$ node --test
✔ initializes the required durable layout and refuses overwrite
✔ replaces managers and requires a handoff while work awaits review
✔ validates dependencies, cycles, assignees, and acceptance commands
✔ runs eligible work, verifies independently, and gates acceptance
✔ blocks acceptance on failed verification and supports evidence paths
✔ rejects into rework and allows another run
✔ lists workers and safely reassigns tasks
✔ reassignment is blocked while running or awaiting review
✔ failed tasks can be reassigned and retried
✔ respects dependencies and overlapping write scopes
✔ returns deterministic status and validation JSON
✔ uses non-zero exit status for invalid JSON validation
✔ rejects unsafe command placeholders and evidence outside the project
✔ rejects evidence symlinks that resolve outside the project
ℹ tests 14   ℹ pass 14   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

The three reassignment tests are the new ones: happy-path reassignment plus
`task list`/dry-run visibility, the review/running gate followed by
`reject` → `assign` landing in `rework`, and `failed` → `assign` → `pending` →
re-run reaching `review` with `attempts` at 2. `node --check
skill/agent-crew/scripts/crew.js` is clean.

## Test results (first round)

```text
$ node --test
✔ initializes the required durable layout and refuses overwrite (146ms)
✔ replaces managers and requires a handoff while work awaits review (716ms)
✔ validates dependencies, cycles, assignees, and acceptance commands (485ms)
✔ runs eligible work, verifies independently, and gates acceptance (711ms)
✔ blocks acceptance on failed verification and supports evidence paths (701ms)
✔ rejects into rework and allows another run (503ms)
✔ respects dependencies and overlapping write scopes (991ms)
✔ returns deterministic status and validation JSON (233ms)
✔ uses non-zero exit status for invalid JSON validation (119ms)
✔ rejects unsafe command placeholders and evidence outside the project (555ms)
✔ rejects evidence symlinks that resolve outside the project (521ms)
ℹ tests 11   ℹ pass 11   ℹ fail 0   ℹ cancelled 0   ℹ skipped 0   ℹ todo 0
```

The two tests that motivated this rework are the last two: the invalid-JSON case
asserts exit `1` and then parses `stdout` as JSON, and the symlink case asserts a
non-zero exit plus an `/outside|evidence|symlink/i` message. Both pass against
the current script. `node --check skill/agent-crew/scripts/crew.js` is clean.

Manual re-probes were run against throwaway temp projects outside the repo (the
tables above). Adjacent safety behavior was re-checked in the same pass and is
unchanged:

```text
unknown placeholder        exit=1  Agent bad command contains unknown placeholder {unknown}
shell metachar token       exit=0  child received the literal string "; rm -rf /" as one argv element
self-dependency            exit=1  Task s cannot depend on itself
escaping write scope       exit=1  Task e write scope ../out must not escape the project root
cycle via validate --json  exit=1  {"valid":false,"errors":["Dependency cycle detected: a -> b -> a"]}
accept without verify      exit=1  accept requires status review
```

## Implementation summary

`scripts/crew.js` is ~1570 lines of CommonJS using only `node:fs`,
`node:path`, and `node:child_process`.

**Parsing.** A single `parseArgs` handles `--flag value`, `--flag=value`,
boolean flags, and repeatable `--needs`, `--writes`, `--evidence`. Unknown
options, duplicate single-value options, and missing values fail with exit 1.

**State.** `<root>/.agent-crew/project.json` is the source of truth. Writes go
through `saveProject`, which writes `project.json.<pid>.<ts>.tmp` and
`fs.renameSync`s it, so a crash cannot leave a truncated state file. Missing
sub-objects are normalized on load; a missing project file produces an
actionable error instead of a stack trace.

**Processes.** `spawnCapture` calls
`spawn(argv[0], argv.slice(1), { cwd, env, shell: false, windowsHide: true })`.
There is exactly one `spawn` call site and no `shell: true` anywhere. stdout and
stderr are captured (bounded at 2 MB each), timeouts `SIGKILL` the child, and
`exitCode` is normalized: timeout → `124`, spawn failure → `127`.

**Placeholders.** `{prompt}`, `{promptFile}`, `{projectRoot}`, `{taskId}`,
`{runDir}`, `{stateDir}`, `{agentId}` are substituted per token. Any other
`{...}` sequence is rejected at `agent add`, `task add`, `verify`, and
`validate` — before spawning.

**Validation.** `task add` rejects duplicate ids, unknown assignees, unknown
and self dependencies, and cycles. Write scopes reject absolute paths,
drive-letter paths, and `..` segments. Acceptance commands must be non-empty
argv arrays with known placeholders. `validate` re-checks all of it plus
statuses, manager definitions, active manager, agent shape, env typing, and
cycles, returning `{valid, errors}` **and** exit 1 when invalid.

**Evidence containment.** Lexical containment first (fast, specific messages
for `../` and absolute paths), then canonical containment via `realpathSync` on
both root and target. Evidence is recorded under its lexical in-project path.

**Scheduling.** Eligibility is `pending`/`rework` with every dependency
`accepted`. The scheduler loop re-evaluates after each completion, so it can
defer a scope-conflicting task and start a later non-conflicting one, then pick
the deferred task up when the conflicting run finishes. Scope comparison
normalizes trailing `/*` and `/**`, then treats equal scopes and path-prefix
ancestors as overlapping. `--dry-run` computes the same plan and never writes.

**Sign-off gate.** Worker exit `0` → `review` only. `verify` requires `review`,
runs the acceptance command from the project root, writes
`runs/verify-<task>-XXXXXX/acceptance.log`, appends a verification record, and
exits non-zero on failure while leaving status at `review`. `accept` requires
`review`, a passing latest verification, and every evidence path to exist
inside the canonical root. `reject` requires `review` and a non-empty note,
clears acceptance metadata, and sets `rework`. All three resolve the active
manager and fail when `--manager` names a different manager, directing the
caller to `handoff`.

**Handoff.** Writes
`.agent-crew/handoffs/<ISO-timestamp>-<from>-to-<to>.md` containing transfer
metadata, the full task table, and an incoming-manager checklist, appends a
record to `project.handoffs`, then switches `activeManager`. `manager use`
refuses while any task is `running`, `review`, or `rework` and names `handoff`
in the error.

**Prompt.** `runs/<task>-XXXXXX/prompt.md` carries the project root, task id,
worker id/label/role, title, description, dependency statuses, write scopes,
the acceptance command and timeout, a changed-files/commands/tests/limitations
reporting checklist, and an explicit statement that self-tests are not
acceptance and that `.agent-crew/` is off limits.

## Acceptance criteria coverage

| # | Criterion | Where |
| --- | --- | --- |
| 1 | `init` layout, safe on repeat | `cmdInit`, refuses when `project.json` exists |
| 2 | Managers and workers added/replaced | `manager add/use/list`, `agent add/list`, `handoff` |
| 3 | Graph rejects unknown, self, cycles | `cmdTask` add checks + `findCycles` |
| 4 | Dependents ineligible before acceptance | `isEligible` requires `accepted` deps |
| 5 | Write-scope conflicts serialize | `scopesOverlap`, `conflictsWith`, scheduler loop |
| 6 | Real child process → `review` | `runTask` via `spawnCapture`, exit 0 → `review` |
| 7 | `verify` records pass/fail | `cmdVerify`, always appends a record |
| 8 | `accept` blocked without verify + evidence | `cmdAccept` verification and canonical-evidence checks |
| 9 | `reject` → `rework` → re-run | `cmdReject`, `attempts` increments on re-run |
| 10 | `handoff` snapshot + transfer | `cmdHandoff` writes Markdown then switches manager |
| 11 | `status`/`validate` valid JSON | `cmdStatus`, `cmdValidate` (JSON on stdout, exit 1 when invalid) |
| 12 | Skill validates, no placeholders | `quick_validate` equivalent passes; no TODO markers |

## Limitations

1. **Skill validator executed via a local equivalent.** The skill-creator
   `scripts/quick_validate.py` needs PyYAML, which is not installed in this
   environment (`ModuleNotFoundError: No module named 'yaml'`). Rather than
   install packages, the validator's rules were reimplemented in a throwaway
   Node script outside the repo: frontmatter presence and format, allowed keys,
   hyphen-case name ≤ 64 chars, description ≤ 1024 chars without angle
   brackets, no `[TODO:` in description or body, fence-aware body scan. It
   reports `Skill is valid!`. Running the canonical Python validator in an
   environment with PyYAML remains advisable.
2. **Canonical containment is symlink- and alias-aware, not inode-aware.** It
   defeats `../` escapes, absolute paths, symlinked files, symlinked
   directories, chained links, and Windows short names, and it fails closed on
   broken links. A **hard link** created inside the project that shares an inode
   with a file outside it is still accepted (probe Q), because `realpathSync`
   reports the in-project name and no inode/volume identity check is performed.
   Detecting that needs `stat`-based `dev`/`ino` comparison against a known
   outside set, which is out of scope for a path check. Evidence recording also
   keeps the lexical name, so an in-project alias is logged as the alias, not
   the resolved target.
3. **Single-host, single-process coordination.** There is no file locking. Two
   concurrent `crew.js` invocations against the same root can interleave reads
   and writes, and the last writer wins. Serialize manager commands yourself.
4. **Scope overlap is prefix-based, not glob-complete.** `src/*` and `src/**`
   collapse to `src`; arbitrary globs such as `**/*.ts` are compared textually.
   Overly broad or unusual globs may under- or over-report conflicts.
5. **No worker sandbox.** Write scopes are instructions in the prompt, not
   enforced constraints. A worker process can write anywhere the OS allows; the
   CLI records what it ran but does not confine it. This is precisely why
   evidence containment is enforced at sign-off rather than trusted at run time.
6. **`accept` trusts the latest verification.** Verification is not bound to a
   content hash, so a worker that mutates files after `verify` and before
   `accept` is not detected.
7. **Interrupted runs are recovered, not resumed.** A task found in `running`
   at the start of a new `run` is marked `failed` (with a stderr warning) and
   requires `task reset`; there is no resume of a partially completed attempt.
8. **Output capture is capped at 2 MB per stream**; the run record's
   `stdoutFile`/`stderrFile` will be truncated beyond that.
9. **Extra commands beyond the spec.** `task reset --id <id>` was added as the
   only transition out of `failed`, which the spec left undefined. `task assign`
   was added for worker reassignment, also unspecified. Both are additive and do
   not change any specified behavior; `task assign` supersedes `task reset` for
   the failed case because it moves the task to `pending` in the same step.
10. **Sign-off separation is limited to identity.** A worker is blocked from
    accepting/rejecting only when the active manager id equals the assignee id;
    the CLI cannot prove a human was involved.
11. **Duplicate `--evidence` values are recorded verbatim** (probe S:
    `["e1.txt","e1.txt"]`). Harmless, but the record is not de-duplicated.
12. **Timestamps use ISO-8601 UTC**; `status --json` and `validate --json` are
    compact (single-line) while `task list --json` and `agent list --json` are
    pretty-printed, matching the spec's exact shapes for the former.
