import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load, exec, temporary, clone } from "./helpers.mjs";

const names = ["Store", "repoName", "parseLog", "insertCommits", "machineFile", "readMachineFile", "weekOf", "weeklyStats", "WEEK0"];
const store = (host = {}) => load("kanso-panel/shipped-store.js", names, host);

test("Shipped's store names repositories by their remote", async () => {
  const { repoName } = await store();
  assert.equal(repoName("git@github.com:org/app.git", "/x/app"), "org/app");
  assert.equal(repoName("https://github.com/org/app", "/x/app"), "org/app");
  assert.equal(repoName("https://gitlab.com/group/sub/app.git", "/x/app"), "gitlab.com/group/sub/app");
  assert.equal(repoName("", "/Users/me/Apps/scratch"), "local/scratch");
});

test("Shipped's store keeps statistics only, and machines share them by hash", async () => {
  const { parseLog, machineFile, readMachineFile, weekOf, WEEK0 } = await store();
  const log = "\x1eaaaaaaaaaaaaaaaaaaaa 1793500000\n\n 3 files changed, 40 insertions(+), 2 deletions(-)\n\x1ebbbbbbbbbbbbbbbbbbbb 1793400000\n\n 1 file changed, 1 deletion(-)\n";
  const commits = clone(parseLog(log));
  assert.deepEqual(commits, [{ hash: "aaaaaaaaaaaa", at: 1793500000, add: 40, del: 2 }, { hash: "bbbbbbbbbbbb", at: 1793400000, add: 0, del: 1 }], "12-character hashes");
  const file = clone(machineFile("box", ["me@example.invalid"], [{ repo: "org/app", hash: "aaaaaaaaaaaa", at: 1, adds: 2, dels: 3 }, { repo: "org/app", hash: "cccccccccccc", at: 4, adds: 5, dels: 6 }]));
  assert.deepEqual(file.repos, ["org/app"]);
  assert.deepEqual(file.commits[1], [0, "cccccccccccc", 4, 5, 6]);
  assert.ok(!JSON.stringify(file).match(/message|subject|path/), "no messages, files or code");
  assert.equal(clone(readMachineFile(JSON.stringify(file))).commits[1].repo, "org/app");
  assert.equal(readMachineFile("not json"), null);
  assert.equal(new Date(WEEK0 * 1000).getUTCDay(), 0, "GitHub's weeks start on Sunday");
  assert.equal(weekOf(Date.UTC(2026, 10, 3, 12) / 1000), Date.UTC(2026, 10, 1) / 1000);
});

// A Herdr home, a repository of yours with commits by two identities on two
// branches and one by a colleague, and GitHub (gists included) faked.
async function setup(t, { otherMachine = null } = {}) {
  const root = await temporary(t);
  const home = join(root, "home"), app = join(root, "app"), repo = join(home, "Apps", "tool");
  await mkdir(repo, { recursive: true });
  const git = async (...args) => { const r = await exec("git", args, { cwd: repo }); assert.equal(r.code, 0, r.stderr); return r.stdout; };
  await git("init", "-q", "-b", "main");
  await git("config", "user.name", "Me"); await git("config", "user.email", "me@example.invalid");
  await git("config", "commit.gpgsign", "false"); await git("config", "core.hooksPath", repo);
  await git("remote", "add", "origin", "git@github.com:org/tool.git");
  const commit = async (file, lines, who) => {
    await writeFile(join(repo, file), "x\n".repeat(lines));
    await git("add", "-A");
    await git(...(who ? ["-c", `user.name=${who.name}`, "-c", `user.email=${who.email}`] : []), "commit", "-q", "-m", file);
  };
  await commit("a.txt", 10);
  await commit("b.txt", 20, { name: "JJ", email: "mequexample.invalid" }); // a typo on another machine
  await commit("c.txt", 999, { name: "Colleague", email: "them@example.invalid" });
  await git("checkout", "-q", "-b", "wip");
  await commit("d.txt", 5);

  let gist = otherMachine ? { id: "g1", files: { "shipped-other.json": { content: JSON.stringify(otherMachine) } } } : null;
  const sent = [];
  const host = {
    appHome: () => app, home: () => home, spaces: () => [], panes: () => [],
    readTextFile: async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } },
    writeTextFile: async (p, text) => { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, text); return null; },
    exec: async (command, args, options) => {
      if (command !== "gh") return exec(command, args, options);
      if (args[1].startsWith("gists?")) return { code: 0, stdout: gist ? `${gist.id}\n` : "", stderr: "" };
      const body = JSON.parse(await readFile(args[args.indexOf("--input") + 1], "utf8"));
      sent.push({ method: args[args.indexOf("-X") + 1], body });
      gist = { id: gist?.id ?? "new", files: { ...(gist?.files ?? {}), ...Object.fromEntries(Object.entries(body.files).map(([k, v]) => [k, { content: v.content }])) } };
      return { code: 0, stdout: JSON.stringify(gist), stderr: "" };
    },
  };
  const mod = await store(host);
  return { ...mod, app, repo, sent, gist: () => gist };
}

test("Shipped's store reads every branch of your repositories, by every identity of yours", async (t) => {
  const s = await setup(t);
  const db = new s.Store();
  await db.open();
  const scanned = await db.scanLocal(["me@example.invalid"], null);
  assert.equal(scanned, 1, "found under ~/Apps");
  let rows = await db.sql("SELECT repo, adds FROM commits ORDER BY adds;", true);
  assert.deepEqual(clone(rows.map((r) => [r.repo, r.adds])), [["org/tool", 5], ["org/tool", 10]], "both branches, not the colleague, not yet the typo");
  assert.equal(await db.scanLocal(["me@example.invalid"], null), 0, "nothing moved: nothing read");

  // An identity learned from another machine: the next read finds those commits too.
  await db.sql("DELETE FROM scans;");
  await db.scanLocal(["me@example.invalid", "mequexample.invalid"], null);
  rows = await db.sql("SELECT adds FROM commits ORDER BY adds;", true);
  assert.deepEqual(clone(rows.map((r) => r.adds)), [5, 10, 20]);

  const weekly = clone(await db.weekly());
  assert.equal(weekly.repos["org/tool"].weeks.reduce((n, w) => n + w[1], 0), 35);
  const rhythm = clone(await db.rhythm(0, Date.now() / 1000 + 60));
  assert.equal(rhythm.hours.reduce((a, b) => a + b, 0), 3);
  assert.equal(rhythm.machines.length, 1);
});

test("Shipped's store keeps the larger of a repository's week, from git or from GitHub", async (t) => {
  const s = await setup(t);
  const db = new s.Store();
  await db.open();
  await db.scanLocal(["me@example.invalid"], null); // 15 lines this week in org/tool
  const week = s.weekOf(Math.floor(Date.now() / 1000)) * 1000;
  await db.saveGithub([
    { repo: "org/tool", pushed: "2026-01-01T00:00:00Z", fetched: 1, weeks: [[week, 100, 1, 2]] },
    { repo: "org/remote-only", pushed: "2026-01-01T00:00:00Z", fetched: 1, weeks: [[week, 7, 0, 1]] },
    { repo: "org/slow", pushed: null, fetched: 0, pending: true },
  ]);
  const weekly = clone(await db.weekly());
  assert.deepEqual(weekly.repos["org/tool"].weeks.find((w) => w[0] === week).slice(1), [100, 1, 2], "GitHub saw more there");
  assert.ok(weekly.repos["org/remote-only"], "a repository no machine has cloned");
  assert.equal((await db.ghRepos()).find((r) => r.repo === "org/slow").pending, 1);
});

test("Shipped's store shares your commits between machines through a private gist", async (t) => {
  const other = { v: 1, machine: "other", updated: 1, identities: ["mequexample.invalid"], repos: ["org/tool", "org/elsewhere"],
    commits: [[1, "eeeeeeeeeeee", 1793000000, 300, 3], [0, "ffffffffffff", 1793000000, 1, 0]] };
  const s = await setup(t, { otherMachine: other });
  const db = new s.Store();
  await db.open();
  await db.scanLocal(["me@example.invalid"], null);
  const synced = clone(await db.syncMachines(["me@example.invalid"]));
  assert.deepEqual(synced.machines, ["other"]);
  assert.deepEqual(synced.identities, ["mequexample.invalid"], "learned, for the next local read");
  const mine = s.sent[0];
  assert.equal(mine.method, "PATCH", "the existing gist");
  const name = Object.keys(mine.body.files)[0];
  assert.match(name, /^shipped-.+\.json$/);
  assert.equal(JSON.parse(mine.body.files[name].content).commits.length, 2, "this machine's commits only");
  const rows = await db.sql("SELECT machine, COUNT(*) n FROM commits GROUP BY machine ORDER BY machine;", true);
  assert.deepEqual(rows.find((r) => r.machine === "other").n, 2);

  // Again: the same commits are not counted twice.
  await db.syncMachines(["me@example.invalid"]);
  assert.equal((await db.sql("SELECT COUNT(*) n FROM commits;", true))[0].n, 4);
});

test("Shipped's store creates the private gist the first time", async (t) => {
  const s = await setup(t);
  const db = new s.Store();
  await db.open();
  await db.syncMachines(["me@example.invalid"]);
  assert.equal(s.sent[0].method, "POST");
  assert.equal(s.sent[0].body.public, false);
  assert.equal(s.sent[0].body.description, "Kanso Shipped stats");
  assert.equal(await db.meta("gist"), "new");
});
