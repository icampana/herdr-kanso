// Derived from the `tabs` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: segmented tab pill, outlined Files and Changes buttons, no bar background.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-tabs; a Specs panel button with the pending count and a needs-you dot (sdd.badge).
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-tabs; tabs and panel buttons without outlines; side panels mounted on demand (only the open one exists); Spend built in, Specs dropped; panel buttons are icons with their name on hover, dragged into any order, and turned on or off in a Panels popup (right-click one); trackpad scrolling moves one tab per swipe.
// Modified by Iván Campaña (https://github.com/icampana): layout writers set the tree only when it is Kanso's, so a switch from another layout never saves that layout into kanso.json.
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, run, openOverlay, props, theme, window, shared, setShared, layout } from "herdr";

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

// The side panels, mounted on demand: the panel stack holds at most one block,
// the open one. Closing removes it from the layout, so Herdr ends that mod
// (its timers, watches and processes stop); opening adds a fresh copy. Nothing
// you aren't looking at runs.
// Each panel's block content: Files, Changes and PR are one mod (kanso-panel) told which panel it is.
const PANELS = {
  files: { mod: "kanso-panel", props: { panel: "files" } }, changes: { mod: "kanso-panel", props: { panel: "changes" } }, pr: { mod: "kanso-panel", props: { panel: "pr" } },
  shipped: { mod: "kanso-panel", props: { panel: "shipped" } },
  insights: { mod: "kanso-spend" },
};

function customPanels() {
  const list = shared("kanso.panels");
  return Array.isArray(list) ? list.filter((p) => p && typeof p.id === "string" && typeof p.mod === "string" && !(p.id in PANELS)) : [];
}

// The panel buttons, in the order you dragged them into, and the ones you
// turned off. Both are shared, so the Panels popup and every bar agree.
const ORDER = "kanso.panels.order", OFF = "kanso.panels.off";
const ICON = "mods/kanso-chrome/icons/";
const BUILTIN = [
  { id: "files", label: "Files", icon: `${ICON}file.svg` },
  // Spend (kanso-spend): costs per model, project and task.
  { id: "insights", label: "Spend", icon: `${ICON}chart.svg` },
  { id: "changes", label: "Changes", icon: `${ICON}changes.svg` },
  // The open pull request of the focused branch: status, checks, reviews, threads, files, agent tasks.
  { id: "pr", label: "PR", icon: `${ICON}pull-request.svg` },
  // What you delivered: lines, pull requests, reviews, streak and records.
  { id: "shipped", label: "Shipped", icon: `${ICON}trophy.svg` },
];
const list = (key) => { const v = shared(key); return Array.isArray(v) ? v.filter((x) => typeof x === "string") : []; };

// Every panel, in order, with `on`. Panels you never placed keep their place
// after the ones you did.
function panelList() {
  const all = [...BUILTIN, ...customPanels().map((p) => ({ id: p.id, label: p.label ?? p.id, icon: p.icon }))];
  const order = list(ORDER), off = new Set(list(OFF));
  const rank = new Map(all.map((p, i) => [p.id, order.includes(p.id) ? order.indexOf(p.id) : order.length + i]));
  return all.sort((a, b) => rank.get(a.id) - rank.get(b.id)).map((p) => ({ ...p, on: !off.has(p.id) }));
}

// Puts panel `from` where `to` is.
function movePanel(from, to) {
  const ids = panelList().map((p) => p.id), i = ids.indexOf(from), j = ids.indexOf(to);
  if (i < 0 || j < 0 || i === j) return;
  ids.splice(i, 1);
  ids.splice(j, 0, from);
  setShared(ORDER, ids);
}

function setPanelOn(id, on) {
  const off = new Set(list(OFF));
  if (on) off.delete(id); else off.add(id);
  setShared(OFF, [...off]);
}

const openPanels = () => openOverlay({ mod: "kanso-tabs", kind: "popup", width: 240, height: 48 + panelList().length * 32, props: { arrange: true } });

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
  init() {
    this.pressed = null;
    this.dragPanel = null;
    this.hoverPanel = null;
    // Opened as the Panels popup: this copy draws the list, not the bar.
    let given = null;
    try { given = props(); } catch { /* a host without props */ }
    this.arrange = Boolean(given?.arrange);
    this.panels = storedObject("panels");
  }

  // Which panel is open now (null: closed), read from the layout.
  // The node that hides: a "panel" wrapper if the layout has one, else the
  // stack itself (Herdr folds a wrapper with a single child into it).
  openPanel(panel, body) {
    const box = panel ?? body, child = body?.children?.[0];
    // A panel that hid its own block is closed.
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
  // (a key, a panel's own close button): hidden means unmounted, shown means mounted.
  reconcile(space, panel, body, now) {
    if (!body || this.inFlight(now)) return;
    const child = body.children?.[0];
    const hidden = (panel ?? body).hidden || Boolean(child?.hidden), mounted = (body.children ?? []).length > 0;
    if (hidden && mounted) this.mount(null);
    else if (!hidden && !mounted) this.mount(this.panels[space?.id] ?? null);
    // A panel kept from an older Kanso whose mod has a new name (Spend was
    // token-spend): mounted again with the one this version ships.
    else if (mounted && child?.id) {
      const want = panelContent(child.id);
      // A panel Kanso no longer has (Specs): closed.
      if (!want) { this.mount(null); return; }
      if (want?.mod && child.content?.mod && child.content.mod !== want.mod) this.mount(hidden ? null : child.id);
    }
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

  // The Panels popup: every panel, dragged into order, each with its switch.
  arrangeView() {
    const t = theme();
    const stop = (_e, cx) => cx.stop_propagation();
    const row = (p) => {
      const target = this.dragPanel && this.dragPanel !== p.id;
      return h_flex().id(`arrange-${p.id}`).h(30).px(8).gap(8).items_center().rounded(6).flex_none()
        .bg(this.dragPanel === p.id ? t.foreground + "12" : CLEAR)
        .hover((s) => s.bg(target ? t.foreground + "1a" : t.foreground + "0a"))
        .on_mouse_down("left", (_e, cx) => { this.dragPanel = p.id; cx.notify(); })
        .on_mouse_up("left", (_e, cx) => { const from = this.dragPanel; this.dragPanel = null; if (from && from !== p.id) movePanel(from, p.id); cx.notify(); })
        .child(svg(`${ICON}grip-vertical.svg`).size(13).text_color(t.dim))
        .child(p.icon ? svg(p.icon).size(15).text_color(p.on ? t.foreground : t.dim) : div().size(15))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(p.on ? t.foreground : t.muted).child(p.label))
        .child(div().id(`arrange-on-${p.id}`).w(28).h(16).p(2).flex_none().rounded_full()
          .bg(p.on ? t.accent : t.foreground + "1f")
          .on_mouse_down("left", stop)
          .on_click((_e, cx) => { setPanelOn(p.id, !p.on); cx.notify(); })
          .child(div().size(12).rounded_full().bg(p.on ? (t.background ?? t.canvas) : t.muted).when(p.on, (el) => el.ml(12))));
    };
    return v_flex().size_full().p(6).gap(2)
      .on_mouse_up("left", (_e, cx) => { this.dragPanel = null; cx.notify(); })
      .child(div().px(8).pt(4).pb(6).text_size(11).text_color(t.dim).child("Panels: drag to order"))
      .children(panelList().map(row));
  }

  render() {
    if (this.arrange) return this.arrangeView();
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
    const shownPanels = panelList().filter((p) => p.on);
    const enabled = shownPanels.map((p) => p.id);
    this.reconcile(space, panel, body, now);
    this.syncPanel(space, now, enabled);
    // A panel turned off while open closes.
    if (now && !enabled.includes(now) && !this.inFlight(now)) this.mount(null);
    // Icons only: the name opens beside the icon while the pointer is on it,
    // and stays open on the panel that is open.
    // Pressed on one and let go on another, a button moves there; right-click
    // opens the Panels popup.
    const panelButton = (p) => {
      const on = now === p.id, target = this.dragPanel && this.dragPanel !== p.id;
      const named = !p.icon || on || this.hoverPanel === p.id;
      // The name slides open: its box eases from 0 to the text's width
      // (about 6.8 px a character at 12) while it fades in, natively.
      const wide = Math.ceil(String(p.label).length * 6.8) + 10;
      const name = div().id(`panel-name-${p.id}`).h_full().flex().items_center().overflow_hidden().flex_none()
        .w(named ? wide : 0).opacity(named ? 1 : 0)
        .transition("width", { duration: 180, easing: "ease-out" })
        .transition("opacity", { duration: 180, easing: "ease-out" })
        .child(div().pl(6).pr(4).whitespace_nowrap().child(p.label));
      return h_flex().id(`panel-${p.id}`).h(TAB_H).min_w(TAB_H).px(p.icon ? 5.5 : 4).flex_none().items_center().justify_center().rounded(6)
        .text_size(12).bg(on ? t.foreground + "12" : CLEAR)
        .text_color(on ? t.foreground : t.muted)
        .hover(s => s.bg(target ? t.foreground + "1a" : on ? t.foreground + "12" : t.foreground + "0a").text_color(t.foreground))
        .on_hover((hovered, cx) => {
          if (hovered) this.hoverPanel = p.id; else if (this.hoverPanel === p.id) this.hoverPanel = null;
          cx.notify();
        })
        .on_mouse_down("left", (_e, cx) => { cx.stop_propagation(); this.dragPanel = p.id; cx.notify(); })
        .on_mouse_up("left", (_e, cx) => {
          const from = this.dragPanel; this.dragPanel = null;
          if (from && from !== p.id) movePanel(from, p.id);
          else if (from === p.id) this.mount(on ? null : p.id);
          cx.notify();
        })
        .on_mouse_down("right", (_e, cx) => { cx.stop_propagation(); openPanels(); })
        .when(Boolean(p.icon), (el) => el.child(svg(p.icon).size(15)))
        .child(name);
    };
    // No background and no line of its own: it sits on the frame.
    return h_flex().size_full().min_w(0).px(12).gap(2).items_center()
      // A pane held in the strip and let go here goes back where it was.
      .on_mouse_up("left", () => { if (shared("strip.drag")) { setShared("strip.drop", null); setShared("strip.drag", null); } })
      .on_mouse_up("left", () => { this.pressed = null; this.dragPanel = null; })
      .on_scroll_wheel(e => this.wheel(e))
      .child(h_flex().id("tab-scroll").flex_1().min_w(0).h_full().items_center().gap(6).overflow_x_scrollbar()
        .child(h_flex().flex_none().gap(2).items_center().children(shown.map(item)))
        .child(button("tab-new", svg("mods/kanso-chrome/icons/plus.svg").size(16), () => openOverlay({ mod: "new-menu", kind: "popup", width: 250, height: 512 }))))
      .child(h_flex().flex_none().gap(2).items_center().children(shownPanels.map(panelButton)))
      .when(window()?.buttons, el => el.child(button("minimize", "−", () => run("window.minimize")))
        .child(button("maximize", "□", () => run("window.maximize")))
        .child(button("close-window", svg("mods/kanso-chrome/icons/close.svg").size(13), () => run("window.close"))));
  }
}
