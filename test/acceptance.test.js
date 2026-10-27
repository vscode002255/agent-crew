const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const test = require("node:test");

const CLI = path.resolve(__dirname, "..", "skill", "agent-crew", "scripts", "crew.js");

function sandbox() {
  return fs.mkdtempSync(path.join(os.tmpdir(), "agent-crew-"));
}

function run(root, ...args) {
  const result = spawnSync(process.execPath, [CLI, ...args, "--root", root], {
    encoding: "utf8",
    timeout: 15000,
  });
  return {
    status: result.status,
    stdout: result.stdout.trim(),
    stderr: result.stderr.trim(),
  };
}

function json(root, ...args) {
  const result = run(root, ...args);
  assert.equal(result.status, 0, result.stderr || result.stdout);
  return JSON.parse(result.stdout);
}

function init(root, name = "demo") {
  const result = run(root, "init", "--name", name);
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function addAgent(root, id, command) {
  const result = run(
    root,
    "agent", "add",
    "--id", id,
    "--label", id.toUpperCase(),
    "--role", "implementer",
    "--command-json", JSON.stringify(command),
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function addTask(root, id, assignee, extra = []) {
  const result = run(
    root,
    "task", "add",
    "--id", id,
    "--title", `Task ${id}`,
    "--assignee", assignee,
    "--accept-json", JSON.stringify([process.execPath, "-e", "process.exit(0)"]),
    ...extra,
  );
  assert.equal(result.status, 0, result.stderr || result.stdout);
}

function state(root) {
  return JSON.parse(fs.readFileSync(path.join(root, ".agent-crew", "project.json"), "utf8"));
}

test("initializes the required durable layout and refuses overwrite", () => {
  const root = sandbox();
  init(root);
  const data = state(root);
  assert.equal(data.version, 1);
  assert.equal(data.name, "demo");
  assert.equal(data.activeManager, "codex");
  assert.ok(fs.existsSync(path.join(root, ".agent-crew", "runs")));
  assert.ok(fs.existsSync(path.join(root, ".agent-crew", "handoffs")));
  const again = run(root, "init", "--name", "demo");
  assert.notEqual(again.status, 0);
});

test("replaces managers and requires a handoff while work awaits review", () => {
  const root = sandbox();
  init(root);
  assert.equal(run(root, "manager", "add", "--id", "pi", "--label", "Pi").status, 0);
  assert.equal(run(root, "manager", "use", "--id", "pi").status, 0);
  assert.equal(state(root).activeManager, "pi");
  assert.equal(run(root, "manager", "use", "--id", "codex").status, 0);

  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "worker");
  assert.equal(json(root, "run", "--json").results[0].status, "review");
  const blocked = run(root, "manager", "use", "--id", "pi");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /handoff/i);

  const handoff = run(root, "handoff", "--to", "pi", "--note", "Pi takes review");
  assert.equal(handoff.status, 0, handoff.stderr || handoff.stdout);
  assert.equal(state(root).activeManager, "pi");
  assert.equal(fs.readdirSync(path.join(root, ".agent-crew", "handoffs")).length, 1);
});

test("validates dependencies, cycles, assignees, and acceptance commands", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "base", "worker");
  addTask(root, "child", "worker", ["--needs", "base"]);

  const missing = run(root, "task", "add", "--id", "bad", "--title", "Bad",
    "--assignee", "worker", "--needs", "missing",
    "--accept-json", JSON.stringify([process.execPath, "-e", "process.exit(0)"]));
  assert.notEqual(missing.status, 0);

  const self = run(root, "task", "add", "--id", "self", "--title", "Self",
    "--assignee", "worker", "--needs", "self",
    "--accept-json", JSON.stringify([process.execPath, "-e", "process.exit(0)"]));
  assert.notEqual(self.status, 0);

  const project = state(root);
  project.tasks.child.needs = ["cycle"];
  project.tasks.cycle = {
    id: "cycle",
    title: "Cycle",
    assignee: "worker",
    needs: ["child"],
    writes: [],
    acceptance: {
      command: [process.execPath, "-e", "process.exit(0)"],
      timeoutSeconds: 60,
    },
    status: "pending",
    attempts: 0,
    runs: [],
    verifications: [],
  };
  fs.writeFileSync(path.join(root, ".agent-crew", "project.json"),
    JSON.stringify(project, null, 2));
  const validation = run(root, "validate", "--json");
  assert.equal(validation.status, 1);
  const report = JSON.parse(validation.stdout);
  assert.equal(report.valid, false);
  assert.ok(report.errors.some((error) => /cycle/i.test(error)));
});

test("runs eligible work, verifies independently, and gates acceptance", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "worker", [process.execPath, "-e",
    "require('fs').writeFileSync('artifact.txt','done')"]);
  addTask(root, "build", "worker", ["--writes", "artifact.txt"]);

  const plan = json(root, "run", "--dry-run", "--json");
  assert.deepEqual(plan.plan, [{ task: "build", assignee: "worker" }]);
  assert.equal(state(root).tasks.build.status, "pending");

  const executed = json(root, "run", "--json");
  assert.equal(executed.results[0].status, "review");
  assert.equal(state(root).tasks.build.status, "review");
  assert.ok(fs.existsSync(path.join(root, "artifact.txt")));
  assert.ok(fs.readdirSync(path.join(root, ".agent-crew", "runs")).length >= 1);

  const premature = run(root, "accept", "build");
  assert.notEqual(premature.status, 0);

  const verified = run(root, "verify", "build");
  assert.equal(verified.status, 0, verified.stderr || verified.stdout);
  assert.equal(state(root).tasks.build.verifications.length, 1);
  assert.equal(state(root).tasks.build.status, "review");

  const accepted = run(root, "accept", "build", "--note", "Evidence reviewed");
  assert.equal(accepted.status, 0, accepted.stderr || accepted.stdout);
  assert.equal(state(root).tasks.build.status, "accepted");
  assert.equal(state(root).tasks.build.acceptedBy, "codex");
});

test("blocks acceptance on failed verification and supports evidence paths", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "worker");
  json(root, "run", "--json");

  const verify = spawnSync(process.execPath, [
    CLI, "verify", "build", "--root", root,
  ], { encoding: "utf8" });
  assert.equal(verify.status, 0, verify.stderr || verify.stdout);
  const accepted = run(root, "accept", "build", "--evidence", "missing.txt");
  assert.notEqual(accepted.status, 0);

  const project = state(root);
  project.tasks.build.acceptance.command = [process.execPath, "-e", "process.exit(1)"];
  fs.writeFileSync(path.join(root, ".agent-crew", "project.json"),
    JSON.stringify(project, null, 2));
  const failedVerify = run(root, "verify", "build");
  assert.notEqual(failedVerify.status, 0);
  const blocked = run(root, "accept", "build");
  assert.notEqual(blocked.status, 0);
});

test("rejects into rework and allows another run", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "worker");
  json(root, "run", "--json");
  const rejected = run(root, "reject", "build", "--note", "Needs another pass");
  assert.equal(rejected.status, 0, rejected.stderr || rejected.stdout);
  assert.equal(state(root).tasks.build.status, "rework");
  const again = json(root, "run", "--json");
  assert.equal(again.results[0].status, "review");
  assert.equal(state(root).tasks.build.attempts, 2);
});

test("lists workers and safely reassigns tasks", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "first", [process.execPath, "-e", "process.exit(0)"]);
  addAgent(root, "second", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "first");

  const agents = json(root, "agent", "list", "--json").agents;
  assert.deepEqual(agents.map((agent) => agent.id), ["first", "second"]);

  const assigned = run(root, "task", "assign", "build", "--assignee", "second",
    "--note", "Second worker has the right context");
  assert.equal(assigned.status, 0, assigned.stderr || assigned.stdout);
  const project = state(root);
  assert.equal(project.tasks.build.assignee, "second");
  assert.equal(project.tasks.build.assignments.length, 1);
  assert.equal(project.tasks.build.assignments[0].from, "first");
  assert.equal(project.tasks.build.assignments[0].to, "second");
  assert.match(project.tasks.build.assignments[0].note, /right context/);

  const plan = json(root, "run", "--dry-run", "--json");
  assert.deepEqual(plan.plan, [{ task: "build", assignee: "second" }]);

  const unknown = run(root, "task", "assign", "build", "--assignee", "missing");
  assert.notEqual(unknown.status, 0);
});

test("reassignment is blocked while running or awaiting review", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "first", [process.execPath, "-e",
    "setTimeout(() => process.exit(0), 300)"]);
  addAgent(root, "second", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "first");

  const running = run(root, "run", "--json");
  assert.equal(running.status, 0, running.stderr || running.stdout);
  assert.equal(state(root).tasks.build.status, "review");

  const blocked = run(root, "task", "assign", "build", "--assignee", "second");
  assert.notEqual(blocked.status, 0);
  assert.match(blocked.stderr, /reject|review|assign/i);
  assert.equal(state(root).tasks.build.assignee, "first");

  run(root, "reject", "build", "--note", "Try another worker");
  const reassigned = run(root, "task", "assign", "build", "--assignee", "second");
  assert.equal(reassigned.status, 0, reassigned.stderr || reassigned.stdout);
  assert.equal(state(root).tasks.build.assignee, "second");
  assert.equal(state(root).tasks.build.status, "rework");
});

test("failed tasks can be reassigned and retried", () => {
  const root = sandbox();
  init(root);
  addAgent(root, "broken", [process.execPath, "-e", "process.exit(3)"]);
  addAgent(root, "working", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "broken");

  const failed = json(root, "run", "--json");
  assert.equal(failed.results[0].status, "failed");

  const assigned = run(root, "task", "assign", "build", "--assignee", "working",
    "--note", "Replace the failing worker");
  assert.equal(assigned.status, 0, assigned.stderr || assigned.stdout);
  const project = state(root);
  assert.equal(project.tasks.build.assignee, "working");
  assert.equal(project.tasks.build.status, "pending");

  const retried = json(root, "run", "--json");
  assert.equal(retried.results[0].status, "review");
  assert.equal(state(root).tasks.build.attempts, 2);
});

test("respects dependencies and overlapping write scopes", () => {
  const root = sandbox();
  init(root);
  const slow = [process.execPath, "-e",
    "setTimeout(() => require('fs').writeFileSync('slow.txt','ok'), 120)"];
  const fast = [process.execPath, "-e",
    "require('fs').writeFileSync('fast.txt','ok')"];
  addAgent(root, "slow", slow);
  addAgent(root, "fast", fast);
  addTask(root, "base", "slow", ["--writes", "shared"]);
  addTask(root, "child", "fast", ["--needs", "base", "--writes", "child.txt"]);
  addTask(root, "parallel", "fast", ["--writes", "other.txt"]);

  const first = json(root, "run", "--max-parallel", "2", "--json");
  assert.deepEqual(first.results.map((item) => item.task), ["base", "parallel"]);
  assert.equal(state(root).tasks.child.status, "pending");

  run(root, "verify", "base");
  run(root, "accept", "base");
  const second = json(root, "run", "--json");
  assert.deepEqual(second.results.map((item) => item.task), ["child"]);
});

test("returns deterministic status and validation JSON", () => {
  const root = sandbox();
  init(root, "status-demo");
  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  const status = json(root, "status", "--json");
  assert.deepEqual(status, {
    project: "status-demo",
    activeManager: "codex",
    agents: 1,
    tasks: {},
  });
  const report = json(root, "validate", "--json");
  assert.equal(report.valid, true);
  assert.deepEqual(report.errors, []);
});

test("uses non-zero exit status for invalid JSON validation", () => {
  const root = sandbox();
  init(root);
  fs.writeFileSync(path.join(root, ".agent-crew", "project.json"), "{bad json");
  const result = run(root, "validate", "--json");
  assert.equal(result.status, 1);
  const report = JSON.parse(result.stdout);
  assert.equal(report.valid, false);
});

test("rejects unsafe command placeholders and evidence outside the project", () => {
  const root = sandbox();
  init(root);
  const badAgent = run(root, "agent", "add", "--id", "bad", "--label", "Bad",
    "--role", "worker", "--command-json",
    JSON.stringify([process.execPath, "-e", "{unknown}"]));
  assert.notEqual(badAgent.status, 0);

  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "worker");
  json(root, "run", "--json");
  run(root, "verify", "build");
  const outside = path.resolve(root, "..", "outside-evidence.txt");
  fs.writeFileSync(outside, "evidence");
  const result = run(root, "accept", "build", "--evidence", outside);
  assert.notEqual(result.status, 0);
  fs.unlinkSync(outside);
});

test("rejects evidence symlinks that resolve outside the project", (t) => {
  const root = sandbox();
  init(root);
  addAgent(root, "worker", [process.execPath, "-e", "process.exit(0)"]);
  addTask(root, "build", "worker");
  json(root, "run", "--json");
  run(root, "verify", "build");

  const outside = path.join(os.tmpdir(), `agent-crew-outside-${process.pid}-${Date.now()}.txt`);
  fs.writeFileSync(outside, "outside evidence");
  const link = path.join(root, "linked-evidence.txt");
  try {
    fs.symlinkSync(outside, link);
  } catch (err) {
    t.skip(`symlink creation unavailable: ${err.message}`);
    return;
  }
  try {
    const result = run(root, "accept", "build", "--evidence", "linked-evidence.txt");
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /outside|evidence|symlink/i);
  } finally {
    fs.unlinkSync(link);
    fs.unlinkSync(outside);
  }
});
