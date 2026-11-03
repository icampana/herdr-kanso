// Derived from the `tabs` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: segmented tab pill, outlined Files and Changes buttons, no bar background.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-tabs; a Specs panel button with the pending count and a needs-you dot (sdd.badge).
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-tabs; tabs and panel buttons without outlines; side panels mounted on demand (only the open one exists); Specs and Insights offered only when installed; trackpad scrolling moves one tab per swipe.
// Modified by Iván Campaña (https://github.com/icampana): layout writers set the tree only when it is Kanso's, so a switch from another layout never saves that layout into kanso.json.
import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, panes, agents, terminals, run, openOverlay, theme, window, shared, setShared, layout, readTextFile, appHome } from "herdr";

// Right after layout.switch, layout() can still return the tree of the layout
// shown before; setting it would save that tree into kanso.json. Only Kanso's
// tree has the strip map, so only that tree is written.
const isKansoTree = (n) => n?.id === "strip-map" || (n?.children ?? []).some(isKansoTree);

// Same helper as kanso-strip, kanso-spaces, kanso-panel and open-with.
// layout.set replaces the whole tree, and a set that has not landed still
// reads as the old one, so each writer keeps its piece in kanso.layout and
// every write puts the strip, the panel and the rail back.
const LAYOUT_INTENT = "kanso.layout";
// The strip writes its columns under their own key, many times a second, so
// it never has to read back and copy the panel and rail to keep them.
const STRIP_INTENT = "kanso.layout.strip";

function walkLayout(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = walkLayout(child, id);
    if (found) return found;
  }
  return null;
}

function paintLayout(tree, preserveSizes = true) {
  if (!tree) return;
  const intent = { ...(shared(LAYOUT_INTENT) ?? {}), ...(shared(STRIP_INTENT) ?? {}) };
  if (intent.nodes) {
    const body = walkLayout(tree, "work-body");
    if (body?.children) {
      const mine = (n) => n.id === "main" || String(n.id).startsWith("strip-");
      const at = body.children.findIndex(mine);
      const rest = body.children.filter((n) => !mine(n));
      const i = Math.max(0, at);
      const nodes = JSON.parse(JSON.stringify(intent.nodes));
      // Native dividers leave px sizes before the strip's adopt timer runs.
      // Keep those edits, but not sizes from the tree a pending strip write
      // was based on: replaying those would undo an explicit width command.
      const keepSize = (node) => {
        const before = intent.sizesBefore?.[node.id], live = walkLayout(body, node.id);
        if (before !== undefined && live?.size?.px !== undefined
          && JSON.stringify(live.size) !== JSON.stringify(before)) node.size = { ...live.size };
        for (const child of node.children ?? []) keepSize(child);
      };
      if (preserveSizes) nodes.forEach(keepSize);
      body.children = [...rest.slice(0, i), ...nodes, ...rest.slice(i)];
    }
  }
  if ("panel" in intent) {
    const body = walkLayout(tree, "panel-body");
    const wrap = walkLayout(tree, "panel") ?? body;
    if (body) {
      const child = intent.panel ? JSON.parse(JSON.stringify(intent.panel)) : null;
      body.children = child ? [child] : [];
      if (child) body.active = child.id;
      else delete body.active;
      if (wrap) wrap.hidden = !child;
    }
  }
  if (intent.rail) {
    const sidebar = (tree.children ?? []).find((n) => n.id === "sidebar");
    if (sidebar) {
      tree.resizable = intent.rail.open;
      sidebar.min = intent.rail.min;
    }
  }
  edgeBesidePanel(tree);
}

// A side panel's left border is Herdr's divider, which moves only the two
// nodes beside it, so a fixed-width neighbor pins it. While a panel shows,
// the strip's right edge rail (28 px, fixed) stands after the panel instead
// of before it, and a strip column keeps the border draggable.
function edgeBesidePanel(tree) {
  const kids = walkLayout(tree, "work-body")?.children;
  const at = kids ? kids.findIndex((n) => n.id === "strip-edge-right") : -1;
  if (at < 0) return;
  const [edge] = kids.splice(at, 1);
  const panel = kids[at];
  const beside = panel && (panel.id === "panel-body" || panel.id === "panel") && !panel.hidden;
  kids.splice(beside ? at + 1 : at, 0, edge);
}

function rememberLayout(patch) {
  setShared(LAYOUT_INTENT, { ...(shared(LAYOUT_INTENT) ?? {}), ...patch });
}

function commitLayout(patch) {
  rememberLayout(patch);
  const tree = layout();
  if (!tree) return false;
  paintLayout(tree);
  if (isKansoTree(tree)) run("layout.set", { layout: tree });
  return true;
}

function storedObject(key) {
  try {
    const v = JSON.parse(localStorage.getItem(key) ?? "{}");
    return v && typeof v === "object" && !Array.isArray(v) ? v : {};
  } catch { return {}; }
}

// The Specs button's extra (added by José Gutiérrez, minimalistic): this space's pending count, published by
// sdd-focused as "sdd.badge" {space, n, pending: [paths]}, and a red dot when an
// agent started on one of them (terminal label spec=<path>) needs you.
function specsBadge(space, t) {
  const badge = shared("sdd.badge");
  if (!badge || badge.space !== space?.id || !badge.n) return null;
  const pending = new Set(badge.pending ?? []);
  const blocked = new Set(agents().filter((a) => a.status === "blocked").map((a) => a.address));
  const alert = terminals().some((term) => pending.has(term.labels?.spec) && blocked.has(term.address));
  return h_flex().gap(4).items_center()
    .child(div().text_size(11).text_color(t.muted).child(String(badge.n)))
    .when(alert, el => el.child(div().size(6).rounded_full().bg(t.blocked)));
}

// The side panels, mounted on demand: the panel stack holds at most one block,
// the open one. Closing removes it from the layout, so Herdr ends that mod
// (its timers, watches and processes stop); opening adds a fresh copy. Nothing
// you aren't looking at runs.
// Each panel's block content: Files, Changes and PR are one mod (kanso-panel) told which panel it is.
const PANELS = {
  files: { mod: "kanso-panel", props: { panel: "files" } }, changes: { mod: "kanso-panel", props: { panel: "changes" } }, pr: { mod: "kanso-panel", props: { panel: "pr" } },
  shipped: { mod: "kanso-panel", props: { panel: "shipped" } },
  insights: { mod: "token-spend" }, specs: { mod: "sdd-focused" },
};

function customPanels() {
  const list = shared("kanso.panels");
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.mod === "string" && !(p.id in PANELS)) : [];
}

function panelContent(id) {
  if (PANELS[id]) return { ...PANELS[id] };
  const custom = customPanels().find((p) => p.id === id);
  if (!custom) return null;
  return custom.props !== undefined ? { mod: custom.mod, props: custom.props } : { mod: custom.mod };
}

const TAB_H = 26; // inside the 2px padding of the pill, so the pill is 30px
const CLEAR = "#00000000";

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

export default class Tabs extends View {
  init(_props, cx) {
    this.pressed = null;
    this.panels = storedObject("panels");
    // Specs and Insights are separate mods: offer each only where it is installed.
    this.installed = {};
    for (const id of ["specs", "insights"]) cx.spawn(async (cx) => {
      try { if ((await readTextFile(`${appHome()}/mods/${PANELS[id].mod}/main.js`)) !== null) { this.installed[id] = true; cx.notify(); } } catch {}
    });
  }

  // Which panel is open now (null: closed), read from the layout.
  // The node that hides: a "panel" wrapper if the layout has one, else the
  // stack itself (Herdr folds a wrapper with a single child into it).
  openPanel(panel, body) {
    const box = panel ?? body, child = body?.children?.[0];
    // A panel that hid itself (Specs' close button hides its own block) is closed.
    return !box || box.hidden || !child || child.hidden ? null : child.id;
  }

  // Shows panel `id` (null: closes it) by rewriting the panel stack to hold
  // only that block.
  mount(id) {
    const content = id ? panelContent(id) : null;
    if (id && !content) return;
    if (!walkLayout(layout(), "panel-body")) return;
    this.want = id;
    this.mountedAt = Date.now();
    commitLayout({ panel: id ? { id, type: "block", content } : null });
  }

  // A change just sent hasn't landed yet: don't read the old state as a choice.
  inFlight(now) {
    return this.want !== undefined && now !== this.want && Date.now() - this.mountedAt < 1000;
  }

  // Keeps the layout honest when something else opened or closed the panel
  // (a key, the Specs close button): hidden means unmounted, shown means mounted.
  reconcile(space, panel, body, now) {
    if (!body || this.inFlight(now)) return;
    const child = body.children?.[0];
    const hidden = (panel ?? body).hidden || Boolean(child?.hidden), mounted = (body.children ?? []).length > 0;
    if (hidden && mounted) this.mount(null);
    else if (!hidden && !mounted) this.mount(this.panels[space?.id] ?? null);
  }

  // The side panel is remembered per space: switching shows that space's choice
  // (closed if it never had one), and opening or closing it records it.
  syncPanel(space, now, enabled) {
    if (!space || this.inFlight(now)) return;
    if (space.id !== this.space) {
      const first = this.space === undefined;
      this.space = space.id;
      if (!(first && !(space.id in this.panels))) {
        const stored = this.panels[space.id] ?? null, want = enabled.includes(stored) ? stored : null;
        if (want !== now) { this.mount(want); return; }
      }
    }
    if (this.panels[space.id] === now) return;
    this.panels[space.id] = now;
    localStorage.setItem("panels", JSON.stringify(this.panels));
  }

  // A trackpad sends dozens of small scroll events per swipe: add them up and
  // move one tab per notch's worth, so a swipe doesn't race through every tab.
  wheel(e) {
    // A mouse wheel reports lines: one notch, one tab.
    if (Math.abs(e.delta_lines?.y ?? 0) >= 1) { run(e.delta_lines.y > 0 ? "tab.prev" : "tab.next"); return; }
    const dy = e.delta.y;
    const now = Date.now();
    if (now - (this.wheelAt ?? 0) > 300) this.wheelSum = 0;
    this.wheelAt = now;
    this.wheelSum = (this.wheelSum ?? 0) + dy;
    if (Math.abs(this.wheelSum) < 40) return;
    run(this.wheelSum > 0 ? "tab.prev" : "tab.next");
    this.wheelSum = 0;
  }

  render() {
    const t = theme();
    const space = spaces().find(p => p.active);
    const shown = space?.tabs ?? [];
    // Each live-data read copies the whole list: read once per render.
    const ps = panes();
    const tree = layout();
    const stop = (_e, cx) => cx.stop_propagation();
    const button = (id, label, action) => div().id(id).size(28).flex_none().flex().items_center().justify_center().rounded(6).text_color(t.muted).hover(s => s.bg(t.foreground + "0a").text_color(t.foreground))
      .on_mouse_down("left", stop).on_click(action).child(label);
    const item = (c, i) => {
      const program = ps.find(p => p.tab === c.id && p.program?.agent)?.program ?? ps.find(p => p.tab === c.id)?.program;
      const name = c.name;
      return h_flex().id(`tab-${c.id}`).h(TAB_H).px(10).gap(6).rounded(6).items_center().flex_none().text_size(12.5)
        .bg(c.active ? t.foreground + "12" : CLEAR)
        .text_color(c.active ? t.foreground : t.muted)
        .hover(s => s.bg(c.active ? t.foreground + "12" : t.foreground + "0a").text_color(t.foreground))
        .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); this.pressed = i; if (e.click_count === 2) run("tab.rename", { id: c.id }); })
        .on_mouse_up("left", () => {
          const from = this.pressed; this.pressed = null;
          if (from !== null && from !== i) run("tab.move", { id: shown[from].id, index: space.tabs.findIndex(x => x.id === c.id) + 1 });
          else run("tab.select", { id: c.id });
        })
        .on_mouse_down("right", () => openOverlay({ mod: "menu", kind: "popup", width: 200, props: { tab: "tab", target: { id: c.id, space: space.id } } }))
        .when(Boolean(program?.icon), el => el.child((program.tint ? svg(program.icon).size(15).text_color(t.muted) : image(program.icon).size(15)).opacity(c.active ? 1 : 0.8)))
        .child(div().max_w(170).truncate().child(c.zoomed ? `${name} Z` : name))
        .when(c.status === "working", el => el.child(h_flex().w(12).h(12).flex_none().items_center().justify_center().text_size(10).text_color(t.working).child(div().frames(["\u00b7", "\u2022", "\u25cf", "\u2022"], 450))))
        .when(c.status === "blocked" || c.status === "done", el => el.child(div().size(6).rounded_full().bg(t[c.status])))
        .when(c.active && shown.length > 1, el => el.child(div().id(`close-${c.id}`).text_color(t.dim).hover(s => s.text_color(t.foreground)).on_mouse_down("left", stop).on_click((_e, cx) => { cx.stop_propagation(); run("tab.close", { id: c.id }); }).child(svg("mods/kanso-chrome/icons/close.svg").size(13))));
    };
    const panel = find(tree, "panel"), body = find(tree, "panel-body");
    const now = this.openPanel(panel, body);
    const custom = customPanels();
    // Specs and Insights, where installed, are offered beside the panels the welcome chose.
    // The PR and Shipped panels ship with Kanso, so they are always offered; custom panels from kanso.panels follow.
    const enabled = [...(shared("workspace.panels") ?? ["files", "changes"]), "pr", "shipped", ...Object.keys(this.installed), ...custom.map((p) => p.id)];
    this.reconcile(space, panel, body, now);
    this.syncPanel(space, now, enabled);
    const panelButton = (id, label, icon, extra) => {
      const on = now === id;
      return h_flex().id(`panel-${id}`).h(TAB_H).px(9).gap(6).flex_none().items_center().rounded(6)
        .text_size(12).bg(on ? t.foreground + "12" : CLEAR)
        .text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(on ? t.foreground + "12" : t.foreground + "0a").text_color(t.foreground)).on_mouse_down("left", stop)
        .on_click(() => this.mount(on ? null : id))
        .when(Boolean(icon), el => el.child(svg(icon).size(15)))
        .child(label)
        .when(Boolean(extra), el => el.child(extra));
    };
    // The count comes from the Specs panel itself, so it shows only while that
    // panel is open (closed, the panel isn't running and its count would be stale).
    const specsExtra = now === "specs" ? specsBadge(space, t) : null;
    // No background and no line of its own: it sits on the frame.
    return h_flex().size_full().min_w(0).px(12).gap(2).items_center()
      // A pane held in the strip and let go here goes back where it was.
      .on_mouse_up("left", () => { if (shared("strip.drag")) { setShared("strip.drop", null); setShared("strip.drag", null); } })
      .on_mouse_up("left", () => { this.pressed = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(6).overflow_x_scrollbar()
        .child(h_flex().flex_none().gap(2).items_center().children(shown.map(item)))
        .child(button("tab-new", svg("mods/kanso-chrome/icons/plus.svg").size(16), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))))
      .when(enabled.includes("files"), el => el.child(panelButton("files", "Files", "mods/kanso-chrome/icons/file.svg")))
      // Insights (costs per model, project and task) opens in the side panel like Files.
      .when(Boolean(this.installed.insights), el => el.child(panelButton("insights", "Spend", "mods/kanso-chrome/icons/chart.svg")))
      .when(enabled.includes("changes"), el => el.child(panelButton("changes", "Changes", "mods/kanso-chrome/icons/changes.svg")))
      // The open pull request of the focused branch: status, checks, reviews, threads, files, agent tasks.
      .child(panelButton("pr", "PR", "mods/kanso-chrome/icons/pull-request.svg"))
      .when(Boolean(this.installed.specs), el => el.child(panelButton("specs", "Specs", "mods/kanso-chrome/icons/file-text.svg", specsExtra)))
      // What you delivered: lines, pull requests, reviews, streak and records.
      .child(panelButton("shipped", "Shipped", "mods/kanso-chrome/icons/trophy.svg"))
      .children(custom.map((p) => panelButton(p.id, p.label ?? p.id, p.icon)))
      .when(window()?.buttons, el => el.child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/kanso-chrome/icons/close.svg").size(13), () => run("window.close"))));
  }
}
