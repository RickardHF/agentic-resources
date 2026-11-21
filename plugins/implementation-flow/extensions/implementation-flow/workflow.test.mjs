import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import * as path from "node:path";
import * as crypto from "node:crypto";
import vm from "node:vm";
import { test } from "node:test";
import { meta, run as originalRun } from "./workflow.mjs";

const clone = (value) => JSON.parse(JSON.stringify(value));
const issueUrl = "https://github.com/RickardHF/Autonomous-Developer-Workflows/issues/42";
const root = "/Users/rickard/repos/private/Autonomous-Developer-Workflows";
const check = { command: "npm test -- feature", outcome: "passed", evidence: "1 test passed" };
const criterion = { id: "AC1", requirement: "The requested behavior works.", verification: "Run the focused behavior test." };
const finding = {
  id: "Q1", severity: "high", category: "security", file: "src/feature.ts",
  startLine: 3, endLine: 4, title: "Unsafe input reaches a query",
  explanation: "User input reaches query construction.", evidence: "request -> query",
  confidence: 9, blocking: true,
};
const labels = {
  approve: "Approve plan and implement", revise: "Request plan changes", stopPlan: "Stop (do not implement)",
  clarify: "Provide clarification and re-plan", finish: "Finish",
  reimplement: "Go back to implementation", replan: "Go back to planning",
  rerunQuality: "Rerun quality/security review", evidence: "Attach evidence and re-decide",
};
const answer = (decision, feedback = "") => ({ action: "accept", content: { decision, feedback } });
const auto = { autoApprovePlan: true, autoFinish: true };
const artifact = (h, name) => [...h.files.entries()].find(([file]) => file.endsWith(`/${name}`) && (name.startsWith("iterations/") || !file.includes("/iterations/")))?.[1].toString();
const plain = (value) => JSON.parse(JSON.stringify(value));
const entries = (h) => JSON.parse(artifact(h, "feedback.json")).entries;
const firstRun = ["1-plan", "2-implement", "3-requirement-coverage", "4-quality-security", "5-synthesis"];
const secondRun = firstRun.slice(1).map((label) => `${label} #2`);

function harness(options = {}) {
  const files = new Map();
  const journal = new Map();
  const calls = [];
  const commands = [];
  const prompts = [];
  const asked = [];
  const events = [];
  const answers = [...(options.answers ?? [])];
  const logs = [];
  const committed = { "src/feature.ts": "original", "docs/notes.md": "notes" };
  const work = { ...committed };
  for (const [name, content] of Object.entries(options.preexisting ?? {})) {
    if (content === null) delete work[name];
    else work[name] = content;
  }
  const state = { branch: "shared-branch", head: "a".repeat(40), staged: options.staged ?? "", committed, work };
  const commits = new Map([[state.head, committed]]);
  const trees = new Map();
  const realIndex = path.join(root, ".git/index");
  let issueReads = 0;
  let activeReviews = 0;
  let maxActiveReviews = 0;
  const replies = clone({
    "1-plan": {
      status: "ready", goal: "Solve the request", scope: { included: ["feature"], excluded: ["unrelated"] },
      acceptanceCriteria: [criterion], steps: ["Update feature", "Run focused test"], mitigations: [],
      rollback: "Revert the feature change", validationRequired: true, blockers: [],
    },
    "2-implement": { status: "complete", summary: "Implemented", changes: ["src/feature.ts"], checks: [check], deviations: [], blockers: [] },
    "3-requirement-coverage": {
      verdict: "pass", summary: "Behavior meets the requirements", coverage: ["src/feature.ts", "src/new.ts"],
      findings: [], checks: [check], criteria: [{ id: "AC1", status: "met", evidence: "Independent check passed" }],
    },
    "4-quality-security": { verdict: "pass", summary: "No concrete defects found", coverage: ["src/feature.ts", "src/new.ts"], findings: [], checks: [], criteria: [] },
    "5-synthesis": { recommendation: "successful", summary: "The request is solved", rationale: ["Both reviews pass"], findings: [], remainingRisks: [], nextSteps: [] },
    ...clone(options.replies ?? {}),
  });
  const changes = (from, to) => [...new Set([...Object.keys(from), ...Object.keys(to)])].sort().filter((name) => from[name] !== to[name]);
  const patchOf = (from, to) => changes(from, to)
    .map((name) => `diff --git a/${name} b/${name}\n${name in from ? `-${from[name]}\n` : ""}${name in to ? `+${to[name]}\n` : ""}`).join("");
  const nul = (names) => names.map((name) => name + "\0").join("");
  const gitOutput = (args, env) => {
    args = args.slice(1);
    const throwawayIndex = args[0] === "add" || args[0] === "write-tree";
    assert.equal(Boolean(env?.GIT_INDEX_FILE), throwawayIndex, `GIT_INDEX_FILE use for git ${args[0]}`);
    if (throwawayIndex) {
      assert.notEqual(env.GIT_INDEX_FILE, realIndex);
      assert.ok(files.has(env.GIT_INDEX_FILE), "throwaway index is seeded from the real index");
    }
    if (args[0] === "symbolic-ref") return state.branch + "\n";
    if (args[0] === "rev-parse") return ({ "--show-toplevel": root, "--absolute-git-dir": root + "/.git", "--git-path": ".git/index" }[args[1]] ?? state.head) + "\n";
    if (args[0] === "status") {
      const tracked = changes(state.committed, state.work).map((name) => `${!(name in state.work) ? " D" : !(name in state.committed) ? "??" : " M"} ${name}`);
      return nul([...(state.staged ? ["M  staged"] : []), ...tracked]);
    }
    if (args[0] === "ls-files") return nul(Object.keys(state.work).filter((name) => !(name in state.committed)).sort());
    if (args[0] === "add") return "";
    if (args[0] === "write-tree") {
      const id = "tree-" + crypto.createHash("sha256").update(JSON.stringify(Object.entries(state.work).sort())).digest("hex");
      trees.set(id, { ...state.work });
      return id + "\n";
    }
    if (args.includes("--cached")) return state.staged;
    if (args[0] === "diff") {
      const refs = args.filter((arg) => commits.has(arg) || trees.has(arg)).map((ref) => commits.get(ref) ?? trees.get(ref));
      const [from, to] = refs.length === 2 ? refs
        : [state.committed, Object.fromEntries(Object.entries(state.work).filter(([name]) => name in state.committed))];
      return args.includes("--name-only") ? nul(changes(from, to)) : patchOf(from, to);
    }
    throw new Error(`Unexpected git command ${args.join(" ")}`);
  };
  const execFile = (program, args, settings, callback) => {
    commands.push({ program, args, env: settings.env });
    assert.ok(settings.cwd === root || settings.cwd === "/cwd");
    let output;
    try {
      if (program === "git") output = gitOutput(args, settings.env);
      else if (program === "gh" && args[0] === "repo") output = JSON.stringify({ nameWithOwner: "RickardHF/Autonomous-Developer-Workflows", url: "https://github.com/RickardHF/Autonomous-Developer-Workflows" });
      else if (program === "gh" && args.at(-1).includes("/comments?")) output = "[[]]";
      else if (program === "gh") {
        issueReads++;
        output = JSON.stringify({
          number: 42, title: "Requested feature", body: options.staleIssue && issueReads > 1 ? "Changed request" : "Implement the feature",
          html_url: issueUrl, updated_at: "2026-10-27T10:00:00Z",
          ...(options.pullRequest ? { pull_request: {} } : {}),
        });
      } else throw new Error(`Unexpected program ${program}`);
      callback(null, output, "");
    } catch (error) {
      callback(error, "", error.message);
    }
  };
  const fs = {
    mkdir: async () => {},
    realpath: async (name) => name,
    writeFile: async (name, value) => files.set(name, Buffer.from(value)),
    rename: async (from, to) => {
      if (!files.has(from)) throw Object.assign(new Error(`ENOENT: ${from}`), { code: "ENOENT" });
      files.set(to, files.get(from));
      files.delete(from);
    },
    readFile: async (name, encoding) => {
      if (files.has(name)) return encoding ? files.get(name).toString(encoding) : files.get(name);
      const relative = path.relative(root, name);
      if (Object.hasOwn(state.work, relative)) return Buffer.from(state.work[relative]);
      throw Object.assign(new Error(`Missing file ${name}`), { code: "ENOENT" });
    },
    readdir: async (name) => {
      const prefix = name.endsWith(path.sep) ? name : name + path.sep;
      const entries = [...files.keys()].filter((entry) => entry.startsWith(prefix)).map((entry) => entry.slice(prefix.length)).filter((entry) => !entry.includes(path.sep));
      if (!entries.length && ![...files.keys()].some((entry) => entry.startsWith(prefix))) throw Object.assign(new Error(`Missing directory ${name}`), { code: "ENOENT" });
      return [...new Set(entries)];
    },
    unlink: async (name) => {
      if (!files.has(name)) throw Object.assign(new Error(`Missing file ${name}`), { code: "ENOENT" });
      files.delete(name);
    },
    copyFile: async (from, to) => {
      assert.equal(from, realIndex);
      files.set(to, Buffer.from("index copy"));
    },
    rm: async (name) => { files.delete(name); },
    lstat: async () => ({ mode: 0o100644, isFile: () => true, isSymbolicLink: () => false }),
    readlink: async () => { throw new Error("Not a symlink"); },
  };
  const modules = { "node:fs/promises": fs, "node:path": path, "node:crypto": crypto, "node:child_process": { execFile } };
  const run = vm.runInNewContext(
    `(${originalRun.toString().replaceAll("await import(", "await load(")})`,
    { load: async (name) => modules[name], process: { env: {}, cwd: () => "/cwd" }, URL, Buffer },
  );
  const ctx = {
    runId: "test-run", args: { issueUrl }, signal: new AbortController().signal,
    session: {
      capabilities: { ui: { elicitation: options.elicitation ?? true } },
      ui: {
        elicitation: async (params) => {
          assert.ok(asked.length < 20, "runaway prompts");
          asked.push(params);
          events.push("ask");
          const scripted = answers.shift();
          if (typeof scripted === "function") return scripted(params);
          if (scripted) return scripted;
          return answer(params.requestedSchema.properties.decision.enum[0]);
        },
      },
    },
    phase: () => {}, log: (message) => logs.push(message),
    step: async (key, producer) => {
      if (journal.has(key)) return clone(journal.get(key));
      const result = await producer();
      journal.set(key, clone(result));
      return result;
    },
    pause: async (key) => {
      if (paused.has(key)) return;
      paused.add(key);
      if (key.startsWith("parked-") && options.autoCloseParked !== false) {
        const pendingPath = path.join(root, ".git", "implementation-flow", ctx.runId, "pending-decision.json");
        const pending = JSON.parse(files.get(pendingPath).toString());
        const location = path.join(root, ".git", "implementation-flow", ctx.runId, "inbox", `${pending.key}.json`);
        files.set(location, Buffer.from(JSON.stringify({
          id: crypto.randomUUID(), key: pending.key, action: "close", feedback: "", source: "test",
        })));
        return;
      }
      throw Object.assign(new Error(`Paused at ${key}`), { name: "AbortError", code: "ABORT_ERR" });
    },
    parallel: async (thunks) => Promise.all(thunks.map(async (thunk) => {
      try { return await thunk(); } catch (error) { logs.push(error.message); return null; }
    })),
    agent: async (prompt, agentOptions) => {
      const label = agentOptions.label;
      const base = label.replace(/ #\d+$/, "");
      calls.push(label);
      events.push(label);
      prompts.push({ label, prompt, schema: agentOptions.schema });
      if (base === "2-implement") {
        state.work["src/feature.ts"] = `implemented by ${label}`;
        state.work["src/new.ts"] = "new file";
        if (options.commitDuringImplementation) state.head = "b".repeat(40);
        if (options.stageDuringImplementation) state.staged += "staged by agent";
        options.duringImplementation?.(state);
      }
      if (base === "3-requirement-coverage" || base === "4-quality-security") {
        activeReviews++;
        maxActiveReviews = Math.max(maxActiveReviews, activeReviews);
        await new Promise((resolve) => setImmediate(resolve));
        activeReviews--;
        if (options.mutateDuringReview) state.work["src/feature.ts"] = "review changed source";
        if (options.tamperArtifact) {
          const entry = [...files.keys()].find((name) => name.endsWith("/plan.json"));
          files.set(entry, Buffer.from("{}"));
        }
      }
      return clone(Object.hasOwn(replies, label) ? replies[label] : replies[base]);
    },
  };
  const paused = new Set();
  return {
    ctx, state, files, replies, calls, commands, prompts, logs, journal, asked, events, answers,
    writeInbox: (key, action, feedback = "", extra = {}) => {
      const location = path.join(root, ".git", "implementation-flow", ctx.runId, "inbox", `${key}.json`);
      files.set(location, Buffer.from(JSON.stringify({ id: crypto.randomUUID(), key, action, feedback, source: "dashboard", ...extra })));
    },
    queueFeedback: (feedback) => {
      const id = crypto.randomUUID();
      const location = path.join(root, ".git", "implementation-flow", ctx.runId, "inbox", `feedback-${id}.json`);
      files.set(location, Buffer.from(JSON.stringify({ id, feedback, source: "chat" })));
    },
    execute: async () => {
      if (ctx.args && typeof ctx.args === "object" && !Object.hasOwn(ctx.args, "decisionChannel")) {
        ctx.args = { ...ctx.args, decisionChannel: options.decisionChannel ?? "prompt" };
      }
      return clone(await run(ctx));
    },
    get maxActiveReviews() { return maxActiveReviews; },
  };
}

test("metadata declares exclusive issue or task inputs and the five pipeline phases", () => {
  assert.equal(meta.name, "implementation-flow");
  assert.deepEqual(meta.argsSchema.oneOf, [
    { type: "object", required: ["issueUrl"], not: { anyOf: [{ required: ["taskTitle"] }, { required: ["taskDescription"] }] } },
    { type: "object", required: ["taskTitle", "taskDescription"], not: { required: ["issueUrl"] } },
  ]);
  assert.deepEqual(Object.keys(meta.argsSchema.properties), ["issueUrl", "taskTitle", "taskDescription", "autoApprovePlan", "autoFinish", "decisionChannel"]);
  assert.equal(meta.argsSchema.additionalProperties, false);
  assert.deepEqual(meta.phases.map((phase) => phase.title), ["Prepare", "Plan", "Implement", "Review", "Summarize"]);
  assert.equal(meta.limits, undefined);
});

test("argsSchema declares a type on every node with properties or required, as the Copilot runtime requires at registration", () => {
  const missing = [];
  const walk = (node, at) => {
    if (node === null || typeof node !== "object") return;
    if (("properties" in node || "required" in node) && typeof node.type !== "string") missing.push(at);
    for (const [key, child] of Object.entries(node.properties ?? {})) walk(child, `${at}.properties.${key}`);
    if (node.items) walk(node.items, `${at}.items`);
    for (const keyword of ["anyOf", "oneOf", "allOf"]) (node[keyword] ?? []).forEach((child, index) => walk(child, `${at}.${keyword}[${index}]`));
  };
  walk(meta.argsSchema, "$");
  assert.deepEqual(missing, []);
});

test("task input runs all stages without GitHub and persists requirements, result and report", async () => {
  const h = harness();
  h.ctx.args = { taskTitle: "Requested task", taskDescription: "Implement **the behavior**.\nPreserve compatibility." };
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.equal(result.taskTitle, h.ctx.args.taskTitle);
  assert.equal(result.artifacts, path.join(root, ".git", "implementation-flow", h.ctx.runId));
  assert.deepEqual(result.reviewAvailability, { requirements: true, qualitySecurity: true });
  assert.equal(Object.hasOwn(result, "issueUrl"), false);
  assert.equal(h.calls.length, 5);
  assert.equal(h.maxActiveReviews, 2);
  assert.equal(h.commands.some(({ program }) => program === "gh"), false);
  const artifact = (name) => [...h.files.entries()].find(([file]) => file.endsWith(`/${name}`))?.[1].toString();
  assert.deepEqual(JSON.parse(artifact("task.json")), {
    title: h.ctx.args.taskTitle, description: h.ctx.args.taskDescription,
  });
  assert.equal(artifact("issue.json"), undefined);
  assert.equal(JSON.parse(artifact("requirements-review.json")).available, true);
  assert.equal(typeof JSON.parse(artifact("context.json")).taskRequirementDigest, "string");
  for (const { prompt } of h.prompts) {
    assert.match(prompt, /task\.json/);
    assert.doesNotMatch(prompt, /\/issue\.json/);
  }
  assert.match(h.prompts[0].prompt, /plan for the task/);
  assert.match(h.prompts[2].prompt, /solves the original task/);
  assert.match(h.prompts[4].prompt, /solves the task/);
  assert.match(artifact("report.md"), /# Task implementation: successful/);
  assert.ok(artifact("report.md").includes(h.ctx.args.taskTitle));
  assert.ok(artifact("report.md").includes(h.ctx.args.taskDescription));
  assert.equal((await h.execute()).recommendation, "successful");
  assert.equal(h.calls.length, 5);
  h.ctx.args.taskDescription = "Different requirements";
  await assert.rejects(h.execute(), /inputs changed/);
});

test("missing, mixed, blank, non-string and unknown inputs fail before commands or agents", async () => {
  for (const args of [
    undefined, null, [], {}, { issueUrl: "" }, { issueUrl: " " }, { issueUrl: 42 },
    { taskTitle: "Task" }, { taskDescription: "Description" },
    { taskTitle: "", taskDescription: "Description" }, { taskTitle: "Task", taskDescription: " \n" },
    { taskTitle: 42, taskDescription: "Description" }, { taskTitle: "Task", taskDescription: {} },
    { issueUrl, taskTitle: "Task" }, { issueUrl, taskDescription: "Description" },
    { issueUrl, taskTitle: "Task", taskDescription: "Description" }, { issueUrl, unexpected: true },
  ]) {
    const h = harness();
    h.ctx.args = args;
    await assert.rejects(h.execute(), /Provide either/);
    assert.equal(h.calls.length, 0);
    assert.equal(h.commands.length, 0);
  }
});

test("task input retains blocked-plan and failed-validation gates", async () => {
  const args = { taskTitle: "Task", taskDescription: "Implement behavior" };
  const blocked = harness();
  blocked.ctx.args = { ...args, autoApprovePlan: true };
  blocked.replies["1-plan"].status = "blocked";
  blocked.replies["1-plan"].blockers = ["Need a decision"];
  assert.equal((await blocked.execute()).recommendation, "inconclusive");
  assert.deepEqual(blocked.calls, ["1-plan"]);
  const failed = harness();
  failed.ctx.args = args;
  failed.replies["2-implement"].checks[0].outcome = "failed";
  assert.equal((await failed.execute()).recommendation, "unsuccessful");
});

test("resume cannot switch between issue and task input modes", async () => {
  for (const startWithTask of [false, true]) {
    const h = harness();
    const task = { taskTitle: "Task", taskDescription: "Implement behavior" };
    h.ctx.args = startWithTask ? task : { issueUrl };
    await h.execute();
    h.ctx.args = startWithTask ? { issueUrl } : task;
    await assert.rejects(h.execute(), /inputs changed/);
    assert.equal(h.calls.length, 5);
  }
});

test("five isolated stages, parallel reviews, new-file coverage, persistent report, same branch", async () => {
  const h = harness();
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.deepEqual(h.calls, ["1-plan", "2-implement", "3-requirement-coverage", "4-quality-security", "5-synthesis"]);
  assert.equal(h.maxActiveReviews, 2);
  assert.equal(result.branch, "shared-branch");
  assert.deepEqual(result.changedFiles, ["src/feature.ts", "src/new.ts"]);
  assert.ok([...h.files.keys()].some((name) => name.endsWith("/report.md")));
  const coveragePrompt = h.prompts.find(({ label }) => label === "3-requirement-coverage").prompt;
  assert.match(coveragePrompt, /untracked-files\.json/);
  assert.doesNotMatch(coveragePrompt, /quality-security-review\.json/);
  const staticPrompt = h.prompts.find(({ label }) => label === "4-quality-security").prompt;
  assert.match(staticPrompt, /static inspection only/);
  assert.doesNotMatch(staticPrompt, /requirements-review\.json/);
});

test("completed runs remain closed and are not reopened by replay", async () => {
  const h = harness();
  const completed = await h.execute();
  assert.equal(completed.closed, true);
  assert.equal((await h.execute()).recommendation, "successful");
  assert.equal(h.calls.length, 5);
  h.state.work["src/feature.ts"] = "external edit";
  assert.deepEqual(await h.execute(), completed);
  assert.equal(h.calls.length, 5);
});

test("cross-repository issue fails before any agent", async () => {
  const cross = harness();
  cross.ctx.args.issueUrl = "https://github.com/someone/another/issues/42";
  await assert.rejects(cross.execute(), /belong to this checked-out/);
  assert.equal(cross.calls.length, 0);
});

const preexisting = { "docs/notes.md": "notes plus the requester's edit", "scratch.txt": "requester's untracked file", "src/feature.ts": "requester's work in progress" };

test("a dirty checkout runs; pre-existing changes are preserved and excluded from this run's diff", async () => {
  const h = harness({ preexisting, staged: "requester staged change", answers: [answer(labels.approve), answer(labels.finish)] });
  h.ctx.args = { taskTitle: "Task", taskDescription: "Implement behavior" };
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.deepEqual(h.calls, ["1-plan", "2-implement", "3-requirement-coverage", "4-quality-security", "5-synthesis"]);
  // The agent's edit on top of the requester's edit to src/feature.ts is attributed; untouched pre-existing changes are not.
  assert.deepEqual(result.changedFiles, ["src/feature.ts", "src/new.ts"]);
  assert.deepEqual(result.preexistingChanges, ["docs/notes.md", "scratch.txt", "src/feature.ts"]);
  const patch = artifact(h, "changes.patch");
  assert.match(patch, /-requester's work in progress\n\+implemented by 2-implement/);
  assert.match(patch, /\+new file/);
  assert.doesNotMatch(patch, /notes plus|untracked file/);
  assert.deepEqual(JSON.parse(artifact(h, "untracked-files.json")).map((entry) => entry.path), ["src/new.ts"]);
  const context = JSON.parse(artifact(h, "context.json"));
  assert.deepEqual(context.preexistingChanges, result.preexistingChanges);
  assert.equal(JSON.parse(artifact(h, "review-snapshot.json")).baseTree, context.baseTree);
  assert.equal(h.state.work["docs/notes.md"], preexisting["docs/notes.md"]);
  assert.equal(h.state.work["scratch.txt"], preexisting["scratch.txt"]);
  assert.equal(h.state.staged, "requester staged change");
  assert.match(h.asked[0].message, /already had uncommitted changes before this run \(3 file/);
  for (const [label, text] of [["1-plan", /Do not plan to revert/], ["2-implement", /Preserve them/], ["3-requirement-coverage", /only this run's changes/], ["4-quality-security", /only this run's changes/]]) {
    assert.match(h.prompts.find((entry) => entry.label === label).prompt, text, label);
  }
  assert.match(artifact(h, "report.md"), /Pre-existing uncommitted changes \(kept, not part of changes\.patch\): docs\/notes\.md, scratch\.txt, src\/feature\.ts/);
  assert.match(artifact(h, "report.md"), /git apply -R .*\/changes\.patch/);
  assert.equal([...h.files.keys()].some((name) => name.endsWith("worktree.index")), false);
  assert.ok(h.commands.some(({ args }) => args[1] === "add" && args.includes("--all")));
});

test("a clean checkout gets no pre-existing-change guidance", async () => {
  const h = harness();
  const result = await h.execute();
  assert.deepEqual(result.preexistingChanges, []);
  assert.doesNotMatch(h.asked[0].message, /uncommitted changes before this run/);
  for (const { prompt } of h.prompts) assert.doesNotMatch(prompt, /started with uncommitted changes/);
  assert.match(artifact(h, "changes.patch"), /\+new file/);
});

test("a dirty start still detects edits outside implementation and reverted pre-existing work is attributed", async () => {
  await assert.rejects(harness({ preexisting, mutateDuringReview: true }).execute(), /Checkout changed/);
  const h = harness({ preexisting, duringImplementation: (state) => { state.work["docs/notes.md"] = "notes"; } });
  h.ctx.args = { taskTitle: "Task", taskDescription: "Implement behavior", ...auto };
  const result = await h.execute();
  assert.deepEqual(result.changedFiles, ["docs/notes.md", "src/feature.ts", "src/new.ts"]);
  assert.match(artifact(h, "changes.patch"), /-notes plus the requester's edit\n\+notes/);
});

test("a dirty start rejects an implementation that changes the requester's staged index", async () => {
  await assert.rejects(harness({ preexisting, staged: "requester staged change", stageDuringImplementation: true }).execute(), /branch, HEAD, or index/);
});

test("invalid URL and PR inputs fail visibly", async () => {
  for (const issueUrl of ["not a URL", "http://github.com/a/b/issues/1", "https://github.com/a/b/pull/1", "https://github.com/a/b/issues/0", "https://github.com/a/b/issues/1?x=y"]) {
    const h = harness();
    h.ctx.args.issueUrl = issueUrl;
    await assert.rejects(h.execute(), /canonical HTTPS/);
    assert.equal(h.calls.length, 0);
  }
  await assert.rejects(harness({ pullRequest: true }).execute(), /pull request/);
});

test("blocked planning preserves blockers without starting implementation", async () => {
  const h = harness();
  h.ctx.args = { issueUrl, autoApprovePlan: true };
  h.replies["1-plan"].status = "blocked";
  h.replies["1-plan"].acceptanceCriteria = [];
  h.replies["1-plan"].blockers = ["Need an acceptance decision"];
  const result = await h.execute();
  assert.equal(result.recommendation, "inconclusive");
  assert.deepEqual(result.blockers, ["Need an acceptance decision"]);
  assert.deepEqual(h.calls, ["1-plan"]);
});

test("null planning fails; null implementation cannot become successful", async () => {
  await assert.rejects(harness({ replies: { "1-plan": null } }).execute(), /Planning did not return/);
  const h = harness({ replies: { "2-implement": null } });
  const result = await h.execute();
  assert.equal(result.recommendation, "unsuccessful");
  assert.ok(h.logs.some((message) => message.includes("failed to return output")));
});

test("implementation cannot commit or stage changes", async () => {
  await assert.rejects(harness({ commitDuringImplementation: true }).execute(), /branch, HEAD, or index/);
  await assert.rejects(harness({ stageDuringImplementation: true }).execute(), /branch, HEAD, or index/);
});

test("missing and structurally invalid review cannot count as passing", async () => {
  const missing = harness({ replies: { "4-quality-security": null } });
  assert.equal((await missing.execute()).recommendation, "inconclusive");
  const invalid = harness();
  invalid.replies["3-requirement-coverage"].criteria = [];
  assert.equal((await invalid.execute()).recommendation, "inconclusive");
  assert.ok(invalid.logs.some((message) => message.includes("invalid acceptance coverage")));
});

test("read-only review source or artifact tampering halts rather than masking failure", async () => {
  await assert.rejects(harness({ mutateDuringReview: true }).execute(), /Checkout changed/);
  await assert.rejects(harness({ tamperArtifact: true }).execute(), /Handoff artifact changed/);
});

test("high security finding overrides optimistic synthesis and appears in severity table", async () => {
  const h = harness();
  h.replies["4-quality-security"].findings = [finding];
  h.replies["5-synthesis"].findings = [{ source: "quality-security-review", id: "Q1", disposition: "accepted", reason: "Reachable from request input" }];
  const result = await h.execute();
  assert.equal(result.recommendation, "unsuccessful");
  const report = [...h.files.entries()].find(([name]) => name.endsWith("/report.md"))[1].toString();
  assert.match(report, /\u{1F7E0} HIGH/u);
  assert.match(report, /\| # \| Severity \| File \| Lines \| Vulnerability \| Confidence \|/);
});

test("requirement review findings retain their source through synthesis and the report", async () => {
  const h = harness();
  h.ctx.args = { taskTitle: "Task", taskDescription: "Implement behavior" };
  h.replies["3-requirement-coverage"].findings = [{ ...finding, id: "R1", category: "functional" }];
  h.replies["5-synthesis"].findings = [{ source: "requirements-review", id: "R1", disposition: "accepted", reason: "Requirement not met" }];
  const result = await h.execute();
  assert.equal(result.recommendation, "unsuccessful");
  assert.equal(result.synthesis.findings[0].source, "requirements-review");
  const synthesis = h.prompts.find(({ label }) => label === "5-synthesis");
  assert.match(synthesis.prompt, /requirements-review\.json/);
  assert.deepEqual([...synthesis.schema.properties.findings.items.properties.source.enum], ["requirements-review", "quality-security-review"]);
  const report = [...h.files.entries()].find(([name]) => name.endsWith("/report.md"))[1].toString();
  assert.match(report, /requirements-review:R1/);
});

test("unmet requirement and failed check prevent success", async () => {
  const unmet = harness();
  unmet.replies["3-requirement-coverage"].criteria[0].status = "not-met";
  assert.equal((await unmet.execute()).recommendation, "unsuccessful");
  const failed = harness();
  failed.replies["2-implement"].checks[0].outcome = "failed";
  assert.equal((await failed.execute()).recommendation, "unsuccessful");
});

test("unverified acceptance, missing validation, and stale issue remain inconclusive", async () => {
  const unverified = harness();
  unverified.replies["3-requirement-coverage"].criteria[0].status = "unverified";
  assert.equal((await unverified.execute()).recommendation, "inconclusive");
  const noChecks = harness();
  noChecks.replies["2-implement"].checks = [];
  assert.equal((await noChecks.execute()).recommendation, "inconclusive");
  assert.equal((await harness({ staleIssue: true }).execute()).recommendation, "inconclusive");
});

test("synthesis must return output and account for every finding", async () => {
  await assert.rejects(harness({ replies: { "5-synthesis": null } }).execute(), /Synthesis did not return/);
  const missing = harness();
  missing.replies["4-quality-security"].findings = [finding];
  await assert.rejects(missing.execute(), /every review finding/);
});


test("flags must be booleans and unknown inputs stay rejected", async () => {
  for (const args of [{ issueUrl, autoFinish: "yes" }, { issueUrl, autoApprovePlan: 1 }, { taskTitle: "T", taskDescription: "D", autoFinish: null }]) {
    const h = harness();
    h.ctx.args = args;
    await assert.rejects(h.execute(), /must be a boolean/);
    assert.equal(h.commands.length + h.calls.length + h.asked.length, 0);
  }
  const h = harness();
  h.ctx.args = { issueUrl, autoFinish: true, surprise: true };
  await assert.rejects(h.execute(), /Provide either/);
});

test("both flags true run without prompts and without a session", async () => {
  const h = harness();
  h.ctx.args = { issueUrl, ...auto };
  h.ctx.session = undefined;
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.equal(result.iteration, 1);
  assert.deepEqual(h.calls, firstRun);
  assert.equal(h.asked.length, 0);
  assert.equal(artifact(h, "feedback.json"), undefined);
});

test("prompting without host elicitation support fails before any command or agent", async () => {
  for (const args of [{ issueUrl }, { issueUrl, autoApprovePlan: true }, { issueUrl, autoFinish: true }]) {
    for (const session of [undefined, { capabilities: {} }, { capabilities: { ui: { elicitation: false } } }]) {
      const h = harness();
      h.ctx.args = args;
      h.ctx.session = session;
      await assert.rejects(h.execute(), /elicitation.*autoApprovePlan and autoFinish both true/);
      assert.equal(h.commands.length + h.calls.length, 0);
    }
  }
});

test("the inbox decision channel pauses durably, rejects missing feedback, and resumes without elicitation", async () => {
  const h = harness({ decisionChannel: "inbox" });
  h.ctx.session.capabilities.ui.elicitation = false;
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  const pending = JSON.parse(artifact(h, "pending-decision.json"));
  assert.equal(pending.key, "plan-approval-v1");
  assert.equal(pending.kind, "plan-approval");
  assert.deepEqual(pending.options.map(({ action }) => action), ["approve", "revise", "stop"]);
  h.writeInbox("plan-approval-v1", "revise");
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-2/);
  assert.match(JSON.parse(artifact(h, "pending-decision.json")).message, /invalid or missing required feedback/);
  h.writeInbox("plan-approval-v1", "approve", "Reviewed in dashboard");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-wait-1/);
  assert.equal(artifact(h, "pending-decision.json") && JSON.parse(artifact(h, "pending-decision.json")).kind, "post-review");
  h.writeInbox("review-decision-v1", "finish");
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.equal(h.asked.length, 0);
  assert.deepEqual(entries(h), [{ iteration: 1, source: "dashboard", action: "approve", feedback: "Reviewed in dashboard" }]);
  assert.equal(artifact(h, "pending-decision.json"), undefined);
});

test("chat feedback added while awaiting approval reaches implementation", async () => {
  const h = harness({ decisionChannel: "inbox" });
  h.ctx.session.capabilities.ui.elicitation = false;
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  h.queueFeedback("Keep the public API stable.");
  h.writeInbox("plan-approval-v1", "approve");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-wait-1/);
  assert.match(h.prompts.find(({ label }) => label === "2-implement").prompt, /feedback\.json/);
  assert.deepEqual(entries(h).at(-1), {
    iteration: 1, source: "chat", action: "feedback", feedback: "Keep the public API stable.",
  });
});

test("edited plans are schema-validated, versioned, and used for implementation", async () => {
  const h = harness({ decisionChannel: "inbox" });
  h.ctx.session.capabilities.ui.elicitation = false;
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  const edited = clone(h.replies["1-plan"]);
  edited.goal = "Solve the request with the edited approach";
  edited.steps = ["Use the edited approach", "Run focused test"];
  h.writeInbox("plan-approval-v1", "approve", "", { plan: edited });
  await assert.rejects(h.execute(), /Paused at review-decision-v1-wait-1/);
  assert.equal(JSON.parse(artifact(h, "plan.json")).goal, edited.goal);
  assert.equal(JSON.parse(artifact(h, "plan-v1.json")).goal, "Solve the request");
  assert.equal(JSON.parse(artifact(h, "plan-v2.json")).goal, edited.goal);
  assert.match(h.prompts.find(({ label }) => label === "2-implement").prompt, /plan\.json/);
});

test("invalid edited plan content is rejected before approval", async () => {
  const h = harness({ decisionChannel: "inbox" });
  h.ctx.session.capabilities.ui.elicitation = false;
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  h.writeInbox("plan-approval-v1", "approve", "", { plan: { ...clone(h.replies["1-plan"]), extra: true } });
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-2/);
  assert.match(JSON.parse(artifact(h, "pending-decision.json")).message, /invalid or missing required feedback/);
});

test("issue changes are shown with a re-plan-or-ignore choice and refresh requirements when accepted", async () => {
  const h = harness({ decisionChannel: "inbox", staleIssue: true, autoCloseParked: false });
  h.ctx.session.capabilities.ui.elicitation = false;
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  h.writeInbox("plan-approval-v1", "approve");
  await assert.rejects(h.execute(), /Paused at issue-delta-1-wait-1/);
  assert.match(JSON.parse(artifact(h, "issue-delta.json")).body.after, /Changed request/);
  const pending = JSON.parse(artifact(h, "pending-decision.json"));
  assert.equal(pending.kind, "issue-delta");
  assert.match(pending.message, /Changed request/);
  h.writeInbox("issue-delta-1", "refresh");
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-2-wait-1/);
  assert.equal(JSON.parse(artifact(h, "issue.json")).body, "Changed request");
  assert.ok([...h.files.keys()].some((name) => /\/iterations\/1\/issue-[a-f0-9]+\.json$/.test(name)));
  h.writeInbox("plan-approval-v1-2", "approve");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-2-wait-1/);
  h.writeInbox("review-decision-v1-2", "close");
  const result = await h.execute();
  assert.equal(result.iteration, 2);
  assert.equal(result.gate.uncertainties.some((item) => /issue requirements\/comments changed/.test(item)), false);
});

test("the plan is shown for approval before implementation and the result is shown before finishing", async () => {
  const h = harness();
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.deepEqual(h.events, ["1-plan", "ask", ...firstRun.slice(1), "ask"]);
  const [approval, finish] = h.asked;
  assert.match(approval.message, /Plan ready for approval \(iteration 1, plan version 1\)/);
  assert.match(approval.message, /Solve the request/);
  assert.match(approval.message, /AC1: The requested behavior works\./);
  assert.match(approval.message, /plan\.json/);
  assert.deepEqual(plain(approval.requestedSchema.properties.decision.enum), [labels.approve, labels.revise, labels.stopPlan]);
  assert.equal(approval.requestedSchema.properties.decision.default, labels.approve);
  assert.match(finish.message, /Iteration 1 finished: successful/);
  assert.match(finish.message, /report\.md/);
  assert.deepEqual(plain(finish.requestedSchema.properties.decision.enum), [
    labels.finish, labels.reimplement, labels.replan, "Rerun requirement review", labels.rerunQuality,
    "Rerun both reviews", "Rerun synthesis", labels.evidence, "Close run",
  ]);
  assert.equal(artifact(h, "feedback.json"), undefined);
  for (const { prompt } of h.prompts) assert.doesNotMatch(prompt, /feedback\.json/);
});

test("Finish parks a run; reopening with a prompt can rerun synthesis and then close", async () => {
  const h = harness({ decisionChannel: "inbox", autoCloseParked: false });
  h.ctx.session.capabilities.ui.elicitation = false;
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  h.writeInbox("plan-approval-v1", "approve");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-wait-1/);
  h.writeInbox("review-decision-v1", "finish");
  await assert.rejects(h.execute(), /Paused at parked-1-wait-1/);
  assert.equal(JSON.parse(artifact(h, "result.json")).parked, true);
  assert.equal(JSON.parse(artifact(h, "pending-decision.json")).kind, "parked");

  h.writeInbox("parked-1", "reopen", "Please reconsider the independent verification");
  await assert.rejects(h.execute(), /Paused at reopen-point-1-wait-1/);
  assert.deepEqual(JSON.parse(artifact(h, "pending-decision.json")).options.map(({ action }) => action),
    ["plan", "implement", "reviews", "synthesis"]);
  h.writeInbox("reopen-point-1", "synthesis");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-r1-wait-1/);
  assert.deepEqual(h.calls, [...firstRun, "5-synthesis"]);
  assert.ok(artifact(h, "iterations/1/reruns/1/summary.json"));
  h.writeInbox("review-decision-v1-r1", "close");
  const result = await h.execute();
  assert.notEqual(result.parked, true);
  assert.equal(artifact(h, "pending-decision.json"), undefined);
  assert.deepEqual(entries(h).at(-1), {
    iteration: 1, source: "dashboard", action: "reopen", feedback: "Please reconsider the independent verification",
  });
});

test("verification evidence can re-decide a parked run without rerunning reviews", async () => {
  const h = harness({ decisionChannel: "inbox", autoCloseParked: false });
  h.ctx.session.capabilities.ui.elicitation = false;
  h.replies["2-implement"].checks = [];
  h.replies["3-requirement-coverage"].criteria[0].status = "unverified";
  await assert.rejects(h.execute(), /Paused at plan-approval-v1-wait-1/);
  h.writeInbox("plan-approval-v1", "approve");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-wait-1/);
  h.writeInbox("review-decision-v1", "finish");
  await assert.rejects(h.execute(), /Paused at parked-1-wait-1/);
  const location = path.join(root, ".git", "implementation-flow", h.ctx.runId, "verification.json");
  h.files.set(location, Buffer.from(JSON.stringify([{
    id: "external-browser", criterionId: "AC1", description: "Browser verification",
    outcome: "passed", evidence: "The feature rendered correctly.", source: "dashboard",
  }])));
  h.writeInbox("parked-1", "evidence");
  await assert.rejects(h.execute(), /Paused at review-decision-v1-r1-wait-1/);
  assert.equal(h.calls.filter((label) => label.startsWith("3-") || label.startsWith("4-")).length, 2);
  assert.equal(h.calls.filter((label) => label === "5-synthesis").length, 2);
  assert.equal(JSON.parse(artifact(h, "result.json")).recommendation, "successful");
  h.writeInbox("review-decision-v1-r1", "close");
  assert.equal((await h.execute()).closed, true);
});

test("post-review can rerun only the selected reviewer and archives replaced evidence", async () => {
  const h = harness({ answers: [answer(labels.approve), answer(labels.rerunQuality), answer(labels.finish)] });
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.deepEqual(h.calls, [...firstRun, "4-quality-security", "5-synthesis"]);
  assert.ok(artifact(h, "iterations/1/reruns/1/quality-security-review.json"));
  assert.ok(h.journal.has("quality-security-review-v1-r1"));
  assert.ok(h.journal.has("summarize-v1-r1"));
});

test("passing attached evidence resolves only unverified criteria and missing validation", async () => {
  const h = harness({
    answers: [answer(labels.approve), () => {
      const location = path.join(root, ".git", "implementation-flow", h.ctx.runId, "verification.json");
      h.files.set(location, Buffer.from(JSON.stringify([{
        id: "browser-check", criterionId: "AC1", description: "Browser verification",
        outcome: "passed", evidence: "The expected result rendered.", source: "dashboard",
      }])));
      return answer(labels.evidence);
    }, answer(labels.finish)],
  });
  h.replies["2-implement"].checks = [];
  h.replies["3-requirement-coverage"].criteria[0].status = "unverified";
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.equal(result.gate.maximumRecommendation, "successful");
  assert.deepEqual(JSON.parse(artifact(h, "verification.json"))[0].id, "browser-check");
  assert.ok(h.journal.has("verification-v1-1-r1"));

  const notMet = harness({
    answers: [answer(labels.approve), () => {
      const location = path.join(root, ".git", "implementation-flow", h.ctx.runId, "verification.json");
      h.files.set(location, Buffer.from(JSON.stringify([{
        id: "browser-check", criterionId: "AC1", description: "Browser verification",
        outcome: "passed", evidence: "The expected result rendered.", source: "dashboard",
      }])));
      return answer(labels.evidence);
    }, answer(labels.finish)],
  });
  notMet.replies["3-requirement-coverage"].criteria[0].status = "not-met";
  assert.equal((await notMet.execute()).recommendation, "unsuccessful");

  const failedEvidence = harness({
    answers: [answer(labels.approve), () => {
      const location = path.join(root, ".git", "implementation-flow", failedEvidence.ctx.runId, "verification.json");
      failedEvidence.files.set(location, Buffer.from(JSON.stringify([{
        id: "browser-failure", criterionId: "AC1", description: "Browser verification",
        outcome: "failed", evidence: "The feature did not render.", source: "dashboard",
      }])));
      return answer(labels.evidence);
    }, answer(labels.finish)],
  });
  assert.equal((await failedEvidence.execute()).recommendation, "unsuccessful");
});

test("only one flag skips only its own prompt", async () => {
  const approvalOnly = harness();
  approvalOnly.ctx.args = { issueUrl, autoFinish: true };
  await approvalOnly.execute();
  assert.deepEqual(approvalOnly.events, ["1-plan", "ask", ...firstRun.slice(1)]);
  const finishOnly = harness();
  finishOnly.ctx.args = { issueUrl, autoApprovePlan: true };
  await finishOnly.execute();
  assert.deepEqual(finishOnly.events, [...firstRun, "ask"]);
});

test("approval notes become protected guidance for later stages", async () => {
  const h = harness({ answers: [answer(labels.approve, "Keep the public API stable")] });
  await h.execute();
  assert.deepEqual(entries(h), [{ iteration: 1, source: "plan-approval", action: "approve", feedback: "Keep the public API stable" }]);
  for (const label of firstRun.slice(1)) {
    const { prompt } = h.prompts.find((item) => item.label === label);
    assert.match(prompt, /feedback\.json/);
    assert.match(prompt, /cannot authorize forbidden actions/);
  }
  assert.match(h.prompts.find(({ label }) => label === "3-requirement-coverage").prompt, /every change the requester asked for/);
  assert.match(artifact(h, "report.md"), /## Human feedback\n- Iteration 1, plan-approval \(approve\): Keep the public API stable/);
});

test("requesting plan changes re-plans with the rejected plan and feedback, then asks again", async () => {
  const h = harness({
    answers: [answer(labels.revise, "Also cover the CLI flag"), answer(labels.approve)],
    replies: { "1-plan #2": { goal: "Revised goal" } },
  });
  h.replies["1-plan #2"] = { ...h.replies["1-plan"], goal: "Revised goal" };
  const result = await h.execute();
  assert.equal(result.recommendation, "successful");
  assert.deepEqual(h.calls, ["1-plan", "1-plan #2", ...firstRun.slice(1)]);
  assert.deepEqual(h.events.slice(0, 5), ["1-plan", "ask", "1-plan #2", "ask", "2-implement"]);
  const replan = h.prompts[1].prompt;
  assert.match(replan, /rejected an earlier plan/);
  assert.match(replan, /iterations\/1\/plan-rejected-1\.json/);
  assert.match(replan, /feedback\.json/);
  assert.equal(JSON.parse(artifact(h, "plan.json")).goal, "Revised goal");
  assert.equal(JSON.parse(artifact(h, "iterations/1/plan-rejected-1.json")).goal, "Solve the request");
  assert.match(h.asked[1].message, /plan version 2/);
  assert.deepEqual(entries(h), [{ iteration: 1, source: "plan-approval", action: "revise", feedback: "Also cover the CLI flag" }]);
});

test("a plan change request without feedback is asked again instead of guessed", async () => {
  const h = harness({ answers: [answer(labels.revise, "  "), answer(labels.revise), answer(labels.approve)] });
  await h.execute();
  assert.equal(h.calls.filter((label) => label.startsWith("1-plan")).length, 1);
  assert.equal(h.asked.length, 4);
  for (const index of [1, 2]) assert.match(h.asked[index].message, /^\*\*Request plan changes\*\* needs a description/);
  assert.doesNotMatch(h.asked[0].message, /needs a description/);
});

test("stopping, declining or dismissing plan approval never implements", async () => {
  for (const scripted of [answer(labels.stopPlan), { action: "decline" }, { action: "cancel" }, answer("unknown choice")]) {
    const h = harness({ answers: [scripted] });
    const result = await h.execute();
    assert.equal(result.recommendation, "inconclusive");
    assert.equal(result.stage, "plan");
    assert.match(result.blockers[0], /did not approve the plan/);
    assert.deepEqual(h.calls, ["1-plan"]);
    assert.equal(JSON.parse(artifact(h, "result.json")).stage, "plan");
    assert.equal(h.asked.length, 1);
  }
});

test("a blocked plan can be clarified and re-planned, stopped, or left blocked automatically", async () => {
  const blockedReply = { status: "blocked", acceptanceCriteria: [], blockers: ["Need an acceptance decision"] };
  const clarified = harness({ answers: [answer(labels.clarify, "Use option A")] });
  clarified.replies["1-plan #2"] = clarified.replies["1-plan"];
  clarified.replies["1-plan"] = blockedReply;
  assert.equal((await clarified.execute()).recommendation, "successful");
  assert.deepEqual(clarified.calls.slice(0, 3), ["1-plan", "1-plan #2", "2-implement"]);
  assert.equal(JSON.parse(artifact(clarified, "iterations/1/plan-rejected-1.json")).status, "blocked");
  assert.match(clarified.asked[0].message, /Planning is blocked[\s\S]*Need an acceptance decision/);
  assert.deepEqual(plain(clarified.asked[0].requestedSchema.properties.decision.enum), [labels.clarify, "Stop"]);
  assert.deepEqual(entries(clarified), [{ iteration: 1, source: "plan-approval", action: "clarify", feedback: "Use option A" }]);
  const stopped = harness({ answers: [answer("Stop")], replies: { "1-plan": blockedReply } });
  const result = await stopped.execute();
  assert.deepEqual(result.blockers, ["Need an acceptance decision"]);
  assert.deepEqual(stopped.calls, ["1-plan"]);
  const unattended = harness({ replies: { "1-plan": blockedReply } });
  unattended.ctx.args = { issueUrl, autoApprovePlan: true };
  assert.deepEqual((await unattended.execute()).blockers, ["Need an acceptance decision"]);
  assert.equal(unattended.asked.length, 0);
});

test("after review the human can go back to implementation in the same run", async () => {
  const h = harness({ answers: [answer(labels.approve), answer(labels.reimplement, "Also handle empty input"), answer(labels.finish)] });
  const result = await h.execute();
  assert.deepEqual(h.calls, [...firstRun, ...secondRun]);
  assert.equal(result.iteration, 2);
  assert.equal(result.recommendation, "successful");
  assert.equal(h.asked.length, 3);
  assert.match(h.asked[2].message, /Iteration 2 finished/);
  const implement = h.prompts.find(({ label }) => label === "2-implement #2").prompt;
  assert.match(implement, /later iteration of the same task/);
  assert.match(implement, /iterations\/1\/implementation\.json/);
  assert.match(implement, /iterations\/1\/requirements-review\.json/);
  assert.match(implement, /iterations\/1\/summary\.json/);
  assert.match(implement, /[^/]feedback\.json/);
  assert.doesNotMatch(implement, /iterations\/1\/plan\.json/);
  assert.match(h.prompts.find(({ label }) => label === "3-requirement-coverage #2").prompt, /every change the requester asked for/);
  assert.doesNotMatch(h.prompts.find(({ label }) => label === "4-quality-security #2").prompt, /iterations\//);
  assert.deepEqual(entries(h), [{ iteration: 1, source: "post-review", action: "reimplement", feedback: "Also handle empty input" }]);
  for (const name of ["implementation.json", "requirements-review.json", "quality-security-review.json", "decision-gate.json", "summary.json", "report.md", "result.json", "changes.patch"]) {
    assert.ok(artifact(h, `iterations/1/${name}`) !== undefined, name);
  }
  assert.equal(artifact(h, "iterations/1/plan.json"), undefined);
  assert.equal(JSON.parse(artifact(h, "result.json")).iteration, 2);
  assert.notEqual(JSON.parse(artifact(h, "iterations/1/result.json")).reviewedFingerprint, result.reviewedFingerprint);
  assert.match(artifact(h, "report.md"), /Iteration: 2/);
  assert.match(artifact(h, "report.md"), /Iteration 1, post-review \(reimplement\): Also handle empty input/);
  assert.match(artifact(h, "iterations/1/report.md"), /Iteration: 1/);
});

test("after review the human can go back to planning, approve the new plan, and iterate", async () => {
  const h = harness({
    answers: [answer(labels.approve), answer(labels.replan, "Rethink the approach"), answer(labels.approve), answer(labels.finish)],
    replies: { "1-plan #2": { goal: "New approach" } },
  });
  h.replies["1-plan #2"] = { ...h.replies["1-plan"], goal: "New approach" };
  const result = await h.execute();
  assert.deepEqual(h.calls, [...firstRun, "1-plan #2", ...secondRun]);
  assert.equal(result.iteration, 2);
  assert.equal(h.asked.length, 4);
  assert.match(h.asked[2].message, /iteration 2, plan version 2/);
  assert.match(h.asked[2].message, /New approach/);
  const plan = h.prompts.find(({ label }) => label === "1-plan #2").prompt;
  assert.match(plan, /iterations\/1\/plan\.json/);
  assert.match(plan, /iterations\/1\/requirements-review\.json/);
  assert.match(plan, /later iteration of the same task/);
  assert.doesNotMatch(plan, /rejected an earlier plan/);
  assert.equal(JSON.parse(artifact(h, "iterations/1/plan.json")).goal, "Solve the request");
  assert.equal(JSON.parse(artifact(h, "plan.json")).goal, "New approach");
  assert.deepEqual(entries(h), [{ iteration: 1, source: "post-review", action: "replan", feedback: "Rethink the approach" }]);
});

test("stopping the second plan keeps earlier changes and reports that", async () => {
  const h = harness({ answers: [answer(labels.approve), answer(labels.replan), answer(labels.stopPlan)] });
  const result = await h.execute();
  assert.equal(result.stage, "plan");
  assert.equal(result.iteration, 2);
  assert.match(result.blockers.join(" "), /earlier iterations remain uncommitted/);
  assert.deepEqual(h.calls, [...firstRun, "1-plan #2"]);
  assert.equal(artifact(h, "feedback.json"), undefined);
});

test("dismissing the post-review prompt finishes with the current result", async () => {
  const h = harness({ answers: [answer(labels.approve), { action: "cancel" }] });
  const result = await h.execute();
  assert.equal(result.iteration, 1);
  assert.deepEqual(h.calls, firstRun);
});

test("every iteration is journaled and completed runs remain closed", async () => {
  const h = harness({ answers: [answer(labels.approve), answer(labels.reimplement, "Again"), answer(labels.finish)] });
  const first = await h.execute();
  const agentCalls = h.calls.length;
  assert.equal((await h.execute()).reviewedFingerprint, first.reviewedFingerprint);
  assert.equal(h.calls.length, agentCalls);
  assert.equal(h.asked.length, 3);
  assert.equal(JSON.parse(artifact(h, "result.json")).iteration, 2);
  assert.ok(artifact(h, "iterations/1/result.json") !== undefined);
  h.state.work["src/feature.ts"] = "external edit";
  assert.equal((await h.execute()).closed, true);
  assert.equal(h.calls.length, agentCalls);
});

test("manual checkpoint edits are recorded and sent through independent review", async () => {
  const h = harness();
  h.answers.push(answer(labels.approve), () => {
    h.state.work["src/feature.ts"] = "edited while the prompt was open";
    return answer(labels.reimplement);
  });
  const result = await h.execute();
  assert.equal(result.closed, true);
  assert.deepEqual(h.calls, [...firstRun, "3-requirement-coverage", "4-quality-security", "5-synthesis"]);
  const manual = [...h.files.entries()].find(([name]) => /manual-edits-1-[a-f0-9]+\.patch$/.test(name))?.[1].toString();
  assert.match(manual, /edited while the prompt was open/);
  assert.match(artifact(h, "changes.patch"), /edited while the prompt was open/);
  assert.match(h.prompts.find(({ label }) => label === "3-requirement-coverage").prompt, /human-authored edits/);
});

test("manual edits made during plan approval are included in the implementation baseline", async () => {
  const h = harness({
    answers: [() => {
      h.state.work["src/feature.ts"] = "requester edit during approval";
      return answer(labels.approve);
    }],
  });
  const result = await h.execute();
  assert.equal(result.closed, true);
  const manual = [...h.files.entries()].find(([name]) => /manual-edits-1-[a-f0-9]+\.patch$/.test(name))?.[1].toString();
  assert.match(manual, /requester edit during approval/);
  assert.match(artifact(h, "changes.patch"), /implemented by 2-implement/);
  assert.match(h.prompts.find(({ label }) => label === "2-implement").prompt, /human-authored checkout edits/);
  assert.match(h.prompts.find(({ label }) => label === "4-quality-security").prompt, /human-authored edits/);
});

test("a branch or staged-index change at a checkpoint still halts reconciliation", async () => {
  const h = harness({
    answers: [answer(labels.approve), () => {
      h.state.head = "c".repeat(40);
      return answer(labels.reimplement);
    }],
  });
  await assert.rejects(h.execute(), /Checkout branch, HEAD, or staged changes changed/);
  assert.deepEqual(h.calls, firstRun);
});

test("aborting the run ends a pending prompt", async () => {
  const controller = new AbortController();
  const h = harness({ answers: [() => new Promise(() => {})] });
  h.ctx.signal = controller.signal;
  setImmediate(() => controller.abort(new Error("run aborted")));
  await assert.rejects(h.execute(), /run aborted/);
  assert.deepEqual(h.calls, ["1-plan"]);
});

test("source is self-contained and uses no inherited or explicitly overridden model settings", async () => {
  const source = await readFile(new URL("./workflow.mjs", import.meta.url), "utf8");
  assert.doesNotMatch(source, /\b(model|reasoningEffort|contextTier|limits):/);
  assert.equal((source.match(/ctx\.agent\(/g) ?? []).length, 4);
  assert.match(source, /ctx\.parallel\(\[\(\) => review\("requirements-review"\), \(\) => review\("quality-security-review"\)\]\)/);
});
