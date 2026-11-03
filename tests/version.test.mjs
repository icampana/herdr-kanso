import assert from "node:assert/strict";
import test from "node:test";
import { readFile } from "node:fs/promises";
import { check, parseChangelog, requiredBump, notes } from "../scripts/check-version.mjs";

const log = (...sections) => `# Changelog\n\n${sections.join("\n")}`;
const section = (v, date, body) => `## [${v}] - ${date}\n\n${body}\n`;
const ok = { tags: [], installedChangedSince: () => false };

test("The repository's own versioning passes", async () => {
  const changelog = await readFile(new URL("../CHANGELOG.md", import.meta.url), "utf8");
  const { version } = JSON.parse(await readFile(new URL("../kanso/mods/kanso-chrome/version.json", import.meta.url), "utf8"));
  assert.deepEqual(check({ version, changelog, tags: ["1.0.0"], installedChangedSince: () => true }), []);
  assert.equal(parseChangelog(changelog).sections.at(-1).version, "1.0.0", "history down to the first release");
});

test("Each release is the exact semantic successor of the one before", () => {
  assert.equal(requiredBump(["Fixed", "Changed"]), "patch");
  assert.equal(requiredBump(["Fixed", "Added"]), "minor");
  assert.equal(requiredBump(["Added", "Removed"]), "major");
  const base = section("1.0.0", "2026-11-01", "### Added\n\n- First.");
  const run = (v, body) => check({ version: v, changelog: log(section(v, "2026-11-02", body), base), ...ok });
  assert.deepEqual(run("1.0.1", "### Fixed\n\n- A bug."), []);
  assert.deepEqual(run("1.1.0", "### Added\n\n- A feature."), []);
  assert.deepEqual(run("2.0.0", "### Breaking\n\n- A key moved."), []);
  assert.match(run("1.1.0", "### Fixed\n\n- A bug.").join(), /patch bump: 1\.0\.1, not 1\.1\.0/);
  assert.match(run("1.0.1", "### Added\n\n- A feature.").join(), /minor bump: 1\.1\.0, not 1\.0\.1/);
  assert.match(run("1.2.0", "### Added\n\n- A feature.").join(), /minor bump: 1\.1\.0, not 1\.2\.0/, "no skipped versions");
});

test("A change to what Kanso installs needs a new version and its section", () => {
  const changelog = log(section("1.0.0", "2026-11-01", "### Added\n\n- First."));
  const errors = check({ version: "1.0.0", changelog, tags: ["1.0.0"], installedChangedSince: () => true });
  assert.match(errors.join(), /changed since v1\.0\.0, but .* still says 1\.0\.0/);
  assert.deepEqual(check({ version: "1.0.0", changelog, tags: ["1.0.0"], installedChangedSince: () => false }), [], "docs-only changes need none");
  assert.match(check({ version: "1.1.0", changelog, ...ok }).join(), /says 1\.1\.0, but the newest CHANGELOG\.md section is 1\.0\.0/);
});

test("The changelog keeps every release, newest first, in the agreed shape", () => {
  const one = section("1.0.0", "2026-11-01", "### Added\n\n- First.");
  const two = section("1.1.0", "2026-11-02", "### Added\n\n- Second.");
  assert.match(check({ version: "1.1.0", changelog: log(two), tags: ["1.0.0", "1.1.0"], installedChangedSince: () => false }).join(), /tag v1\.0\.0 has no CHANGELOG\.md section/);
  assert.match(check({ version: "1.1.0", changelog: log(one, two), ...ok }).join(), /newest first/);
  assert.match(check({ version: "1.0.0", changelog: log(section("1.0.0", "2026-11-01", "### Improved\n\n- x")), ...ok }).join(), /"Improved" is not one of/);
  assert.match(check({ version: "1.0.0", changelog: log(section("1.0.0", "2026-11-01", "Nothing.")), ...ok }).join(), /lists no changes/);
  assert.match(check({ version: "1.0", changelog: log("## [1.0] - 2026-11-01\n\n### Added\n\n- x\n"), ...ok }).join(), /not a semantic version/);
  assert.match(check({ version: "1.0.0", changelog: log("## 1.0.0\n"), ...ok }).join(), /a version heading reads/);
  assert.match(check({ version: "1.0.0", changelog: log(one), tags: ["1.1.0"], installedChangedSince: () => false }).join(), /older than the released v1\.1\.0/);
});

test("Release notes are the version's section", () => {
  const changelog = log(section("1.1.0", "2026-11-02", "### Added\n\n- Second."), section("1.0.0", "2026-11-01", "### Added\n\n- First."));
  assert.equal(notes(changelog, "1.1.0"), "### Added\n\n- Second.");
  assert.equal(notes(changelog, "9.9.9"), null);
});
