# Implementation flow dynamic workflow

Registered name: `implementation-flow` (extension bundled by the `implementation-flow`
Copilot plugin; start a new session after installing or updating the plugin).

Input: either a GitHub issue URL:

```json
{
  "issueUrl": "https://github.com/RickardHF/Autonomous-Developer-Workflows/issues/42"
}
```

Or a task title and description:

```json
{
  "taskTitle": "Add CSV export",
  "taskDescription": "Add CSV export for the current results, preserving their active filters and sort order."
}
```

The two input modes are mutually exclusive. All supplied values must be nonempty
strings; partial task input, mixed modes, and unknown fields are rejected before
any commands or agents run. Issue input requires authenticated `gh` access and
must identify an issue in the checked-out repository. Task input needs only Git,
does not call `gh`, and does not create or modify any GitHub issue.

Invoke with `run_dynamic_workflow` using this name and input. This definition is
session-scoped, not a GitHub Actions workflow or an app-wide automation. Its source
is preserved next to this document for inspection and re-registration.

The optional `decisionChannel` selects inbox decisions (default) or prompt
elicitation. Two optional boolean flags control the human checkpoints described
under [Human approval and iteration](#human-approval-and-iteration):

```json
{ "issueUrl": "https://github.com/OWNER/REPOSITORY/issues/42", "decisionChannel": "inbox", "autoApprovePlan": true, "autoFinish": true }
```

`decisionChannel` is `"inbox"` or `"prompt"` and defaults to `"inbox"`.
`autoApprovePlan` and `autoFinish` default to `false`. Invalid values are rejected.

The workflow uses five fresh workflow-agent contexts per pass, not five sidebar sessions.
It captures the current branch and HEAD in this repository; it never creates or
switches branches. Keep other writers out of the checkout until the run ends.

The checkout does not need to be clean. Prepare records the working tree as it
is, including tracked edits, staged changes and untracked files, as a git tree
(`baseTree`). It builds the tree from a throwaway copy of the index, so your
index and files are not touched. It lists the files that already differed from
HEAD as `preexistingChanges` in `context.json`. Each stage is told that these
are your changes:
- The planner treats them as the current code.
- The implementer must preserve them and leave them unstaged.
- Reviewers judge only the run's own changes.

After implementation, `changes.patch` is `git diff <baseTree> <current tree>`.
It contains everything the run changed, including new and binary files, and
nothing that was already there. `git apply -R changes.patch` undoes the run and
leaves your earlier work in place. Your staged index must stay as it was. The
plan-approval prompt and `report.md` mention any pre-existing changes.

1. A read-only planner captures acceptance criteria and an implementation plan.
2. The sole implementation agent edits and validates the shared checkout.
3. A requirement-coverage reviewer checks actual behavior against the captured
   issue or task, including any original requirement missed by the plan.
4. A separate static quality/security reviewer runs concurrently with stage 3,
   without seeing its findings.
5. A synthesizer reads both reviews and recommends successful, unsuccessful, or
   inconclusive. A deterministic gate prevents an optimistic summary from
   overriding missing reviews, unverified acceptance, failed checks, changed issue
   requirements, or unresolved blocking/high/critical findings.

Agents receive paths to local requirement, plan, implementation, and review artifacts,
not predecessor conversation history. The coordinator persists structured outputs,
the tracked-file patch, a hashed new-file manifest, review fingerprint, and a final
Markdown report under `<git-dir>/implementation-flow/<run-id>/` (outside the checkout's tracked files).

New files are explicitly included in review instructions.

Issue runs retain `issue.json`, `context.json`'s `issueRequirementDigest`, and
`result.json`'s `issueUrl`. Task runs instead record `task.json` with `title` and
`description`, `context.json`'s `taskRequirementDigest`, and `result.json`'s
`taskTitle`. Both use the same plan, implementation, review and decision contracts,
including the `requirements-review.json` artifact and agent labels for coverage.
Task requirements are immutable captured input, so no remote freshness check is
needed. Issue requirements/comments are checked at the review checkpoint. New or
edited content can be accepted as a refreshed snapshot or ignored; ignoring
leaves the gate inconclusive.

The workflow does not commit, push, create a PR, modify the GitHub issue, or
automatically apply review fixes. Source changes remain unstaged on the original
branch. A blocked plan ends without starting implementation unless a human
clarifies it (see below). Failed implementation output is recorded explicitly and
any partial changes are still reviewed; success is disallowed.

### Human approval and iteration

By default, decisions use the durable `inbox` channel: the workflow writes a
`pending-decision.json` artifact and pauses for a dashboard or session-tool
response. Under **Workflow controls → Decision needed**, the dashboard renders
decision messages as Markdown using the same safe preview as reports.
The inbox does not require elicitation support. Set `decisionChannel:
"prompt"` to use session forms instead. `autoApprovePlan` and `autoFinish` skip
their checkpoints independently.

**Plan approval** (skipped by `autoApprovePlan: true`). After the planner returns
a ready plan, the dashboard shows its goal, acceptance criteria and steps with
the path of `plan.json`. It can also edit the plan JSON before approval; an edit
must pass the plan contract and is retained as a versioned artifact:

- *Approve plan and implement*: continues. Any note is recorded as feedback.
- *Request plan changes*: requires a description. The rejected plan is archived as
  `iterations/<n>/plan-rejected-<k>.json`, then the planner runs again as
  `1-plan #<k+1>` with the rejected plan and your feedback, and the approval dialog
  repeats. There is no limit on the number of revisions.
- *Stop (do not implement)*, or dismissing the dialog: ends the run with an
  `inconclusive` result at `stage: "plan"` and changes nothing.

If planning returns **blocked**, a human run offers *Provide clarification and
re-plan* (requires text) or *Stop*; with `autoApprovePlan: true` the run ends
with the blockers as before.

**After review** (skipped by `autoFinish: true`). Once the report is written the
dialog shows the recommendation and offers:

- *Finish* parks the run so it can be reopened later. *Close run* completes it;
  completed runs, including `autoFinish` runs, cannot be reopened.
- *Go back to implementation*: runs implement → review → summarize again, in the
  same run, on top of the existing uncommitted changes.
- *Go back to planning*: re-plans first (with the previous plan and reviews as
  inputs), asks for plan approval again unless `autoApprovePlan`, then implements.
- Rerun either reviewer or both, rerun synthesis only, or attach verification
  evidence and recompute the decision gate and synthesis without rerunning reviews.
- Reopen a parked run with a new prompt and a restart point: planning,
  implementation, both reviews, or synthesis.

Instructions typed for the next pass are saved in the protected `feedback.json`
(`{ "entries": [{ "iteration", "source", "action", "feedback" }] }`, with `source`
`plan-approval` or `post-review`). Later agents are told to apply it, but it
cannot authorize forbidden actions such as committing or pushing, and the
requirement-coverage reviewer verifies that each requested change was made.
Acceptance criteria remain cumulative across passes. The final report gains an
`Iteration: n` line and a **Human feedback** section.

When a pass is repeated, its artifacts (`implementation.json`, `changes.patch`,
`untracked-files.json`, `review-snapshot.json`, both reviews, `decision-gate.json`,
`summary.json`, `report.md`, `result.json`, and `plan.json` when re-planning) move to
`iterations/<n>/`; the top-level files always describe the latest pass, and
`result.json` carries its `iteration`. Later passes use suffixed step keys and agent
labels (`2-implement #2`, `3-requirement-coverage #2`, ...). The dashboard shows the
latest pass and browses earlier iterations and reruns, including plan versions.

While paused at a decision, source edits are reconciled as manual edits, saved in
`manual-edits-*.patch`, included in the run's `changes.patch`, and sent through
review. Branch, HEAD, or staged-index changes halt reconciliation. Declining to
approve a later plan keeps earlier passes' changes in the checkout and says so in
the result.

Resume uses durable step outputs and agent memoization; completed agents are not
restarted. Inbox responses and prompt answers are journaled, so a resumed run
does not ask again for decisions it already has. Switching input modes or
changing task requirements on resume is rejected; start a new run for a
different task. Protected-artifact changes still stop the run rather than
reviewing stale content. Do not clear journals or undo source changes blindly.

Read-only boundaries are agent instructions plus before/after fingerprints, not
an OS sandbox or an exclusive repository lock. Ignored build output is outside
the fingerprint. The implementation is instructed not to change ignored source
or submodule worktrees; reviewers must report scope they cannot verify.

The adjacent `workflow.test.mjs` uses mocked Git/GitHub, filesystem, and agents to exercise
ordering, review concurrency, artifact handoffs, failure handling, recommendation
gates, and resume safety without changing the repository or running live agents:

```sh
node --test plugins/implementation-flow/extensions/implementation-flow/workflow.test.mjs
```

## Run dashboard

The same bundled extension also declares the **Implementation flow runs** canvas
(`implementation-flow-runs`). After reloading the extension provider with
`extensions_reload` (or restarting the Copilot session), ask Copilot to
**"Open the implementation-flow dashboard."** The canvas takes an empty input object.
It does not start a delivery run just to inspect existing artifacts.

The dashboard uses plain HTML, CSS, and JavaScript with no framework, build
step, CDN, or additional package installation. Its extension-owned HTTP server
binds only to `127.0.0.1` on an ephemeral port with a private per-panel URL.
Closing the panel stops that panel's server; closing the session also stops
the observer. The dashboard lists runs and exposes confirmed workflow controls
for starting, pausing, resuming, cancelling, and responding to decisions. It
supports plan editing, inline feedback, verification evidence, iteration
browsing, and plan comparison. Mutations use same-origin and capability checks;
the dashboard does not expose arbitrary file writes or command execution.

Select a run to see its issue-or-task/branch identity, recorded runtime state and
delivery recommendation. The connected **Prepare → Plan → Implement → Review →
Summarize** path follows the workflow's phase metadata. Click a phase to inspect
its artifacts, or use the arrow keys, Home and End with the phase tabs focused.
The Review phase also exposes its two independent, parallel reviewers.

Phase colors have explicit text labels: **green** means completed, **gray**
means not started/skipped (or explicitly unknown), **red** means a runtime/agent
error or recorded failed validation/review, **blue** means in progress, and
**yellow** means closed unfinished, including blocked or unavailable output and
a phase interrupted by a paused, halted or cancelled run. A completed phase is
not a promise of a successful final delivery recommendation. Stale active
phases are unknown, not falsely shown as still executing.
An actively executing resumed phase does not inherit failed or incomplete
artifact outputs from an earlier attempt.

Each artifact has an independent collapsible view with **Preview** and **Raw**
modes. Files load when expanded; background refresh preserves the selected
phase, expanded artifacts, mode and unchanged nested preview contents. Activity
is filtered to the selected phase. Runtime observations and unknown future
files remain accessible under **Run-level & other files**.

Artifacts are grouped by their producing phase: issue or task and context under Prepare,
plan under Plan, implementation/patch and compact reviewed-checkout metadata under Implement,
both review outputs under Review, and report/result/synthesis/decision gate
under Summarize. The inspector supports JSON, Markdown, patches and text files;
unknown JSON gets a generic view. The smaller `result.json` written when planning
is blocked belongs to Plan instead, since Summarize never ran.

Known artifacts have document-style previews rather than generic property/value
layouts:

- **Captured issue** shows the issue number/title, clickable URL, upper-right
  update time, rendered Markdown body, and individual comments with their own
  links and update times. Captured comments do not include author metadata.
- **Captured task** shows the supplied title and rendered Markdown description.
  Task runs use the task title in the run list and have no GitHub issue link.
- **Implementation plan** has a top status badge and titled sections.
  Acceptance criteria use **ID**, **Requirements**, and **Verification** columns.
- **Implementation result** starts with a changed-file list: added files are
  green, modified/renamed files yellow, and deleted files red, with explicit
  text statuses. The implementation and both reviews display readable output
  reports without wrapper keys or property-name headings.
- **Source changes** uses a GitHub-style unified diff with collapsible file
  headers, old/new line numbers, hunk context, and added/removed lines. Binary
  and mode-only changes remain identifiable; unsupported patches show a
  notice and recorded text rather than an invented diff.
- **Reviewed checkout** is a metadata strip above the Implement artifacts,
  without a repeated changed-file list. Its original JSON remains accessible
  in **Raw checkout metadata**.
- **Final result** and **Review synthesis** use titled sections and findings
  tables. Synthesis tables show source, ID, disposition, and reason; reviewer
  tables retain severity, location, confidence, blocking status, and expandable
  evidence.

There is no standalone **New files** panel in Implement. Its original manifest
remains under **Run-level & other files**. The recorded patch includes the run's
new files, so file statuses come from the patch first. Runs from before version
1.1.0 recorded tracked-file changes only. For them, the manifest supplies "added"
statuses for paths and hashes, but **not new-file contents**, and a notice says
so. The dashboard does not read the current checkout to manufacture a historical
new-file diff. Missing or unsupported evidence produces an explicit unavailable
status or notice.
Related patch/manifest changes refresh file statuses even when the primary
implementation output is unchanged.

### Progress across sessions

Workflow observation APIs are scoped to the owning Copilot session. Whenever
this extension is loaded, its observer uses those supported APIs to record its
own `implementation-flow` runs, even if no dashboard panel is open. It writes only a
separate `dashboard.json` under `<git-dir>/implementation-flow/<run-id>/`, resolving
`<git-dir>` with `git rev-parse --absolute-git-dir` just like the workflow.
This keeps tracked files and protected delivery handoffs untouched.

Another session in the same checkout can read those snapshots. Other
worktrees, clones, and machines have separate storage and are not aggregated.
The observer reconciles every five seconds and on runtime invalidations; the
page refreshes every three seconds while visible. Observer failures appear in
the owning session's log and dashboard rather than changing the delivery result.

`dashboard.json` is a versioned display contract (`schemaVersion: 1`), containing
run/owner identity, revision and timestamps, runtime status/error, phases,
agent labels/status, and at most 200 recent progress records. Progress text is
limited to 4,000 characters per record, with truncation indicated. It does not
copy agent prompts or full conversations, and is written by private, atomic
file replacement.

**Runtime state is not the delivery verdict.** A runtime `completed` run can
have an `unsuccessful` or `inconclusive` recommendation. A nonterminal
`pending`/`running` snapshot without an observation for 30 seconds is shown as
stale, with its last known state; staleness does not prove a crash or ongoing
execution. Paused and halted attempts remain recorded as such until a resume
is observed.

Older runs without compatible snapshots remain **artifact-only**: their
artifacts and recommendation are inspectable, but phase timings and live
status are unknown. Empty run directories are shown without inventing an
outcome. The observer can recover supported runtime history if the owning
session is opened again. The dashboard never reads Copilot's internal databases.

### JSON artifact contracts

JSON files do **not** all contain the same properties. Their current contracts
are defined by the schemas and save sites in `workflow.mjs`:

| Artifact | Main fields / shape |
|---|---|
| `context.json` | Run, repository, checkout, branch, starting revision, starting worktree tree (`baseTree`), `preexistingChanges` and requirement digest |
| `issue.json` | Number, title, nullable body, URL, update timestamp and comments |
| `task.json` | Supplied task title and description |
| `plan.json` | Status, goal, scope, acceptance criteria, steps, mitigations, rollback, validation requirement and blockers |
| `implementation.json` | `available`, nullable `output`, `changedFiles`; output holds status, summary, changes, checks, deviations and blockers |
| Both `*-review.json` files | `available`, nullable `output`; output holds verdict, summary, coverage, findings, checks and criteria |
| `decision-gate.json` | Maximum recommendation, failures and uncertainties |
| `summary.json` | Recommendation, summary, rationale, finding dispositions, remaining risks and next steps |
| `result.json` | Full delivery result (with its `iteration`), or a smaller blocked-planning/stopped result with `stage`, `iteration`, `blockers`, `recommendation` and artifact path |
| `feedback.json` | `entries` of human feedback: iteration, source, action and text |
| `pending-decision.json` | Durable pending decision and allowed actions |
| `verification.json` | Later verification evidence attached to a parked run |
| `issue-delta.json` | New or edited issue title, body, or comment snapshot |
| `review-snapshot.json` | Branch, revision, starting and reviewed trees, fingerprint, changed files, pre-existing changes and review instructions |
| `changes.patch` | Binary-safe diff of everything this run changed (including new files) relative to the starting worktree |
| `untracked-files.json` | Array of the run's new or changed untracked files with path, mode, SHA-256 and symlink flag |
| `dashboard.json` | Versioned runtime observations, separate from delivery artifacts |

These are per-artifact shapes, not a forever-stable universal schema. Existing
delivery artifacts are not versioned, and partial runs may omit files.
The SDK does not enforce every JSON Schema keyword; readers must tolerate
extra fields. Contract warnings, unavailable outputs, and malformed JSON are
visible in the inspector, and Raw preserves unknown properties and original text.

The Markdown preview supports headings, paragraphs, ordered/unordered lists,
inline code, emphasis, absolute HTTP(S) links, fenced code and tables. HTML is
displayed as text; images and remote assets are not fetched. Relative, file,
credential-bearing and unsafe-scheme links are not activated. Large Markdown
and deeply nested/long JSON previews are bounded with a visible notice; Raw
retains the full artifact within the 2 MiB file display limit.

The server exposes only supported, regular text artifacts inside canonical run
directories. It rejects symlinks, path traversal, cross-origin data requests,
unknown capability URLs, oversized files and all non-GET requests. It does not
serve arbitrary `.git` files or execute commands on behalf of the page.

### Dashboard checks

Run the adjacent deterministic tests without running live agents:

```sh
node --test plugins/implementation-flow/extensions/implementation-flow/workflow.test.mjs plugins/implementation-flow/extensions/implementation-flow/dashboard.test.mjs
```

The dashboard tests use temporary artifacts, a mocked owning-session SDK,
a small dependency-free DOM fixture, and real loopback HTTP requests.
They cover rendered issue/comment documents, exact acceptance-table columns,
output and synthesis layouts, diff parsing/line numbers, file statuses,
related-artifact refresh and run-switch races, schema variants, legacy/partial runs,
cross-session snapshots, stale progress, observer failures, history pagination,
resume and lifecycle handling, phase order/dependencies, artifact ownership,
the five phase colors, incomplete outputs, mutation endpoint protections, and rendering
boundaries.
