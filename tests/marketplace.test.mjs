import assert from "node:assert/strict";
import { readFile, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import test from "node:test";

const root = fileURLToPath(new URL("../", import.meta.url));
const readJson = async (name) => JSON.parse(await readFile(path.join(root, name), "utf8"));
const catalogs = [".github/plugin/marketplace.json", ".claude-plugin/marketplace.json"];

for (const catalogPath of catalogs) {
  test(`${catalogPath} resolves self-contained, versioned plugins`, async () => {
    const catalog = await readJson(catalogPath);
    assert.equal(catalog.name, "rickardhf-agentic-resources");
    assert.ok(catalog.owner.name);
    assert.ok(catalog.plugins.length > 0);
    assert.equal(new Set(catalog.plugins.map(({ name }) => name)).size, catalog.plugins.length);
    for (const entry of catalog.plugins) {
      assert.match(entry.source, /^\.\/plugins\/[a-z0-9-]+$/);
      const manifestPath = catalogPath.startsWith(".claude-plugin/")
        ? ".claude-plugin/plugin.json" : "plugin.json";
      const manifest = await readJson(path.join(entry.source, manifestPath));
      for (const field of ["name", "version", "description"]) {
        assert.equal(entry[field], manifest[field], `${entry.name}: ${field}`);
      }
      assert.ok(manifest.author.name);
      for (const component of ["agents", "extensions"]) {
        for (const location of manifest[component] ?? []) {
          const directory = path.resolve(root, entry.source, location);
          const relative = path.relative(path.resolve(root, entry.source), directory);
          assert.ok(relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative));
          assert.ok((await stat(directory)).isDirectory());
          const files = await readdir(directory);
          if (component === "agents") {
            assert.ok(files.some((name) => name.endsWith(".agent.md")));
          } else {
            assert.ok(files.length > 0);
            for (const name of files) {
              assert.ok((await stat(path.join(directory, name, "extension.mjs"))).isFile());
            }
          }
        }
      }
    }
  });
}

test("Claude compatibility preserves engineering-team without advertising Copilot-only extensions", async () => {
  const copilot = await readJson(catalogs[0]);
  const claude = await readJson(catalogs[1]);
  assert.deepEqual(copilot.plugins.map(({ name }) => name), ["engineering-team", "implementation-flow"]);
  assert.deepEqual(claude.plugins.map(({ name }) => name), ["engineering-team"]);
  assert.deepEqual(
    await readJson("plugins/engineering-team/plugin.json"),
    await readJson("plugins/engineering-team/.claude-plugin/plugin.json"),
  );
  const delivery = await readJson("plugins/implementation-flow/plugin.json");
  assert.equal(delivery.version, "1.0.0");
  assert.deepEqual(delivery.extensions, ["./extensions"]);
  assert.equal(delivery.$schema, undefined, "SDK extension paths require the Copilot-specific manifest");
});
