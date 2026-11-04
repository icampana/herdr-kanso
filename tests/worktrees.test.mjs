import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, rm, writeFile, stat } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { load, context, temporary, clone, exec } from "./helpers.mjs";

const names = ["Worktrees", "removable", "losses", "lastDays", "spaceBy", "freedSpec", "freedText", "explainPrompt", "reviewPrompt", "rootsFor", "parseDiscovery", "basesFrom", "parseWorktrees", "parseProbe", "stateOf", "safe", "consequence", "fmtSize", "fmtAge", "inside"];
const writeTextFile = (path, text) => writeFile(path, text);
const storeOf = (app) => load("kanso-panel/worktrees-store.js", ["WorktreeStore", "upsertSql", "rowOf", "itemOf"], { exec, appHome: () => app, writeTextFile });
const worktrees = async (host = {}) => load("kanso-panel/worktrees.js", names, {
  WorktreeStore: (await storeOf(host.app ?? "/nonexistent")).WorktreeStore,
  exec, spaces: () => [], panes: () => [], home: () => "/Users/me", run() {}, theme: () => ({}), shared: () => null, notify() {},
  knownAgents: async () => [], Share: class { constructor() { this.open = false; } }, postText: (parts, fallback) => (parts.length ? parts.join(", ") + "." : fallback), ...host,
});
const git = async (cwd, ...args) => {
  const r = await exec("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd });
  assert.equal(r.code, 0, `git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
};
const exists = (p) => stat(p).then(() => true, () => false);

test("Worktrees searches the top folders of your spaces, or the ones you chose", async () => {
  const { rootsFor, inside } = await worktrees();
  assert.deepEqual(clone(rootsFor(["/Users/me/Apps/acme/web", "/Users/me/Apps/x", "/Users/me", "/Users/me/.config/a", "/Volumes/w/repo", "/private/tmp/x", null], "/Users/me")),
    ["/Users/me/Apps", "/Volumes/w/repo"], "home itself, hidden folders and temp are not roots");
  assert.deepEqual(clone(rootsFor(["/Users/me/Apps/a"], "/Users/me", ["/src", "rel", "/src"])), ["/src"]);
  assert.ok(inside("/private/tmp/wt", "/tmp/wt/src"), "/tmp is /private/tmp");
  assert.ok(!inside("/a/wt", "/a/wt2"));
});

test("Worktrees parses git's worktree list and the probes", async () => {
  const { parseWorktrees, parseProbe, basesFrom, parseDiscovery } = await worktrees();
  const list = clone(parseWorktrees("worktree /r\0HEAD a\0branch refs/heads/main\0\0worktree /w1\0HEAD b\0detached\0locked\0\0worktree /w2\0HEAD c\0branch refs/heads/feat/x\0prunable gitdir file points to non-existent location\0\0"));
  assert.deepEqual(list.map((w) => [w.path, w.main, w.branch, w.detached, w.locked, w.prunable]),
    [["/r", true, "main", false, false, false], ["/w1", false, null, true, true, false], ["/w2", false, "feat/x", false, false, true]]);
  assert.deepEqual(clone(parseProbe("recent\nonly\t1\ndirty\t3\nlast\t100\nmerged\nahead\t2\n")), { gone: false, replaced: false, broken: false, dirty: 3, last: 100000, ahead: 2, merged: true, recent: true, only: 1 });
  assert.equal(parseProbe("gone\n").gone, true);
  assert.equal(parseProbe("replaced\n").replaced, true);
  assert.deepEqual(clone(basesFrom("origin/main\nmain\norigin/master\n")), ["origin/main", "main"]);
  assert.deepEqual(clone(basesFrom("master\n")), ["master"]);
  assert.deepEqual(clone(parseDiscovery("R\t/a\nO\t/tmp/x\n\nnoise")), { repos: ["/a"], orphans: ["/tmp/x"] });
});

test("Worktrees says what removing loses, and only cleans up what loses nothing", async () => {
  const { stateOf, safe, consequence, removable, losses } = await worktrees();
  const w = (o) => ({ probed: true, branch: "b", dirty: 0, ahead: 0, only: 0, merged: false, recent: false, ...o });
  assert.equal(stateOf(w({ merged: true })), "merged");
  assert.equal(stateOf(w({ merged: true, dirty: 2 })), "changes", "uncommitted work beats merged");
  assert.equal(stateOf(w({ merged: true, open: true })), "open");
  assert.equal(stateOf(w({ merged: true, recent: true })), "recent", "touched today: an agent may be at work");
  assert.equal(stateOf(w({ branch: null, ahead: 2, only: 2 })), "lost");
  assert.equal(stateOf(w({ branch: null, ahead: 2 })), "detached", "its commits are on a branch");
  assert.equal(stateOf(w({ ahead: 2 })), "unmerged");
  assert.deepEqual([w({ merged: true }), w({ missing: true }), w({ ahead: 1 }), w({ branch: null, ahead: 1 }),
    w({ merged: true, open: true }), w({ merged: true, locked: true }), w({ merged: true, dirty: 1 }), w({ branch: null, only: 1 }), w({ recent: true }), w({ probed: false })].map(safe),
  [true, true, true, true, false, false, false, false, false, false]);
  assert.match(consequence(w({ dirty: 2, ahead: 3 }), "main"), /^Loses 2 uncommitted changes\. Branch b stays with its 3 commits\.$/);
  assert.match(consequence(w({ merged: true }), "main"), /Nothing is lost\. Branch b goes too: its work is in main\./);
  assert.match(consequence(w({ branch: null, ahead: 1, only: 1 }), "main"), /Loses 1 commit no branch has/);
  assert.deepEqual([w({ dirty: 1 }), w({ branch: null, only: 2 }), w({ recent: true }), w({ open: true }), w({ locked: true }), w({ probed: false }), { orphan: true }].map(removable),
    [true, true, false, false, false, false, true], "Remove all asks first, and still leaves what may be in use");
  assert.equal(losses([w({ dirty: 2 }), w({ dirty: 1 }), w({ branch: null, only: 3 }), { orphan: true }]),
    "Loses 3 uncommitted changes in 2; 3 commits no branch has, in 1; whatever is in a folder git no longer knows.");
  assert.equal(losses([w({ merged: true })]), "Nothing is lost.");
});

test("Worktrees keeps each worktree once, rewrites it only when it changed, and keeps the gone ones as history", async (t) => {
  const app = await temporary(t), dir = await temporary(t);
  const { WorktreeStore } = await storeOf(app);
  const store = new WorktreeStore();
  await store.open();
  const sql = async (q) => clone(await store.sql(q, true));
  const a = join(dir, "a"), b = join(dir, "b"), c = join(dir, "c");
  await mkdir(a); await mkdir(b);
  const day = (d) => new Date(2026, 10, d, 12).getTime();
  const wa = { path: a, repo: "/r", branch: "x", size: 100, dirty: 0, merged: true }, wb = { path: b, repo: "/r", branch: "y", size: 50, dirty: 2 };
  const rec = { path: c, repo: "/r", missing: true };
  await store.save([wa, wb, rec], day(1));
  await store.save([wa, { ...wb, size: null }, rec], day(2));
  assert.equal((await sql("SELECT COUNT(*) n FROM worktrees;"))[0].n, 3, "read again: no copies");
  assert.deepEqual((await sql("SELECT changed, size FROM worktrees ORDER BY path;")).map((r) => [r.changed, r.size]), [[day(1), 100], [day(1), 50], [day(1), null]],
    "unchanged rows are not rewritten; a size not measured keeps the stored one");
  await store.save([{ ...wa, size: 120 }, { ...wb, dirty: 0 }, rec], day(3));
  assert.deepEqual((await sql("SELECT changed, size, dirty FROM worktrees WHERE path IN ('" + a + "','" + b + "') ORDER BY path;")).map((r) => [r.changed, r.size, r.dirty]),
    [[day(3), 120, 0], [day(3), 50, 0]], "a change rewrites the row");

  // Removed here, and gone outside: both are history, with what they freed.
  await store.removed(wa, { kb: 120, branches: 1 }, day(4));
  await rm(a, { recursive: true }); await rm(b, { recursive: true });
  const gone = await store.sweep(new Set(), { has: (r) => r === "/r" }, day(5));
  assert.equal(gone, 2, "b's folder is gone; c's record is no longer listed by its repository");
  const h = clone(await store.history());
  assert.deepEqual([h.kb, h.kanso, h.worktrees, h.records, h.branches], [170, 120, 2, 1, 1]);
  assert.deepEqual(h.freedByDay, { "2026-11-04": 120, "2026-11-05": 50 });

  // The same path made again is a new row; the old one stays history.
  await mkdir(a);
  await store.save([{ ...wa, size: 10 }], day(6));
  assert.equal((await sql(`SELECT COUNT(*) n FROM worktrees WHERE path='${a}';`))[0].n, 2);
  assert.equal((await store.live()).length, 1);

  // A folder outside the scan's repositories is left alone.
  assert.equal(await store.sweep(new Set(), { has: () => false }, day(7)), 0, "a still exists");
  await store.recordScan({ worktrees: 1, size: 10, canGo: 0, canGoSize: 0, look: 0, missing: 0, orphans: 0, repos: 1 }, day(6));
  await store.recordScan({ worktrees: 1, size: 30, canGo: 0, canGoSize: 0, look: 0, missing: 0, orphans: 0, repos: 1 }, day(6) + 3600000);
  assert.deepEqual(clone(await store.history()).diskByDay, { "2026-11-06": 30 }, "a day's last scan");

  // Two copies of the panel at once: the second waits for the first instead of "database is locked".
  const other = new WorktreeStore();
  const many = Array.from({ length: 300 }, (_, i) => ({ path: join(dir, `w${i}`), repo: "/r", size: i }));
  await Promise.all([store.save(many, day(8)), other.save(many.map((w) => ({ ...w, size: w.size + 1 })), day(8)), store.history(), other.open(), other.history()]);
  assert.equal((await sql("SELECT COUNT(*) n FROM worktrees WHERE gone_at IS NULL;"))[0].n, 301);
});

test("Worktrees shows where the space is, by what can be done with it", async () => {
  const { spaceBy } = await worktrees();
  const w = (o) => ({ probed: true, fresh: true, branch: "b", dirty: 0, ahead: 0, only: 0, merged: false, recent: false, ...o });
  const parts = clone(spaceBy([w({ merged: true, size: 100 }), w({ size: 50 }), w({ dirty: 1, size: 30 }), w({ recent: true, size: 20 }), w({ missing: true }), w({ probed: false, size: 5 })], [{ orphan: true, size: 7 }]));
  assert.deepEqual(parts.map((p) => [p.key, p.count, p.kb]), [["go", 2, 150], ["look", 1, 30], ["use", 1, 20], ["left", 1, 7], ["checking", 1, 5]]);
});

test("Worktrees shares the totals only: what was freed, or what they take before that", async () => {
  const { freedSpec, freedText, lastDays } = await worktrees();
  const day = (d) => new Date(2026, 10, d, 12).getTime();
  assert.deepEqual(clone(lastDays({ "2026-11-01": 5, "2026-11-03": 7 }, day(3), 3)).map((d) => [d.day, d.kb]), [["2026-11-01", 5], ["2026-11-02", 0], ["2026-11-03", 7]]);
  const h = { kb: 2.5 * 1048576, kanso: 2 * 1048576, worktrees: 4, records: 5, orphans: 1, branches: 2, since: day(1),
    freedByDay: { "2026-11-01": 2 * 1048576, "2026-11-03": 512 * 1024 }, diskByDay: { "2026-11-01": 9 * 1048576 } };
  const now = { size: 9 * 1048576, worktrees: 40, canGoSize: 1048576, look: 3, space: [{ key: "go", label: "Can go, losing nothing", count: 30, kb: 1048576 }, { key: "look", label: "Need a look", count: 3, kb: 0 }] };
  const spec = clone(freedSpec(h, now, day(3)));
  assert.deepEqual([spec.hero.big, spec.hero.small, spec.right], ["2.5", "GB", "since Nov 1"]);
  assert.deepEqual(spec.stats.map((x) => x.value), ["4", "2", "6"]);
  assert.equal(spec.blocks[0].title, "Freed each day");
  assert.match(freedText(h, now), /^Freed 2\.5 GB of disk from 4 git worktrees my AI agents left behind, 2 merged branches deleted\.$/);
  const before = clone(freedSpec({ ...h, kb: 0, freedByDay: {} }, now, day(3)));
  assert.deepEqual([before.hero.big, before.hero.label], ["9.0", "of disk in git worktrees agents left behind"]);
  assert.equal(before.blocks[0].title, "On disk each day");
  assert.deepEqual(before.blocks[1].rows, [{ name: "Can go, losing nothing", detail: "30 folders", value: "1.0", unit: "GB" }], "where the space is, by state; empty states left out");
  assert.match(freedText({ kb: 0 }, now), /^My AI agents left 9\.0 GB of disk in 40 git worktrees\.$/);
  assert.doesNotMatch(JSON.stringify([spec, before]) + freedText(h, now), /\/|acme|feat/, "no path, repository or branch");
});

test("Worktrees asks your agent to explain, never to change anything", async () => {
  const { explainPrompt, reviewPrompt } = await worktrees();
  const w = { path: "/wt/a", repo: "/src/acme", branch: "feat/x", dirty: 2, only: 0 };
  const one = explainPrompt(w, "develop");
  assert.match(one, /worktree of \/src\/acme, on branch feat\/x/);
  assert.match(one, /git log develop\.\.HEAD/);
  assert.match(one, /Do not change, commit, push or delete anything\./);
  assert.match(explainPrompt({ orphan: true, path: "/x" }), /repository moved or was deleted/);
  const all = reviewPrompt([w, { path: "/wt/b", repo: "/src/acme", branch: null, dirty: 0, only: 3 }], () => "main");
  assert.match(all, /- \/wt\/a \(worktree of \/src\/acme, branch feat\/x, 2 uncommitted changes, compared with main\)/);
  assert.match(all, /detached HEAD, 3 commits no branch has/);
  assert.match(all, /Do not change, commit, push or delete anything yourself\./);
});

test("Worktrees finds every kind in a real repository and cleans up the safe ones", async (t) => {
  const dir = await temporary(t), root = join(dir, "Apps"), repo = join(root, "acme"), far = join(dir, "far");
  await mkdir(repo, { recursive: true }); await mkdir(far);
  await git(repo, "init", "-q", "-b", "main");
  await writeFile(join(repo, "a.txt"), "a\n"); await git(repo, "add", "."); await git(repo, "commit", "-qm", "a");
  const add = async (n, ...extra) => { await git(repo, "worktree", "add", "-q", ...extra, join(far, n)); return join(far, n); };
  // Merged: its commit is in main. Squashed: main got the same change as one commit.
  const merged = await add("merged", "-b", "merged");
  await writeFile(join(merged, "m.txt"), "m\n"); await git(merged, "add", "."); await git(merged, "commit", "-qm", "m");
  await git(repo, "merge", "-q", "--ff-only", "merged");
  const squashed = await add("squashed", "-b", "squashed");
  await writeFile(join(squashed, "s.txt"), "s\n"); await git(squashed, "add", "."); await git(squashed, "commit", "-qm", "s1");
  await writeFile(join(squashed, "s2.txt"), "s\n"); await git(squashed, "add", "."); await git(squashed, "commit", "-qm", "s2");
  await git(repo, "merge", "-q", "--squash", "squashed"); await git(repo, "commit", "-qm", "squash");
  const unmerged = await add("unmerged", "-b", "unmerged");
  await writeFile(join(unmerged, "u.txt"), "u\n"); await git(unmerged, "add", "."); await git(unmerged, "commit", "-qm", "u");
  const dirty = await add("dirty", "-b", "dirty");
  await writeFile(join(dirty, "new.txt"), "wip\n");
  // Detached on a commit only it has (lost if removed), and on one a branch has.
  const lost = await add("lost", "--detach");
  await writeFile(join(lost, "d.txt"), "d\n"); await git(lost, "add", "."); await git(lost, "commit", "-qm", "d");
  const detached = join(far, "detached");
  await git(repo, "worktree", "add", "-q", "--detach", detached, "unmerged");
  const open = await add("open", "-b", "open");
  // Clean to the scan; work lands in it before Clean up reaches it.
  const late = await add("late", "-b", "late");
  const gone = await add("gone", "-b", "gone"); await rm(gone, { recursive: true });
  // A worktree's folder made again as a repository of its own: git worktree
  // remove refuses it ("is not a .git file"); only the record may go.
  const reused = await add("reused", "-b", "reused"); await rm(reused, { recursive: true });
  await mkdir(reused); await git(reused, "init", "-q"); await writeFile(join(reused, "keep.txt"), "mine\n");
  // A worktree whose repository moved: its .git names the old place, so git
  // can't read it, and nothing it says about it is true.
  const moved = await add("moved", "-b", "moved");
  await writeFile(join(moved, "wip.txt"), "unsaved\n");
  await writeFile(join(moved, ".git"), `gitdir: ${join(dir, "old-place/.git/worktrees/moved")}\n`);
  // A folder whose worktree record was deleted under it.
  const orphan = join(root, "leftover");
  await mkdir(orphan); await writeFile(join(orphan, ".git"), `gitdir: ${join(dir, "deleted/.git/worktrees/leftover")}\n`);

  const notes = [], settings = { "kanso.worktrees.roots": [root] }, app = join(dir, "app");
  const host = (extra) => worktrees({
    app, home: () => dir, shared: (k) => settings[k] ?? null,
    spaces: () => [{ folder: repo }], panes: () => [{ cwd: join(open, "src") }], notify: (n) => notes.push(n), ...extra,
  });
  const { cx, drain } = context();
  const { Worktrees, stateOf, removable } = await host();

  // Everything here was touched a moment ago: Clean up leaves it all but the record of a gone folder.
  const busy = new Worktrees();
  busy.init(cx); await drain();
  assert.deepEqual(clone(busy.plan().map((w) => w.path.split("/").pop()).sort()), ["gone", "reused"]);
  assert.equal(stateOf(busy.groups[0].items.find((w) => w.path.endsWith("/merged"))), "recent");

  settings["kanso.worktrees.idleHours"] = 0;
  const panel = new Worktrees();
  panel.init(cx); await drain();
  assert.equal(panel.note, null);
  assert.equal(panel.groups.length, 1);
  const g = panel.groups[0], by = Object.fromEntries(g.items.map((w) => [w.path.split("/").pop(), w]));
  assert.deepEqual(Object.fromEntries(Object.entries(by).map(([k, w]) => [k, stateOf(w)])), {
    merged: "merged", squashed: "merged", unmerged: "unmerged", dirty: "changes", lost: "lost", detached: "detached", open: "open", gone: "missing", reused: "missing", moved: "broken", late: "merged",
  });
  assert.ok(!removable(by.moved), "never in a Remove all: git can't say what it holds");
  assert.ok(by.reused.replaced && by.reused.size === null, "reused: not measured, its space is not the worktree's");
  assert.equal(g.base, "main");
  assert.ok(by.merged.size > 0, "measured");
  assert.deepEqual(clone(panel.orphans.map((o) => o.path)), [orphan]);

  assert.deepEqual(clone(panel.plan().map((w) => w.path.split("/").pop()).sort()), ["detached", "gone", "late", "merged", "reused", "squashed", "unmerged"]);
  await writeFile(join(late, "new.txt"), "started after the scan\n");
  panel.cleanUp(cx); await drain();
  assert.equal(panel.note, null, "no error: what changed is left alone");
  assert.match(panel.notice, /^1 stays: it changed since the scan/);
  assert.ok(existsSync(join(late, "new.txt")) && stateOf(by.late) === "changes", "checked again right before: its new work is kept");
  assert.match(notes[0].title, /^Freed \d+ KB$/);
  assert.match(notes[0].body, /^6 removed, \d+ KB freed so far$/);
  assert.ok(existsSync(join(reused, ".git")) && existsSync(join(reused, "keep.txt")), "the reused folder, a repository of its own, is not touched");
  assert.ok(!(await git(repo, "worktree", "list")).includes("/reused"), "its old record is gone");
  const after = clone(panel.hist);
  assert.deepEqual([after.worktrees, after.records, after.branches], [4, 2, 2], "4 folders, 2 records (one gone, one reused), the 2 merged branches");
  assert.ok(after.kb > 0 && after.kb === after.kanso, "all freed here");
  assert.equal(Object.keys(after.diskByDay).length, 1, "the scan is kept");

  // Opened again: the last scan shows at once, as it was, until checked again.
  const again = new Worktrees();
  again.init(cx); await drain();
  assert.equal(again.hist.kb, after.kb, "the history is read back, not counted twice");
  assert.ok(![merged, squashed, unmerged, detached].some((p) => existsSync(p)), "folders removed");
  assert.ok(await exists(dirty) && await exists(lost) && await exists(open), "the rest stay");
  const branches = (await git(repo, "branch", "--format=%(refname:short)")).split("\n").sort();
  assert.deepEqual(branches, ["dirty", "gone", "late", "main", "moved", "open", "reused", "unmerged"], "merged branches go; the others keep their commits");

  assert.ok(!(await git(repo, "worktree", "list")).includes("/gone"), "pruned");

  // One at a time, after a confirmation: an open one is refused.
  panel.remove(by.open, cx); await drain();
  assert.ok(await exists(open), "open in Herdr: never removed");
  panel.remove(by.dirty, cx); await drain();
  assert.ok(!(await exists(dirty)), "uncommitted work goes only when confirmed");
  panel.remove(panel.orphans[0], cx); await drain();
  assert.ok(!(await exists(orphan)), "orphan folder deleted");
  assert.deepEqual(clone(panel.groups[0].items.map((w) => w.path.split("/").pop()).sort()), ["late", "lost", "moved", "open"]);

  // Remove all: the commit only "lost" had and late's new file go with them; the open one and the broken link stay.
  panel.removeAll(panel.groups[0].items.filter(removable), cx); await drain();
  assert.ok(!existsSync(lost) && existsSync(open) && existsSync(join(moved, "wip.txt")));
  assert.deepEqual(clone(panel.groups[0].items.map((w) => w.path.split("/").pop()).sort()), ["moved", "open"]);

  // Repaired, git reads it again, and its uncommitted file shows.
  panel.repair(by.moved, cx); await drain();
  assert.equal(panel.note, null);
  assert.equal(stateOf(by.moved), "changes");
  assert.equal(by.moved.dirty, 1);
});
