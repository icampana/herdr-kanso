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
// State per tab in shared "strip.state": { cols: [{ panes, w, h, y }], vx }
//   w: column width as a share of the view; vx: the view's left edge on the
//   row, in view widths; h: a pane's height in its column; y: first pane shown.
// Headers and peeks talk to the controller through shared "strip.req"
// (scroll, focus, move, width) and "strip.intent" (where the next pane goes).

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, layout, run, shared, setShared, theme, nextCommand, props, hc, settings } from "herdr";

const W_STEPS = [1 / 3, 1 / 2, 2 / 3, 1];
const NEW_W = 2 / 3; // a new column: wide enough that its neighbour peeks in
const EPS = 1e-3;
const KEY = "strip.state";
const HEADER_H = 34;
const WHEEL_PX = 600; // trackpad/wheel pixels that slide the view one full width
const MIN_PEEK = 0.02; // narrower slivers are left out

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
const rows = (c) => Math.max(1, Math.floor(1 / c.h + EPS));
const nonce = () => Date.now() + Math.random();

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
    return div().id("peek").relative().size_full().overflow_hidden().bg(t.background).cursor_pointer()
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

  start(st, ci) { let s = 0; for (let i = 0; i < ci; i++) s += st.cols[i].w; return s; }
  total(st) { return st.cols.reduce((s, c) => s + c.w, 0); }

  sync(tab, ps) {
    const st = this.state[tab] ?? { cols: [], vx: 0 };
    if (st.vx === undefined) st.vx = 0;
    const ids = new Set(ps.map((p) => p.pane));
    // Horizontal only: one pane per column (older stacked columns are split).
    st.cols = st.cols.flatMap((c) => c.panes.filter((id) => ids.has(id)).map((id) => ({ panes: [id], w: c.w, h: 1, y: 0 })));
    const known = new Set(st.cols.flatMap((c) => c.panes));
    const fresh = ps.filter((p) => !known.has(p.pane));
    if (fresh.length && !st.cols.length) {
      // First sight of this tab: a lone pane fills the view; more sit side by side.
      for (const p of fresh) st.cols.push({ panes: [p.pane], w: fresh.length === 1 ? 1 : NEW_W, h: 1, y: 0 });
    } else {
      for (const p of fresh) { this.place(st, p.pane); st.focus = p.pane; this.pendingFocus = p.terminal; this.reveal(st, p.pane); }
    }
    this.state[tab] = st;
    return st;
  }

  place(st, id) {
    const intent = shared("strip.intent");
    const usable = intent && intent.at !== this.usedIntent && Date.now() - intent.at < 5000;
    if (usable) this.usedIntent = intent.at;
    const dir = usable ? (intent.dir === "up" ? "left" : intent.dir === "down" ? "right" : intent.dir) : "right";
    const at = this.where(st, usable ? intent.from : st.focus) ?? { ci: st.cols.length - 1, ri: 0 };
    st.cols.splice(dir === "left" ? at.ci : at.ci + 1, 0, { panes: [id], w: NEW_W, h: 1, y: 0 });
  }

  clampView(st) {
    const max = Math.max(0, this.total(st) - 1);
    st.vx = clamp(st.vx ?? 0, 0, max);
    st.tx = clamp(st.tx ?? st.vx, 0, max);
    for (const c of st.cols) c.y = clamp(c.y ?? 0, 0, Math.max(0, c.panes.length - rows(c)));
  }

  // Slides the view the least that shows a pane whole (niri's "never center").
  reveal(st, id) {
    const at = this.where(st, id);
    if (!at) return;
    const s = this.start(st, at.ci), e = s + st.cols[at.ci].w;
    const from = st.tx ?? st.vx;
    if (s < from) st.tx = s;
    else if (e > from + 1) st.tx = e - 1;
    if (st.tx !== st.vx) this.dirty = true;
    const col = st.cols[at.ci], n = rows(col);
    if (at.ri < (col.y ?? 0)) col.y = at.ri;
    if (at.ri >= (col.y ?? 0) + n) col.y = at.ri - n + 1;
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
      this.focusOn(st, col.panes[clamp(ri ?? col.y ?? 0, 0, col.panes.length - 1)], ps);
    };
    const split = (dir) => {
      if (!id) return;
      setShared("strip.intent", { dir, from: id, at: Date.now() });
      run("pane.split", { pane: id, direction: "right" });
    };
    switch (name) {
      case "go-left": if (at) go(at.ci - 1); break;
      case "go-right": if (at) go(at.ci + 1); break;
      case "move-left": case "move-right":
        if (at) {
          const to = at.ci + (name === "move-left" ? -1 : 1);
          if (to >= 0 && to < st.cols.length) { [st.cols[at.ci], st.cols[to]] = [st.cols[to], st.cols[at.ci]]; this.reveal(st, id); }
        }
        break;
      case "new-right": split("right"); break;
      case "new-left": split("left"); break;
      case "close": if (id) run("pane.close", { pane: id }); break;
      case "width": if (at) { st.cols[at.ci].w = step(W_STEPS, st.cols[at.ci].w); this.reveal(st, id); } break;
      case "scroll-left": this.slide(st, -1 / 3); break;
      case "scroll-right": this.slide(st, 1 / 3); break;
      case "center": if (at) { st.tx = this.start(st, at.ci) + st.cols[at.ci].w / 2 - 0.5; this.clampView(st); this.dirty = true; } break;
      case "first": go(0); break;
      case "last": go(st.cols.length - 1); break;
      default: {
        const n = /^col-(\d)$/.exec(name);
        if (n) go(Number(n[1]) - 1);
      }
    }
  }

  // Free scrolling moves the view, not the focus. A pane only partly in view
  // is a peek (no live terminal), so if the focused one slides out of full
  // view the keyboard moves to the nearest pane still whole in view.
  slide(st, d) {
    st.vx = (st.vx ?? 0) + d;
    st.tx = undefined;
    this.clampView(st);
    this.dirty = true;
    this.slidAt = Date.now();
    const whole = (ci) => { const s = this.start(st, ci); return s >= st.vx - EPS && s + st.cols[ci].w <= st.vx + 1 + EPS; };
    const at = this.where(st, st.focus);
    if (at && whole(at.ci)) return;
    let best = null;
    for (let ci = 0; ci < st.cols.length; ci++) if (whole(ci) && (best === null || Math.abs(ci - (at?.ci ?? 0)) < Math.abs(best - (at?.ci ?? 0)))) best = ci;
    if (best === null) return;
    const col = st.cols[best], id = col.panes[col.y ?? 0];
    const p = panes().find((q) => q.pane === id);
    st.focus = id; st.lastSeen = id;
    if (p?.terminal) this.pendingFocus = p.terminal;
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
    } else if (req.op === "move") {
      this.move(st, req.pane, req.to);
      this.focusOn(st, req.pane, ps);
    }
  }

  // Ctrl+drag a header onto another: the pane becomes a column beside it, on
  // the side it came from.
  move(st, id, to) {
    const from = this.where(st, id), target = this.where(st, to);
    if (!from || !target || id === to) return;
    const width = st.cols[from.ci].w, fromLeft = from.ci < target.ci;
    st.cols[from.ci].panes.splice(from.ri, 1);
    if (!st.cols[from.ci].panes.length) st.cols.splice(from.ci, 1);
    const t = this.where(st, to);
    st.cols.splice(fromLeft ? t.ci + 1 : t.ci, 0, { panes: [id], w: width, h: 1, y: 0 });
  }

  // ---- The tree ----------------------------------------------------------------

  build(st, ps) {
    const byId = new Map(ps.map((p) => [p.pane, p]));
    const weight = (f) => Math.max(1, Math.round(f * 1000));
    const filler = (id, f) => ({ id, type: "block", size: { weight: weight(f) }, content: { mod: "kanso-strip", props: { filler: true } } });
    const header = (id) => ({ id: `head-${id}`, type: "block", size: { px: HEADER_H }, content: { mod: "kanso-pane", props: { pane: id, terminal: byId.get(id).terminal, strip: true } } });
    const live = (id, size) => ({ id: `strip-${id}`, type: "column", size, background: "background",
      children: [header(id), { id: `term-${id}`, type: "block", content: { terminal: byId.get(id).terminal } }] });
    const peekGeo = {};
    const out = [];
    const v0 = st.vx, v1 = st.vx + 1;
    let s = 0, covered = 0;
    for (const c of st.cols) {
      const e = s + c.w, frac = Math.min(e, v1) - Math.max(s, v0);
      if (frac > MIN_PEEK) {
        covered += frac;
        const n = rows(c), shown = c.panes.slice(c.y ?? 0, (c.y ?? 0) + n);
        if (frac >= c.w - EPS) {
          const used = shown.length * c.h;
          if (shown.length === 1 && used >= 1 - EPS) out.push(live(shown[0], { weight: weight(frac) }));
          else {
            const kids = shown.map((id) => live(id, { weight: weight(c.h) }));
            if (used < 1 - EPS) kids.push(filler(`strip-fill-${c.panes[0]}`, 1 - used));
            out.push({ id: `strip-col-${c.panes[0]}`, type: "column", gap: 1, background: "border", resizable: false, size: { weight: weight(frac) }, children: kids });
          }
        } else {
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
    if (covered < 1 - EPS) out.push(filler("strip-rest", 1 - covered));
    if (JSON.stringify(peekGeo) !== JSON.stringify(shared("strip.peek") ?? {})) setShared("strip.peek", peekGeo);
    return out;
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
    if (this.kind === "filler") return div().size_full().bg(theme().background);
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
    if (st.cols.length < 2) return div();
    const at = this.where(st, st.focus);
    let x = 0;
    const pills = st.cols.map((c, i) => {
      const s0 = x, e0 = x + c.w; x = e0;
      const seen = Math.min(e0, st.vx + 1) - Math.max(s0, st.vx);
      const tone = at?.ci === i ? t.foreground : seen >= c.w - EPS ? t.muted : seen > MIN_PEEK ? t.dim : t.input;
      return div().id(`strip-mark-${i}`).h(14).px(1).flex_none().flex().items_center().cursor_pointer()
        .on_click(() => { this.focusOn(st, c.panes[0], ps); this.dirty = true; })
        .child(div().w(Math.round(6 + c.w * 18)).h(4).rounded_full().bg(tone));
    });
    return h_flex().id("strip-map").size_full().gap(3).justify_center().items_center()
      .tooltip("⌘1-9 go to · ⌘[ ⌘] previous, next · ⌘D new · ⌘W close · ⌘⇧[ ⌘⇧] move")
      .on_scroll_wheel((ev) => this.wheel(ev, st))
      .children(pills);
  }
}
