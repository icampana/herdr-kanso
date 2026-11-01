// Kanso strip, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// An endless canvas of panes, as in Omarchy's scrolling layout or niri. Panes
// sit side by side in columns, each with its own width; the view is a window
// onto that row that slides continuously. A new pane opens beside the focused
// one without shrinking anything, and the view slides just enough to show it,
// so its neighbour is left peeking in at the edge.
//
// How: in the "work-body" row, the layout's "main" node is replaced with what
// the view covers. A column fully in view is a header block (kanso-pane) over
// a live `{terminal}` block. A column cut by the edge of the view is a "peek":
// a copy of this mod showing that terminal's screen as text, clipped at the
// edge and dimmed (Herdr can't clip a live terminal; a terminal block always
// fills its block). Click a peek to slide to it. Off-screen columns aren't in
// the tree at all. Weights are the visible share of the view, so while the
// view slides only the peeks change size; live terminals keep their width.
//
// Herdr rules that shape the tree: a layout nests at most 16 levels (columns
// sit directly in work-body), and Herdr folds empty containers and
// single-child ones (free space is a filler block, never an empty column).
//
// Copies, chosen by props: none = the controller and minimap (status bar),
// {filler: true} = free space, {peek: pane, terminal, side} = a peek.
//
// State per tab in shared "strip.state": { cols: [{ panes, w, pin }], vx }
//   w: column width as a share of the view; vx: the view's left edge on the
//   row, in view widths. pin: "left" or "right" for a pinned column, which
//   stays on that side of the view, always whole, while the rest slides in
//   the space left between the pinned ones. A column may stack panes (split down): they share
//   its height equally and never move vertically; drag moves a pane sideways.
// Headers and peeks talk to the controller through shared "strip.req"
// (scroll, focus, move, width) and "strip.intent" (where the next pane goes).

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, layout, run, shared, setShared, theme, nextCommand, props, hc, settings } from "herdr";

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
const MIN_PEEK = 0.02; // narrower slivers are left out
const MIN_VIEW = 0.2; // pinned columns always leave this much of the view to slide

const TAB_BLOCK = {
  id: "main", type: "block", background: "border",
  content: { tab: "active", pane: {
    header: { content: { mod: "kanso-pane" }, reveal: "always", height: HEADER_H, position: "top" },
    background: "background", border: { width: 0, color: "border" }, focus: { width: 0, color: "border" },
    radius: 0, gap: 1, lone: false } },
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

// While a header grip is held (shared "strip.resize"), any strip surface
// under the pointer forwards its moves, so the drag survives crossing a peek
// or free space. Terminal text never reports the pointer; stay on the headers.
function forwardResize(e) {
  const r = shared("strip.resize");
  if (!r || !r.w || !r.px) return;
  const dx = e.position.x - r.x;
  if (Math.abs(dx) < 2) return;
  setShared("strip.resize", { ...r, x: e.position.x });
  setShared("strip.req", { op: "resize", pane: r.pane, d: dx / (r.px / r.w), n: nonce() });
}
const endResize = () => { if (shared("strip.resize")) setShared("strip.resize", null); };

export default class Strip extends View {
  init(_props, cx) {
    const p = props() ?? {};
    this.kind = p.filler ? "filler" : p.peek ? "peek" : "controller";
    if (this.kind === "filler") return;
    if (this.kind === "peek") return this.initPeek(cx);

    this.state = JSON.parse(JSON.stringify(shared(KEY) ?? {}));
    this.saved = JSON.stringify(this.state);
    this.lastReq = shared("strip.req")?.n ?? null;
    this.usedIntent = shared("strip.intent")?.at ?? null;
    this.pendingFocus = null;
    this.sets = [];
    // Scrolling writes the layout at most every 60 ms, however fast the wheel.
    cx.timer.every(60, (cx) => {
      // Ease the view toward where reveal wants it: a short glide, not a jump.
      const st = this.state[this.tab()];
      if (st && st.tx !== undefined && Math.abs(st.tx - st.vx) > 0.002) {
        const d = st.tx - st.vx;
        st.vx = Math.abs(d) < 0.01 ? st.tx : st.vx + d * 0.5;
        this.dirty = true;
      }
      if (this.dirty) { this.dirty = false; cx.notify(); }
    });
    cx.spawn(async (cx) => {
      for (;;) {
        let c;
        try { c = await nextCommand(); } catch { break; }
        this.command(String(c).replace(/^kanso-strip\./, ""));
        cx.notify();
      }
    });
  }

  // ---- Peek: a neighbour's screen as text, clipped at the view's edge --------------

  initPeek(cx) {
    this.lines = [];
    const read = (cx) => cx.spawn(async (cx) => {
      try {
        const r = await hc(["read", props().terminal]);
        if (r.code === 0) { this.lines = r.stdout.replace(/\x1b\[[0-9;?]*[A-Za-z]/g, "").split("\n").slice(-200); cx.notify(); }
      } catch {}
    });
    read(cx);
    cx.timer.every(3000, (cx) => read(cx));
  }

  renderPeek() {
    const t = theme(), p = props(), s = settings() ?? {};
    const geo = shared("strip.peek")?.[p.peek];
    const full = this.size && geo ? this.size.width * (geo.w / Math.max(geo.frac, EPS)) : null;
    const size = Number(s.font_size) || 13;
    const text = v_flex().absolute().top(8).w(full ?? 2000).px(14)
      .when(p.side === "left", (el) => el.right(0)).when(p.side !== "left", (el) => el.left(0))
      .font_family(String(s.font ?? s.font_family ?? "JetBrains Mono")).text_size(size).text_color(t.foreground)
      .children(this.lines.map((l, i) => div().id(`pl-${i}`).h(Math.round(size * 1.38)).whitespace_nowrap().child(l || " ")));
    // Dropping a dragged pane on a peek puts it beyond that column's near edge.
    const drag = shared("strip.drag");
    return div().id("peek").relative().size_full().overflow_hidden().bg(t.background).cursor_pointer()
      .when(Boolean(drag) && drag.pane !== p.peek, (el) => el.bg(t.hover))
      .on_mouse_move(forwardResize)
      .on_mouse_up("left", () => {
        endResize();
        const d = shared("strip.drag");
        if (!d) return;
        if (d.pane !== p.peek && Date.now() - d.at < 15000) setShared("strip.req", { op: "move", pane: d.pane, to: p.peek, side: p.side === "left" ? "before" : "after", n: nonce() });
        setShared("strip.drag", null);
      })
      .on_size_change((sz, cx) => { this.size = sz; cx.notify(); })
      .on_click(() => setShared("strip.req", { op: "focus", pane: p.peek, n: nonce() }))
      .child(text.opacity(0.4))
      // What is behind the edge, so an empty-looking peek still says where it leads.
      .child(h_flex().absolute().bottom(14).w_full().justify_center().child(
        h_flex().h(22).px(10).gap(6).items_center().rounded_full().bg(t.popover).text_size(11.5).text_color(t.muted)
          .child(p.side === "left" ? "\u2039" : "")
          .child(div().max_w(160).truncate().child(p.title ?? "Pane"))
          .child(p.side === "left" ? "" : "\u203a")));
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
  pinnedW(st) { return st.cols.reduce((s, c) => s + (c.pin ? c.w : 0), 0); }
  viewW(st) { return Math.max(MIN_VIEW, 1 - this.pinnedW(st)); }

  sync(tab, ps) {
    const st = this.state[tab] ?? { cols: [], vx: 0, n: shared("strip.n") ?? DEFAULT_N };
    if (st.vx === undefined) st.vx = 0;
    if (!st.n) st.n = shared("strip.n") ?? DEFAULT_N;
    const ids = new Set(ps.map((p) => p.pane));
    st.cols = st.cols.map((c) => ({ ...c, panes: c.panes.filter((id) => ids.has(id)) })).filter((c) => c.panes.length);
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

  clampView(st) {
    const max = Math.max(0, this.total(st) - this.viewW(st));
    st.vx = clamp(st.vx ?? 0, 0, max);
    st.tx = clamp(st.tx ?? st.vx, 0, max);
  }

  // Slides the view the least that shows a pane whole (niri's "never center").
  reveal(st, id) {
    const at = this.where(st, id);
    if (!at || st.cols[at.ci].pin) return; // a pinned pane is always in view
    const s = this.start(st, at.ci), e = s + st.cols[at.ci].w, vw = this.viewW(st);
    const from = st.tx ?? st.vx;
    if (s < from) st.tx = s;
    else if (e > from + vw) st.tx = e - vw;
    if (st.tx !== st.vx) this.dirty = true;
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
      case "scroll-left": this.slide(st, -1 / 3); break;
      case "scroll-right": this.slide(st, 1 / 3); break;
      case "center": if (at && !st.cols[at.ci].pin) { st.tx = this.start(st, at.ci) + st.cols[at.ci].w / 2 - this.viewW(st) / 2; this.clampView(st); this.dirty = true; } break;
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

  // Free scrolling moves the view, not the focus. A pane only partly in view
  // is a peek (no live terminal), so if the focused one slides out of full
  // view the keyboard moves to the nearest pane still whole in view.
  // Choose how many panes fit in the view; every column becomes 1/n wide.
  setN(st, n, keep) {
    st.n = clamp(Math.round(n), 1, N_MAX);
    setShared("strip.n", st.n);
    for (const c of st.cols) if (!c.pin) c.w = 1 / st.n; // a pinned pane keeps its width
    if (keep) { st.tx = undefined; this.reveal(st, keep); st.vx = st.tx ?? st.vx; }
    this.clampView(st);
  }

  // Even out the columns to the current count without changing it.
  fit(st, keep) { this.setN(st, st.n ?? DEFAULT_N, keep); }

  // Dragging the divider right of column `ci` by `d` (share of the view): that
  // column grows, the next one gives the space, both stay at least MIN_W.
  resize(st, ci, d) {
    const a = st.cols[ci], b = st.cols[ci + 1];
    if (!a) return;
    if (!b) { a.w = clamp(a.w + d, MIN_W, 1); this.clampView(st); return; }
    const dd = clamp(d, MIN_W - a.w, b.w - MIN_W);
    a.w += dd; b.w -= dd;
    this.clampView(st);
  }

  slide(st, d) {
    st.vx = (st.vx ?? 0) + d;
    st.tx = undefined;
    this.clampView(st);
    this.dirty = true;
    this.slidAt = Date.now();
    const vw = this.viewW(st);
    const whole = (ci) => { const c = st.cols[ci]; if (c.pin) return false; const s = this.start(st, ci); return s >= st.vx - EPS && s + c.w <= st.vx + vw + EPS; };
    const at = this.where(st, st.focus);
    if (at && (st.cols[at.ci].pin || whole(at.ci))) return;
    let best = null;
    for (let ci = 0; ci < st.cols.length; ci++) if (whole(ci) && (best === null || Math.abs(ci - (at?.ci ?? 0)) < Math.abs(best - (at?.ci ?? 0)))) best = ci;
    if (best === null) return;
    const col = st.cols[best], id = col.panes[0];
    const p = panes().find((q) => q.pane === id);
    st.focus = id; st.lastSeen = id;
    if (p?.terminal) this.pendingFocus = p.terminal;
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
    } else if (req.op === "resize") { const at = this.where(st, req.pane); if (at) this.resize(st, at.ci, req.d); this.dirty = true; }
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
  move(st, id, to, side) {
    const from = this.where(st, id), target = this.where(st, to);
    if (!from || !target || id === to || (from.ci === target.ci && st.cols[from.ci].panes.length === 1)) return;
    // A pinned pane never changes place, and nothing lands among the pinned.
    if (st.cols[from.ci].pin || st.cols[target.ci].pin) return;
    const col = st.cols[from.ci];
    const after = side ? side === "after" : from.ci < target.ci;
    col.panes.splice(from.ri, 1);
    if (!col.panes.length) st.cols.splice(from.ci, 1);
    const t = this.where(st, to);
    st.cols.splice(after ? t.ci + 1 : t.ci, 0, { panes: [id], w: col.w });
    this.order(st);
    this.clampView(st);
  }

  // ---- The tree ----------------------------------------------------------------

  build(st, ps) {
    const byId = new Map(ps.map((p) => [p.pane, p]));
    const weight = (f) => Math.max(1, Math.round(f * 1000));
    const filler = (id, f) => ({ id, type: "block", size: { weight: weight(f) }, content: { mod: "kanso-strip", props: { filler: true } } });
    const header = (id) => ({ id: `head-${id}`, type: "block", size: { px: HEADER_H }, content: { mod: "kanso-pane", props: { pane: id, terminal: byId.get(id).terminal, strip: true } } });
    const live = (id, size) => ({ id: `strip-${id}`, type: "column", size, background: "background",
      children: [header(id), { id: `term-${id}`, type: "block", content: { terminal: byId.get(id).terminal } }] });
    // One pane: the cell is the column. Stacked: equal shares of the height.
    const whole = (c, f) => c.panes.length === 1 ? live(c.panes[0], { weight: weight(f) })
      : { id: `strip-col-${c.panes[0]}`, type: "column", gap: 1, background: "border", resizable: false, size: { weight: weight(f) },
        children: c.panes.map((id) => live(id, { weight: 1000 })) };
    const peekGeo = {};
    const out = [];
    const vw = this.viewW(st);
    const v0 = st.vx, v1 = st.vx + vw;
    let s = 0, covered = 0;
    for (const c of st.cols) {
      if (c.pin) continue;
      const e = s + c.w, frac = Math.min(e, v1) - Math.max(s, v0);
      if (frac > MIN_PEEK) {
        covered += frac;
        const shown = c.panes;
        if (frac >= c.w - EPS) out.push(whole(c, frac));
        else {
          // Cut by the view's edge: a peek of its first pane in view.
          const id = shown[0];
          peekGeo[id] = { w: c.w, frac };
          out.push({ id: `strip-peek-${id}`, type: "column", size: { weight: weight(frac) }, background: "background", children: [
            header(id),
            { id: `peek-${id}`, type: "block", content: { mod: "kanso-strip", props: { peek: id, terminal: byId.get(id).terminal, side: s < v0 ? "left" : "right", title: byId.get(id).program?.name || byId.get(id).title || "Pane" } } },
          ] });
        }
      }
      s = e;
    }
    if (covered < vw - EPS) out.push(filler("strip-rest", vw - covered));
    if (JSON.stringify(peekGeo) !== JSON.stringify(shared("strip.peek") ?? {})) setShared("strip.peek", peekGeo);
    // Pinned columns stay at their side, in their order, always whole.
    const pinned = (side) => st.cols.filter((c) => c.pin === side).map((c) => whole(c, c.w));
    return [...pinned("left"), ...out, ...pinned("right")];
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
    try { run("layout.set", { layout: tree }); } catch { this.halted = now; return false; }
    return true;
  }

  save() {
    const tabs = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
    for (const id of Object.keys(this.state)) if (!tabs.has(id)) delete this.state[id];
    const text = JSON.stringify(this.state);
    if (text !== this.saved) { this.saved = text; setShared(KEY, JSON.parse(text)); }
  }

  // ---- Drawing -----------------------------------------------------------------

  wheel(ev, st) {
    const lines = ev.delta_lines?.y ?? 0;
    const d = lines ? -lines * 40 : (Math.abs(ev.delta.x) > Math.abs(ev.delta.y) ? -ev.delta.x : -ev.delta.y);
    this.slide(st, d / WHEEL_PX);
  }

  render() {
    if (this.kind === "filler") return div().id("filler").size_full().bg(theme().background).on_mouse_move(forwardResize).on_mouse_up("left", endResize);
    if (this.kind === "peek") return this.renderPeek();
    const t = theme();
    if (this.halted && Date.now() - this.halted > 10000) { this.halted = 0; this.sets = []; this.applied = null; }
    if (this.halted) return h_flex().size_full().justify_center().items_center().text_size(11).text_color(t.blocked).child("Strip paused");

    const tab = this.tab();
    const ps = tab ? panes().filter((p) => p.tab === tab) : [];
    const usable = ps.length > 0 && ps.every((p) => p.terminal);
    if (!usable) { this.apply([TAB_BLOCK]); this.save(); return div(); }

    const st = this.sync(tab, ps);
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
    this.apply(this.build(st, ps));
    this.save();

    if (this.pendingFocus) {
      const shownNow = JSON.stringify(find(layout(), "work-body") ?? {}).includes(`"terminal":"${this.pendingFocus}"`);
      if (shownNow) { run("pane.focus", { terminal: this.pendingFocus }); this.pendingFocus = null; }
    }

    // Minimap: one soft pill per column, as wide as its share of the view, no
    // frame. Whole in view `muted`, peeking `dim`, off-screen `input`, the
    // focused one `foreground`. Click a pill to go there; scroll to slide.
    const at = this.where(st, st.focus);
    let x = 0;
    const vw = this.viewW(st);
    const pills = st.cols.map((c, i) => {
      const s0 = x, e0 = x + (c.pin ? 0 : c.w); x = e0;
      const seen = c.pin ? c.w : Math.min(e0, st.vx + vw) - Math.max(s0, st.vx);
      const tone = at?.ci === i ? t.foreground : seen >= c.w - EPS ? t.muted : seen > MIN_PEEK ? t.dim : t.input;
      // A stacked column shows one thin bar per pane.
      const w = Math.round(6 + c.w * 18), k = c.panes.length;
      return v_flex().id(`strip-mark-${i}`).h(14).px(1).gap(1).flex_none().justify_center().cursor_pointer()
        .on_click(() => { this.focusOn(st, c.panes[0], ps); this.dirty = true; })
        .children(c.panes.map((id, r) => div().id(`strip-cell-${id}`).w(w).h(k > 1 ? 2 : 4).rounded_full()
          .bg(at?.ci === i && at?.ri !== r ? t.muted : tone)));
    });
    const n = st.n ?? DEFAULT_N;
    const tiny = (id, label, tip, action) => div().id(id).size(16).flex_none().flex().items_center().justify_center().rounded(4)
      .text_size(11).text_color(t.dim).cursor_pointer().tooltip(tip)
      .hover((h) => h.bg(t.foreground + "12").text_color(t.foreground))
      .on_click(() => { action(); this.dirty = true; })
      .child(label);
    return h_flex().id("strip-map").size_full().gap(3).justify_center().items_center()
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
