import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, writeFile, symlink } from "node:fs/promises";
import { join } from "node:path";
import { load, temporary, exec } from "./helpers.mjs";

const { insideRoot } = await load("kanso-panel/lib.js", ["insideRoot"]);

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
