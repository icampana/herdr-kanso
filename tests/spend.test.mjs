import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { exec, temporary } from "./helpers.mjs";

const presenter = fileURLToPath(new URL("../kanso/mods/kanso-spend/presenter.mjs", import.meta.url));

// A home with one Claude Code session, and a fresh price list so nothing is fetched.
async function fixture(t) {
  const root = await temporary(t);
  const home = join(root, "home"), data = join(root, "data");
  const project = join(home, ".claude", "projects", "-Users-me-Apps-secret-project");
  await mkdir(project, { recursive: true });
  await mkdir(data, { recursive: true });
  const now = new Date().toISOString();
  const lines = [
    { type: "user", sessionId: "s1", timestamp: now, cwd: "/Users/me/Apps/secret-project", uuid: "u1", message: { role: "user", content: "hi" } },
    { type: "assistant", sessionId: "s1", timestamp: now, cwd: "/Users/me/Apps/secret-project", uuid: "a1", requestId: "r1",
      message: { id: "m1", role: "assistant", model: "claude-opus-4-1", usage: { input_tokens: 1000000, output_tokens: 100000, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 } } },
  ];
  await writeFile(join(project, "s1.jsonl"), lines.map((l) => JSON.stringify(l)).join("\n") + "\n");
  await writeFile(join(data, "pricing.json"), JSON.stringify({ fetchedAt: Date.now(), rates: [{ id: "anthropic/claude-opus-4.1", input: 0.000015, output: 0.000075 }] }));
  return { home, data };
}

const run = async (f, command) => {
  const r = await exec(process.execPath, [presenter, command, "--store", join(f.data, "store.json"), "--home", f.home]);
  assert.equal(r.code, 0, r.stderr);
  return JSON.parse(r.stdout);
};

test("Spend, now part of Kanso, prices your AI sessions at list price", async (t) => {
  const f = await fixture(t);
  const out = await run(f, "snapshot");
  assert.equal(out.kind, "kanso-spend-costs");
  assert.equal(out.costs.hero.value, "$22.50", "1M in at $15/M plus 100K out at $75/M");
  assert.equal(out.costs.live[0].detail.project, "secret-project");
  assert.ok((await stat(join(f.data, "spend.db"))).size > 0, "the store is kept in SQLite");
  assert.equal(await stat(join(f.data, "store.json")).catch(() => null), null, "no JSON store");

  // Prepared again from the store alone: the same numbers, nothing scanned.
  const again = await run(f, "prepare");
  assert.equal(again.costs.hero.value, "$22.50");
});

test("Spend moves a store.json from before into SQLite once", async (t) => {
  const f = await fixture(t);
  await run(f, "snapshot");
  // The store as the JSON file it used to be.
  const { loadStore } = await import("../kanso/mods/kanso-spend/core/store.mjs");
  const legacy = (await loadStore(join(f.data, "store.json"))).store;
  const old = join(f.data, "..", "old");
  await mkdir(old, { recursive: true });
  await writeFile(join(old, "store.json"), JSON.stringify(legacy));
  await writeFile(join(old, "pricing.json"), await readFile(join(f.data, "pricing.json")));
  const g = { home: f.home, data: old };

  const read = await run(g, "prepare");
  assert.equal(read.costs.hero.value, "$22.50", "read as it is, before any scan");
  assert.equal(await stat(join(old, "spend.db")).catch(() => null), null, "a read moves nothing");

  const scanned = await run(g, "snapshot");
  assert.equal(scanned.costs.hero.value, "$22.50", "the same numbers after the move");
  assert.ok(await stat(join(old, "spend.db")));
  assert.ok(await stat(join(old, "store.json.migrated")), "the old file is kept aside");
  assert.equal(await stat(join(old, "store.json")).catch(() => null), null);

  // A rescan from SQLite: the same numbers, one row per scanned file.
  assert.equal((await run(g, "snapshot")).costs.hero.value, "$22.50");
  const { DatabaseSync } = await import("node:sqlite");
  const db = new DatabaseSync(join(old, "spend.db"), { readOnly: true });
  t.after(() => db.close());
  assert.equal(db.prepare("SELECT COUNT(*) n FROM files").get().n, Object.keys(legacy.files).length);
});
