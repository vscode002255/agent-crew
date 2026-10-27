#!/usr/bin/env node
"use strict";

/**
 * agent-crew — zero-dependency manager/worker orchestration CLI.
 *
 * Durable state lives in <project>/.agent-crew/project.json.
 * Child processes are always spawned from argv arrays; shell: true is never used.
 */

const fs = require("node:fs");
const path = require("node:path");
const { spawn } = require("node:child_process");

const STATE_DIR_NAME = ".agent-crew";
const PROJECT_FILE = "project.json";
const VERSION = 1;
const TASK_STATUSES = ["pending", "running", "review", "rework", "accepted", "failed"];
const BLOCKING_STATUSES = ["running", "review", "rework"];
const ASSIGNABLE_STATUSES = ["pending", "rework", "failed"];
const DEFAULT_AGENT_TIMEOUT = 600;
const DEFAULT_ACCEPT_TIMEOUT = 60;
const MAX_CAPTURE_BYTES = 2 * 1024 * 1024;
const ID_RE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;
const PLACEHOLDER_RE = /\{[^{}\s]+\}/g;
const PLACEHOLDERS = new Set([
  "{prompt}",
  "{promptFile}",
  "{projectRoot}",
  "{taskId}",
  "{runDir}",
  "{stateDir}",
  "{agentId}",
]);

class CliError extends Error {}

function fail(message) {
  throw new CliError(message);
}

/* ------------------------------------------------------------------ */
/* argv parsing                                                        */
/* ------------------------------------------------------------------ */

const BOOLEAN_FLAGS = new Set(["json", "dry-run", "help"]);
const REPEATABLE_FLAGS = new Set(["needs", "writes", "evidence"]);

function parseArgs(argv) {
  const opts = { _: [] };
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i];
    if (arg === "--") {
      opts._.push(...argv.slice(i + 1));
      break;
    }
    if (arg.startsWith("--")) {
      let name = arg.slice(2);
      let value;
      const eq = name.indexOf("=");
      if (eq !== -1) {
        value = name.slice(eq + 1);
        name = name.slice(0, eq);
      }
      if (name === "") fail("Invalid empty option");
      if (BOOLEAN_FLAGS.has(name)) {
        opts[name] = value === undefined ? true : value !== "false";
        continue;
      }
      if (value === undefined) {
        const next = argv[i + 1];
        if (next === undefined) fail(`Missing value for --${name}`);
        value = next;
        i += 1;
      }
      if (REPEATABLE_FLAGS.has(name)) {
        if (!Array.isArray(opts[name])) opts[name] = [];
        opts[name].push(value);
      } else {
        if (opts[name] !== undefined) fail(`Duplicate option --${name}`);
        opts[name] = value;
      }
      continue;
    }
    opts._.push(arg);
  }
  return opts;
}

function requireString(opts, name) {
  const value = opts[name];
  if (typeof value !== "string" || value.trim() === "") {
    fail(`Missing required option --${name}`);
  }
  return value.trim();
}

function optionalString(opts, name, fallback = "") {
  const value = opts[name];
  if (value === undefined) return fallback;
  if (typeof value !== "string") fail(`Option --${name} must be a string`);
  return value;
}

function parseJsonOption(opts, name, expected) {
  const raw = requireString(opts, name);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    fail(`Option --${name} must be valid JSON: ${err.message}`);
  }
  if (expected === "array") {
    if (!Array.isArray(parsed) || parsed.length === 0) {
      fail(`Option --${name} must be a non-empty JSON array`);
    }
    if (!parsed.every((item) => typeof item === "string")) {
      fail(`Option --${name} must be a JSON array of strings`);
    }
    return parsed;
  }
  if (expected === "object") {
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      fail(`Option --${name} must be a JSON object`);
    }
    const env = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (typeof value !== "string") {
        fail(`Option --${name} values must be strings (${key})`);
      }
      env[key] = value;
    }
    return env;
  }
  return parsed;
}

function parsePositiveInt(raw, label, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) {
    fail(`${label} must be a positive integer`);
  }
  return value;
}

function parsePositiveNumber(raw, label, fallback) {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isFinite(value) || value <= 0) {
    fail(`${label} must be a positive number of seconds`);
  }
  return value;
}

/* ------------------------------------------------------------------ */
/* state helpers                                                       */
/* ------------------------------------------------------------------ */

function stateDirOf(root) {
  return path.join(root, STATE_DIR_NAME);
}

function projectPathOf(root) {
  return path.join(stateDirOf(root), PROJECT_FILE);
}

function relPath(root, abs) {
  const rel = path.relative(root, abs);
  return rel === "" ? "." : rel.split(path.sep).join("/");
}

function safeName(value) {
  return String(value).replace(/[^A-Za-z0-9._-]+/g, "_").slice(0, 64) || "task";
}

function nowIso() {
  return new Date().toISOString();
}

function saveProject(ctx, project) {
  const target = projectPathOf(ctx.root);
  const tmp = `${target}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(project, null, 2)}\n`, "utf8");
  fs.renameSync(tmp, target);
}

function loadState(ctx) {
  const projectPath = projectPathOf(ctx.root);
  if (!fs.existsSync(projectPath)) {
    fail(
      `No agent-crew project at ${ctx.root}. Run "crew.js init --name <name>" first.`,
    );
  }
  let project;
  try {
    project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
  } catch (err) {
    fail(`Cannot parse ${relPath(ctx.root, projectPath)}: ${err.message}`);
  }
  if (!project || typeof project !== "object" || Array.isArray(project)) {
    fail("Project state must be a JSON object");
  }
  if (!project.managers || typeof project.managers !== "object") project.managers = {};
  if (!project.agents || typeof project.agents !== "object") project.agents = {};
  if (!project.tasks || typeof project.tasks !== "object") project.tasks = {};
  if (!Array.isArray(project.handoffs)) project.handoffs = [];
  return { project, projectPath };
}

function getTask(project, taskId) {
  if (typeof taskId !== "string" || taskId.trim() === "") {
    fail("A task id is required");
  }
  const task = project.tasks[taskId];
  if (!task) fail(`Unknown task ${taskId}`);
  return task;
}

function resolveManager(project, requested) {
  const activeId = project.activeManager;
  const active = project.managers[activeId];
  if (!active) fail(`Active manager ${activeId} is not defined`);
  if (requested !== undefined) {
    if (!project.managers[requested]) fail(`Unknown manager ${requested}`);
    if (requested !== activeId) {
      fail(
        `Manager ${requested} is not the active manager (${activeId}); ` +
          `use "crew.js handoff --to ${requested}" to transfer authority`,
      );
    }
  }
  return active;
}

/* ------------------------------------------------------------------ */
/* command template helpers                                            */
/* ------------------------------------------------------------------ */

function findPlaceholders(token) {
  return token.match(PLACEHOLDER_RE) || [];
}

function assertCommandTemplate(command, label) {
  if (!Array.isArray(command) || command.length === 0) {
    fail(`${label} must be a non-empty argv array`);
  }
  for (const token of command) {
    if (typeof token !== "string" || token.length === 0) {
      fail(`${label} must contain only non-empty strings`);
    }
    for (const placeholder of findPlaceholders(token)) {
      if (!PLACEHOLDERS.has(placeholder)) {
        fail(`${label} contains unknown placeholder ${placeholder}`);
      }
    }
  }
}

function substitute(token, vars) {
  let out = token;
  for (const [key, value] of Object.entries(vars)) {
    out = out.split(`{${key}}`).join(value);
  }
  return out;
}

/* ------------------------------------------------------------------ */
/* process execution                                                   */
/* ------------------------------------------------------------------ */

function spawnCapture(argv, { cwd, env, timeoutMs }) {
  return new Promise((resolve) => {
    let child;
    try {
      child = spawn(argv[0], argv.slice(1), {
        cwd,
        env,
        shell: false,
        windowsHide: true,
        stdio: ["ignore", "pipe", "pipe"],
      });
    } catch (err) {
      resolve({ exitCode: null, signal: null, stdout: "", stderr: String(err.message), spawnError: err, timedOut: false });
      return;
    }

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let spawnError = null;
    let settled = false;

    const finish = (code, signal) => {
      if (settled) return;
      settled = true;
      if (timer) clearTimeout(timer);
      resolve({ exitCode: code, signal, stdout, stderr, spawnError, timedOut });
    };

    child.stdout.on("data", (chunk) => {
      if (stdout.length < MAX_CAPTURE_BYTES) stdout += chunk.toString("utf8");
    });
    child.stderr.on("data", (chunk) => {
      if (stderr.length < MAX_CAPTURE_BYTES) stderr += chunk.toString("utf8");
    });
    child.on("error", (err) => {
      spawnError = err;
      finish(null, null);
    });
    child.on("close", (code, signal) => finish(code, signal));

    const timer = timeoutMs
      ? setTimeout(() => {
          timedOut = true;
          try {
            child.kill("SIGKILL");
          } catch {
            /* ignore */
          }
        }, timeoutMs)
      : null;
  });
}

function normalizeExitCode(result) {
  if (result.timedOut) return 124;
  if (result.spawnError) return 127;
  if (typeof result.exitCode === "number") return result.exitCode;
  return 1;
}

function buildWorkerEnv(agent, task, runDir, promptFile) {
  return {
    ...process.env,
    ...(agent.env || {}),
    AGENT_CREW_TASK_ID: task.id,
    AGENT_CREW_AGENT_ID: agent.id,
    AGENT_CREW_RUN_DIR: runDir,
    AGENT_CREW_PROMPT_FILE: promptFile,
  };
}

/* ------------------------------------------------------------------ */
/* write scopes                                                        */
/* ------------------------------------------------------------------ */

function normalizeScope(scope) {
  let value = String(scope).trim().replace(/\\/g, "/");
  value = value.replace(/^\.\//, "");
  value = value.replace(/\/\*\*$/, "").replace(/\/\*$/, "");
  value = value.replace(/\*\*$/, "").replace(/\*$/, "");
  value = value.replace(/\/+$/, "");
  return value;
}

function scopesOverlap(a, b) {
  const na = normalizeScope(a);
  const nb = normalizeScope(b);
  if (!na || !nb) return true;
  if (na === nb) return true;
  if (na.startsWith(`${nb}/`)) return true;
  if (nb.startsWith(`${na}/`)) return true;
  return false;
}

function conflictsWith(task, activeScopes) {
  const writes = Array.isArray(task.writes) ? task.writes : [];
  if (writes.length === 0) return false;
  for (const scope of activeScopes) {
    for (const write of writes) {
      if (scopesOverlap(write, scope)) return true;
    }
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* dependency graph                                                    */
/* ------------------------------------------------------------------ */

function findCycles(tasks) {
  const errors = [];
  const seen = new Map();

  const visit = (id, stack) => {
    const mark = seen.get(id) || 0;
    if (mark === 2) return;
    if (mark === 1) {
      const start = stack.indexOf(id);
      const cycle = stack.slice(start === -1 ? 0 : start).concat(id);
      errors.push(`Dependency cycle detected: ${cycle.join(" -> ")}`);
      return;
    }
    seen.set(id, 1);
    stack.push(id);
    const task = tasks[id];
    const needs = task && Array.isArray(task.needs) ? task.needs : [];
    for (const dep of needs) {
      if (tasks[dep]) visit(dep, stack);
    }
    stack.pop();
    seen.set(id, 2);
  };

  for (const id of Object.keys(tasks)) visit(id, []);
  return errors;
}

function wouldCreateCycle(tasks, taskId, needs) {
  const stack = [...needs];
  const visited = new Set();
  while (stack.length > 0) {
    const current = stack.pop();
    if (current === taskId) return true;
    if (visited.has(current)) continue;
    visited.add(current);
    const task = tasks[current];
    if (task && Array.isArray(task.needs)) stack.push(...task.needs);
  }
  return false;
}

/* ------------------------------------------------------------------ */
/* prompt + snapshot construction                                      */
/* ------------------------------------------------------------------ */

function buildWorkerPrompt(ctx, project, task, agent) {
  const needs = Array.isArray(task.needs) ? task.needs : [];
  const writes = Array.isArray(task.writes) ? task.writes : [];
  const acceptance = task.acceptance || {};
  const command = Array.isArray(acceptance.command) ? acceptance.command : [];
  const lines = [];

  lines.push(`# Agent Crew task assignment: ${task.id}`);
  lines.push("");
  lines.push(`Project root: ${ctx.root}`);
  lines.push(`Project name: ${project.name}`);
  lines.push(`Task id: ${task.id}`);
  lines.push(`Assigned worker: ${agent.id} (${agent.label})`);
  lines.push(`Worker role: ${agent.role}`);
  lines.push("");
  lines.push("## Task");
  lines.push(`Title: ${task.title}`);
  lines.push(`Description: ${task.description && task.description.trim() ? task.description : "(none provided)"}`);
  lines.push("");
  lines.push("## Accepted dependencies");
  if (needs.length === 0) {
    lines.push("- none");
  } else {
    for (const dep of needs) {
      const depTask = project.tasks[dep];
      const status = depTask ? depTask.status : "unknown";
      lines.push(`- ${dep} (${status})${depTask ? `: ${depTask.title}` : ""}`);
    }
  }
  lines.push("");
  lines.push("## Write scopes");
  if (writes.length === 0) {
    lines.push("- none declared; do not modify project files");
  } else {
    for (const write of writes) lines.push(`- ${write}`);
  }
  lines.push("");
  lines.push("Make changes only within the declared write scopes. Do not create,");
  lines.push("modify, or delete files outside those scopes, and do not touch other");
  lines.push("projects.");
  lines.push("");
  lines.push("## Acceptance command (run by the manager, not by you)");
  lines.push(`Command: ${JSON.stringify(command)}`);
  lines.push(`Timeout: ${acceptance.timeoutSeconds} seconds`);
  lines.push("");
  lines.push("## Reporting");
  lines.push("When you finish, report:");
  lines.push("- changed files");
  lines.push("- commands you ran");
  lines.push("- tests you ran and their results");
  lines.push("- limitations, risks, and follow-up work");
  lines.push("");
  lines.push("Your own tests and a zero exit code are not manager acceptance. The");
  lines.push("manager runs the acceptance command independently and signs off. Do not");
  lines.push("claim the task is accepted, and do not edit .agent-crew/ state.");
  lines.push("");
  return lines.join("\n");
}

function buildHandoffSnapshot(ctx, project, from, to, note, at, taskSummary) {
  const lines = [];
  lines.push(`# Agent Crew handoff: ${from} -> ${to}`);
  lines.push("");
  lines.push(`- Project: ${project.name}`);
  lines.push(`- Project root: ${ctx.root}`);
  lines.push(`- Handed off at: ${at}`);
  lines.push(`- From manager: ${from}`);
  lines.push(`- To manager: ${to}`);
  lines.push(`- Note: ${note && note.trim() ? note : "(none)"}`);
  lines.push("");
  lines.push("## Task state at handoff");
  lines.push("");
  if (taskSummary.length === 0) {
    lines.push("No tasks recorded.");
  } else {
    lines.push("| Task | Status | Assignee | Attempts | Needs |");
    lines.push("| --- | --- | --- | --- | --- |");
    for (const task of taskSummary) {
      const needs = Array.isArray(task.needs) && task.needs.length > 0 ? task.needs.join(", ") : "-";
      lines.push(`| ${task.id} | ${task.status} | ${task.assignee} | ${task.attempts || 0} | ${needs} |`);
    }
  }
  lines.push("");
  lines.push("## Incoming manager checklist");
  lines.push("");
  lines.push("1. Run `crew.js status` and `crew.js validate`.");
  lines.push("2. For every task in `review`, run `crew.js verify <task-id>`.");
  lines.push("3. Accept only after reading the verification log and the deliverable.");
  lines.push("4. Reject with a concrete note when the deliverable falls short.");
  lines.push("5. Record any further handoff with `crew.js handoff --to <manager>`.");
  lines.push("");
  return lines.join("\n");
}

/* ------------------------------------------------------------------ */
/* init                                                                */
/* ------------------------------------------------------------------ */

function cmdInit(ctx) {
  const name = requireString(ctx.opts, "name");
  const stateDir = stateDirOf(ctx.root);
  const projectPath = projectPathOf(ctx.root);
  if (fs.existsSync(projectPath)) {
    fail(`Project already initialized at ${relPath(ctx.root, projectPath)}; refusing to overwrite`);
  }
  fs.mkdirSync(path.join(stateDir, "runs"), { recursive: true });
  fs.mkdirSync(path.join(stateDir, "handoffs"), { recursive: true });
  const project = {
    version: VERSION,
    name,
    activeManager: "codex",
    managers: { codex: { id: "codex", label: "Codex" } },
    agents: {},
    tasks: {},
    handoffs: [],
  };
  saveProject(ctx, project);
  process.stdout.write(`initialized ${name} at ${relPath(ctx.root, stateDir)}\n`);
}

/* ------------------------------------------------------------------ */
/* managers                                                            */
/* ------------------------------------------------------------------ */

function cmdManager(ctx, sub) {
  if (sub === "add") {
    const state = loadState(ctx);
    const project = state.project;
    const id = requireString(ctx.opts, "id");
    const label = requireString(ctx.opts, "label");
    if (!ID_RE.test(id)) fail(`Invalid manager id ${id}`);
    if (project.managers[id]) fail(`Manager ${id} already exists`);
    project.managers[id] = { id, label };
    saveProject(ctx, project);
    process.stdout.write(`manager added ${id}\n`);
    return;
  }

  if (sub === "use") {
    const state = loadState(ctx);
    const project = state.project;
    const id = requireString(ctx.opts, "id");
    if (!project.managers[id]) fail(`Unknown manager ${id}`);
    if (id === project.activeManager) {
      process.stdout.write(`manager ${id} already active\n`);
      return;
    }
    const blocking = Object.values(project.tasks).filter((task) =>
      BLOCKING_STATUSES.includes(task.status),
    );
    if (blocking.length > 0) {
      const ids = blocking.map((task) => `${task.id}(${task.status})`).join(", ");
      fail(
        `Cannot switch manager while tasks are running, in review, or in rework: ${ids}. ` +
          `Use "crew.js handoff --to ${id}" to transfer the project instead.`,
      );
    }
    project.activeManager = id;
    saveProject(ctx, project);
    process.stdout.write(`active manager ${id}\n`);
    return;
  }

  if (sub === "list") {
    const state = loadState(ctx);
    const project = state.project;
    for (const manager of Object.values(project.managers)) {
      const marker = manager.id === project.activeManager ? "*" : " ";
      process.stdout.write(`${marker} ${manager.id}\t${manager.label}\n`);
    }
    return;
  }

  fail("Usage: crew.js manager <add|use|list> [options]");
}

function cmdHandoff(ctx) {
  const state = loadState(ctx);
  const project = state.project;
  const to = requireString(ctx.opts, "to");
  const note = optionalString(ctx.opts, "note");
  if (!project.managers[to]) fail(`Unknown manager ${to}`);
  const from = project.activeManager;
  if (!project.managers[from]) fail(`Active manager ${from} is not defined`);
  if (to === from) fail(`Manager ${to} is already the active manager`);

  const at = nowIso();
  const stamp = at.replace(/[:.]/g, "-");
  const fileName = `${stamp}-${safeName(from)}-to-${safeName(to)}.md`;
  const handoffDir = path.join(stateDirOf(ctx.root), "handoffs");
  fs.mkdirSync(handoffDir, { recursive: true });
  const filePath = path.join(handoffDir, fileName);
  const tasks = Object.values(project.tasks);
  fs.writeFileSync(filePath, buildHandoffSnapshot(ctx, project, from, to, note, at, tasks), "utf8");

  project.handoffs.push({
    from,
    to,
    note,
    at,
    file: relPath(ctx.root, filePath),
    tasks: tasks.map((task) => ({ id: task.id, status: task.status, assignee: task.assignee })),
  });
  project.activeManager = to;
  saveProject(ctx, project);
  process.stdout.write(`handoff ${from} -> ${to} (${relPath(ctx.root, filePath)})\n`);
}

/* ------------------------------------------------------------------ */
/* agents                                                              */
/* ------------------------------------------------------------------ */

function cmdAgent(ctx, sub) {
  if (sub === "add") {
    const state = loadState(ctx);
    const project = state.project;
    const id = requireString(ctx.opts, "id");
    const label = requireString(ctx.opts, "label");
    const role = requireString(ctx.opts, "role");
    if (!ID_RE.test(id)) fail(`Invalid agent id ${id}`);
    if (project.agents[id]) fail(`Agent ${id} already exists`);
    const command = parseJsonOption(ctx.opts, "command-json", "array");
    assertCommandTemplate(command, `Agent ${id} command`);
    const timeoutSeconds = parsePositiveNumber(ctx.opts.timeout, "--timeout", DEFAULT_AGENT_TIMEOUT);
    const env = ctx.opts["env-json"] === undefined
      ? {}
      : parseJsonOption(ctx.opts, "env-json", "object");
    project.agents[id] = {
      id,
      label,
      role,
      command,
      timeoutSeconds,
      env,
    };
    saveProject(ctx, project);
    process.stdout.write(`agent added ${id}\n`);
    return;
  }

  if (sub === "list") {
    const state = loadState(ctx);
    const project = state.project;
    const agents = Object.values(project.agents);
    if (ctx.opts.json) {
      process.stdout.write(`${JSON.stringify({ agents }, null, 2)}\n`);
      return;
    }
    if (agents.length === 0) {
      process.stdout.write("no agents\n");
      return;
    }
    for (const agent of agents) {
      process.stdout.write(`${agent.id}\t${agent.role}\t${agent.label}\n`);
    }
    return;
  }

  fail("Usage: crew.js agent <add|list> [options]");
}

/* ------------------------------------------------------------------ */
/* tasks                                                               */
/* ------------------------------------------------------------------ */

function cmdTask(ctx, sub) {
  if (sub === "add") {
    const state = loadState(ctx);
    const project = state.project;
    const id = requireString(ctx.opts, "id");
    if (!ID_RE.test(id)) fail(`Invalid task id ${id}`);
    if (project.tasks[id]) fail(`Task ${id} already exists`);
    const title = requireString(ctx.opts, "title");
    const description = optionalString(ctx.opts, "description");
    const assignee = requireString(ctx.opts, "assignee");
    if (!project.agents[assignee]) fail(`Unknown assignee ${assignee}`);
    const needs = ctx.opts.needs || [];
    const writes = ctx.opts.writes || [];
    for (const dep of needs) {
      if (dep === id) fail(`Task ${id} cannot depend on itself`);
      if (!project.tasks[dep]) fail(`Task ${id} depends on unknown task ${dep}`);
    }
    if (wouldCreateCycle(project.tasks, id, needs)) {
      fail(`Task ${id} would create a dependency cycle`);
    }
    for (const write of writes) {
      const normalized = String(write).replace(/\\/g, "/");
      if (normalized.trim() === "") fail(`Task ${id} has an empty write scope`);
      if (path.isAbsolute(String(write)) || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
        fail(`Task ${id} write scope ${write} must be relative to the project root`);
      }
      if (normalized.split("/").includes("..")) {
        fail(`Task ${id} write scope ${write} must not escape the project root`);
      }
    }
    const command = parseJsonOption(ctx.opts, "accept-json", "array");
    assertCommandTemplate(command, `Task ${id} acceptance command`);
    const timeoutSeconds = parsePositiveNumber(
      ctx.opts["accept-timeout"],
      "--accept-timeout",
      DEFAULT_ACCEPT_TIMEOUT,
    );

    project.tasks[id] = {
      id,
      title,
      description,
      assignee,
      needs: [...needs],
      writes: [...writes],
      acceptance: { command: [...command], timeoutSeconds },
      status: "pending",
      attempts: 0,
      runs: [],
      verifications: [],
      rejections: [],
      createdAt: nowIso(),
    };
    saveProject(ctx, project);
    process.stdout.write(`task added ${id} (${assignee})\n`);
    return;
  }

  if (sub === "list") {
    const state = loadState(ctx);
    const project = state.project;
    const tasks = Object.values(project.tasks);
    if (ctx.opts.json) {
      const payload = {
        tasks: tasks.map((task) => {
          const entry = {
            id: task.id,
            title: task.title,
            status: task.status,
            assignee: task.assignee,
            needs: task.needs || [],
            writes: task.writes || [],
            attempts: task.attempts || 0,
          };
          if (Array.isArray(task.assignments) && task.assignments.length > 0) {
            entry.assignments = task.assignments;
          }
          return entry;
        }),
      };
      process.stdout.write(`${JSON.stringify(payload, null, 2)}\n`);
      return;
    }
    if (tasks.length === 0) {
      process.stdout.write("no tasks\n");
      return;
    }
    for (const task of tasks) {
      process.stdout.write(`${task.id}\t${task.status}\t${task.assignee}\t${task.title}\n`);
    }
    return;
  }

  if (sub === "assign") {
    const state = loadState(ctx);
    const project = state.project;
    const taskId = typeof ctx.opts._[2] === "string" ? ctx.opts._[2] : ctx.opts.id;
    const task = getTask(project, taskId);
    const assignee = requireString(ctx.opts, "assignee");
    if (!ID_RE.test(assignee)) fail(`Invalid assignee ${assignee}`);
    if (!project.agents[assignee]) fail(`Unknown assignee ${assignee}`);
    if (task.assignee === assignee) {
      fail(`Task ${task.id} is already assigned to ${assignee}`);
    }
    if (!ASSIGNABLE_STATUSES.includes(task.status)) {
      fail(
        `Task ${task.id} is ${task.status} and cannot be reassigned. ` +
          `Only pending, rework, or failed tasks can be reassigned. ` +
          `If work is in ${task.status}, reject or reset it first: ` +
          `"crew.js reject ${task.id} --note <text>" (review) or ` +
          `"crew.js task reset --id ${task.id}" (failed), then assign again.`,
      );
    }
    const note = optionalString(ctx.opts, "note");
    const from = task.assignee;
    if (!Array.isArray(task.assignments)) task.assignments = [];
    task.assignee = assignee;
    task.assignments.push({ from, to: assignee, note, at: nowIso() });
    if (task.status === "failed") task.status = "pending";
    saveProject(ctx, project);
    process.stdout.write(
      `task assigned ${task.id}: ${from} -> ${assignee}; status ${task.status}\n`,
    );
    return;
  }

  if (sub === "reset") {
    const state = loadState(ctx);
    const project = state.project;
    const task = getTask(project, ctx.opts.id);
    if (task.status !== "failed") {
      fail(
        `Task ${task.id} is ${task.status}; reset only applies to failed tasks. ` +
          "Use reject for tasks in review.",
      );
    }
    const note = optionalString(ctx.opts, "note");
    task.status = "pending";
    task.resetAt = nowIso();
    task.resetNote = note;
    saveProject(ctx, project);
    process.stdout.write(`task reset ${task.id}; status pending\n`);
    return;
  }

  fail("Usage: crew.js task <add|list|assign|reset> [options]");
}

/* ------------------------------------------------------------------ */
/* run                                                                 */
/* ------------------------------------------------------------------ */

function isEligible(project, task) {
  if (task.status !== "pending" && task.status !== "rework") return false;
  const needs = Array.isArray(task.needs) ? task.needs : [];
  return needs.every((dep) => {
    const depTask = project.tasks[dep];
    return Boolean(depTask) && depTask.status === "accepted";
  });
}

function collectEligible(ctx, project, onlyId) {
  const tasks = project.tasks;
  if (onlyId !== undefined && !tasks[onlyId]) fail(`Unknown task ${onlyId}`);
  const list = [];
  for (const task of Object.values(tasks)) {
    if (onlyId !== undefined && task.id !== onlyId) continue;
    if (!isEligible(project, task)) continue;
    if (!project.agents[task.assignee]) {
      fail(`Task ${task.id} has unknown assignee ${task.assignee}`);
    }
    list.push(task);
  }
  if (onlyId !== undefined && list.length === 0) {
    const task = tasks[onlyId];
    fail(
      `Task ${onlyId} is not eligible to run (status ${task.status}); ` +
        "only pending or rework tasks with accepted dependencies are eligible",
    );
  }
  return list;
}

async function runTask(ctx, state, task) {
  const project = state.project;
  const agent = project.agents[task.assignee];
  if (!agent) fail(`Task ${task.id} has unknown assignee ${task.assignee}`);

  const runsDir = path.join(stateDirOf(ctx.root), "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(runsDir, `${safeName(task.id)}-`));
  const prompt = buildWorkerPrompt(ctx, project, task, agent);
  const promptFile = path.join(runDir, "prompt.md");
  fs.writeFileSync(promptFile, prompt, "utf8");

  const vars = {
    prompt,
    promptFile,
    projectRoot: ctx.root,
    taskId: task.id,
    runDir,
    stateDir: stateDirOf(ctx.root),
    agentId: agent.id,
  };
  const argv = agent.command.map((token) => substitute(token, vars));
  const startedAt = nowIso();
  const startedMs = Date.now();

  task.status = "running";
  saveProject(ctx, project);

  const result = await spawnCapture(argv, {
    cwd: ctx.root,
    env: buildWorkerEnv(agent, task, runDir, promptFile),
    timeoutMs: Math.round(agent.timeoutSeconds * 1000),
  });

  const finishedAt = nowIso();
  const exitCode = normalizeExitCode(result);
  const stdoutFile = path.join(runDir, "stdout.log");
  const stderrFile = path.join(runDir, "stderr.log");
  fs.writeFileSync(stdoutFile, result.stdout, "utf8");
  fs.writeFileSync(stderrFile, result.stderr, "utf8");

  task.attempts = (task.attempts || 0) + 1;
  const record = {
    dir: relPath(ctx.root, runDir),
    exitCode,
    startedAt,
    finishedAt,
    durationMs: Date.now() - startedMs,
    attempt: task.attempts,
    agentId: agent.id,
    command: argv,
    promptFile: relPath(ctx.root, promptFile),
    stdoutFile: relPath(ctx.root, stdoutFile),
    stderrFile: relPath(ctx.root, stderrFile),
    timedOut: Boolean(result.timedOut),
  };
  if (!Array.isArray(task.runs)) task.runs = [];
  task.runs.push(record);
  task.status = exitCode === 0 ? "review" : "failed";
  saveProject(ctx, project);

  return { task: task.id, assignee: agent.id, exitCode, status: task.status };
}

async function executePlan(ctx, state, plan, maxParallel) {
  const project = state.project;
  const pending = plan.map((item) => project.tasks[item.task]);
  const order = [];
  const results = new Map();
  const active = [];
  const persistedScopes = Object.values(project.tasks)
    .filter((task) => task.status === "running")
    .flatMap((task) => (Array.isArray(task.writes) ? task.writes : []));

  const activeScopes = () => [
    ...persistedScopes,
    ...active.flatMap((entry) => (Array.isArray(entry.task.writes) ? entry.task.writes : [])),
  ];

  while (pending.length > 0 || active.length > 0) {
    while (active.length < maxParallel) {
      const scopes = activeScopes();
      const index = pending.findIndex((task) => !conflictsWith(task, scopes));
      if (index === -1) break;
      const task = pending.splice(index, 1)[0];
      order.push(task.id);
      const promise = runTask(ctx, state, task)
        .then((result) => {
          results.set(task.id, result);
          return result;
        })
        .catch((err) => {
          results.set(task.id, {
            task: task.id,
            assignee: task.assignee,
            exitCode: 1,
            status: project.tasks[task.id].status || "failed",
          });
          process.stderr.write(`crew: run failed for ${task.id}: ${err.message}\n`);
          return null;
        });
      active.push({ task, promise });
    }
    if (active.length === 0) {
      const stale = Object.values(project.tasks)
        .filter((task) => task.status === "running")
        .map((task) => task.id);
      const blocked = pending.map((task) => task.id);
      const reason = stale.length > 0
        ? `tasks still marked running (${stale.join(", ")}) hold their write scopes`
        : "write scopes conflict with tasks already scheduled";
      process.stderr.write(
        `crew: cannot schedule ${blocked.join(", ")}: ${reason}. ` +
          "Inspect the run records and resolve the stale state before retrying.\n",
      );
      process.exitCode = 1;
      break;
    }
    const settled = await Promise.race(
      active.map((entry) => entry.promise.then(() => entry, () => entry)),
    );
    const index = active.indexOf(settled);
    if (index !== -1) active.splice(index, 1);
  }

  return order
    .map((id) => results.get(id))
    .filter((result) => result !== undefined);
}

async function cmdRun(ctx) {
  const state = loadState(ctx);
  const project = state.project;
  const cycles = findCycles(project.tasks);
  if (cycles.length > 0) fail(cycles[0]);

  const maxParallel = parsePositiveInt(ctx.opts["max-parallel"], "--max-parallel", 1);
  const onlyId = ctx.opts.task;
  const dryRun = Boolean(ctx.opts["dry-run"]);

  // A single CLI process owns every run, so a task left in `running` was
  // interrupted. Mark it failed instead of silently re-running or blocking
  // all future scheduling on its write scopes.
  if (!dryRun) {
    const interrupted = Object.values(project.tasks).filter((task) => task.status === "running");
    if (interrupted.length > 0) {
      const at = nowIso();
      for (const task of interrupted) {
        task.status = "failed";
        task.interruptedAt = at;
        task.interruptionNote = "Previous run did not record a completion; marked failed.";
      }
      saveProject(ctx, project);
      process.stderr.write(
        `crew: recovered interrupted task(s): ${interrupted.map((task) => task.id).join(", ")}; ` +
          "marked failed. Use \"crew.js task reset --id <id>\" to retry.\n",
      );
    }
  }

  const eligible = collectEligible(ctx, project, onlyId);
  const plan = eligible.map((task) => ({ task: task.id, assignee: task.assignee }));
  const asJson = Boolean(ctx.opts.json);

  if (dryRun) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ dryRun: true, plan })}\n`);
      return;
    }
    if (plan.length === 0) {
      process.stdout.write("plan: no eligible tasks\n");
      return;
    }
    for (const item of plan) process.stdout.write(`plan ${item.task} ${item.assignee}\n`);
    return;
  }

  if (plan.length === 0) {
    if (asJson) {
      process.stdout.write(`${JSON.stringify({ dryRun: false, results: [] })}\n`);
    } else {
      process.stdout.write("no eligible tasks\n");
    }
    return;
  }

  const results = await executePlan(ctx, state, plan, maxParallel);

  if (asJson) {
    process.stdout.write(`${JSON.stringify({ dryRun: false, results })}\n`);
    return;
  }
  for (const result of results) {
    process.stdout.write(`${result.task} ${result.assignee} ${result.status} exit=${result.exitCode}\n`);
  }
}

/* ------------------------------------------------------------------ */
/* verify / accept / reject                                            */
/* ------------------------------------------------------------------ */

function cmdVerify(ctx) {
  const state = loadState(ctx);
  const project = state.project;
  const taskId = ctx.opts._[1];
  const task = getTask(project, taskId);
  const manager = resolveManager(project, ctx.opts.manager);
  if (task.status !== "review") {
    fail(`Task ${task.id} is ${task.status}; verify requires status review`);
  }
  const acceptance = task.acceptance || {};
  const command = acceptance.command;
  if (!Array.isArray(command) || command.length === 0) {
    fail(`Task ${task.id} has no acceptance command`);
  }
  assertCommandTemplate(command, `Task ${task.id} acceptance command`);

  const runsDir = path.join(stateDirOf(ctx.root), "runs");
  fs.mkdirSync(runsDir, { recursive: true });
  const runDir = fs.mkdtempSync(path.join(runsDir, `verify-${safeName(task.id)}-`));
  const vars = {
    prompt: "",
    promptFile: "",
    projectRoot: ctx.root,
    taskId: task.id,
    runDir,
    stateDir: stateDirOf(ctx.root),
    agentId: task.assignee,
  };
  const argv = command.map((token) => substitute(token, vars));
  const timeoutSeconds = parsePositiveNumber(
    acceptance.timeoutSeconds,
    `Task ${task.id} acceptance timeoutSeconds`,
    DEFAULT_ACCEPT_TIMEOUT,
  );

  const startedAt = nowIso();
  const startedMs = Date.now();

  return spawnCapture(argv, {
    cwd: ctx.root,
    env: { ...process.env },
    timeoutMs: Math.round(timeoutSeconds * 1000),
  }).then((result) => {
    const finishedAt = nowIso();
    const exitCode = normalizeExitCode(result);
    const logFile = path.join(runDir, "acceptance.log");
    const log = [
      `# Independent verification for ${task.id}`,
      `manager: ${manager.id}`,
      `command: ${JSON.stringify(argv)}`,
      `exitCode: ${exitCode}`,
      `startedAt: ${startedAt}`,
      `finishedAt: ${finishedAt}`,
      "",
      "## stdout",
      result.stdout,
      "",
      "## stderr",
      result.stderr,
      "",
    ].join("\n");
    fs.writeFileSync(logFile, log, "utf8");

    const record = {
      manager: manager.id,
      command: argv,
      exitCode,
      passed: exitCode === 0,
      dir: relPath(ctx.root, runDir),
      logFile: relPath(ctx.root, logFile),
      startedAt,
      finishedAt,
      durationMs: Date.now() - startedMs,
      timedOut: Boolean(result.timedOut),
    };
    if (!Array.isArray(task.verifications)) task.verifications = [];
    task.verifications.push(record);
    saveProject(ctx, project);

    if (exitCode !== 0) {
      fail(
        `Independent verification failed for ${task.id} (exit ${exitCode}); ` +
          `see ${record.logFile}. The task stays in review and cannot be accepted.`,
      );
    }
    process.stdout.write(`verified ${task.id} (exit 0) by ${manager.id}\n`);
  });
}

function isInside(canonicalRoot, abs) {
  const rel = path.relative(canonicalRoot, abs);
  if (rel === "") return true;
  if (path.isAbsolute(rel)) return false;
  return rel !== ".." && !rel.startsWith(`..${path.sep}`);
}

function canonicalPath(target) {
  // realpath resolves symlinks, junctions, and short/long name aliases.
  return fs.realpathSync(target);
}

function resolveInsideRoot(root, candidate) {
  const abs = path.resolve(root, candidate);
  if (!isInside(path.resolve(root), abs)) {
    fail(`Path is outside the project root: ${candidate}`);
  }
  return abs;
}

/**
 * Resolve an evidence path and prove that its canonical (symlink-free) target
 * still lives inside the canonical project root. Lexical checks alone are not
 * enough: a symlink inside the project can point anywhere on disk.
 */
function resolveEvidence(root, candidate) {
  const abs = resolveInsideRoot(root, candidate);
  if (!fs.existsSync(abs)) fail(`Evidence path does not exist: ${candidate}`);

  let canonicalRoot;
  let canonicalTarget;
  try {
    canonicalRoot = canonicalPath(root);
    canonicalTarget = canonicalPath(abs);
  } catch (err) {
    fail(`Cannot resolve evidence path ${candidate}: ${err.message}`);
  }
  if (!isInside(canonicalRoot, canonicalTarget)) {
    fail(
      `Evidence path resolves outside the project root: ${candidate} ` +
        `(real path ${canonicalTarget})`,
    );
  }
  return abs;
}

function cmdAccept(ctx) {
  const state = loadState(ctx);
  const project = state.project;
  const taskId = ctx.opts._[1];
  const task = getTask(project, taskId);
  const manager = resolveManager(project, ctx.opts.manager);
  if (task.status !== "review") {
    fail(`Task ${task.id} is ${task.status}; accept requires status review`);
  }
  const verifications = Array.isArray(task.verifications) ? task.verifications : [];
  const latest = verifications[verifications.length - 1];
  if (!latest || latest.passed !== true) {
    fail(
      `Task ${task.id} has no passing verification; run "crew.js verify ${task.id}" first`,
    );
  }
  if (manager.id === task.assignee) {
    fail(
      `Manager ${manager.id} is also the assignee of ${task.id}; a worker cannot sign off its own task`,
    );
  }

  const evidence = [];
  for (const raw of ctx.opts.evidence || []) {
    const abs = resolveEvidence(ctx.root, raw);
    evidence.push(relPath(ctx.root, abs));
  }

  const note = optionalString(ctx.opts, "note");
  const at = nowIso();
  task.status = "accepted";
  task.acceptedBy = manager.id;
  task.acceptedAt = at;
  task.acceptedNote = note;
  task.evidence = evidence;
  task.acceptanceRecord = {
    manager: manager.id,
    note,
    evidence,
    at,
    verification: {
      exitCode: latest.exitCode,
      dir: latest.dir,
      logFile: latest.logFile,
    },
  };
  saveProject(ctx, project);
  process.stdout.write(`accepted ${task.id} by ${manager.id}\n`);
}

function cmdReject(ctx) {
  const state = loadState(ctx);
  const project = state.project;
  const taskId = ctx.opts._[1];
  const task = getTask(project, taskId);
  const manager = resolveManager(project, ctx.opts.manager);
  const note = requireString(ctx.opts, "note");
  if (task.status !== "review") {
    fail(`Task ${task.id} is ${task.status}; reject requires status review`);
  }
  if (manager.id === task.assignee) {
    fail(
      `Manager ${manager.id} is also the assignee of ${task.id}; a worker cannot reject its own task`,
    );
  }

  if (!Array.isArray(task.rejections)) task.rejections = [];
  const at = nowIso();
  task.rejections.push({ manager: manager.id, note, at });
  task.status = "rework";
  task.reworkReason = note;
  delete task.acceptedBy;
  delete task.acceptedAt;
  delete task.acceptedNote;
  delete task.evidence;
  delete task.acceptanceRecord;
  saveProject(ctx, project);
  process.stdout.write(`rejected ${task.id}; status rework\n`);
}

/* ------------------------------------------------------------------ */
/* status / validate                                                   */
/* ------------------------------------------------------------------ */

function cmdStatus(ctx) {
  const state = loadState(ctx);
  const project = state.project;
  const tasks = {};
  for (const task of Object.values(project.tasks)) {
    tasks[task.id] = { status: task.status, assignee: task.assignee };
  }
  const payload = {
    project: project.name,
    activeManager: project.activeManager,
    agents: Object.keys(project.agents).length,
    tasks,
  };
  if (ctx.opts.json) {
    process.stdout.write(`${JSON.stringify(payload)}\n`);
    return;
  }
  process.stdout.write(`project: ${payload.project}\n`);
  process.stdout.write(`active manager: ${payload.activeManager}\n`);
  process.stdout.write(`agents: ${payload.agents}\n`);
  const entries = Object.entries(tasks);
  if (entries.length === 0) {
    process.stdout.write("tasks: none\n");
    return;
  }
  for (const [id, info] of entries) {
    process.stdout.write(`task ${id}: ${info.status} (${info.assignee})\n`);
  }
}

function validateProject(ctx, project) {
  const errors = [];

  if (project.version !== VERSION) {
    errors.push(`version must be ${VERSION}`);
  }
  if (typeof project.name !== "string" || project.name.trim() === "") {
    errors.push("name must be a non-empty string");
  }

  if (!project.managers || typeof project.managers !== "object" || Array.isArray(project.managers)) {
    errors.push("managers must be an object");
  } else {
    for (const [id, manager] of Object.entries(project.managers)) {
      if (!manager || typeof manager !== "object" || Array.isArray(manager)) {
        errors.push(`manager ${id} must be an object`);
        continue;
      }
      if (manager.id !== id) errors.push(`manager ${id} has mismatched id`);
      if (typeof manager.label !== "string" || manager.label.trim() === "") {
        errors.push(`manager ${id} label must be a non-empty string`);
      }
    }
    if (!project.managers[project.activeManager]) {
      errors.push(`activeManager ${project.activeManager} is not defined in managers`);
    }
  }

  const agents = project.agents;
  if (!agents || typeof agents !== "object" || Array.isArray(agents)) {
    errors.push("agents must be an object");
  } else {
    for (const [id, agent] of Object.entries(agents)) {
      if (!agent || typeof agent !== "object" || Array.isArray(agent)) {
        errors.push(`agent ${id} must be an object`);
        continue;
      }
      if (agent.id !== id) errors.push(`agent ${id} has mismatched id`);
      if (typeof agent.label !== "string" || agent.label.trim() === "") {
        errors.push(`agent ${id} label must be a non-empty string`);
      }
      if (typeof agent.role !== "string" || agent.role.trim() === "") {
        errors.push(`agent ${id} role must be a non-empty string`);
      }
      try {
        assertCommandTemplate(agent.command, `agent ${id} command`);
      } catch (err) {
        errors.push(err.message);
      }
      if (!Number.isFinite(agent.timeoutSeconds) || agent.timeoutSeconds <= 0) {
        errors.push(`agent ${id} timeoutSeconds must be a positive number`);
      }
      if (agent.env !== undefined) {
        if (!agent.env || typeof agent.env !== "object" || Array.isArray(agent.env)) {
          errors.push(`agent ${id} env must be an object`);
        } else {
          for (const [key, value] of Object.entries(agent.env)) {
            if (typeof value !== "string") errors.push(`agent ${id} env ${key} must be a string`);
          }
        }
      }
    }
  }

  const tasks = project.tasks;
  if (!tasks || typeof tasks !== "object" || Array.isArray(tasks)) {
    errors.push("tasks must be an object");
    return errors;
  }

  for (const [id, task] of Object.entries(tasks)) {
    if (!task || typeof task !== "object" || Array.isArray(task)) {
      errors.push(`task ${id} must be an object`);
      continue;
    }
    if (task.id !== id) errors.push(`task ${id} has mismatched id`);
    if (typeof task.title !== "string" || task.title.trim() === "") {
      errors.push(`task ${id} title must be a non-empty string`);
    }
    if (task.description !== undefined && typeof task.description !== "string") {
      errors.push(`task ${id} description must be a string`);
    }
    if (!TASK_STATUSES.includes(task.status)) {
      errors.push(`task ${id} has invalid status ${task.status}`);
    }
    if (agents && typeof agents === "object" && !agents[task.assignee]) {
      errors.push(`task ${id} has unknown assignee ${task.assignee}`);
    }
    if (!Array.isArray(task.needs)) {
      errors.push(`task ${id} needs must be an array`);
    } else {
      for (const dep of task.needs) {
        if (typeof dep !== "string") {
          errors.push(`task ${id} needs entries must be strings`);
          continue;
        }
        if (dep === id) errors.push(`task ${id} depends on itself`);
        else if (!tasks[dep]) errors.push(`task ${id} depends on unknown task ${dep}`);
      }
    }
    if (!Array.isArray(task.writes)) {
      errors.push(`task ${id} writes must be an array of path prefixes or globs`);
    } else {
      for (const write of task.writes) {
        if (typeof write !== "string" || write.trim() === "") {
          errors.push(`task ${id} has an empty write scope`);
          continue;
        }
        const normalized = write.replace(/\\/g, "/");
        if (path.isAbsolute(write) || normalized.startsWith("/") || /^[A-Za-z]:/.test(normalized)) {
          errors.push(`task ${id} write scope ${write} must be relative to the project root`);
        } else if (normalized.split("/").includes("..")) {
          errors.push(`task ${id} write scope ${write} must not escape the project root`);
        }
      }
    }
    if (!task.acceptance || typeof task.acceptance !== "object" || Array.isArray(task.acceptance)) {
      errors.push(`task ${id} must declare an acceptance command`);
    } else {
      try {
        assertCommandTemplate(task.acceptance.command, `task ${id} acceptance command`);
      } catch (err) {
        errors.push(err.message);
      }
      if (!Number.isFinite(task.acceptance.timeoutSeconds) || task.acceptance.timeoutSeconds <= 0) {
        errors.push(`task ${id} acceptance timeoutSeconds must be a positive number`);
      }
    }
    if (task.runs !== undefined && !Array.isArray(task.runs)) {
      errors.push(`task ${id} runs must be an array`);
    }
    if (task.verifications !== undefined && !Array.isArray(task.verifications)) {
      errors.push(`task ${id} verifications must be an array`);
    }
    if (task.attempts !== undefined && !Number.isInteger(task.attempts)) {
      errors.push(`task ${id} attempts must be an integer`);
    }
  }

  errors.push(...findCycles(tasks));
  return errors;
}

function cmdValidate(ctx) {
  const asJson = Boolean(ctx.opts.json);
  const projectPath = projectPathOf(ctx.root);
  const errors = [];

  if (!fs.existsSync(projectPath)) {
    errors.push(`No agent-crew project at ${ctx.root}`);
  } else {
    // Track parse success separately from the parsed value: JSON literals such
    // as null, false, 0, or "" are falsy but perfectly valid JSON, and a truthy
    // test would silently report them as valid state.
    let project;
    let parsed = false;
    try {
      project = JSON.parse(fs.readFileSync(projectPath, "utf8"));
      parsed = true;
    } catch (err) {
      errors.push(`project.json is not valid JSON: ${err.message}`);
    }
    if (parsed) {
      if (!project || typeof project !== "object" || Array.isArray(project)) {
        errors.push("project.json must contain a JSON object");
      } else {
        errors.push(...validateProject(ctx, project));
      }
    }
  }

  const valid = errors.length === 0;
  if (asJson) {
    // Machine-readable output still uses the exit status as the signal, so a
    // caller can gate on `status` without re-parsing the JSON body.
    process.stdout.write(`${JSON.stringify({ valid, errors })}\n`);
    if (!valid) process.exitCode = 1;
    return;
  }
  if (valid) {
    process.stdout.write("valid\n");
    return;
  }
  for (const error of errors) process.stderr.write(`error: ${error}\n`);
  process.exitCode = 1;
}

/* ------------------------------------------------------------------ */
/* usage + main                                                        */
/* ------------------------------------------------------------------ */

const USAGE = `agent-crew — durable manager/worker task orchestration

Usage:
  crew.js init --name <name> [--root <dir>]
  crew.js manager add --id <id> --label <label> [--root <dir>]
  crew.js manager use --id <id> [--root <dir>]
  crew.js manager list [--root <dir>]
  crew.js handoff --to <id> [--note <text>] [--root <dir>]
  crew.js agent add --id <id> --label <label> --role <role> \\
      --command-json '<json array>' [--timeout <seconds>] [--env-json '<json object>']
  crew.js agent list [--root <dir>]
  crew.js task add --id <id> --title <title> [--description <text>] \\
      --assignee <agent-id> [--needs <id>]... [--writes <path>]... \\
      --accept-json '<json array>' [--accept-timeout <seconds>]
  crew.js task list [--json] [--root <dir>]
  crew.js task assign <task-id> --assignee <agent-id> [--note <text>] [--root <dir>]
  crew.js task reset --id <id> [--note <text>] [--root <dir>]
  crew.js run [--max-parallel <n>] [--task <id>] [--dry-run] [--json]
  crew.js verify <task-id> [--manager <id>]
  crew.js accept <task-id> [--manager <id>] [--note <text>] [--evidence <path>]...
  crew.js reject <task-id> --manager <id> --note <text>
  crew.js status [--json]
  crew.js validate [--json]

All commands accept --root <dir>; the default is the current directory.
`;

async function main(argv) {
  const opts = parseArgs(argv);
  const ctx = {
    root: path.resolve(typeof opts.root === "string" ? opts.root : process.cwd()),
    stateDir: null,
    opts,
  };
  ctx.stateDir = stateDirOf(ctx.root);

  const [command, sub] = opts._;

  if (opts.help || command === "help" || command === undefined) {
    process.stdout.write(USAGE);
    if (command === undefined && !opts.help) {
      process.exitCode = 1;
    }
    return;
  }

  switch (command) {
    case "init":
      cmdInit(ctx);
      return;
    case "manager":
      cmdManager(ctx, sub);
      return;
    case "handoff":
      cmdHandoff(ctx);
      return;
    case "agent":
      cmdAgent(ctx, sub);
      return;
    case "task":
      cmdTask(ctx, sub);
      return;
    case "run":
      await cmdRun(ctx);
      return;
    case "verify":
      await cmdVerify(ctx);
      return;
    case "accept":
      cmdAccept(ctx);
      return;
    case "reject":
      cmdReject(ctx);
      return;
    case "status":
      cmdStatus(ctx);
      return;
    case "validate":
      cmdValidate(ctx);
      return;
    default:
      fail(`Unknown command ${command}. Run "crew.js help" for usage.`);
  }
}

main(process.argv.slice(2)).catch((err) => {
  if (err instanceof CliError) {
    process.stderr.write(`crew: ${err.message}\n`);
    process.exitCode = 1;
    return;
  }
  process.stderr.write(`crew: unexpected error: ${err && err.stack ? err.stack : err}\n`);
  process.exitCode = 1;
});
