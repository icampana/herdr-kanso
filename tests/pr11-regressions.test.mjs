import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, mkdir, readFile, writeFile, symlink, unlink, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import vm from "node:vm";

const runFile = promisify(execFile);
const clone = (value) => JSON.parse(JSON.stringify(value));
const mods = new URL("../kanso/mods/", import.meta.url);

// Load the actual mod logic with the desktop host supplied by each fixture.
async function load(file, names, host = {}) {
  const source = (await readFile(new URL(file, mods), "utf8"))
    .replace(/^import .*;\n/gm, "")
    .replace(/export default /g, "").replace(/export /g, "");
  return vm.runInNewContext(`${source}\n;({ ${names.join(", ")} });`, { View: class {}, ...host });
}

async function temporary(t) {
  const dir = await mkdtemp(join(tmpdir(), "kanso-regression-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  return dir;
}

async function exec(command, args, options = {}) {
  try {
    const result = await runFile(command, args, { cwd: options.cwd, maxBuffer: 4 * 1024 * 1024 });
    return { code: 0, ...result };
  } catch (error) {
    return { code: error.code, stdout: error.stdout ?? "", stderr: error.stderr ?? String(error) };
  }
}

function context() {
  const pending = [];
  const cx = { notify() {}, spawn(fn) { const task = fn(cx); pending.push(task); return task; } };
  return { cx, async drain() { while (pending.length) await pending.shift(); } };
}

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

test("Files preserves newline names, dotfiles and symlinks", async (t) => {
  const parent = await temporary(t), root = join(parent, "folder\nwith spaces");
  await mkdir(root);
  for (const name of ["first\nsecond.txt", "tabs\tand\\slashes.txt", ".hidden", "O’Brien.txt"]) {
    await writeFile(join(root, name), "text");
  }
  await mkdir(join(root, "directory")); await mkdir(join(root, ".git"));
  await symlink("directory", join(root, "link"));
  await symlink("missing", join(root, "dangling"));
  const { directory } = await load("kanso-panel/files.js", ["directory"], { exec, window: () => ({ platform: "macos" }) });
  const entries = Object.fromEntries((await directory(root, null)).map(({ name, dir }) => [name, dir]));
  assert.deepEqual(entries, {
    "first\nsecond.txt": false, "tabs\tand\\slashes.txt": false, ".hidden": false,
    "O’Brien.txt": false, directory: true, link: false, dangling: false,
  });
  await symlink(root, join(parent, "root-link"));
  assert.equal((await directory(join(parent, "root-link"), null)).length, 7);
});

test("Files falls back to the shell listing when find cannot run", async (t) => {
  const root = await temporary(t);
  await writeFile(join(root, "file.txt"), ""); await mkdir(join(root, "directory"));
  const calls = [];
  const { directory } = await load("kanso-panel/files.js", ["directory"], { window: () => ({ platform: "macos" }),
    exec: async (command, args, options) => { calls.push(command); if (command === "find") throw new Error("not installed"); return exec(command, args, options); } });
  const entries = Object.fromEntries((await directory(root, null)).map(({ name, dir }) => [name, dir]));
  assert.deepEqual(entries, { "file.txt": false, directory: true });
  assert.deepEqual(calls, ["find", "bash"]);
});

test("Files marks the entry past the cap as a folder when it is one", async (t) => {
  const root = await temporary(t);
  for (let i = 0; i < 600; i++) await mkdir(join(root, `dir-${i}`));
  const { directory } = await load("kanso-panel/files.js", ["directory"], { exec, window: () => ({ platform: "macos" }) });
  const entries = await directory(root, null);
  assert.equal(entries.length, 501);
  assert.ok(entries.every((entry) => entry.dir));
});

test("Files reports truncation only above 500 entries", async (t) => {
  const root = await temporary(t);
  for (let i = 0; i < 500; i++) await writeFile(join(root, `file-${i}`), "");
  const { directory, Files } = await load("kanso-panel/files.js", ["directory", "Files"], {
    exec, insideRoot, window: () => ({ platform: "macos" }), key: () => root,
  });
  const panel = new Files();
  Object.assign(panel, { root, entries: new Map(), folders: new Set(), limited: false });
  await panel.loadFolder("", root);
  assert.equal(panel.entries.get("").length, 500);
  assert.equal(panel.limited, false);
  for (let i = 500; i < 510; i++) await writeFile(join(root, `file-${i}`), "");
  assert.equal((await directory(root, null)).length, 501);
  await panel.loadFolder("", root);
  assert.equal(panel.entries.get("").length, 500);
  assert.equal(panel.limited, true);
});

test("Files virtual rows use list-level handlers for open, expand and context menu", async () => {
  let deferred = false, list;
  function element() {
    const handlers = {};
    const target = {
      handlers,
      when(condition, callback) { if (condition) callback(proxy); return proxy; },
    };
    const proxy = new Proxy(target, { get(object, name) {
      if (name in object) return object[name];
      return (...args) => {
        if (String(name).startsWith("on_")) {
          assert.equal(deferred, false, "Herdr forbids event registration inside virtual row renderers");
          handlers[name] = args[0];
        }
        return proxy;
      };
    } });
    return proxy;
  }
  const { Files } = await load("kanso-panel/files.js", ["Files"], {
    div: element, svg: element, h_flex: element, v_flex: element,
    Scrollbar: { vertical: element }, theme: () => ({}), key: () => "fixture",
    v_virtual_list: (_id, count, _height, key, render) => {
      const el = element(); list = { count, key, render, el }; return el;
    },
  });
  const panel = new Files();
  Object.assign(panel, { context: "fixture", root: "/repo", folders: new Set(), marks: {},
    entries: new Map([["", [{ name: "directory", dir: true }, { name: "file.txt", dir: false }]]]),
  });
  const actions = [];
  panel.toggle = (path) => actions.push(["toggle", path]);
  panel.show = (path) => actions.push(["show", path]);
  panel.openWith = (path) => actions.push(["openWith", path]);
  panel.render({});
  deferred = true;
  assert.equal(list.render({ start: 0, end: list.count }).length, 2);
  deferred = false;
  list.el.handlers.on_item_click(list.key(0), {});
  list.el.handlers.on_item_click(list.key(1), {});
  list.el.handlers.on_item_secondary_click(list.key(0), {}, {});
  list.el.handlers.on_item_secondary_click(list.key(1), {}, {});
  assert.deepEqual(actions, [["toggle", "directory"], ["show", "file.txt"], ["openWith", "file.txt"]]);
});

test("Pull request panel lists your open ones and shows the one you pick", async () => {
  const prs = { 1: { number: 1, title: "Branch work", headRefName: "feat", updatedAt: "2026-10-01T00:00:00Z" },
    2: { number: 2, title: "Other work", headRefName: "other", updatedAt: "2026-10-02T00:00:00Z" } };
  const calls = [];
  const exec = async (command, args) => {
    calls.push([command, ...args].join(" "));
    if (command === "git") return { code: 0, stdout: args[0] === "rev-parse" ? "/repo\n" : "feat\n", stderr: "" };
    if (args[0] === "pr" && args[1] === "list") return { code: 0, stdout: JSON.stringify([prs[1], prs[2]]), stderr: "" };
    if (args[0] === "pr" && args[1] === "view") return { code: 0, stdout: JSON.stringify(prs[args[2] === "--json" ? 1 : args[2]]), stderr: "" };
    return { code: 1, stdout: "", stderr: "offline" };
  };
  const { PullRequest } = await load("kanso-panel/pr.js", ["PullRequest"], {
    exec, key: () => "repo", location: () => ({ cwd: "/repo", on: null }),
  });
  const panel = new PullRequest();
  Object.assign(panel, { expanded: {}, mine: [], selected: null, threads: [] });
  const { cx, drain } = context();
  cx.timer = { every() {} };
  panel.refresh(cx); await drain();
  assert.equal(panel.pr.number, 1);
  assert.deepEqual([...panel.mine].map((p) => p.number), [2, 1], "newest first");
  panel.choose(prs[2], cx); await drain();
  assert.equal(panel.pr.number, 2);
  assert.equal(panel.selected, 2);
  assert.ok(calls.includes("gh pr view 2 --json " + calls.find((c) => c.startsWith("gh pr view --json")).slice("gh pr view --json ".length)));
  panel.choose(prs[1], cx); await drain();
  assert.equal(panel.pr.number, 1);
  assert.equal(panel.selected, null, "the branch's own follows the branch again");
});

async function layoutFixture() {
  const nodes = [{ id: "strip-col-a", type: "column", size: { weight: 1 }, children: [
    { id: "strip-a", type: "block", size: { weight: 1 }, content: { terminal: "a" } },
    { id: "strip-b", type: "block", size: { weight: 1 }, content: { terminal: "b" } },
  ] }];
  let tree = { id: "root", children: [
    { id: "sidebar", min: 200 },
    { id: "work-body", children: [...clone(nodes), { id: "panel-body", type: "stack", hidden: true, children: [] }] },
  ] };
  const state = {}, writes = [];
  const host = {
    shared: (key) => clone(state[key] ?? null), setShared: (key, value) => { state[key] = clone(value); },
    layout: () => clone(tree), window: () => ({ platform: "macos" }),
    run: (command, args) => { if (command === "layout.set") writes.push(clone(args.layout)); },
  };
  const { Strip } = await load("kanso-strip/main.js", ["Strip"], host);
  const strip = new Strip(); strip.sets = [];
  const flush = () => { while (writes.length) tree = writes.shift(); };
  strip.apply(clone(nodes)); flush();
  return { nodes, host, strip, flush, body: () => tree.children[1] };
}

const writers = [
  ["kanso-tabs/main.js", "Tabs", (x) => new x.Tabs().mount("changes")],
  ["kanso-panel/lib.js", "showPanel", (x) => x.showPanel("changes", { mod: "kanso-panel" })],
  ["open-with/main.js", "showPreview", (x) => x.showPreview("/repo/readme.md", null)],
  ["kanso-spaces/main.js", "setRail", (x) => x.setRail(false, 76)],
];
for (const [file, name, write] of writers) {
  test(`${file} preserves native column and stack resizing`, async () => {
    const f = await layoutFixture();
    f.body().children[0].size = { px: 350 };
    f.body().children[0].children[0].size = { px: 73 };
    write(await load(file, [name], f.host)); f.flush();
    assert.equal(f.body().children[0].size.px, 350);
    assert.equal(f.body().children[0].children[0].size.px, 73);
    f.strip.tab = () => "tab";
    f.strip.state = { tab: { cols: [] } };
    f.strip.adopt();
    assert.ok(f.strip.drift, "The resize must remain visible to adopt()");
  });

  test(`${file} preserves a pending strip width command`, async () => {
    const f = await layoutFixture();
    f.body().children[0].size = { px: 350 };
    const next = clone(f.nodes); next[0].size = { weight: 2 };
    f.strip.sets = []; f.strip.apply(next); // Still queued: layout() returns the old px size.
    write(await load(file, [name], f.host)); f.flush();
    assert.deepEqual(f.body().children[0].size, { weight: 2 });
  });

  test(`a strip write preserves the pending change from ${file}`, async () => {
    const f = await layoutFixture();
    write(await load(file, [name], f.host)); // The other writer has not landed yet.
    const intent = f.host.shared("kanso.layout");
    const next = clone(f.nodes); next[0].size = { weight: 2 };
    f.strip.sets = []; f.strip.apply(next); f.flush();
    assert.deepEqual(f.body().children[0].size, { weight: 2 });
    if (intent.panel) {
      assert.deepEqual(f.body().children.find((node) => node.id === "panel-body").children, [intent.panel]);
    } else {
      assert.equal(f.host.layout().resizable, intent.rail.open);
      assert.equal(f.host.layout().children[0].min, intent.rail.min);
    }
  });
}

// Parse a single PowerShell literal independently of the production escaper.
function psLiteral(text) {
  assert.equal(text[0], "'");
  let value = "", i = 1;
  const quotes = "'‘’‚‛";
  for (; i < text.length; i++) {
    const ch = text[i];
    if (!quotes.includes(ch)) value += ch;
    else if (quotes.includes(text[i + 1] ?? "\0")) { value += ch; i++; }
    else return { value, rest: text.slice(i + 1) };
  }
  assert.fail("Unterminated PowerShell literal");
}

test("Windows launch keeps all PowerShell single quotes inside literals", async () => {
  let command;
  const { OpenWith } = await load("open-with/main.js", ["OpenWith"], {
    exec: async (_program, args) => { command = args.at(-1); return { code: 0 }; },
  });
  const view = new OpenWith(); view.platform = "windows";
  for (const quote of "'‘’‚‛") {
    const path = `C:\\repo\\report${quote}); Write-Output marker; #.txt`;
    const cli = `C:\\Users\\O${quote}Brien\\editor.exe`;
    await view.spawn(cli, [path]);
    const executable = psLiteral(command.slice("Start-Process -FilePath ".length));
    assert.equal(executable.value, cli);
    assert.ok(executable.rest.startsWith(" -ArgumentList "));
    const argument = psLiteral(executable.rest.slice(" -ArgumentList ".length));
    assert.equal(argument.value, `"${path}"`);
    assert.equal(argument.rest, " -ErrorAction Stop");
  }
});

test("Windows arguments retain spaces, empty strings, quotes and trailing slashes", async () => {
  let command;
  const { OpenWith } = await load("open-with/main.js", ["OpenWith"], {
    exec: async (_program, args) => { command = args.at(-1); return { code: 0 }; },
  });
  const view = new OpenWith(); view.platform = "windows";
  await view.spawn("editor.exe", ["--remote", "ssh-remote+host", "C:\\My Project\\", "", 'a"b', 'a\\"b']);
  const executable = psLiteral(command.slice("Start-Process -FilePath ".length));
  const argument = psLiteral(executable.rest.slice(" -ArgumentList ".length));
  assert.equal(argument.value, String.raw`"--remote" "ssh-remote+host" "C:\My Project\\" "" "a\"b" "a\\\"b"`);
  for (const invalid of ["a\0b", "a\rb", "a\nb"]) {
    assert.throws(() => view.spawn("editor.exe", [invalid]), /Invalid path/);
  }
});
