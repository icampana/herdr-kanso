// Kanso strip, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// An endless canvas of panes, as in Omarchy's scrolling layout or niri. Panes
// sit side by side in columns, each with its own width; the view is a window
// onto that row. The view always starts at a column's edge and shows only
// whole, live panes: it slides a column at a time, and a new pane opens
// beside the focused one without shrinking anything.
//
// How: in the "work-body" row, the layout's "main" node is replaced with what
// the view shows. Each column in view is a header block (a {pane} copy) over a
// live `{terminal}` block (Herdr can't clip a terminal, so none is ever cut).
// When columns lie beyond an edge, a narrow "edge" block (a copy of this mod)
// stands there: a rail with a stack of tiles, one per pane beyond, and a card
// on hover that names them; click one to bring that pane in. Off-screen columns aren't in the tree at all. The shown columns
// share the width by their weights, so they stretch a little to fill it.
//
// Herdr rules that shape the tree: a layout nests at most 16 levels (columns
// sit directly in work-body), and Herdr folds empty containers and
// single-child ones (free space is a filler block, never an empty column).
//
// Copies, chosen by props: none = the controller and minimap (status bar),
// {edge: pane, side, count, panes} = the tab at an edge for the panes beyond it,
// {ruler: <pane> | "h"} = a 1px block that measures a pane's width or the strip's height,
// {drop: <pane>} = the card that stands in for a pane's terminal while a pane is held,
// {pane, terminal} = a pane's header (the app passes these; the strip adds {strip: true}).
//
// State per tab in shared "strip.state": { cols: [{ panes, w, pin }], vx }
//   w: column width as a share of the view; vx: the view's left edge on the
//   row, in view widths, always a column's start. pin: "left" or "right" for a pinned column, which
//   stays on that side of the view, always whole, while the rest slides in
//   the space left between the pinned ones. A column may stack panes (split down): they share
//   height (hs: pane -> share, equal until dragged) and never move
//   vertically; drag moves a pane sideways.
// Headers and edges talk to the controller through shared "strip.req"
// (scroll, focus, move, width, pin) and "strip.intent" (where the next pane goes).
// A held pane is shared "strip.drag" {pane, at}; where it would land right
// now is "strip.drop" {to, side}, written by whatever the pointer is over.
// Resizing is Herdr's own divider drag; the strip reads the result back
// (see "Resizing" below) with the help of 1px ruler blocks that measure.

import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex, HoverCard } from "gpui-base";
import { spaces, panes, focused, layout, run, shared, setShared, theme, nextCommand, props, terminals, openOverlay, home } from "herdr";

// How many panes the view holds at once (`st.n`, 1 to 8; you choose). A new
// column takes 1/n of the view; dragging the divider between two columns
// resizes them and the others reflow, so the row grows or shrinks in "pages".
const N_MAX = 8;
const DEFAULT_N = 2;
const MIN_W = 0.08; // narrowest a column can be dragged, as a share of the view
const W_STEPS = [1 / 4, 1 / 3, 1 / 2, 2 / 3, 1];
const newW = (st) => 1 / (st.n ?? DEFAULT_N);
const EPS = 1e-3;
const KEY = "strip.state";
const HEADER_H = 34;
const WHEEL_PX = 600; // trackpad/wheel pixels that slide the view one full width
const EDGE_W = 28; // the tab at an edge that stands for the panes beyond it
const WHEEL_STEP = 0.25; // of a view width of wheel travel moves one column
const MIN_VIEW = 0.2; // pinned columns always leave this much of the view to slide
const COL_MIN = 140; // px: a column can't be dragged narrower
const ROW_MIN = 90; // px: a stacked pane can't be dragged shorter
const SETTLE = 250; // ms without the dragged sizes changing before the strip adopts them

const GAP = 6; // the soft gutter between panes, in the frame's tone: no lines
const RADIUS = 8;
const TAB_BLOCK = {
  id: "main", type: "block", background: "chrome",
  content: { tab: "active", pane: {
    header: { content: { mod: "kanso-strip" }, reveal: "always", height: HEADER_H, position: "top" },
    background: "background", border: { width: 0, color: "border" }, focus: { width: 0, color: "border" },
    radius: RADIUS, gap: GAP, lone: false } },
};

function find(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = find(child, id);
    if (found) return found;
  }
  return null;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const step = (list, v) => list[(list.findIndex((s) => Math.abs(s - v) < EPS) + 1) % list.length];
const nonce = () => Date.now() + Math.random();

// The node a column is in the tree.
const nodeId = (c) => (c.panes.length === 1 ? `strip-${c.panes[0]}` : `strip-col-${c.panes[0]}`);

// What the ruler blocks measured, in logical px, lives in shared "strip.px":
// each pane's width (a 1px line under its terminal) by pane id, and the
// strip's height (a 1px line at the end of work-body) as "h". Each copy of
// this mod runs on its own, so they meet in shared state; the controller
// reads it when it adopts a drag and drops the panes that are gone.
const PX = "strip.px";
const DRAG_MAX = 12000; // ms a held pane stays held with nobody dropping it (let go over a gutter)

// A pane's name: the one you gave its terminal (the `kanso.name` label, set
// by a double-click on a header or a sidebar row), else the program's.
const givenNames = () => {
  const out = new Map();
  for (const term of terminals()) { const n = term?.labels?.["kanso.name"]; if (n) out.set(term.address, n); }
  return out;
};
const nameOf = (info, given) => {
  const prog = info?.program;
  return given?.get(info?.terminal) || (prog?.agent || prog?.shell) && prog.name || info?.title || prog?.name || "Pane";
};
// A program's icon from the app's program table (null when it has none), and
// the same with an empty square of its size in that case.
const programIcon = (prog, size, color) => !prog?.icon ? null : prog.tint ? svg(prog.icon).size(size).flex_none().text_color(color) : image(prog.icon).w(size).h(size).flex_none();
const iconOf = (prog, size, color) => programIcon(prog, size, color) ?? div().size(size);
// Where on a pane the pointer is: the left and right quarters mean a column
// of its own before or after; the middle, stacked above (upper half) or
// below (lower half).
const zoneOf = (e, fallback = "below") => {
  const w = e.bounds?.width, h = e.bounds?.height, at = e.local_position;
  if (!w || !h || !at) return fallback;
  return at.x < w / 4 ? "before" : at.x > w * 3 / 4 ? "after" : at.y < h / 2 ? "above" : "below";
};
const endDrag = () => { setShared("strip.drop", null); setShared("strip.drag", null); };

// The header (a {pane} copy): the terminal label that holds a name you gave
// it, the rename dialog's width (kanso-prompt, as in the sidebar), how wide
// the folder and branch may grow, and a folder shown from home.
const NAME_LABEL = "kanso.name";
const PROMPT_W = 420;
const BADGE_MAX_W = 220;
const folder = (cwd) => {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
};

export default class Strip extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = p.edge ? "edge" : p.ruler ? "ruler" : p.drop ? "drop" : p.pane ? "head" : "controller";
    if (this.kind === "head") this.hovered = false;
    if (this.kind !== "controller") return;

    this.state = JSON.parse(JSON.stringify(shared(KEY) ?? {}));
    this.saved = JSON.stringify(this.state);
    this.lastReq = shared("strip.req")?.n ?? null;
    this.usedIntent = shared("strip.intent")?.at ?? null;
    this.pendingFocus = null;
    this.sets = [];
    // Scrolling writes the layout at most every 60 ms, however fast the wheel.
    this.seq = 0; // bumped by whatever changes the model outside render (see render's key)
    cx.timer.every(60, (cx) => { if (this.dirty) { this.dirty = false; this.seq++; cx.notify(); } });
    // A drag on one of Herdr's dividers changes the tree without telling us.
    cx.timer.every(150, (cx) => {
      // A pane let go where nothing takes drops (a gutter) is held until
      // the next press or move over a pane; failing those, it ends here.
      const held = shared("strip.drag");
      if (held && Date.now() - held.at > DRAG_MAX) endDrag();
      if (this.adopt()) { this.seq++; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        let c;
        try { c = await nextCommand(); } catch { break; }
        this.command(String(c).replace(/^kanso-strip\./, ""));
        this.seq++;
        cx.notify();
      }
    });
  }

  // ---- Edge: the tab at the view's edge for the panes beyond it --------------

  // A rail in the frame's own color, so it reads as chrome rather than as a
  // pane. At its middle, where the eye lands, a chevron over a stack of small
  // tiles, one per pane beyond the edge, each with its program and a state dot:
  // the row of panes, seen end-on. Resting the pointer there opens a card that
  // names them; a click on a tile or a row brings that pane in, a click on the
  // bare rail the nearest one.
  renderEdge() {
    const t = theme(), p = props();
    const all = panes();
    const ids = (p.panes ?? [p.edge]).filter((id) => all.some((q) => q.pane === id));
    const left = p.side === "left";
    const chevron = left ? "\u2039" : "\u203a";
    const show = (id) => setShared("strip.req", { op: "focus", pane: id, n: nonce() });
    const given = givenNames();
    const name = (info) => nameOf(info, given), icon = iconOf;
    const dot = (st, size) => st === "working" ? div().size(size).rounded_full().bg(t.working).loop("opacity", { from: 0.35, to: 1, period: 1800 })
      : st === "blocked" ? div().size(size).rounded_full().bg(t.blocked).loop("opacity", { from: 0.45, to: 1, period: 1600 })
      : st === "done" ? div().size(size).rounded_full().bg(t.done) : null;
    const MAX_TILES = 8;
    const tile = (id) => {
      const info = all.find((q) => q.pane === id), d = dot(info?.status, 7);
      return div().id(`edge-tile-${id}`).relative().size(20).flex_none().rounded(6).bg(t.input)
        .flex().items_center().justify_center()
        .hover((h) => h.bg(t.selected))
        .on_click((_e, cx) => { cx.stop_propagation(); show(id); })
        .child(icon(info?.program, 12, t.muted))
        .when(Boolean(d), (el) => el.child(d.absolute().top(-2).right(-2).border(1).border_color(t.chrome)));
    };
    const stack = v_flex().id("edge-stack").items_center().gap(5).py(6).px(4)
      .child(div().h(16).text_size(14).text_color(takes ? t.foreground : t.muted).child(chevron))
      .children(ids.slice(0, MAX_TILES).map(tile))
      .when(ids.length > MAX_TILES, (el) => el.child(div().text_size(10).text_color(t.dim).child(`+${ids.length - MAX_TILES}`)));
    const rowOf = (id) => {
      const info = all.find((q) => q.pane === id), d = dot(info?.status, 6);
      return h_flex().id(`edge-row-${id}`).h(26).px(8).gap(8).items_center().rounded(6).cursor_pointer()
        .hover((h) => h.bg(t.hover))
        .on_click((_e, cx) => { cx.stop_propagation(); show(id); })
        .child(icon(info?.program, 13, t.muted))
        .child(div().flex_1().min_w(0).truncate().text_size(12.5).text_color(t.foreground).child(name(info)))
        .when(Boolean(d), (el) => el.child(d));
    };
    const card = v_flex().w(220).p(6).gap(1).rounded(8).bg(t.chrome).shadow_md()
      .child(div().h(22).px(8).flex().items_center().text_size(11).text_color(t.dim)
        .child(`${ids.length === 1 ? "One pane" : `${ids.length} panes`} beyond the ${left ? "left" : "right"} edge`))
      .children(ids.map(rowOf));
    const drag = shared("strip.drag");
    const takes = Boolean(drag) && drag.pane !== p.edge; // a held pane can land beyond this edge
    return v_flex().id("edge").size_full().items_center().justify_center().bg(t.chrome).cursor_pointer()
      .hover((h) => h.bg(takes ? t.accent + "40" : t.hover))
      // While a pane is held the rail is a target too: lit in the accent,
      // brighter under the pointer, its chevron in full ink.
      .when(takes, (el) => el.bg(t.accent + "24").cursor_grabbing())
      // Dropping a dragged pane here puts it just beyond this edge.
      .on_mouse_up("left", () => {
        const d = shared("strip.drag");
        if (!d) return;
        if (d.pane !== p.edge) setShared("strip.req", { op: "move", pane: d.pane, to: p.edge, side: left ? "after" : "before", n: nonce() });
        endDrag();
      })
      .on_click(() => show(p.edge))
      .child(HoverCard.new(`edge-card-${p.side}`).anchor(left ? "left_center" : "right_center").open_delay(350).close_delay(250)
        .trigger(stack)
        .content(card));
  }

  // A block that measures: {ruler: "h"} is 1px wide at the end of work-body
  // and takes its height (drawn in `chrome`, as the gutter); {ruler: <pane>}
  // lies under that pane's terminal, RADIUS tall, takes its width and draws
  // the slab's rounded bottom in `background`.
  renderRuler() {
    const what = props().ruler;
    const t = theme();
    // A pane's foot is part of its card while a pane is held: landing below
    // the pane lights it too, and letting go on it lands there.
    const drag = what !== "h" ? shared("strip.drag") : null;
    const takes = Boolean(drag) && drag.pane !== what;
    const drop = takes ? shared("strip.drop") : null;
    // A size change comes on every frame of a divider drag, and a shared write
    // redraws every mod: the ruler notes each one and writes the last once the
    // size has rested 120 ms (the controller adopts a drag after 250 ms).
    return div().size_full().when(what !== "h", (el) => el.rounded_b(RADIUS).bg(t.background)).on_size_change((sz, cx) => {
      const v = Math.round(what === "h" ? sz.height : sz.width);
      if (!v) return;
      this.measured = v;
      if (this.measuring) return;
      this.measuring = cx.timer.after(120, () => {
        this.measuring = null;
        const px = shared(PX) ?? {};
        if (px[what] !== this.measured) setShared(PX, { ...px, [what]: this.measured });
      });
    })
      .when(takes, (el) => el.cursor_grabbing()
        .on_mouse_move(() => { const d = shared("strip.drop"); if (d?.to !== what || d.side !== "below") setShared("strip.drop", { to: what, side: "below" }); })
        .on_mouse_up("left", () => {
          const d = shared("strip.drag");
          if (d && d.pane !== what) setShared("strip.req", { op: "move", pane: d.pane, to: what, side: "below", n: nonce() });
          endDrag();
        }))
      .when(drop?.to === what && drop.side === "below", (el) => el.child(div().size_full().rounded_b(RADIUS).bg(t.accent + "40")));
  }

  // ---- Sorting: the strip while a pane is held ---------------------------------

  // Holding a header's grip turns every pane into a card in its own place: the
  // terminal lives on, only its picture gives way, so the whole pane takes the
  // drop, not just its header. Over a card, the half the held pane will take
  // fills with the accent and carries its name, and the card's own name steps
  // to the other half: the result, shown before you let go. The held pane's
  // own card is dim. Letting go on it, or anywhere that isn't a pane, moves
  // nothing.
  renderDrop() {
    const t = theme(), id = props().drop;
    const all = panes(), given = givenNames();
    const me = all.find((q) => q.pane === id);
    const drag = shared("strip.drag");
    const held = drag ? all.find((q) => q.pane === drag.pane) : null;
    const mine = drag?.pane === id;
    const drop = !mine ? shared("strip.drop") : null;
    const side = drop?.to === id ? drop.side : null;
    const label = (info, strong) => v_flex().flex_1().size_full().min_w(0).min_h(0).items_center().justify_center().gap(8)
      .child(iconOf(info?.program, 22, strong ? t.foreground : t.muted))
      .child(div().w_full().px(12).truncate().text_center().text_size(13).when(strong, (el) => el.font_medium())
        .text_color(strong ? t.foreground : t.muted).child(nameOf(info, given)));
    const across = side === "before" || side === "after";
    const first = side === "before" || side === "above";
    const ghost = () => label(held, true).bg(t.accent + "40");
    return div().id(`drop-${id}`).size_full().relative().cursor_grabbing()
      .when(mine, (el) => el.opacity(0.4))
      .when(!mine, (el) => el
        .on_mouse_move((e) => {
          const s = zoneOf(e), d = shared("strip.drop");
          if (d?.to !== id || d.side !== s) setShared("strip.drop", { to: id, side: s });
        })
        .on_hover((over) => { if (!over && shared("strip.drop")?.to === id) setShared("strip.drop", null); }))
      .on_mouse_up("left", (e) => {
        const d = shared("strip.drag");
        if (!d) return;
        if (!mine) setShared("strip.req", { op: "move", pane: d.pane, to: id, side: zoneOf(e, side ?? "below"), n: nonce() });
        endDrag();
      })
      .child(!side ? div().absolute().inset_0().flex().child(label(me, false))
        : (across ? h_flex() : v_flex()).absolute().inset_0()
          .children(first ? [ghost(), label(me, false)] : [label(me, false), ghost()]));
  }

  // ---- The header: a {pane} copy ------------------------------------------------

  // Derived from the `pane` mod shipped with Herdr (Apache-2.0), by way of
  // 0OZ's and José Gutiérrez's quiet headers. Shows the program's icon, the
  // name (yours, the agent's, or the terminal's title), the folder, the
  // branch and the agent's status; on hover, buttons split, zoom and close
  // the pane. In the strip (props.strip) it also slides the view on wheel,
  // holds the pane on its grip and is the top of the pane's drop card. The
  // app's own `{tab}` block (one pane, TAB_BLOCK) uses the same copy.
  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // A double-click on the header opens the rename dialog Herdr uses for
  // spaces and tabs (`kanso-prompt`, which writes the terminal's label).
  rename(p, shown) {
    openOverlay({ mod: "kanso-prompt", kind: "dialog", width: PROMPT_W, props: {
      title: "Rename terminal", value: shown, hint: "Empty: the name the program gives it",
      label: { terminal: p.terminal, key: NAME_LABEL } } });
  }

  // Where the pane is: quiet text, no outline. The branch keeps its glyph.
  // (`where` and `place` below are the model's.)
  badge(t, text, iconPath, on) {
    return h_flex().flex_shrink(1).min_w(0).max_w(BADGE_MAX_W).gap(4).items_center().text_size(11.5).text_color(on ? t.muted : t.dim)
      .when(Boolean(iconPath), (el) => el.child(svg(iconPath).size(12).flex_none()))
      .child(div().min_w(0).truncate().child(text));
  }

  // In the strip, a split first says where the new pane goes, and the zoom
  // button cycles the column's width instead.
  act(command, args) {
    const pane = props()?.pane;
    if (props()?.strip && command === "pane.split") setShared("strip.intent", { dir: args.direction, from: pane, at: Date.now() });
    if (props()?.strip && command === "pane.zoom") { setShared("strip.req", { op: "width", pane, n: nonce() }); return; }
    run(command, args);
  }

  // Wheel or swipe over a header slides the canvas continuously (600px of
  // travel = one view width; a mouse notch = 40px).
  wheelReq(e) {
    const lines = e.delta_lines?.y ?? 0;
    const d = lines ? -lines * 40 : (Math.abs(e.delta.x) > Math.abs(e.delta.y) ? -e.delta.x : -e.delta.y);
    if (d) setShared("strip.req", { op: "scroll", d: d / WHEEL_PX, n: nonce() });
  }

  // The pane's folder in a code editor (the `open-with` mod), on the machine
  // its space lives on.
  openWith(p) {
    const space = spaces().find((s) => s.tabs.some((x) => x.id === p.tab));
    openOverlay({ mod: "open-with", kind: "popup", width: 340, props: { folder: p.cwd, machine: space?.machine ?? null } });
  }

  // The six-dot grip near the header's right edge: hold it and drag onto
  // another pane to move this pane there (shared "strip.drag" while held;
  // Ctrl+drag anywhere on the header does the same).
  grip(t, pane) {
    const held = shared("strip.drag")?.pane === pane;
    return div().id(`grip-${pane}`).w(18).h_full().flex_none().flex().items_center().justify_center().cursor_grab()
      .tooltip("Hold and drag onto another pane to move this one there")
      .text_color(held ? t.foreground : t.dim)
      .hover((h) => h.text_color(t.foreground))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); setShared("strip.drag", { pane, at: Date.now() }); })
      // A press anywhere else while this pane is still held: it was let go
      // where nothing took it, so the hold ends.
      .on_mouse_down_out(() => { const d = shared("strip.drag"); if (d?.pane === pane && Date.now() - d.at > 300) endDrag(); })
      .child(svg("mods/kanso-chrome/icons/grip-vertical.svg").size(14));
  }

  // While a pane is held, the header is the top of its pane's drop card: the
  // left quarter means a column before this pane, the right quarter one
  // after, the middle stacks the held pane above it (the card below has the
  // zone for below). What the pointer says goes to shared "strip.drop".
  dragMove(e, pane) {
    const width = e.bounds?.width || this.width || 0;
    if (width) this.width = width;
    const d = shared("strip.drag");
    if (!d || d.pane === pane || !width) return;
    const x = e.local_position.x;
    const side = x < width / 4 ? "before" : x > width * 3 / 4 ? "after" : "above";
    const cur = shared("strip.drop");
    if (cur?.to !== pane || cur.side !== side) setShared("strip.drop", { to: pane, side });
  }

  button(t, id, icon, command, args) {
    return div().id(id).p(5).rounded(6).text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (typeof command === "function") command();
        else this.act(command, args);
      })
      .child(svg(`mods/kanso-chrome/icons/${icon}.svg`).size(15));
  }

  renderHead() {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = p.mod === "sdd-focused" ? "Spec" : nameOf(p, givenNames());
    const pic = programIcon(p.program, 15, t.muted);
    const st = p.status;
    const pane = p.pane;
    // No rule under it: the header is part of the pane. The selected pane's
    // header is a shade lighter and its title in full ink; in the strip that
    // is the pane the strip remembers, so it stays marked while a side panel
    // has the keyboard. A pane whose agent needs you can't be missed: its
    // header is tinted in the alarm color over a breathing bar of it.
    const strip = Boolean(props()?.strip);
    const remembered = strip ? shared(KEY)?.[p.tab]?.focus : null;
    const on = remembered ? remembered === pane : p.focused || (strip && p.terminal && focused()?.terminal === p.terminal);
    // A held pane: this header is the top of a drop card (see dragMove).
    const drag = strip ? shared("strip.drag") : null;
    const drop = drag && drag.pane !== pane ? shared("strip.drop") : null;
    const side = drop?.to === pane ? drop.side : null;
    const ink = on || st === "blocked"; // full ink: the selected pane, and one that needs you
    // A pinned pane stays on its side of the view: a pin by its title says so.
    const pinned = strip && Boolean(shared(KEY)?.[p.tab]?.cols?.find((c) => c.panes?.includes(pane))?.pin);
    const pin = () => setShared("strip.req", { op: "pin", pane, n: nonce() });
    return h_flex().id(`pane-head-${pane}`).size_full().pl(14).pr(6).gap(10).items_center().text_size(12.5).relative()
      // The pane is a rounded slab; the header's wash follows its top corners.
      .rounded_t(RADIUS)
      // Pinned: the accent's tint, a little stronger when it's also the selected one.
      .when(pinned && st !== "blocked", (el) => el.bg(t.accent + (on ? "40" : "24")))
      .when(st === "blocked", (el) => el.bg(t.blocked + "66")
        .child(div().absolute().left_0().bottom_0().w_full().h(2).bg(t.blocked).loop("opacity", { from: 0.45, to: 1, period: 1600 })))
      .when(on && !pinned && st !== "blocked", (el) => el.bg(t.selected))
      // Where the held pane lands lights up in the accent, header and card as
      // one: the left or right half for a column before or after, the whole
      // header (the top of the pane) for above.
      .when(Boolean(side), (el) => el.child(h_flex().absolute().inset_0().rounded_t(RADIUS)
        .child(div().flex_1().h_full().when(side === "before" || side === "above", (d) => d.bg(t.accent + "40").rounded_tl(RADIUS).when(side === "above", (d) => d.rounded_tr(RADIUS))))
        .child(div().flex_1().h_full().when(side === "after" || side === "above", (d) => d.bg(t.accent + "40").rounded_tr(RADIUS)))))
      .when(Boolean(drag) && drag.pane === pane, (el) => el.opacity(0.4))
      .when(Boolean(drag), (el) => el.cursor_grabbing())
      .on_hover((hovered, cx) => {
        this.hovered = hovered;
        if (!hovered && shared("strip.drop")?.to === pane && shared("strip.drop")?.side !== "below") setShared("strip.drop", null);
        cx.notify();
      })
      .on_size_change((sz) => { this.width = sz.width; })
      .on_mouse_down("left", (e) => {
        // A double-click renames the terminal; in the strip, Ctrl+press holds the pane.
        if (e.click_count === 2 && p.terminal) { this.rename(p, name); return; }
        if (!strip) return;
        if (e.modifiers.control && !pinned) setShared("strip.drag", { pane, at: Date.now() });
        else if (shared("strip.drag")) endDrag(); // a drag let go elsewhere
      })
      .when(strip, (el) => el
        .on_scroll_wheel((e) => this.wheelReq(e))
        .on_mouse_move((e) => this.dragMove(e, pane))
        .on_mouse_up("left", () => {
          const d = shared("strip.drag");
          if (!d) return;
          if (d.pane !== pane) setShared("strip.req", { op: "move", pane: d.pane, to: pane, side: side ?? "above", n: nonce() });
          endDrag();
        }))
      .on_click(() => run("pane.focus", strip && p.terminal ? { terminal: p.terminal } : { pane }))
      .when(Boolean(pic), (el) => el.child(pic.opacity(ink ? 1 : 0.75)))
      .child(div().flex_none().truncate().max_w(260).text_size(12.5).when(ink, (el) => el.font_medium()).text_color(ink ? t.foreground : t.muted).child(name))
      .when(Boolean(p.cwd), (el) => el.child(this.badge(t, folder(p.cwd), null, ink)))
      .when(Boolean(p.branch), (el) => el.child(this.badge(t, p.branch, "mods/kanso-chrome/icons/branch.svg", ink)))
      .when(pinned && !this.hovered, (el) => el.child(svg("mods/kanso-chrome/icons/pin.svg").size(12).flex_none().text_color(t.dim)))
      .child(div().flex_1())
      .when(st === "working" && !this.hovered, (el) => el.child(h_flex().w(12).h(12).flex_none().items_center().justify_center().text_size(10).text_color(t.working).child(div().frames(["·", "•", "●", "•"], 450))))
      .when(st === "blocked", (el) => el.child(h_flex().flex_none().gap(6).items_center().text_size(11.5).font_medium().text_color(t.foreground)
        .child(div().size(7).rounded_full().bg(t.blocked).loop("opacity", { from: 0.45, to: 1, period: 1600 })).child("Needs you")))
      .when(st === "done" && !this.hovered, (el) => el.child(div().size(6).flex_none().rounded_full().bg(t.done)))
      .when(this.hovered && !drag, (el) => el
        .when(strip, (el) => el.child(this.button(t, `ph-p-${pane}`, "pin", pin).when(pinned, (b) => b.text_color(t.foreground))))
        .when(Boolean(p.cwd), (el) => el.child(this.button(t, `ph-o-${pane}`, "open-with", () => this.openWith(p))))
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })))
      .when(strip && !pinned, (el) => el.child(this.grip(t, pane)));
  }

  // ---- The model ---------------------------------------------------------------

  tab() {
    const space = spaces().find((s) => s.active);
    return space?.tabs?.find((t) => t.active)?.id ?? null;
  }

  focusPane(ps) {
    const f = focused();
    if (!f) return null;
    if (f.pane && ps.some((p) => p.pane === f.pane)) return f.pane;
    return ps.find((p) => p.terminal && p.terminal === f.terminal)?.pane ?? null;
  }

  where(st, id) {
    for (let ci = 0; ci < st.cols.length; ci++) {
      const ri = st.cols[ci].panes.indexOf(id);
      if (ri >= 0) return { ci, ri };
    }
    return null;
  }

  // Positions on the sliding row count only columns that aren't pinned; the
  // sliding view is what the pinned ones leave of the screen.
  start(st, ci) { let s = 0; for (let i = 0; i < ci; i++) if (!st.cols[i].pin) s += st.cols[i].w; return s; }
  total(st) { return st.cols.reduce((s, c) => s + (c.pin ? 0 : c.w), 0); }
  // Columns are kept in screen order: pinned left, the sliding row, pinned
  // right. A split or move that crosses a group lands at its edge.
  order(st) {
    const rank = (c) => (c.pin === "left" ? 0 : c.pin === "right" ? 2 : 1);
    st.cols = st.cols.map((c, i) => [c, i]).sort((a, b) => rank(a[0]) - rank(b[0]) || a[1] - b[1]).map(([c]) => c);
  }
  // The sliding row: the unpinned columns with where they start and end.
  row(st) {
    const out = []; let x = 0;
    st.cols.forEach((c, ci) => { if (!c.pin) { out.push({ ci, s: x, e: x + c.w }); x += c.w; } });
    return out;
  }
  pinnedW(st) { return st.cols.reduce((s, c) => s + (c.pin ? c.w : 0), 0); }
  viewW(st) { return Math.max(MIN_VIEW, 1 - this.pinnedW(st)); }

  sync(tab, ps) {
    const st = this.state[tab] ?? { cols: [], vx: 0, n: shared("strip.n") ?? DEFAULT_N };
    if (st.vx === undefined) st.vx = 0;
    if (!st.n) st.n = shared("strip.n") ?? DEFAULT_N;
    const ids = new Set(ps.map((p) => p.pane));
    st.cols = st.cols.map((c) => ({ ...c, panes: c.panes.filter((id) => ids.has(id)) })).filter((c) => c.panes.length);
    for (const c of st.cols) if (c.hs) c.hs = Object.fromEntries(c.panes.filter((id) => id in c.hs).map((id) => [id, c.hs[id]]));
    const known = new Set(st.cols.flatMap((c) => c.panes));
    const fresh = ps.filter((p) => !known.has(p.pane));
    if (fresh.length && !st.cols.length) {
      // First sight of this tab: a lone pane fills the view; more sit side by side.
      for (const p of fresh) st.cols.push({ panes: [p.pane], w: fresh.length === 1 ? 1 : newW(st) });
    } else {
      for (const p of fresh) { this.place(st, p.pane); st.focus = p.pane; this.pendingFocus = p.terminal; this.reveal(st, p.pane); }
    }
    this.order(st);
    this.state[tab] = st;
    return st;
  }

  place(st, id) {
    const intent = shared("strip.intent");
    const usable = intent && intent.at !== this.usedIntent && Date.now() - intent.at < 5000;
    if (usable) this.usedIntent = intent.at;
    const dir = usable ? intent.dir : "right";
    const at = this.where(st, usable ? intent.from : st.focus) ?? { ci: st.cols.length - 1, ri: 0 };
    // Down or up: stacked in the same column, under or over the pane it came from.
    if (dir === "down" || dir === "up") st.cols[at.ci].panes.splice(dir === "down" ? at.ri + 1 : at.ri, 0, id);
    else st.cols.splice(dir === "left" ? at.ci : at.ci + 1, 0, { panes: [id], w: newW(st) });
  }

  // The view starts where a column starts: the last start at or before vx,
  // and never past the first start from which the rest of the row fits.
  clampView(st) {
    const row = this.row(st);
    let at = 0;
    for (const r of row) if (r.s <= Math.min(st.vx ?? 0, this.lastStart(st)) + EPS) at = r.s;
    st.vx = at;
    delete st.tx;
  }
  lastStart(st) {
    const row = this.row(st), vw = this.viewW(st), total = this.total(st);
    return row.find((r) => total - r.s <= vw + EPS)?.s ?? 0;
  }


  // Slides the view the least that shows a pane whole (niri's "never center").
  // Slides the view the least that shows a pane whole (niri's "never center"),
  // to a column's start.
  reveal(st, id) {
    const at = this.where(st, id);
    if (!at || st.cols[at.ci].pin) return; // a pinned pane is always in view
    const row = this.row(st), vw = this.viewW(st);
    const me = row.find((r) => r.ci === at.ci);
    if (!me) return;
    const was = st.vx;
    if (me.s < st.vx - EPS) st.vx = me.s;
    else if (me.e > st.vx + vw + EPS) st.vx = (row.find((r) => me.e - r.s <= vw + EPS) ?? me).s;
    if (st.vx !== was) this.dirty = true;
    this.clampView(st);
  }


  // ---- Actions -----------------------------------------------------------------

  command(name) {
    const tab = this.tab();
    const st = tab && this.state[tab];
    if (!st) return;
    const ps = panes().filter((p) => p.tab === tab);
    const id = this.focusPane(ps) ?? (ps.some((p) => p.pane === st.focus) ? st.focus : null) ?? st.cols[0]?.panes[0] ?? null;
    const at = id && this.where(st, id);
    const go = (ci, ri) => {
      const col = st.cols[ci];
      if (!col) return;
      this.focusOn(st, col.panes[clamp(ri ?? 0, 0, col.panes.length - 1)], ps);
    };
    const split = (dir) => {
      if (!id) return;
      setShared("strip.intent", { dir, from: id, at: Date.now() });
      run("pane.split", { pane: id, direction: dir === "down" || dir === "up" ? "down" : "right" });
    };
    switch (name) {
      case "go-left": if (at) go(at.ci - 1, at.ri); break;
      case "go-right": if (at) go(at.ci + 1, at.ri); break;
      case "go-up": if (at && at.ri > 0) go(at.ci, at.ri - 1); break;
      case "go-down": if (at && at.ri < st.cols[at.ci].panes.length - 1) go(at.ci, at.ri + 1); break;
      case "new-down": split("down"); break;
      case "new-up": split("up"); break;
      case "move-left": case "move-right":
        if (at) {
          const to = at.ci + (name === "move-left" ? -1 : 1);
          if (to >= 0 && to < st.cols.length && !st.cols[at.ci].pin && !st.cols[to].pin) { [st.cols[at.ci], st.cols[to]] = [st.cols[to], st.cols[at.ci]]; this.reveal(st, id); }
        }
        break;
      case "new-right": split("right"); break;
      case "new-left": split("left"); break;
      case "close": if (id) run("pane.close", { pane: id }); break;
      case "width": if (at) { st.cols[at.ci].w = step(W_STEPS, st.cols[at.ci].w); this.reveal(st, id); } break;
      case "scroll-left": this.step(st, -1); break;
      case "scroll-right": this.step(st, 1); break;
      case "center": if (id) this.reveal(st, id); break;
      case "pin": if (id) this.pin(st, id); break;
      case "fit": this.fit(st, id); break;
      case "more": this.setN(st, (st.n ?? DEFAULT_N) + 1, id); break;
      case "fewer": this.setN(st, (st.n ?? DEFAULT_N) - 1, id); break;
      case "first": go(0); break;
      case "last": go(st.cols.length - 1); break;
      default: {
        const n = /^col-(\d)$/.exec(name);
        if (n) go(Number(n[1]) - 1);
        const per = /^per-(\d)$/.exec(name);
        if (per) this.setN(st, Number(per[1]), id);
      }
    }
  }

  // Choose how many panes fit in the view; every column becomes 1/n wide.
  setN(st, n, keep) {
    st.n = clamp(Math.round(n), 1, N_MAX);
    setShared("strip.n", st.n);
    for (const c of st.cols) { if (!c.pin) c.w = 1 / st.n; delete c.hs; } // a pinned pane keeps its width
    this.clampView(st);
    if (keep) this.reveal(st, keep);
  }

  // Even out the columns to the current count without changing it.
  fit(st, keep) { this.setN(st, st.n ?? DEFAULT_N, keep); }

  // ---- Resizing: Herdr's own dividers --------------------------------------------
  // The boundaries between columns and between stacked panes are Herdr's
  // (`resizable`). A drag leaves a px size on the node it moved; once the
  // sizes have stayed put for SETTLE ms, this reads them back and turns them
  // into shares, so the next tree the strip writes keeps what you dragged.
  sizesOf(nodes) {
    const sig = {};
    for (const n of nodes) {
      if (!this.isCol(n)) continue;
      sig[n.id] = n.size ?? null;
      if (String(n.id).startsWith("strip-col-")) for (const c of n.children ?? []) sig[c.id] = c.size ?? null;
    }
    return sig;
  }
  isCol(n) { const id = String(n.id); return id.startsWith("strip-") && !id.startsWith("strip-edge") && !id.startsWith("strip-ruler"); }

  adopt() {
    const tab = this.tab(), st = tab && this.state[tab];
    if (!st || !this.appliedSizes) return false;
    const body = find(layout(), "work-body");
    if (!body?.children) return false;
    const text = JSON.stringify(this.sizesOf(body.children));
    if (text === this.appliedSizes) { this.drift = null; return false; }
    const now = Date.now();
    if (this.drift?.text !== text) { this.drift = { text, at: now }; return false; }
    if (now - this.drift.at < SETTLE) return false;
    const colNodes = body.children.filter((n) => this.isCol(n));
    const inTree = st.cols.filter((c) => colNodes.some((n) => n.id === nodeId(c)));
    // Widths come from the panes' rulers; the strip's height from its own.
    const px = shared(PX) ?? {};
    const width = (c) => px[c.panes[0]] ?? 0;
    const H = px.h;
    if (!H || inTree.some((c) => !width(c))) return false;
    const span = inTree.reduce((s, c) => s + width(c), 0) || 1;
    const sumW = inTree.reduce((s, c) => s + c.w, 0);
    // What each stacked pane measures: px ones take theirs, the rest share
    // what is left by weight.
    const pxOf = (nodes, total, gap) => {
      const fixed = nodes.reduce((s, n) => s + (n.size?.px ?? 0), 0) + gap * (nodes.length - 1);
      const wsum = nodes.reduce((s, n) => s + (n.size?.px ? 0 : (n.size?.weight ?? 1)), 0) || 1;
      const free = Math.max(0, total - fixed);
      return new Map(nodes.map((n) => [n.id, n.size?.px ?? free * (n.size?.weight ?? 1) / wsum]));
    };
    let changed = false;
    for (const c of inTree) {
      const n = colNodes.find((k) => k.id === nodeId(c));
      const w = clamp(width(c) / span * sumW, MIN_W, 1);
      if (Math.abs(w - c.w) > EPS) { c.w = w; changed = true; }
      if (c.panes.length > 1 && n.children) {
        const hs = pxOf(n.children, H, GAP);
        const tot = c.panes.reduce((s, id) => s + (hs.get(`strip-${id}`) ?? 0), 0) || 1;
        const next = Object.fromEntries(c.panes.map((id) => [id, (hs.get(`strip-${id}`) ?? 0) / tot]));
        if (JSON.stringify(next) !== JSON.stringify(c.hs ?? null)) { c.hs = next; changed = true; }
      }
    }
    this.drift = null;
    if (changed) this.clampView(st);
    // Write the tree again either way: weights in place of the px the drag
    // left, so the row keeps filling the view when the window changes.
    this.applied = null;
    return true;
  }

  // Wheel travel adds up; a quarter of the view moves the view one column.
  slide(st, d) {
    st.acc = (st.acc ?? 0) + d;
    if (Math.abs(st.acc) < WHEEL_STEP) return;
    const dir = st.acc > 0 ? 1 : -1;
    st.acc = 0;
    this.step(st, dir);
  }

  // Moves the view one column; the focus follows if its pane left the view,
  // to the nearest pane still in view.
  step(st, dir) {
    const row = this.row(st);
    if (!row.length) return;
    let k = row.findIndex((r) => Math.abs(r.s - st.vx) < EPS);
    if (k < 0) k = 0;
    k = clamp(k + dir, 0, row.length - 1);
    const to = Math.min(row[k].s, this.lastStart(st));
    if (Math.abs(to - st.vx) < EPS) return;
    st.vx = to;
    this.dirty = true;
    this.slidAt = Date.now();
    const shown = new Set(this.shownCols(st));
    const at = this.where(st, st.focus);
    if (at && (st.cols[at.ci].pin || shown.has(at.ci))) return;
    let best = null;
    for (const ci of shown) if (best === null || Math.abs(ci - (at?.ci ?? 0)) < Math.abs(best - (at?.ci ?? 0))) best = ci;
    if (best === null) return;
    const id = st.cols[best].panes[0];
    const p = panes().find((q) => q.pane === id);
    st.focus = id; st.lastSeen = id;
    if (p?.terminal) this.pendingFocus = p.terminal;
  }

  // Which columns (indices) the view shows whole from vx: as many as fit, and
  // always the first.
  shownCols(st) {
    const row = this.row(st), vw = this.viewW(st);
    let k = row.findIndex((r) => Math.abs(r.s - st.vx) < EPS);
    if (k < 0) k = 0;
    const out = []; let used = 0;
    for (let i = k; i < row.length; i++) {
      const c = st.cols[row[i].ci];
      if (out.length && used + c.w > vw + EPS) break;
      out.push(row[i].ci); used += c.w;
    }
    return out;
  }


  // The strip shows terminals as layout blocks, never the tab's own panes.
  // Herdr's focus, though, lands on a tab's pane whenever you come to the tab
  // (another space or tab, a layout switch, a restart), and that pane isn't
  // on screen: the keyboard would go nowhere until you clicked. So whenever a
  // tab's pane holds the focus, the strip hands it to a block: the pane you
  // had selected in this tab, or the one something chose meanwhile (an agent
  // notification, closing the selected pane).
  keepKeyboard(tab, st, ps) {
    const entered = tab !== this.lastTab;
    this.lastTab = tab;
    const f = focused();
    const p = f?.pane && ps.find((q) => q.pane === f.pane);
    if (!p?.terminal) return;
    // Herdr's own focus doesn't follow the blocks, so it only moves when
    // something chose a pane: then that pane is the choice. Otherwise only
    // coming to the tab counts, so a side panel you click keeps the keyboard.
    const moved = st.model != null && f.pane !== st.model;
    st.model = f.pane;
    if (!entered && !moved) return;
    const id = !moved && ps.some((q) => q.pane === st.focus) ? st.focus : f.pane;
    st.lastSeen = id; // not a new choice: nothing to slide for
    this.focusOn(st, id, ps);
  }

  // Pins the pane's column to the side of the view it is on now, or lets a
  // pinned one slide again. A pin that would leave less than MIN_VIEW to
  // slide is refused.
  pin(st, id) {
    const at = this.where(st, id);
    if (!at) return;
    const c = st.cols[at.ci];
    if (c.pin) { delete c.pin; this.reveal(st, id); this.dirty = true; return; }
    if (1 - this.pinnedW(st) - c.w < MIN_VIEW) return;
    const left = this.start(st, at.ci) + c.w / 2 - st.vx < this.viewW(st) / 2;
    c.pin = left ? "left" : "right";
    this.order(st);
    this.clampView(st);
    this.dirty = true;
  }

  focusOn(st, id, ps) {
    const p = ps.find((q) => q.pane === id);
    if (!p) return;
    st.focus = id;
    this.reveal(st, id);
    this.pendingFocus = p.terminal;
  }

  request(st, ps) {
    const req = shared("strip.req");
    if (!req || req.n === this.lastReq) return;
    this.lastReq = req.n;
    if (req.op === "scroll") this.slide(st, req.d);
    else if (req.op === "focus") this.focusOn(st, req.pane, ps);
    else if (req.op === "width") {
      const at = this.where(st, req.pane);
      if (at) { st.cols[at.ci].w = step(W_STEPS, st.cols[at.ci].w); this.reveal(st, req.pane); }
    }
    else if (req.op === "per") this.setN(st, req.n, st.focus);
    else if (req.op === "pin") this.pin(st, req.pane);
    else if (req.op === "move") {
      this.move(st, req.pane, req.to, req.side);
      this.focusOn(st, req.pane, ps);
    }
  }

  // A pane dragged onto another lands as its own column before or after
  // that one's column (`side`); without a side, on the side it came from.
  // Panes never move vertically: one dragged out of a stack leaves it.
  // side: "before" or "after" puts the pane in a column of its own beside the
  // target's column; "above" or "below" stacks it with the target pane, in
  // its column (any number can stack; the layout's 90px minimum is the limit).
  move(st, id, to, side) {
    const from = this.where(st, id), target = this.where(st, to);
    if (!from || !target || id === to) return;
    const into = side === "above" || side === "below";
    if (!into && from.ci === target.ci && st.cols[from.ci].panes.length === 1) return;
    // A pinned pane never changes place, and nothing lands among the pinned
    // (stacking under a pinned pane is fine: the column keeps its place).
    if (st.cols[from.ci].pin || (st.cols[target.ci].pin && !into)) return;
    const col = st.cols[from.ci];
    const after = side ? side === "after" : from.ci < target.ci;
    col.panes.splice(from.ri, 1);
    if (!col.panes.length) st.cols.splice(from.ci, 1);
    const t = this.where(st, to);
    if (into) { const c = st.cols[t.ci]; c.panes.splice(side === "above" ? t.ri : t.ri + 1, 0, id); if (c.hs) delete c.hs; }
    else st.cols.splice(after ? t.ci + 1 : t.ci, 0, { panes: [id], w: col.w });
    this.order(st);
    this.clampView(st);
  }

  // ---- The tree ----------------------------------------------------------------

  // `sorting`: a pane is held, so each pane's terminal gives its place to a
  // drop card (the terminal stays alive; the tree only stops showing it).
  build(st, ps, sorting = false) {
    const byId = new Map(ps.map((p) => [p.pane, p]));
    const weight = (f) => Math.max(1, Math.round(f * 1000));
    const header = (id) => ({ id: `head-${id}`, type: "block", size: { px: HEADER_H }, content: { mod: "kanso-strip", props: { pane: id, terminal: byId.get(id).terminal, strip: true } } });
    const body = (id) => ({ id: `term-${id}`, type: "block", content: sorting ? { mod: "kanso-strip", props: { drop: id } } : { terminal: byId.get(id).terminal } });
    // A pane's ruler is also its foot: a terminal paints square corners, so
    // the foot, RADIUS tall, draws the slab's rounded bottom over the frame.
    const ruler = (what) => { const px = what === "h" ? 1 : RADIUS; return { id: `strip-ruler-${what}`, type: "block", size: { px }, min: px, max: px, background: "chrome",
      content: { mod: "kanso-strip", props: { ruler: what } } }; };
    const live = (id, size, min) => ({ id: `strip-${id}`, type: "column", size, min, background: "background", radius: RADIUS,
      children: [header(id), body(id), ruler(id)] });
    // One pane: the cell is the column. Stacked: the panes share the height
    // (`hs`, equal until a divider is dragged).
    const share = (c, id) => (c.hs?.[id] ?? 1) / c.panes.reduce((s, k) => s + (c.hs?.[k] ?? 1), 0);
    const whole = (c) => c.panes.length === 1 ? live(c.panes[0], { weight: weight(c.w) }, COL_MIN)
      : { id: `strip-col-${c.panes[0]}`, type: "column", gap: GAP, background: "chrome", min: COL_MIN, size: { weight: weight(c.w) },
        children: c.panes.map((id) => live(id, { weight: weight(share(c, id)) }, ROW_MIN)) };
    // The edge tab knows the nearest column beyond it (what a click brings in)
    // and every pane beyond, in row order, for its tiles and its card.
    const edge = (ci, side, beyond) => ({ id: `strip-edge-${side}`, type: "block", size: { px: EDGE_W }, min: EDGE_W, max: EDGE_W,
      content: { mod: "kanso-strip", props: { edge: st.cols[ci].panes[0], side, count: beyond.length, panes: beyond.flatMap((r) => st.cols[r.ci].panes) } } });
    const row = this.row(st), shown = this.shownCols(st);
    this.shown = new Set(shown);
    const k = row.findIndex((r) => r.ci === shown[0]);
    const after = k + shown.length;
    const out = shown.map((ci) => whole(st.cols[ci]));
    if (k > 0) out.unshift(edge(row[k - 1].ci, "left", row.slice(0, k)));
    if (after < row.length) out.push(edge(row[after].ci, "right", row.slice(after)));
    // Pinned columns stay at their side, in their order, always whole.
    const pinned = (side) => st.cols.filter((c) => c.pin === side).map(whole);
    // The height ruler stands at the end, 1px wide.
    return [...pinned("left"), ...out, ...pinned("right"), ruler("h")];
  }


  apply(nodes) {
    const text = JSON.stringify(nodes);
    if (text === this.applied) return false;
    const tree = layout();
    const body = find(tree, "work-body");
    if (!body?.children) return false;
    const mine = (n) => n.id === "main" || String(n.id).startsWith("strip-");
    if (nodes.length === 1 && nodes[0] === TAB_BLOCK && body.children.filter(mine).length === 1 && body.children.find(mine)?.content?.tab) { this.applied = text; return false; }
    const now = Date.now();
    // Coalesce: at most one write every 50 ms; the 60 ms timer sends the rest.
    if (now - (this.sets.at(-1) ?? 0) < 50) { this.dirty = true; return false; }
    this.sets = this.sets.filter((t) => now - t < 3000);
    if (this.sets.length >= 60) { this.halted = now; return false; } // 20 writes a second for 3 s: something is wrong
    this.sets.push(now);
    const at = body.children.findIndex(mine);
    const rest = body.children.filter((n) => !mine(n));
    body.children = [...rest.slice(0, Math.max(0, at)), ...nodes, ...rest.slice(Math.max(0, at))];
    this.applied = text;
    this.appliedSizes = JSON.stringify(this.sizesOf(nodes));
    try { run("layout.set", { layout: tree }); } catch { this.halted = now; return false; }
    return true;
  }

  save() {
    const tabs = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
    for (const id of Object.keys(this.state)) if (!tabs.has(id)) delete this.state[id];
    const text = JSON.stringify(this.state);
    if (text !== this.saved) { this.saved = text; setShared(KEY, JSON.parse(text)); }
    // Measurements of panes that are gone go too.
    const px = shared(PX);
    if (px && Date.now() - (this.prunedAt ?? 0) > 10000) {
      this.prunedAt = Date.now();
      const live = new Set(panes().map((p) => p.pane));
      const kept = Object.fromEntries(Object.entries(px).filter(([k]) => k === "h" || live.has(k)));
      if (Object.keys(kept).length !== Object.keys(px).length) setShared(PX, kept);
    }
  }

  // ---- Drawing -----------------------------------------------------------------

  wheel(ev, st) {
    const lines = ev.delta_lines?.y ?? 0;
    const d = lines ? -lines * 40 : (Math.abs(ev.delta.x) > Math.abs(ev.delta.y) ? -ev.delta.x : -ev.delta.y);
    this.slide(st, d / WHEEL_PX);
  }

  render() {
    if (this.kind === "edge") return this.renderEdge();
    if (this.kind === "ruler") return this.renderRuler();
    if (this.kind === "drop") return this.renderDrop();
    if (this.kind === "head") return this.renderHead();
    const t = theme();
    if (this.halted && Date.now() - this.halted > 10000) { this.halted = 0; this.sets = []; this.applied = null; }
    if (this.halted) return h_flex().size_full().justify_center().items_center().text_size(11).text_color(t.blocked).child("Strip paused");

    const tab = this.tab();
    const ps = tab ? panes().filter((p) => p.tab === tab) : [];
    const usable = ps.length > 0 && ps.every((p) => p.terminal);
    if (!usable) { this.apply([TAB_BLOCK]); this.save(); return div(); }

    // Every shared write anywhere redraws this view. The model only moves
    // on what this key names (and on `seq`: commands, adopted drags, the
    // wheel): with the key unchanged, only the minimap is drawn again.
    const f = focused(), drag = shared("strip.drag");
    const key = [tab, ps.map((p) => `${p.pane}:${p.terminal}`).join(","), f?.pane ?? "", f?.terminal ?? "", drag?.pane ?? "",
      shared("strip.req")?.n ?? "", shared("strip.intent")?.at ?? "", this.seq].join("|");
    let st = this.state[tab];
    if (key !== this.lastKey || this.pendingFocus || !st) {
      this.lastKey = key;
      st = this.sync(tab, ps);
      this.request(st, ps);
      this.keepKeyboard(tab, st, ps);
      const now = this.focusPane(ps);
      // A focus change right after a slide is the slide's own doing: don't
      // slide back to it.
      if (now && now !== st.lastSeen) {
        st.lastSeen = now;
        if (Date.now() - (this.slidAt ?? 0) > 600) { st.focus = now; this.reveal(st, now); }
      }
      this.clampView(st);
      // Sorting while one of this tab's panes is held; when it ends, the
      // keyboard goes back to the pane that had it (its terminal was away).
      const sorting = Boolean(drag) && ps.some((p) => p.pane === drag.pane);
      if (this.sorting && !sorting) { if (shared("strip.drop")) setShared("strip.drop", null); this.focusOn(st, st.focus, ps); }
      this.sorting = sorting;
      this.apply(this.build(st, ps, sorting));
      this.save();

      if (this.pendingFocus) {
        const shownNow = JSON.stringify(find(layout(), "work-body") ?? {}).includes(`"terminal":"${this.pendingFocus}"`);
        if (shownNow) { run("pane.focus", { terminal: this.pendingFocus }); this.pendingFocus = null; }
      }
    }

    // Minimap: one soft pill per column, as wide as its share of the view, no
    // frame. In view `muted`, off-screen `input`, the focused one
    // `foreground`. Click a pill to go there; scroll to slide.
    const at = this.where(st, st.focus);
    const pills = st.cols.map((c, i) => {
      const tone = at?.ci === i ? t.foreground : c.pin || this.shown?.has(i) ? t.muted : t.input;
      // A stacked column shows one thin bar per pane.
      const w = Math.round(6 + c.w * 18), k = c.panes.length;
      return v_flex().id(`strip-mark-${i}`).h(14).px(1).gap(1).flex_none().justify_center().cursor_pointer()
        .on_click(() => { this.focusOn(st, c.panes[0], ps); this.dirty = true; })
        .children(c.panes.map((id, r) => div().id(`strip-cell-${id}`).w(w).h(k > 1 ? 2 : 4).rounded_full()
          .bg(at?.ci === i && at?.ri !== r ? t.muted : tone)));
    });
    const n = st.n ?? DEFAULT_N;
    const tiny = (id, label, tip, action) => div().id(id).size(16).flex_none().flex().items_center().justify_center().rounded(6)
      .text_size(11).text_color(t.dim).cursor_pointer().tooltip(tip)
      .hover((h) => h.bg(t.foreground + "12").text_color(t.foreground))
      .on_click(() => { action(); this.dirty = true; })
      .child(label);
    return h_flex().id("strip-map").size_full().gap(3).justify_center().items_center()
      .on_mouse_up("left", () => { if (shared("strip.drag")) endDrag(); }) // a held pane let go here goes back
      .tooltip("⌘1-9 go to · ⌘[ ⌘] previous, next · ⌘D new · ⌘W close · ⌘⇧[ ⌘⇧] move · ⌘⇧- ⌘⇧= panes per view")
      .on_scroll_wheel((ev) => this.wheel(ev, st))
      .children(pills)
      .child(div().w(8))
      .child(tiny("strip-fewer", "\u2212", "Fewer panes per view", () => this.setN(st, n - 1, st.focus)))
      .child(div().id("strip-n").text_size(11).text_color(t.muted).tooltip(`${n} per view · click to even out`).cursor_pointer()
        .on_click(() => { this.fit(st, st.focus); this.dirty = true; }).child(String(n)))
      .child(tiny("strip-more", "+", "More panes per view", () => this.setN(st, n + 1, st.focus)));
  }
}
