import { badge, element, icon, renderArtifact, renderCheckout, renderMarkdown, renderPatch, safeLink } from "./renderer.mjs";

const $ = (id) => document.getElementById(id);
const text = (tag, value, className) => element(document, tag, value, className);
const date = (value) => Number.isFinite(value) ? new Date(value).toLocaleString() : "Not recorded";
const artifactCount = (count) => `${count} artifact${count === 1 ? "" : "s"}`;
const panels = new Map();
const artifactRequests = new Map();
let selectedRun = null;
let selectedPhase = null;
let lastRun = null;
let latestRuns = [];
let busy = false;
let listStamp = "";
let pathStamp = "";
let phaseStamp = "";
let overviewStamp = "";
let runRequest = 0;
let controlsStamp = "";
const statusText = (run) => run.freshness === "artifact-only" ? "Artifact-only"
  : run.freshness === "stale" ? "Status unavailable"
    : run.pendingDecision?.kind === "parked" ? "Parked (reopenable)"
      : run.pendingDecision ? "Awaiting decision" : run.observation.status;

async function request(route, params = {}) {
  const url = new URL(`api/${route}`, location.href);
  for (const [key, value] of Object.entries(params)) url.searchParams.set(key, value);
  const response = await fetch(url, { signal: AbortSignal.timeout(10_000), cache: "no-store" });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

async function mutate(route, body) {
  const response = await fetch(new URL(`api/${route}`, location.href), {
    method: "POST", cache: "no-store", signal: AbortSignal.timeout(10_000),
    headers: { "Content-Type": "application/json", "X-Implementation-Flow": "1" },
    body: JSON.stringify(body),
  });
  const data = await response.json();
  if (!response.ok) throw new Error(data.error ?? `Request failed (${response.status}).`);
  return data;
}

function controlButton(label, action, parent, disabled = false) {
  const button = text("button", label);
  button.type = "button";
  button.disabled = disabled;
  button.addEventListener("click", action);
  parent.append(button);
  return button;
}

function controlField(tag, label, parent, value = "") {
  const wrapper = text("label", undefined, "control-field");
  wrapper.append(text("span", label));
  const input = text(tag);
  if (tag === "textarea") input.rows = 3;
  input.value = value;
  wrapper.append(input);
  parent.append(wrapper);
  return input;
}

function reportControlError(panel, error) {
  let status = panel.querySelector(".control-status");
  if (!status) {
    status = text("p", undefined, "control-status");
    status.setAttribute("role", "status");
    panel.append(status);
  }
  status.textContent = error.message;
  status.dataset.error = "true";
}

async function sendDecision(panel, run, option, feedback, planEditor) {
  try {
    let plan;
    if (planEditor?.value.trim()) {
      try { plan = JSON.parse(planEditor.value); }
      catch { throw new Error("Plan must be valid JSON before submitting."); }
    }
    const target = panel.querySelector(".comment-target")?.value.trim();
    const note = feedback.value.trim();
    const combined = target && note ? `Comment on ${target}: ${note}` : note;
    await mutate("respond", { runId: run.runId, action: option.action, feedback: combined, ...(plan ? { plan } : {}) });
    await refresh(true);
  } catch (error) { reportControlError(panel, error); }
}

function renderControls(run) {
  const panel = $("run-controls");
  const stamp = JSON.stringify([
    run.runId, run.observation?.status, run.pendingDecision,
    run.artifacts.map((entry) => [entry.name, entry.size, entry.modifiedAt]),
  ]);
  if (stamp === controlsStamp) return;
  controlsStamp = stamp;
  panel.replaceChildren();
  panel.hidden = false;
  const heading = text("h2", "Workflow controls");
  panel.append(heading);
  const buttons = text("div", undefined, "control-actions");
  for (const action of ["pause", "resume", "cancel"]) {
    controlButton(action[0].toUpperCase() + action.slice(1), async () => {
      try { await mutate(action, { runId: run.runId }); await refresh(true); }
      catch (error) { reportControlError(panel, error); }
    }, buttons, action === "pause" && run.observation?.status !== "running" || action === "resume" && run.observation?.status !== "paused");
  }
  panel.append(buttons);

  if (run.pendingDecision) {
    const pending = text("section", undefined, "decision-panel");
    pending.append(text("h3", "Decision needed"), typeof run.pendingDecision.message === "string"
      ? renderMarkdown(document, run.pendingDecision.message)
      : text("p", "Decision message unavailable.", "notice"));
    const feedback = controlField("textarea", "Feedback or inline comment", pending);
    const target = controlField("input", "Comment target (optional)", pending);
    target.className = "comment-target";
    target.placeholder = "For example: AC2 or implementation step 3";
    let planEditor;
    if (run.pendingDecision.kind === "plan-approval") {
      const details = text("details");
      details.append(text("summary", "Edit plan JSON"));
      planEditor = controlField("textarea", "Plan", details);
      planEditor.rows = 12;
      const planArtifact = run.artifacts.find((entry) => entry.name === "plan.json");
      if (planArtifact) void readArtifact(run.runId, planArtifact).then((data) => {
        if (!planEditor.value) planEditor.value = data.text;
      }).catch((error) => reportControlError(panel, error));
      pending.append(details);
    }
    const options = text("div", undefined, "control-actions decision-options");
    for (const option of run.pendingDecision.options) {
      controlButton(option.label, () => { void sendDecision(panel, run, option, feedback, planEditor); }, options);
    }
    pending.append(options);
    panel.append(pending);
  }

  const feedbackSection = text("details", undefined, "feedback-panel");
  feedbackSection.append(text("summary", "Queue chat feedback"));
  const feedback = controlField("textarea", "Used at the next planning or implementation checkpoint", feedbackSection);
  controlButton("Queue feedback", async () => {
    try { await mutate("feedback", { runId: run.runId, feedback: feedback.value }); feedback.value = ""; await refresh(true); }
    catch (error) { reportControlError(panel, error); }
  }, feedbackSection);
  panel.append(feedbackSection);

  const evidenceSection = text("details", undefined, "evidence-panel");
  evidenceSection.append(text("summary", "Attach verification evidence"));
  const evidenceId = controlField("input", "Evidence ID", evidenceSection);
  const criterionId = controlField("input", "Acceptance criterion ID (optional)", evidenceSection);
  const evidenceDescription = controlField("input", "Description", evidenceSection);
  const command = controlField("input", "Command or verification method (optional)", evidenceSection);
  const outcome = controlField("select", "Outcome", evidenceSection);
  for (const value of ["passed", "failed"]) {
    const option = text("option", value);
    option.value = value;
    outcome.append(option);
  }
  const evidence = controlField("textarea", "Observed evidence", evidenceSection);
  controlButton("Attach evidence", async () => {
    try {
      await mutate("evidence", {
        runId: run.runId, id: evidenceId.value.trim(),
        ...(criterionId.value.trim() ? { criterionId: criterionId.value.trim() } : {}),
        description: evidenceDescription.value.trim(),
        ...(command.value.trim() ? { command: command.value.trim() } : {}),
        outcome: outcome.value, evidence: evidence.value.trim(),
      });
      evidence.value = "";
      await refresh(true);
    } catch (error) { reportControlError(panel, error); }
  }, evidenceSection);
  panel.append(evidenceSection);

  const iterations = run.artifacts.filter((entry) => entry.name.startsWith("iterations/"));
  if (iterations.length) {
    const history = text("details", undefined, "history-panel");
    history.append(text("summary", `Iteration and rerun history (${iterations.length} artifacts)`));
    const picker = text("select");
    picker.setAttribute("aria-label", "Select an archived artifact");
    for (const entry of iterations) {
      const option = text("option", entry.name);
      option.value = entry.name;
      picker.append(option);
    }
    const preview = text("pre", "", "history-preview");
    controlButton("View artifact", async () => {
      try { preview.textContent = (await request("artifact", { runId: run.runId, name: picker.value })).text; }
      catch (error) { preview.textContent = `Cannot load archived artifact: ${error.message}`; }
    }, history);
    history.prepend(picker);

    const plans = run.artifacts.filter((entry) => /(?:^|\/)plan(?:-v[0-9]+|-rejected-[0-9]+)?\.json$/.test(entry.name));
    if (plans.length > 1) {
      history.append(text("h3", "Compare plan versions"));
      const first = text("select"); const second = text("select");
      for (const select of [first, second]) for (const entry of plans) {
        const option = text("option", entry.name); option.value = entry.name; select.append(option);
      }
      first.setAttribute("aria-label", "Earlier plan version");
      second.setAttribute("aria-label", "Later plan version");
      if (plans.length > 1) second.value = plans.at(-1).name;
      const diff = text("pre", "", "history-preview");
      controlButton("Compare plans", async () => {
        try {
          const [a, b] = await Promise.all([
            request("artifact", { runId: run.runId, name: first.value }),
            request("artifact", { runId: run.runId, name: second.value }),
          ]);
          diff.textContent = comparePlans(a.value, b.value);
        } catch (error) { diff.textContent = `Cannot compare plans: ${error.message}`; }
      }, history);
      history.append(first, second, diff);
    }
    history.append(preview);
    panel.append(history);
  }

  const starter = text("details", undefined, "start-panel");
  starter.append(text("summary", "Start a workflow"));
  const issue = controlField("input", "GitHub issue URL", starter);
  const title = controlField("input", "Task title", starter);
  const description = controlField("textarea", "Task description", starter);
  const confirmation = text("label", undefined, "confirm-field");
  const checked = text("input");
  checked.type = "checkbox";
  confirmation.append(checked, text("span", "I confirm starting this workflow in the current repository."));
  starter.append(confirmation);
  controlButton("Start workflow", async () => {
    const args = issue.value.trim()
      ? { issueUrl: issue.value.trim() }
      : { taskTitle: title.value.trim(), taskDescription: description.value.trim() };
    if (Boolean(issue.value.trim()) === Boolean(title.value.trim() || description.value.trim())) {
      reportControlError(panel, new Error("Provide either an issue URL or both task fields, not both."));
      return;
    }
    try { await mutate("start", { args, confirm: checked.checked }); await refresh(true); }
    catch (error) { reportControlError(panel, error); }
  }, starter);
  panel.append(starter);
}

function comparePlans(before, after) {
  if (!before || !after) return "Both selected artifacts must contain a plan.";
  const compareList = (label, oldItems, newItems, key) => {
    const oldMap = new Map((oldItems ?? []).map((item, index) => [key(item, index), item]));
    const newMap = new Map((newItems ?? []).map((item, index) => [key(item, index), item]));
    const lines = [];
    for (const [id, value] of oldMap) {
      if (!newMap.has(id)) lines.push(`- ${label}: ${JSON.stringify(value)}`);
      else if (JSON.stringify(value) !== JSON.stringify(newMap.get(id))) lines.push(`~ ${label}: ${JSON.stringify(value)} => ${JSON.stringify(newMap.get(id))}`);
    }
    for (const [id, value] of newMap) if (!oldMap.has(id)) lines.push(`+ ${label}: ${JSON.stringify(value)}`);
    return lines;
  };
  return [
    ...compareList("acceptance criterion", before.acceptanceCriteria, after.acceptanceCriteria, (item) => item.id),
    ...compareList("step", before.steps, after.steps, (_item, index) => String(index)),
  ].join("\n") || "No acceptance-criteria or step changes.";
}

function showConnection(message) {
  $("connection").textContent = message;
  $("connection").hidden = !message;
}

function resetRun(runId) {
  selectedRun = runId;
  selectedPhase = null;
  lastRun = null;
  pathStamp = "";
  phaseStamp = "";
  overviewStamp = "";
  controlsStamp = "";
  panels.clear();
  artifactRequests.clear();
  $("checkout").replaceChildren();
  $("checkout").hidden = true;
  $("run-files").open = false;
}

function renderRuns(runs) {
  const stamp = JSON.stringify(runs.map((run) => [run.runId, run.title, run.branch, run.freshness, run.observation?.status, run.recommendation, run.artifactCount])) + selectedRun;
  if (stamp === listStamp) return;
  listStamp = stamp;
  const focusedRun = document.activeElement?.dataset.runId;
  $("run-count").textContent = String(runs.length);
  $("runs").replaceChildren();
  $("run-picker").replaceChildren();
  for (const run of runs) {
    const button = text("button", undefined, "run-button");
    button.type = "button";
    button.dataset.runId = run.runId;
    button.setAttribute("aria-current", String(run.runId === selectedRun));
    const footer = text("span", undefined, "run-footer");
    footer.append(badge(document, run.recommendation ?? statusText(run)), text("code", run.runId.slice(0, 8)));
    button.append(text("span", run.title, "run-title"), text("span", `${artifactCount(run.artifactCount)} / ${run.branch ?? "Branch not recorded"}`, "muted"), footer);
    button.addEventListener("click", () => selectRun(run.runId));
    $("runs").append(button);
    const option = text("option", `${run.title} - ${statusText(run)}`);
    option.value = run.runId;
    $("run-picker").append(option);
  }
  $("run-picker").value = selectedRun ?? "";
  if (focusedRun) [...$("runs").children].find((node) => node.dataset.runId === focusedRun)?.focus();
}

function selectRun(runId) {
  if (runId === selectedRun) return;
  resetRun(runId);
  $("run-detail").hidden = true;
  $("empty").hidden = false;
  $("empty").textContent = "Loading run...";
  renderRuns(latestRuns);
  void loadRun().catch((error) => {
    if (runId === selectedRun) showConnection(`Cannot load run: ${error.message} Use Refresh to retry.`);
  });
}

function renderOverview(run) {
  const overview = $("overview");
  const observedTime = overview.querySelector(".observation-time");
  if (observedTime) observedTime.textContent = date(run.observation?.observedAt);
  const stamp = JSON.stringify([run.title, run.issueUrl, run.branch, run.runId, run.freshness, run.recommendation,
    run.artifacts.length, run.warnings, run.observation?.status, run.observation?.startedAt, run.observation?.error]);
  if (stamp === overviewStamp) return;
  overviewStamp = stamp;
  const heading = text("div", undefined, "run-heading-row");
  const href = safeLink(run.issueUrl);
  const title = text("h2", run.title, "run-heading");
  heading.append(title);
  if (href) {
    const link = text("a", undefined, "issue-link");
    link.href = href; link.target = "_blank"; link.rel = "noopener noreferrer";
    link.title = "View captured issue on GitHub"; link.setAttribute("aria-label", link.title);
    link.append(icon(document, "external")); heading.append(link);
  }
  const identity = text("p", undefined, "identity muted");
  identity.append(icon(document, "branch"), text("span", run.branch ?? "Branch not recorded"), text("span", "/"), text("code", run.runId));
  const statuses = text("div", undefined, "status-line");
  statuses.append(badge(document, statusText(run)), text("span", "Delivery"), badge(document, run.recommendation ?? "Not recorded"),
    text("span", artifactCount(run.artifacts.length), "muted"));
  overview.replaceChildren(heading, identity, statuses);
  if (!run.observation || run.freshness === "stale" || run.warnings.length || run.observation.error) {
    const note = text("details", undefined, "run-note");
    const summary = text("summary");
    summary.append(icon(document, "info"), text("span", !run.observation ? "Artifact history / runtime not recorded"
      : run.freshness === "stale" ? "Live status unavailable / showing last recorded progress" : "Run notices"));
    note.append(summary);
    if (!run.observation) note.append(text("p", "These files are inspectable, but phase completion and timings were not recorded. Gray unknown phases are not assumed to be skipped."));
    else {
      const timing = text("p", `Started: ${date(run.observation.startedAt)}. Last observed: `);
      timing.append(text("span", date(run.observation.observedAt), "observation-time"));
      note.append(timing);
      if (run.freshness === "stale") note.append(text("p", `Last observed runtime state: ${run.observation.status}. Staleness does not prove that the run is still executing or has failed.`));
      if (run.observation.error) note.append(text("p", run.observation.error));
    }
    for (const warning of run.warnings) note.append(text("p", warning));
    // Keep an expanded explanation open across heartbeat refreshes.
    note.open = overview.dataset.noteOpen === "true";
    note.addEventListener("toggle", () => { overview.dataset.noteOpen = String(note.open); });
    overview.append(note);
  }
}

function selectPhase(key, focus = false) {
  if (!lastRun || !lastRun.phases.some((phase) => phase.key === key)) return;
  selectedPhase = key;
  renderPath(lastRun);
  renderPhase(lastRun);
  if (focus) {
    const button = [...$("phases").querySelectorAll("button")].find((node) => node.dataset.phaseKey === key);
    button?.focus();
    button?.scrollIntoView({ block: "nearest", inline: "nearest" });
  }
}

function renderPath(run) {
  const stamp = JSON.stringify(run.phases.map((phase) => [phase.key, phase.status, phase.color, phase.artifacts.length])) + selectedPhase;
  if (stamp === pathStamp) return;
  pathStamp = stamp;
  const focused = document.activeElement?.dataset.phaseKey;
  $("phases").replaceChildren();
  run.phases.forEach((phase, index) => {
    const step = text("div", undefined, "phase-step");
    step.dataset.color = phase.color;
    step.dataset.state = phase.state;
    const button = text("button", undefined, "phase-button");
    button.type = "button"; button.id = `phase-${phase.key}`; button.dataset.phaseKey = phase.key;
    button.setAttribute("role", "tab"); button.setAttribute("aria-controls", "phase-panel");
    button.setAttribute("aria-selected", String(phase.key === selectedPhase));
    button.tabIndex = phase.key === selectedPhase ? 0 : -1;
    button.setAttribute("aria-label", `${phase.title}: ${phase.status}, ${artifactCount(phase.artifacts.length)}`);
    button.title = phase.reason;
    const node = text("span", undefined, "phase-node");
    if (phase.state === "completed") node.append(icon(document, "check"));
    else if (phase.state === "error") node.append(icon(document, "error"));
    else if (phase.state === "closed") node.append(icon(document, "pause"));
    else if (phase.state === "unknown") node.append(text("span", "?"));
    else node.append(text("span", String(index + 1)));
    button.append(node, text("span", phase.title, "phase-label"), text("span", phase.status, "phase-caption"));
    if (phase.key === "review") {
      const parallel = text("span", undefined, "parallel-label");
      parallel.append(icon(document, "branch"), text("span", "2 in parallel")); button.append(parallel);
    }
    button.addEventListener("click", () => selectPhase(phase.key));
    button.addEventListener("keydown", (event) => {
      const move = { ArrowRight: 1, ArrowDown: 1, ArrowLeft: -1, ArrowUp: -1 }[event.key];
      if (!move && !["Home", "End"].includes(event.key)) return;
      event.preventDefault();
      const next = event.key === "Home" ? 0 : event.key === "End" ? run.phases.length - 1 : (index + move + run.phases.length) % run.phases.length;
      selectPhase(run.phases[next].key, true);
    });
    step.append(button); $("phases").append(step);
  });
  $("phase-note").textContent = run.observation ? "Select a phase to inspect its evidence." : "Select a phase to inspect its files. Runtime state is unknown.";
  if (focused) [...$("phases").querySelectorAll("button")].find((node) => node.dataset.phaseKey === focused)?.focus();
}

function renderPanel(record) {
  record.preview?.setAttribute("aria-pressed", String(!record.raw));
  record.rawButton?.setAttribute("aria-pressed", String(record.raw));
  record.content.replaceChildren();
  for (const warning of record.data.view?.warnings ?? []) record.content.append(text("p", warning, "notice"));
  if (record.checkout) record.content.append(renderCheckout(document, record.data.value, record.data.text));
  else if (record.raw || record.data.kind === "text" && record.entry.name !== "changes.patch" || record.data.kind === "json" && !Object.hasOwn(record.data, "value")) {
    record.content.append(text("pre", record.data.text, "raw"));
  } else if (record.entry.name === "changes.patch") record.content.append(renderPatch(document, record.data.text));
  else if (record.data.kind === "markdown") record.content.append(renderMarkdown(document, record.data.text));
  else record.content.append(renderArtifact(document, record.entry.name, record.data.value, record.evidence));
}

function artifactVersion(entry) {
  return entry ? `${entry.name}:${entry.size}:${entry.modifiedAt}` : "missing";
}

function readArtifact(runId, entry) {
  const key = `${runId}:${entry.name}`;
  const stamp = artifactVersion(entry);
  const cached = artifactRequests.get(key);
  if (cached?.stamp === stamp) return cached.promise;
  const record = { stamp };
  record.promise = request("artifact", { runId, name: entry.name }).catch((error) => {
    if (artifactRequests.get(key) === record) artifactRequests.delete(key);
    throw error;
  });
  artifactRequests.set(key, record);
  return record.promise;
}

async function loadEvidence(runId, entries) {
  const evidence = { warnings: [] };
  await Promise.all(entries.map(async ([name, entry]) => {
    if (!entry) {
      evidence.warnings.push(`${name} was not recorded. Some file statuses may be unavailable.`);
      return;
    }
    try {
      const data = await readArtifact(runId, entry);
      if (name === "changes.patch") evidence.patch = data.text;
      else if (Array.isArray(data.value) && data.value.every((item) => item && typeof item.path === "string")) {
        evidence.manifest = data.value;
        evidence.warnings.push(...(data.view?.warnings ?? []).map((warning) => `${name}: ${warning}`));
      } else evidence.warnings.push(`${name} is invalid. New-file status may be unavailable; inspect its Raw view.`);
    } catch (error) {
      evidence.warnings.push(`Cannot load ${name}: ${error.message} Use Refresh to retry. Some file statuses may be unavailable.`);
    }
  }));
  // Keep the content stamp deterministic even when independent reads finish out of order.
  evidence.warnings.sort();
  return evidence;
}

async function loadPanel(record, force = false) {
  const related = record.entry.name === "implementation.json"
    ? ["changes.patch", "untracked-files.json"].map((name) => [name, record.artifacts.find((entry) => entry.name === name)]) : [];
  const stamp = [artifactVersion(record.entry), ...related.map(([name, entry]) => `${name}:${artifactVersion(entry)}`)].join("|");
  if (!force && (record.stamp === stamp || record.loading === stamp)) return;
  if (force) {
    for (const entry of [record.entry, ...related.map(([, entry]) => entry)].filter(Boolean)) artifactRequests.delete(`${record.runId}:${entry.name}`);
  }
  record.loading = stamp;
  const sequence = ++record.sequence;
  record.message.replaceChildren(text("p", record.data ? "Updating artifact..." : "Loading artifact...", "muted"));
  record.body.setAttribute("aria-busy", "true");
  try {
    const [data, evidence] = await Promise.all([readArtifact(record.runId, record.entry), loadEvidence(record.runId, related)]);
    if (sequence !== record.sequence || record.runId !== selectedRun) return;
    const unchanged = record.data?.text === data.text && JSON.stringify(record.data?.view) === JSON.stringify(data.view) &&
      JSON.stringify(record.evidence) === JSON.stringify(evidence);
    record.data = data; record.evidence = evidence;
    record.stamp = evidence.warnings.some((warning) => warning.startsWith("Cannot load")) ? null : stamp;
    record.message.replaceChildren();
    if (!unchanged) renderPanel(record);
  } catch (error) {
    if (sequence !== record.sequence || record.runId !== selectedRun) return;
    const retry = text("button", "Retry");
    retry.type = "button"; retry.addEventListener("click", () => { void loadPanel(record, true); });
    record.message.replaceChildren(text("p", `Cannot load artifact: ${error.message}${record.data ? " Previously loaded contents may be out of date." : ""}`, "notice"), retry);
  } finally {
    if (sequence === record.sequence) { record.loading = null; record.body.setAttribute("aria-busy", "false"); }
  }
}

function artifactPanel(run, entry, initiallyOpen) {
  let record = panels.get(entry.name);
  if (record) {
    record.entry = entry;
    record.artifacts = run.artifacts;
    if (record.size) record.size.textContent = `${entry.size.toLocaleString()} bytes${entry.tooLarge ? " / exceeds display limit" : ""}`;
    return record;
  }
  if (entry.name === "review-snapshot.json") {
    const node = text("div", undefined, "checkout-panel");
    const message = text("div"); message.setAttribute("role", "status");
    const content = text("div");
    node.append(message, content);
    record = { node, body: node, message, content, entry, runId: run.runId, artifacts: run.artifacts,
      checkout: true, data: null, stamp: null, loading: null, sequence: 0 };
    panels.set(entry.name, record);
    return record;
  }
  const node = text("details", undefined, "artifact-panel");
  node.dataset.artifact = entry.name;
  const summary = text("summary", undefined, "artifact-summary");
  const title = text("span", undefined, "artifact-title");
  title.append(text("span", entry.label, "artifact-label"), text("code", entry.name));
  const size = text("span", `${entry.size.toLocaleString()} bytes${entry.tooLarge ? " / exceeds display limit" : ""}`, "artifact-size muted");
  const arrow = icon(document, "chevron"); arrow.classList.add("disclosure-arrow");
  summary.append(icon(document, "file"), title, size, text("span", entry.format, "file-format"), arrow);
  const body = text("div", undefined, "artifact-body");
  const controls = text("div", undefined, "view-controls");
  controls.setAttribute("role", "group"); controls.setAttribute("aria-label", `${entry.label} view`);
  const preview = text("button", "Preview"); const rawButton = text("button", "Raw");
  preview.type = rawButton.type = "button";
  preview.setAttribute("aria-pressed", "true"); rawButton.setAttribute("aria-pressed", "false");
  controls.append(preview, rawButton);
  const message = text("div"); message.setAttribute("role", "status");
  const content = text("div", undefined, "artifact-content");
  body.append(controls, message, content); node.append(summary, body);
  record = { node, body, preview, rawButton, size, message, content, entry, runId: run.runId, artifacts: run.artifacts,
    raw: false, data: null, stamp: null, loading: null, sequence: 0 };
  panels.set(entry.name, record);
  preview.addEventListener("click", () => { record.raw = false; if (record.data) renderPanel(record); });
  rawButton.addEventListener("click", () => { record.raw = true; if (record.data) renderPanel(record); });
  node.addEventListener("toggle", () => { if (node.open && node.isConnected) void loadPanel(record); });
  node.open = initiallyOpen;
  return record;
}

function syncArtifacts(container, run, entries, openFirst = false) {
  const records = entries.map((entry, index) => artifactPanel(run, entry, openFirst && index === 0));
  const nodes = records.map((record) => record.node);
  if (container.children.length !== nodes.length || nodes.some((node, index) => container.children[index] !== node)) container.replaceChildren(...nodes);
  for (const record of records) {
    if (record.node.open && (container.id !== "run-artifacts" || $("run-files").open)) void loadPanel(record);
  }
}

function renderPhase(run) {
  const phase = run.phases.find((phase) => phase.key === selectedPhase);
  if (!phase) return;
  const checkout = $("checkout");
  checkout.hidden = !phase.checkout;
  if (phase.checkout) {
    const record = artifactPanel(run, phase.checkout);
    if (checkout.firstChild !== record.node) checkout.replaceChildren(record.node);
    void loadPanel(record);
  }
  $("phase-panel").setAttribute("aria-labelledby", `phase-${phase.key}`);
  const stamp = JSON.stringify({ phase, progress: run.observation?.progress });
  if (stamp !== phaseStamp) {
    phaseStamp = stamp;
    const heading = text("div", undefined, "phase-heading-row");
    const state = badge(document, phase.status); state.dataset.color = phase.color; state.title = phase.reason;
    heading.append(text("h2", phase.title), state, text("span", artifactCount(phase.artifacts.length), "muted"));
    $("selected-phase").replaceChildren(heading, text("p", phase.detail, "phase-description"));
    if (["error", "closed"].includes(phase.state)) $("selected-phase").append(text("p", phase.reason, "notice"));
    const branches = $("review-branches");
    branches.hidden = phase.key !== "review";
    branches.replaceChildren();
    if (phase.key === "review") {
      for (const [label, title] of [["3-requirement-coverage", "Requirement coverage"], ["4-quality-security", "Quality & security"]]) {
        const agent = phase.agents.find((agent) => agent.label === label);
        const lane = text("div", undefined, "review-lane");
        lane.append(icon(document, "branch"), text("span", title), badge(document, agent?.status ?? "Not recorded"));
        branches.append(lane);
      }
    }
    const progress = run.observation?.progress;
    const records = progress?.records.filter((record) => phase.runtimeId && record.phaseId === phase.runtimeId) ?? [];
    $("progress-count").textContent = String(records.length);
    $("progress-note").textContent = progress?.truncated ? "Recent tail only; earlier activity is omitted."
      : records.length ? "Recorded activity for this phase." : "No recorded activity for this phase.";
    const scroll = $("progress").scrollTop;
    $("progress").replaceChildren(...records.map((record) => {
      const item = text("li");
      item.append(text("span", `Attempt ${record.attempt ?? "?"} / ${date(record.recordedAt)}`, "muted"), text("p", record.text));
      return item;
    }));
    $("progress").scrollTop = scroll;
  }
  if (phase.artifacts.length) syncArtifacts($("phase-artifacts"), run, phase.artifacts, true);
  else $("phase-artifacts").replaceChildren(text("div", undefined, "artifact-empty"));
  if (!phase.artifacts.length) {
    $("phase-artifacts").firstChild.append(icon(document, "file"), text("h3", "No artifacts for this phase yet"),
      text("p", phase.state === "unknown" ? "This run has no recorded files for this phase. Its execution state is unknown."
        : "Files will appear here when the workflow records this phase's output.", "muted"));
  }
  syncArtifacts($("run-artifacts"), run, run.runArtifacts);
  $("run-files-count").textContent = `(${run.runArtifacts.length})`;
  $("run-files").hidden = !run.runArtifacts.length;
}

async function loadRun() {
  const runId = selectedRun;
  if (!runId) return;
  const sequence = ++runRequest;
  const run = await request("run", { runId });
  if (runId !== selectedRun || sequence !== runRequest) return;
  lastRun = run;
  $("empty").hidden = true; $("run-detail").hidden = false;
  renderControls(run);
  if (!run.phases.some((phase) => phase.key === selectedPhase)) {
    selectedPhase = run.phases.find((phase) => phase.state === "active")?.key
      ?? run.phases.find((phase) => phase.state === "error")?.key
      ?? run.phases.find((phase) => phase.state === "closed")?.key
      ?? run.phases.filter((phase) => phase.artifacts.length).at(-1)?.key ?? run.phases[0]?.key;
  }
  renderOverview(run); renderPath(run); renderPhase(run);
}

async function refresh(force = false) {
  if (busy) return;
  busy = true;
  $("refresh").disabled = true;
  if (force) {
    artifactRequests.clear();
    for (const record of panels.values()) record.stamp = null;
  }
  try {
    const data = await request("runs");
    latestRuns = data.runs;
    if (!latestRuns.some((run) => run.runId === selectedRun)) resetRun(latestRuns[0]?.runId ?? null);
    renderRuns(latestRuns);
    if (!latestRuns.length) {
      $("empty").hidden = false; $("empty").textContent = "No runs recorded yet. Run implementation-flow in this checkout to start collecting evidence.";
      $("run-detail").hidden = true;
    } else await loadRun();
    showConnection(data.observer.errors.map((error) => `Progress recording unavailable (${error.runId}): ${error.message}`).join("\n"));
  } catch (error) {
    showConnection(`Cannot refresh dashboard: ${error.message} Displayed data may be out of date. Use Refresh to retry.`);
    if (!selectedRun) $("empty").textContent = "Run data could not be loaded.";
  } finally { busy = false; $("refresh").disabled = false; }
}

$("app-symbol").append(icon(document, "workflow"));
$("refresh-symbol").append(icon(document, "refresh"));
$("activity-symbol").append(icon(document, "activity"));
$("refresh").addEventListener("click", () => { void refresh(true); });
$("run-picker").addEventListener("change", (event) => selectRun(event.target.value));
$("run-files").addEventListener("toggle", () => {
  if ($("run-files").open && lastRun) syncArtifacts($("run-artifacts"), lastRun, lastRun.runArtifacts);
});
void refresh();
const timer = setInterval(() => { if (!document.hidden) void refresh(); }, 3_000);
window.addEventListener("pagehide", () => clearInterval(timer), { once: true });
