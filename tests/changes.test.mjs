import assert from "node:assert/strict";
import test from "node:test";
import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { load, temporary, exec, context } from "./helpers.mjs";

const { insideRoot, diffRows } = await load("kanso-panel/lib.js", ["insideRoot", "diffRows"]);

async function repo(t) {
  const cwd = await temporary(t);
  const git = async (...args) => {
    const result = await exec("git", args, { cwd });
    assert.equal(result.code, 0, result.stderr);
    return result.stdout;
  };
  await git("init", "-q");
  await git("config", "user.name", "Regression tests");
  await git("config", "user.email", "tests@example.invalid");
  await git("config", "commit.gpgsign", "false");
  await git("config", "core.hooksPath", cwd);
  const { Changes } = await load("kanso-panel/changes.js", ["Changes"], {
    exec, insideRoot, diffRows, key: () => cwd,
    location: () => ({ cwd, on: "fixture" }), // No live filesystem watcher.
    readTextFile: (path) => readFile(path, "utf8"),
  });
  const panel = new Changes();
  panel.input = { set_value() {} };
  const { cx, drain } = context();
  const commit = async () => {
    panel.refresh(cx);
    await drain();
    panel.message = "Commit from Changes";
    panel.commit(cx);
    await drain();
    assert.equal(panel.note, null);
    assert.equal(await git("status", "--porcelain"), "");
  };
  return { cwd, git, panel, commit };
}

test("Changes commits a staged deletion without adding a missing path", async (t) => {
  const { cwd, git, commit } = await repo(t);
  await writeFile(join(cwd, "removed.txt"), "before\n");
  await git("add", "-A"); await git("commit", "-qm", "initial");
  await git("rm", "removed.txt");
  await commit();
  assert.equal(await git("show", "--pretty=", "--name-status", "HEAD"), "D\tremoved.txt\n");
});

test("Changes commits both sides of a staged rename", async (t) => {
  const { cwd, git, commit } = await repo(t);
  await writeFile(join(cwd, "old.txt"), "contents\n");
  await git("add", "-A"); await git("commit", "-qm", "initial");
  await git("mv", "old.txt", "new.txt");
  await commit();
  assert.equal(await git("ls-tree", "--name-only", "HEAD"), "new.txt\n");
});

test("Changes still stages unstaged deletions and new literal filenames", async (t) => {
  const { cwd, git, commit } = await repo(t);
  await writeFile(join(cwd, "removed.txt"), "before\n");
  await git("add", "-A"); await git("commit", "-qm", "initial");
  await unlink(join(cwd, "removed.txt"));
  await writeFile(join(cwd, "[draft]*.txt"), "after\n");
  await commit();
  assert.equal(await git("ls-tree", "--name-only", "HEAD"), "[draft]*.txt\n");
});

test("Changes supports an initial commit", async (t) => {
  const { cwd, commit } = await repo(t);
  await writeFile(join(cwd, "first.txt"), "first\n");
  await commit();
});
