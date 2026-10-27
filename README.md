# agent-crew

Manager/worker orchestration for replaceable CLI agents.

`agent-crew` gives a main agent a durable way to plan work, delegate tasks,
supervise execution, independently verify deliverables, and accept or reject
them with an auditable record. It does not depend on any vendor's sub-agent API.

[中文简介](#中文简介)

## Why

Multi-agent systems often confuse "the worker finished" with "the work is
accepted". `agent-crew` separates those two events:

```text
worker exit 0  ->  review
manager verify ->  accept or reject
```

A worker can never sign off its own task. A failed task can be reassigned, and
the old attempt, reason, logs, and exit code remain in the project state.

## Features

- Replaceable manager identity with handoff snapshots
- Replaceable worker pool
- Parallel execution
- Task dependency graph with cycle detection
- Write-scope conflict control
- Independent acceptance commands
- Explicit `accept`, `reject`, and `rework` gates
- Durable state, logs, exit codes, and evidence
- Zero third-party runtime dependencies

## Requirements

- Node.js 20 or newer
- Any CLI agent that can accept a prompt as an argv token

## Install

Download the latest `agent-crew-*.zip` from GitHub Releases, or clone this
repository.

Copy the `skill/agent-crew` directory into the skills directory used by your
agent host. The exact directory depends on the host; `SKILL.md` is the skill
entrypoint.

No package installation is required. The CLI is a single CommonJS file:

```text
skill/agent-crew/scripts/crew.js
```

## Quick start

Initialize a project:

```bash
node skill/agent-crew/scripts/crew.js init --root ./demo --name demo
```

Register a worker. The command is a JSON argv array, not a shell string:

```bash
node skill/agent-crew/scripts/crew.js agent add \
  --root ./demo \
  --id worker \
  --label "Worker" \
  --role implementer \
  --command-json '["your-agent-cli","-p","{prompt}"]'
```

Create a task with an independent acceptance command:

```bash
node skill/agent-crew/scripts/crew.js task add \
  --root ./demo \
  --id implement \
  --title "Implement the requested feature" \
  --assignee worker \
  --writes src \
  --accept-json '["node","--test"]'
```

Plan, run, verify, and sign off:

```bash
node skill/agent-crew/scripts/crew.js run --root ./demo --dry-run --json
node skill/agent-crew/scripts/crew.js run --root ./demo --max-parallel 2 --json
node skill/agent-crew/scripts/crew.js verify --root ./demo implement
node skill/agent-crew/scripts/crew.js accept --root ./demo implement \
  --note "Independent tests passed and diff reviewed" \
  --evidence test-output.txt
```

## Replace a worker

List the worker pool:

```bash
node skill/agent-crew/scripts/crew.js agent list --root ./demo --json
```

Reassign a pending, rework, or failed task:

```bash
node skill/agent-crew/scripts/crew.js task assign \
  --root ./demo \
  implement \
  --assignee replacement-worker \
  --note "The first worker failed; reassigning the same task"
```

Running, review, and accepted tasks must be rejected or reset before
reassignment. This prevents old evidence from being mistaken for the new
worker's work.

## Replace the manager

```bash
node skill/agent-crew/scripts/crew.js manager add --root ./demo --id manager-b --label "Manager B"
node skill/agent-crew/scripts/crew.js handoff --root ./demo --to manager-b --note "Transfer sign-off authority"
```

The handoff writes a Markdown snapshot under `.agent-crew/handoffs/` before the
active manager changes.

## State layout

```text
.agent-crew/
  project.json
  runs/
  handoffs/
```

`project.json` is the source of truth. Do not edit it by hand.

## Security model

- Commands are spawned from argv arrays with `shell: false`.
- Unknown placeholders are rejected before spawning.
- Evidence paths must exist inside the project root.
- Evidence symlinks that resolve outside the project are rejected.
- Worker exit `0` means "ready for review", never "accepted".
- Write scopes are prompt constraints, not an operating-system sandbox.

See [references/workflow.md](skill/agent-crew/references/workflow.md) for the
full protocol and state schema.

## Testing

```bash
node --test
```

The repository includes acceptance tests covering the state machine, DAG
validation, write-scope scheduling, independent verification, reassignment, and
evidence containment.

## Publish a GitHub release

1. Create a public repository.
2. Push the repository to the `main` branch.
3. Create a tag such as `v0.1.0`.
4. Attach `dist/agent-crew-0.1.0.zip` to the GitHub Release.
5. Tell users to download the ZIP or use the repository source archive.

The release ZIP contains the installable `agent-crew` skill directory.

## 中文简介

`agent-crew` 是一套不绑定具体 Agent 的多 Agent 协作流程：

- 主 Agent 担任项目经理，负责拆任务、调度、监督和签字
- 员工 Agent 负责实施，可以自由更换
- 多个员工可以并行，也可以按依赖顺序执行
- 员工失败后，同一任务可以改派
- 项目经理也可以更换，交接时自动保存快照
- 员工完成只进入 `review`
- 项目经理独立验收后，才能 `accept`

核心原则：员工可以换，经理可以换，但验收权必须独立。

## License

MIT
