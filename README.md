# Agentic Library

Reusable agents, skills, prompts, and Copilot plugins for use across projects.

## Install from the marketplace

Register the marketplace once, then install the plugins you want:

```sh
copilot plugin marketplace add RickardHF/agentic-resources
copilot plugin install engineering-team@rickardhf-agentic-resources
copilot plugin install issue-delivery@rickardhf-agentic-resources
```

Start a new Copilot session in the repository where you want to use the plugin.
After a new release, refresh the catalog and update the installed plugin:

```sh
copilot plugin marketplace update rickardhf-agentic-resources
copilot plugin update issue-delivery
```

| Plugin | Components | Documentation |
| --- | --- | --- |
| `engineering-team` | Engineering team agents | [Agents](plugins/engineering-team/agents) |
| `issue-delivery` | Issue delivery workflow and read-only run dashboard | [Usage and requirements](plugins/issue-delivery/README.md) |

`issue-delivery` requires a Copilot runtime with SDK extensions, dynamic workflows,
and canvas support. It is not a Claude Code plugin.

## Library layout

The Copilot catalog is `.github/plugin/marketplace.json`. Each entry points to a
self-contained directory under `plugins/`, with a root `plugin.json` and all of
its components inside that directory. Installing a plugin does not depend on the
original project or files outside its package.

These packages use the supported Copilot-specific manifest format (without an
Agent Plugins `$schema`). In particular, `issue-delivery` needs the `extensions`
component-path field; this is not the namespaced `extensions` metadata field in
the portable Agent Plugins format. See the [Copilot plugin reference](https://docs.github.com/en/copilot/reference/copilot-cli-reference/cli-plugin-reference).

`.claude-plugin/marketplace.json` remains a compatibility catalog for
`engineering-team`, whose Claude manifest is kept alongside the Copilot manifest.
It intentionally excludes the Copilot-only `issue-delivery` plugin. The top-level
`agents/`, `skills/`, and `prompts/` directories are standalone resources, not
automatically installed marketplace components.

## Add or update a plugin

1. Add a self-contained package under `plugins/<name>/` with a root `plugin.json`.
2. Register it in `.github/plugin/marketplace.json`, keeping its name, description,
   and version aligned with its manifest.
3. If it also supports Claude Code, update the compatibility catalog and manifest.
4. When updating packaged code, bump its plugin and catalog versions together.

Run the packaging checks and issue-delivery's deterministic tests:

```sh
node --test tests/marketplace.test.mjs plugins/issue-delivery/extensions/issue-delivery/*.test.mjs
```
