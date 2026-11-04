import assert from "node:assert/strict";
import test from "node:test";
import { clone, context, load } from "./helpers.mjs";

async function layoutFixture() {
  const nodes = [{ id: "strip-col-a", type: "column", size: { weight: 1 }, children: [
    { id: "strip-a", type: "block", size: { weight: 1 }, content: { terminal: "a" } },
    { id: "strip-b", type: "block", size: { weight: 1 }, content: { terminal: "b" } },
  ] }];
  let tree = { id: "root", children: [
    { id: "sidebar", min: 200 },
    { id: "work-body", children: [...clone(nodes), { id: "panel-body", type: "stack", hidden: true, children: [] }] },
    { id: "strip-map", type: "block", content: { mod: "kanso-strip" } },
  ] };
  const state = {}, writes = [];
  const host = {
    shared: (key) => clone(state[key] ?? null), setShared: (key, value) => { state[key] = clone(value); },
    layout: () => clone(tree), window: () => ({ platform: "macos" }), theme: () => ({ accent: "#000000", background: "#ffffff" }),
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

// Right after layout.switch, layout() can still return the tree of the layout
// that was shown before. A writer that edits that tree and sets it saves it
// into kanso.json, and Kanso is gone until the file is restored by hand.
function foreignLayout() {
  const tree = { id: "root", children: [
    { id: "sidebar", min: 180, children: [{ id: "spaces", type: "block", content: { mod: "spaces" } }] },
    { id: "work", type: "column", children: [{ id: "work-body", type: "row", children: [
      { id: "main", type: "block", content: { tab: "active" } },
      { id: "panel-body", type: "stack", hidden: true, children: [] },
    ] }] },
  ] };
  const state = {}, writes = [];
  const host = {
    shared: (key) => clone(state[key] ?? null), setShared: (key, value) => { state[key] = clone(value); },
    layout: () => clone(tree), window: () => ({ platform: "macos" }),
    run: (command, args) => { if (command === "layout.set") writes.push(clone(args.layout)); },
  };
  return { host, writes };
}

for (const [file, name, write] of writers) {
  test(`${file} never writes another layout's tree`, async () => {
    const f = foreignLayout();
    write(await load(file, [name], f.host));
    assert.equal(f.writes.length, 0);
  });
}

test("kanso-strip/main.js never writes another layout's tree", async () => {
  const f = foreignLayout();
  const { Strip } = await load("kanso-strip/main.js", ["Strip"], f.host);
  const strip = new Strip(); strip.sets = [];
  const nodes = [{ id: "strip-col-a", type: "column", size: { weight: 1 }, children: [
    { id: "strip-a", type: "block", size: { weight: 1 }, content: { terminal: "a" } },
  ] }];
  strip.apply(nodes);
  assert.equal(f.writes.length, 0);
  assert.notEqual(strip.applied, JSON.stringify(nodes), "A skipped write must not count as applied, or it is never retried");
});

// Herdr's divider moves only the two nodes beside it: nothing fixed may stand
// just before the side panel, or its border cannot be dragged.
const helpers = ["kanso-strip/main.js", "kanso-tabs/main.js", "kanso-panel/lib.js", "open-with/main.js", "kanso-spaces/main.js"];
for (const file of helpers) {
  test(`${file} puts the strip's right edge rail after a shown panel`, async () => {
    const { edgeBesidePanel } = await load(file, ["edgeBesidePanel"], {});
    const tree = (hidden) => ({ id: "root", children: [{ id: "work-body", children: [
      { id: "strip-ruler-h" }, { id: "strip-a" }, { id: "strip-edge-right" }, { id: "panel-body", hidden, children: [] }] }] });
    const order = (t) => t.children[0].children.map((n) => n.id);
    const shown = tree(false); edgeBesidePanel(shown);
    assert.deepEqual(order(shown), ["strip-ruler-h", "strip-a", "panel-body", "strip-edge-right"]);
    edgeBesidePanel(shown);
    assert.deepEqual(order(shown), ["strip-ruler-h", "strip-a", "panel-body", "strip-edge-right"], "idempotent");
    const hidden = tree(true); edgeBesidePanel(hidden);
    assert.deepEqual(order(hidden), ["strip-ruler-h", "strip-a", "strip-edge-right", "panel-body"], "a closed panel leaves it in place");
  });
}

test("The strip's fixed height ruler stands at the row's start, never beside the panel", async () => {
  const f = await layoutFixture();
  const { Strip } = await load("kanso-strip/main.js", ["Strip"], f.host);
  const strip = new Strip();
  strip.row = (st) => st.cols.map((_c, ci) => ({ ci }));
  strip.shownCols = (st) => st.cols.map((_c, ci) => ci);
  const st = { cols: [{ panes: ["a"], w: 0.5 }, { panes: ["b"], w: 0.5 }] };
  const ids = strip.build(st, [{ pane: "a", terminal: "ta" }, { pane: "b", terminal: "tb" }]).map((n) => n.id);
  assert.equal(ids[0], "strip-ruler-h");
  assert.notEqual(ids.at(-1), "strip-ruler-h");
});

test("kanso-tabs opens and closes a custom panel from kanso.panels through commitLayout", async () => {
  const f = await layoutFixture();
  f.host.setShared("kanso.panels", [
    { id: "workflow", label: "Workflow", icon: "mods/herdr-workflow/icon.svg", mod: "herdr-workflow", props: { tab: "state" } },
  ]);
  const { Tabs } = await load("kanso-tabs/main.js", ["Tabs"], f.host);
  const tabs = new Tabs();
  tabs.mount("workflow"); f.flush();
  const panelBody = () => f.body().children.find((node) => node.id === "panel-body");
  assert.equal(panelBody().hidden, false);
  assert.deepEqual(panelBody().children, [
    { id: "workflow", type: "block", content: { mod: "herdr-workflow", props: { tab: "state" } } },
  ]);
  tabs.mount(null); f.flush();
  assert.equal(panelBody().hidden, true);
  assert.deepEqual(panelBody().children, []);
});

test("kanso-tabs shows its panels in the order you drag them, without the ones you turned off", async () => {
  const store = {};
  const host = { shared: (k) => store[k], setShared: (k, v) => { store[k] = v; } };
  const { panelList, movePanel, setPanelOn } = await load("kanso-tabs/main.js", ["panelList", "movePanel", "setPanelOn"], host);
  const ids = () => clone(panelList().filter((p) => p.on).map((p) => p.id));
  assert.deepEqual(ids(), ["files", "insights", "changes", "pr", "shipped", "worktrees"], "Spend and Worktrees ship with Kanso; no Specs");
  movePanel("shipped", "files");
  assert.deepEqual(ids(), ["shipped", "files", "insights", "changes", "pr", "worktrees"], "dropped on Files: takes its place");
  movePanel("files", "pr");
  assert.deepEqual(ids(), ["shipped", "insights", "changes", "pr", "files", "worktrees"], "dragged right");
  setPanelOn("changes", false);
  assert.deepEqual(ids(), ["shipped", "insights", "pr", "files", "worktrees"]);
  assert.equal(panelList().find((p) => p.id === "changes").on, false, "still listed in the popup, off");
  setPanelOn("changes", true);
  assert.deepEqual(ids(), ["shipped", "insights", "changes", "pr", "files", "worktrees"], "back where it was");
  store["kanso.panels.order"] = ["files", "insights", "changes", "pr", "shipped"];
  assert.equal(ids().at(-1), "worktrees", "a panel added after you placed yours comes after them");
  store["kanso.panels"] = [{ id: "workflow", label: "Workflow", mod: "herdr-workflow" }];
  assert.equal(ids().at(-1), "workflow", "a custom panel you never placed comes last");
});

test("kanso-tabs closes a panel Kanso no longer has (Specs)", async () => {
  const { Tabs } = await load("kanso-tabs/main.js", ["Tabs"], { shared: () => undefined });
  const tabs = new Tabs();
  const mounted = [];
  tabs.mount = (id) => mounted.push(id);
  tabs.reconcile({ id: "s1" }, null, { id: "panel-body", children: [{ id: "specs", type: "block", content: { mod: "sdd-focused" } }] }, "specs");
  assert.deepEqual(mounted, [null]);
});

// Parse a single PowerShell literal independently of the production escaper.

test("kanso-tabs remounts a panel kept from the separate token-spend mod as Kanso's Spend", async () => {
  const { Tabs } = await load("kanso-tabs/main.js", ["Tabs"], { shared: () => undefined });
  const tabs = new Tabs();
  const mounted = [];
  tabs.mount = (id) => mounted.push(id);
  const body = (mod) => ({ id: "panel-body", children: [{ id: "insights", type: "block", content: { mod } }] });
  tabs.reconcile({ id: "s1" }, null, body("token-spend"), "insights");
  assert.deepEqual(mounted, ["insights"], "mounted again, now with kanso-spend");
  tabs.reconcile({ id: "s1" }, null, body("kanso-spend"), "insights");
  assert.deepEqual(mounted, ["insights"], "already Kanso's: left alone");
});

test("kanso-spaces passes an explicit machine to space.new for local, remote, and active spaces", async () => {
  const clicks = {};
  const node = () => {
    let currentId = null;
    const proxy = new Proxy({}, {
      get(_target, prop) {
        if (prop === "id") return (id) => { currentId = id; return proxy; };
        if (prop === "on_click") return (fn) => { if (currentId) clicks[currentId] = fn; return proxy; };
        if (prop === "when") return (cond, fn) => (cond ? fn(proxy) : proxy);
        return () => proxy;
      },
    });
    return proxy;
  };
  const calls = [];
  let activeMachine = "odin";
  const spList = () => [
    { id: "sp-local", name: "local", folder: "/home", machine: null, active: activeMachine === null, tabs: [] },
    { id: "odin/sp1", name: "remote", folder: "/srv", machine: "odin", active: activeMachine === "odin", tabs: [] },
  ];
  const { Spaces } = await load("kanso-spaces/main.js", ["Spaces"], {
    div: node, svg: node, image: node, h_flex: node, v_flex: node,
    Popover: { new: node },
    ORDERS: { updated: "Updated" }, DEFAULT_ORDER: "updated", NAME_LABEL: "kanso.name", PIN_LABEL: "kanso.pin",
    orderSessions: (l) => l, withTerminals: () => [], labelsOf: () => new Map(),
    theme: () => ({ foreground: "#fff", muted: "#888", dim: "#666", chrome: "#111", hover: "#222", ansi2: "#0f0" }),
    shared: () => null, setShared: () => {},
    spaces: spList, panes: () => [], agents: () => [],
    machines: () => [{ name: null, layout: "ready" }, { name: "odin", layout: "ready" }],
    run: (cmd, args) => calls.push([cmd, clone(args ?? null)]),
  });
  const view = new Spaces();
  Object.assign(view, {
    git: {}, shown: new Set(["odin/sp1"]), born: {}, custom: {}, order: "updated",
    machines: [{ name: "odin", state: "connected" }], folded: new Set(), agentsFolded: new Set(),
    orderPicker: node,
  });
  view.render();

  const cx = { stop_propagation() {}, notify() {} };
  clicks["machine-add-local"]({}, cx);
  clicks["machine-new-local"]({}, cx);
  clicks["machine-add-odin"]({}, cx);
  clicks["space-new"]({}, cx);

  activeMachine = null;
  view.shown.add("sp-local");
  view.render();
  clicks["space-new"]({}, cx);

  assert.deepEqual(calls, [
    ["space.new", { machine: "" }],
    ["space.new", { machine: "" }],
    ["space.new", { machine: "odin" }],
    ["space.new", { machine: "odin" }],
    ["space.new", { machine: "" }],
  ]);
});
