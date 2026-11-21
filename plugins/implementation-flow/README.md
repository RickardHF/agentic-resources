# Implementation flow plugin

This Copilot-specific plugin bundles the `implementation-flow` dynamic workflow and
the **Implementation flow runs** dashboard (`implementation-flow-runs`).

## Install and use

```sh
copilot plugin marketplace add RickardHF/agentic-resources
copilot plugin install implementation-flow@rickardhf-agentic-resources
```

Start a new Copilot session in your target Git repository. The runtime must support
SDK extensions, `defineWorkflow`, and canvases; Git must be available. GitHub issue
input also requires an authenticated GitHub CLI (`gh`); task input does not require
GitHub access. The runtime supplies `@github/copilot-sdk`; no npm install or build
step is needed.

Ask Copilot to run the `implementation-flow` workflow with:

```json
{
  "issueUrl": "https://github.com/OWNER/REPOSITORY/issues/42"
}
```

Or supply a standalone task:

```json
{
  "taskTitle": "Add CSV export",
  "taskDescription": "Add CSV export for the current results, preserving their active filters and sort order."
}
```

Provide exactly one input mode: `issueUrl`, or both `taskTitle` and
`taskDescription`. All values must be nonempty strings. A GitHub issue must belong
to the checked-out repository. A task uses its supplied title and description as
the requirements and does not create a GitHub issue.

Run it in the repository that should receive the implementation, on the intended
branch, with no concurrent writers. The checkout does not need to be clean:
uncommitted changes you already have (edits, staged changes, untracked files)
are kept as they are, shown to every stage as your existing work, and excluded
from the run's diff, so reviews only judge what the run changed. To undo just
the run's changes, use `git apply -R <artifacts>/changes.patch`. Each pass uses five agent
contexts and can consume substantial credits. It leaves source changes unstaged;
it does not create branches, commit, push, open pull requests, or modify the issue.

### Human in the loop

By default, decisions use a durable inbox surfaced in the **Implementation flow
runs** dashboard and through session tools. The run pauses without requiring
elicitation support. Set `"decisionChannel": "prompt"` to use the optional
session prompt forms instead.

At plan approval, edit the plan JSON in the dashboard, approve it, request
changes, or stop. After review, choose to finish (park the run for later
reopening), close it, return to planning or implementation, rerun either reviewer
or both, rerun synthesis, or attach verification evidence and recompute the
decision gate. A parked run can be reopened with a new prompt and a restart point;
`autoFinish: true` closes the run and cannot be reopened.

The dashboard also supports starting runs (with confirmation), pausing,
resuming and cancelling them; inline comments/feedback; later verification
evidence; iteration and rerun artifact browsing; and plan-version comparison.
Session tools can list pending decisions, respond to a decision, queue chat
feedback for the next planning or implementation checkpoint, and attach
verification evidence. New or edited GitHub issue content and comments are shown
at the next checkpoint, where you can re-plan from the refreshed snapshot or
ignore it.

Manual checkout edits made while waiting at a decision are recorded as
`manual-edits-*.patch`, included in the run's change patch, and sent through
review. Branch, HEAD, or staged-index changes still stop reconciliation. An
edited plan must pass the workflow's plan contract before it is adopted as a new
version. Replaced outputs and earlier passes remain available under
`iterations/<n>/` and `iterations/<n>/reruns/<k>/`.

Two optional flags turn each prompt off independently (both default to `false`):

```json
{
  "taskTitle": "Add CSV export",
  "taskDescription": "Add CSV export for the current results.",
  "autoApprovePlan": true,
  "autoFinish": true
}
```

- `autoApprovePlan` implements the plan without asking.
- `autoFinish` ends the run after the first review without asking.

The optional `"prompt"` decision channel requires host elicitation support.
`"inbox"` works without it. The two automation flags still skip their respective
checkpoints independently.

Ask **"Open the implementation-flow dashboard"** to inspect and control runs.
Artifacts live under the target checkout's Git directory, not in the installed
plugin.

Do not also load another project or user copy of the `implementation-flow`
extension in the same session: both would register the same workflow and canvas.

See the [extension documentation](extensions/implementation-flow/README.md) for workflow
behavior, resume constraints, artifact contracts, and dashboard details.

## Source and updates

Imported from
[`RickardHF/Autonomous-Developer-Workflows/.github/extensions/issue-delivery`](https://github.com/RickardHF/Autonomous-Developer-Workflows/tree/902631f13018867a494db48207b189181f26fa8f/.github/extensions/issue-delivery)
at commit `902631f13018867a494db48207b189181f26fa8f`.
The runtime modules, renderer assets, and tests are vendored together under
`extensions/implementation-flow/`, with local changes for the new name,
standalone task input, inbox decisions, dashboard controls, reruns, reopening,
evidence, issue updates and checkpoint reconciliation. Installation does not
fetch files from the original project.

To update, import that directory from a reviewed upstream revision, retain all
sibling assets and tests, preserve local task-input support and the human-in-the-loop
flow, update this provenance, and bump `plugin.json` and the Copilot marketplace
entry together.

From this marketplace's repository root:

```sh
node --test plugins/implementation-flow/extensions/implementation-flow/*.test.mjs
```
