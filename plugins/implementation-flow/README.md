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
branch with a clean checkout and no concurrent writers. It uses five agent
contexts and can consume substantial credits. It leaves source changes unstaged;
it does not create branches, commit, push, open pull requests, or modify the issue.

Ask **"Open the implementation-flow dashboard"** to inspect recorded runs. Artifacts
live under the target checkout's Git directory, not in the installed plugin.
The dashboard is read-only and does not start workflows.

Do not also load another project or user copy of the `implementation-flow`
extension in the same session: both would register the same workflow and canvas.

See the [extension documentation](extensions/implementation-flow/README.md) for workflow
behavior, resume constraints, artifact contracts, and dashboard details.

## Source and updates

Imported from
[`RickardHF/Autonomous-Developer-Workflows/.github/extensions/issue-delivery`](https://github.com/RickardHF/Autonomous-Developer-Workflows/tree/902631f13018867a494db48207b189181f26fa8f/.github/extensions/issue-delivery)
at commit `902631f13018867a494db48207b189181f26fa8f`.
The runtime modules, renderer assets, and tests are vendored together under
`extensions/implementation-flow/`, with local changes for the new name and
standalone task input support, and documentation adjusted for this package's
layout. Installation does not fetch files from the original project.

To update, import that directory from a reviewed upstream revision, retain all
sibling assets and tests, preserve local task-input support, update this provenance,
and bump `plugin.json` and the Copilot marketplace entry together.

From this marketplace's repository root:

```sh
node --test plugins/implementation-flow/extensions/implementation-flow/*.test.mjs
```
