import assert from "node:assert/strict";
import test from "node:test";
import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { load, context, exec, temporary, clone } from "./helpers.mjs";

const names = ["Updater", "newestTag", "compareVersions", "mergeKeys", "SOURCE"];
const repo = new URL("../kanso/", import.meta.url);

async function updater(host) {
  return load("kanso-chrome/update.js", names, host);
}

test("Kanso's newest release comes from the vX.Y.Z tags, not from Herdr", async () => {
  const { newestTag, compareVersions } = await updater();
  const out = [
    "aaa\trefs/tags/v1.0.0", "bbb\trefs/tags/v1.10.0", "ccc\trefs/tags/v1.9.3",
    "ddd\trefs/tags/nightly", "eee\trefs/tags/v2.0.0-beta",
  ].join("\n");
  assert.equal(newestTag(out), "1.10.0", "numeric order, other tags ignored");
  assert.equal(newestTag(""), null);
  assert.ok(compareVersions("1.2.0", "1.10.0") < 0);
  assert.equal(compareVersions("v1.0.0", "1.0.0"), 0);
});

test("Keys follow the release only where you left them as shipped", async () => {
  const { mergeKeys } = await updater();
  const before = { "layout:kanso": { "cmd-d": "a", "cmd-e": "b", "cmd-f": "c", "cmd-g": "d", "cmd-h": "e" } };
  const after = { "layout:kanso": { "cmd-d": "a2", "cmd-e": "b2", "cmd-f": "c", "cmd-n": "new", "cmd-h": "e2" } };
  const user = {
    global: { "cmd-q": "app.quit" },
    // cmd-d as shipped, cmd-e yours, cmd-g as shipped (the release drops it), cmd-h removed by you.
    "layout:kanso": { "cmd-d": "a", "cmd-e": "mine", "cmd-f": "c", "cmd-g": "d" },
  };
  const { keys, changed, kept } = clone(mergeKeys(clone(user), before, after)); // out of the mod's realm
  assert.ok(changed);
  assert.deepEqual(keys.global, user.global, "other sections untouched");
  assert.deepEqual(keys["layout:kanso"], { "cmd-d": "a2", "cmd-e": "mine", "cmd-f": "c", "cmd-n": "new" });
  assert.deepEqual(kept, ["cmd-e"]);
  assert.equal(mergeKeys(clone(user), before, before).changed, false, "a release that kept them changes nothing");
});

// A Herdr home with Kanso 1.0.0 installed and used, and two releases served
// from file:// URLs: what v1.0.0 shipped and the v1.1.0 tarball.
async function fixture(t, { layoutChanged = true } = {}) {
  const root = await temporary(t);
  const home = join(root, "home"), site = join(root, "site");
  const shippedKeys = JSON.parse(await readFile(new URL("keys.json", repo), "utf8"));
  const shippedLayout = await readFile(new URL("layouts/kanso.json", repo), "utf8");

  // v1.0.0, as GitHub's raw files.
  const oldKeys = clone(shippedKeys);
  oldKeys["layout:kanso"]["cmd-d"] = "kanso-strip.old-right";
  delete oldKeys["layout:kanso"]["cmd-shift-w"];
  await mkdir(join(site, "v1.0.0/kanso/layouts"), { recursive: true });
  await writeFile(join(site, "v1.0.0/kanso/keys.json"), JSON.stringify(oldKeys));
  await writeFile(join(site, "v1.0.0/kanso/layouts/kanso.json"), layoutChanged ? '{"root":{"id":"old"}}' : shippedLayout);

  // v1.1.0: this repository's kanso/ with version.json saying 1.1.0.
  const top = join(site, "build/herdr-kanso-1.1.0");
  await cp(new URL(".", repo), join(top, "kanso"), { recursive: true });
  await writeFile(join(top, "kanso/mods/kanso-chrome/version.json"), '{ "version": "1.1.0" }\n');
  await writeFile(join(top, "README.md"), "not installed\n");
  const made = await exec("tar", ["-czf", join(site, "v1.1.0.tar.gz"), "-C", join(site, "build"), "herdr-kanso-1.1.0"]);
  assert.equal(made.code, 0, made.stderr);

  // The person's home: Kanso 1.0.0, a custom key, a live layout, another mod.
  await mkdir(join(home, "mods/kanso-chrome"), { recursive: true });
  await writeFile(join(home, "mods/kanso-chrome/version.json"), '{ "version": "1.0.0" }\n');
  await writeFile(join(home, "mods/kanso-chrome/main.js"), "// 1.0.0\n");
  await mkdir(join(home, "mods/token-spend"), { recursive: true });
  await writeFile(join(home, "mods/token-spend/main.js"), "// someone else's\n");
  await mkdir(join(home, "layouts"), { recursive: true });
  await writeFile(join(home, "layouts/kanso.json"), '{"root":{"id":"live"}}');
  const userKeys = { global: { "cmd-q": "app.quit" }, "layout:kanso": { ...oldKeys["layout:kanso"], "cmd-shift-o": "mine.open" } };
  await writeFile(join(home, "keys.json"), JSON.stringify(userKeys, null, 2));

  const url = (p) => pathToFileURL(join(site, p)).href;
  const source = {
    remote: "unused",
    tarball: (v) => url(`v${v}.tar.gz`),
    file: (v, path) => url(`v${v}/${path}`),
  };
  const store = {}, toasts = [], checks = [], resizes = [];
  const footer = { id: "sidebar-footer", size: { px: 156 } };
  const host = {
    layout: () => ({ id: "root", children: [{ id: "sidebar", children: [footer] }] }),
    run: (name, args) => { resizes.push(args.px); footer.size = { px: args.px }; return null; },
    appHome: () => home,
    shared: (k) => store[k],
    setShared: (k, v) => { store[k] = v; },
    notify: (n) => { toasts.push(n); return String(toasts.length); },
    readTextFile: async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } },
    writeTextFile: async (p, text) => { await writeFile(p, text); return null; },
    exec: async (command, args, options) => {
      if (command === "herdr-app") { checks.push(args[1].split("/").pop()); return { code: 0, stdout: "check passed", stderr: "" }; }
      if (command === "git") return { code: 0, stdout: "x\trefs/tags/v1.0.0\ny\trefs/tags/v1.1.0\n", stderr: "" };
      return exec(command, args, options);
    },
  };
  const { Updater } = await updater(host);
  return { home, store, toasts, checks, resizes, footer, updater: new Updater(source), userKeys };
}

test("Updating Kanso swaps its mods, merges its keys and keeps your layout aside", async (t) => {
  const f = await fixture(t);
  const { cx, drain } = context();
  cx.timer = { every() {} };
  f.updater.start(cx); await drain();
  assert.equal(f.updater.installed, "1.0.0");
  assert.equal(f.updater.available(), "1.1.0");
  assert.equal(f.toasts.length, 1);
  assert.match(f.toasts[0].title, /Kanso 1\.1\.0 is available/);
  assert.equal(f.toasts[0].action.name, "kanso-chrome.update");
  assert.deepEqual(f.resizes, [192], "the footer grows a row for it");

  // Another check does not toast the same version again.
  await f.updater.check(cx, true);
  assert.equal(f.toasts.length, 1);

  await f.updater.install(cx);
  assert.equal(f.updater.error, null, f.updater.error);
  const shipped = (await readdir(new URL("mods/", repo))).sort();
  assert.deepEqual([...f.checks].sort(), shipped, "every mod checked before the swap");

  const mods = await readdir(join(f.home, "mods"));
  for (const name of shipped) assert.ok(mods.includes(name), name);
  assert.ok(mods.includes("token-spend"), "other mods stay");
  assert.equal(JSON.parse(await readFile(join(f.home, "mods/kanso-chrome/version.json"), "utf8")).version, "1.1.0");
  assert.equal(await readFile(join(f.home, "mods/kanso-chrome/main.js"), "utf8"),
    await readFile(new URL("mods/kanso-chrome/main.js", repo), "utf8"));
  assert.ok((await readdir(join(f.home, "themes"))).includes("kanso-day.json"));

  const layouts = await readdir(join(f.home, "layouts"));
  const old = layouts.find((n) => n.startsWith("kanso.json.old-"));
  assert.ok(old, "the layout you had is kept");
  assert.equal(await readFile(join(f.home, "layouts", old), "utf8"), '{"root":{"id":"live"}}');
  assert.equal(await readFile(join(f.home, "layouts/kanso.json"), "utf8"),
    await readFile(new URL("layouts/kanso.json", repo), "utf8"));

  const keys = JSON.parse(await readFile(join(f.home, "keys.json"), "utf8"));
  const now = JSON.parse(await readFile(new URL("keys.json", repo), "utf8"))["layout:kanso"];
  assert.deepEqual(keys.global, f.userKeys.global);
  assert.equal(keys["layout:kanso"]["cmd-d"], now["cmd-d"], "a shipped key follows the release");
  assert.equal(keys["layout:kanso"]["cmd-shift-w"], now["cmd-shift-w"], "a new key arrives");
  assert.equal(keys["layout:kanso"]["cmd-shift-o"], "mine.open", "your own key stays");

  assert.deepEqual(await readdir(f.home).then((n) => n.filter((x) => x.startsWith("."))), [], "nothing staged left");
  assert.equal(f.updater.available(), null);
  const done = f.toasts.at(-1);
  assert.equal(done.title, "Kanso updated to 1.1.0");
  assert.equal(done.level, "success");
  assert.match(done.body, /layouts\/kanso\.json\.old-/);
  assert.equal(f.store["kanso.update"].done, null, "reported once");
  assert.deepEqual(f.resizes, [192, 156], "and gives the room back");
});

test("A release that kept the layout leaves yours as it is", async (t) => {
  const f = await fixture(t, { layoutChanged: false });
  const { cx, drain } = context();
  cx.timer = { every() {} };
  f.updater.start(cx); await drain();
  f.footer.size = { px: 240 }; // sized by you
  await f.updater.install(cx);
  assert.equal(f.updater.error, null, f.updater.error);
  assert.deepEqual(f.resizes, [192], "a footer you sized is left alone");
  assert.equal(await readFile(join(f.home, "layouts/kanso.json"), "utf8"), '{"root":{"id":"live"}}');
  assert.ok(!(await readdir(join(f.home, "layouts"))).some((n) => n.startsWith("kanso.json.old-")));
});

test("A tag whose files say another version is not installed", async (t) => {
  const f = await fixture(t);
  const { cx, drain } = context();
  cx.timer = { every() {} };
  f.updater.start(cx); await drain();
  f.store["kanso.update"].latest = "1.2.0"; // tagged, but no such tarball
  await f.updater.install(cx);
  assert.ok(f.updater.error);
  assert.equal(f.toasts.at(-1).level, "error");
  assert.equal(await readFile(join(f.home, "mods/kanso-chrome/main.js"), "utf8"), "// 1.0.0\n", "nothing replaced");
  assert.deepEqual(await readdir(f.home).then((n) => n.filter((x) => x.startsWith("."))), []);
});

test("Kanso looks for releases on every start, every few minutes, and when asked", async () => {
  const store = { "kanso.update": { latest: "1.0.0", checked: Date.now(), notified: "1.0.0" } }, toasts = [];
  let tags = "x\trefs/tags/v1.3.1\n", asked = 0, every = null, offline = false;
  const host = {
    appHome: () => "/nowhere", shared: (k) => store[k], setShared: (k, v) => { store[k] = v; },
    notify: (n) => { toasts.push(n); return "1"; }, readTextFile: async () => '{ "version": "1.3.1" }',
    layout: () => null, run: () => null,
    exec: async (command) => { asked++; return command === "git" && !offline ? { code: 0, stdout: tags, stderr: "" } : { code: 128, stdout: "", stderr: "offline" }; },
  };
  const { Updater } = await updater(host);
  const u = new Updater();
  const { cx, drain } = context();
  cx.timer = { every(ms, fn) { every = ms; } };
  u.start(cx); await drain();
  assert.equal(asked, 1, "a start looks even right after another look");
  assert.ok(every <= 5 * 60 * 1000, "then every 5 minutes at most");

  await u.check(cx, false, false);
  assert.equal(asked, 1, "the timer does not look twice within minutes");
  await u.check(cx, true, true);
  assert.equal(toasts.at(-1).title, "Kanso is up to date", "asked: it says so");

  tags = "x\trefs/tags/v1.3.1\ny\trefs/tags/v1.4.0\n";
  await u.check(cx, true, false);
  assert.equal(toasts.at(-1).title, "Kanso 1.4.0 is available");
  await u.check(cx, true, true);
  assert.equal(toasts.filter((n) => n.title === "Kanso 1.4.0 is available").length, 2, "asked again: told again");

  offline = true;
  await u.check(cx, true, true);
  assert.equal(toasts.at(-1).title, "Kanso could not check for updates");
});
