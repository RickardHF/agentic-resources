# Issue delivery plugin

This Copilot-specific plugin bundles the `issue-delivery` dynamic workflow and
the **Issue delivery runs** dashboard (`issue-delivery-runs`).

## Install and use

```sh
copilot plugin marketplace add RickardHF/agentic-resources
copilot plugin install issue-delivery@rickardhf-agentic-resources
```

Start a new Copilot session in your target Git repository. The runtime must support
SDK extensions, `defineWorkflow`, and canvases; Git and an authenticated GitHub CLI
(`gh`) must be available. The runtime supplies `@github/copilot-sdk`; no npm install
or build step is needed.

Ask Copilot to run the `issue-delivery` workflow with:

```json
{
  "issueUrl": "https://github.com/OWNER/REPOSITORY/issues/42"
}
```

Run it in the repository that should receive the implementation, on the intended
branch with a clean checkout and no concurrent writers. It uses five agent
contexts and can consume substantial credits. It leaves source changes unstaged;
it does not create branches, commit, push, open pull requests, or modify the issue.

Ask **"Open the issue-delivery dashboard"** to inspect recorded runs. Artifacts
live under the target checkout's Git directory, not in the installed plugin.
The dashboard is read-only and does not start workflows.

Do not also load a project or user copy of the original `issue-delivery` extension
in the same session: both would register the same workflow and canvas.

See the [extension documentation](extensions/issue-delivery/README.md) for workflow
behavior, resume constraints, artifact contracts, and dashboard details.

## Source and updates

Imported from
[`RickardHF/Autonomous-Developer-Workflows/.github/extensions/issue-delivery`](https://github.com/RickardHF/Autonomous-Developer-Workflows/tree/902631f13018867a494db48207b189181f26fa8f/.github/extensions/issue-delivery)
at commit `902631f13018867a494db48207b189181f26fa8f`.
The runtime modules, renderer assets, and tests are vendored together under
`extensions/issue-delivery/`; only the bundled documentation is adjusted for this
package's layout. Installation does not fetch files from the original project.

To update, import that directory from a reviewed upstream revision, retain all
sibling assets and tests, update this provenance, and bump `plugin.json` and the
Copilot marketplace entry together.

From this marketplace's repository root:

```sh
node --test plugins/issue-delivery/extensions/issue-delivery/*.test.mjs
```
