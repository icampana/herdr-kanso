// Kanso strip, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// An endless strip of panes, as in Omarchy's scrolling layout or niri: every
// pane keeps its own size, a new one opens beside (or above/below) the focused
// one without shrinking anything, and the view slides to show it. Panes that
// don't fit are off-screen, still running.
//
// How: in the "work-body" row, the layout's "main" node (Herdr's
// `{tab: "active"}` block) is replaced with the columns in view, each a header
// block (kanso-pane) over a `{terminal}` block, sized by weight as a share of
// the view. Only columns in view are in the tree, so off-screen ones cost
// nothing to draw. Two Herdr rules shape the tree: a layout may nest at most
// 16 levels (so columns sit directly in work-body), and Herdr folds empty
// containers and single-child ones (so free space is a filler block, a copy of
// this mod with `{filler: true}`, never an empty column).
// This copy sits in the status bar and draws the minimap: one mark per column,
// the ones in view brighter, the focused one in full ink.
//
// State per tab, kept in shared "strip.state": { cols: [{ panes, w, h, y }], x }
//   w: the column's width as a share of the view (1/3, 1/2, 2/3, 1)
//   h: each pane's height in that column as a share of the view (1, 1/2)
//   y: the first pane in view in that column; x: the first column in view.
// Requests from the pane headers arrive in shared "strip.req" (scroll, move,
// width) and "strip.intent" (where the next new pane goes).

import { View, div } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { spaces, panes, focused, layout, run, shared, setShared, theme, nextCommand, props } from "herdr";

const W_STEPS = [1 / 3, 1 / 2, 2 / 3, 1];
const H_STEPS = [1, 1 / 2];
const NEW_W = 1 / 2;
const EPS = 1e-3;
const KEY = "strip.state";
const HEADER_H = 34;

// The tab block "main" goes back to when the strip can't show a tab (a mod
// pane in it, or no panes): Herdr's own split view, framed as Kanso frames it.
const TAB_BLOCK = {
  id: "main", type: "block", background: "border",
  content: { tab: "active", pane: {
    header: { content: { mod: "kanso-pane" }, reveal: "always", height: HEADER_H, position: "top" },
    background: "background", border: { width: 0, color: "border" }, focus: { width: 0, color: "border" },
    radius: 0, gap: 1, lone: false } },
};

function findWithParent(node, id, parent = null) {
  if (node?.id === id) return { node, parent };
  for (const child of node?.children ?? []) {
    const found = findWithParent(child, id, node);
    if (found) return found;
  }
  return null;
}

const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));
const step = (list, v) => list[(list.findIndex((s) => Math.abs(s - v) < EPS) + 1) % list.length];
const rows = (c) => Math.max(1, Math.floor(1 / c.h + EPS)); // panes in view at once in a column

export default class Strip extends View {
  init(_props, cx) {
    this.filler = Boolean(props()?.filler);
    if (this.filler) return;
    this.sets = [];
    this.state = structuredCloneSafe(shared(KEY) ?? {});
    this.saved = JSON.stringify(this.state);
    this.lastReq = shared("strip.req")?.n ?? null;
    this.usedIntent = shared("strip.intent")?.at ?? null;
    this.pendingFocus = null;
    cx.spawn(async (cx) => {
      for (;;) {
        let c;
        try { c = await nextCommand(); } catch { break; }
        this.command(String(c).replace(/^kanso-strip\./, ""));
        cx.notify();
      }
    });
  }

  // ---- The model -----------------------------------------------------------------

  tab() {
    const space = spaces().find((s) => s.active);
    return space?.tabs?.find((t) => t.active)?.id ?? null;
  }

  // The pane with the keyboard: a terminal block's (pane null) by its terminal.
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

  // Brings the tab's state in line with its panes: closed ones leave, new ones
  // are placed where their split asked for (header buttons, keys), else in a
  // new column right of the focused one.
  sync(tab, ps) {
    const st = this.state[tab] ?? { cols: [], x: 0 };
    const ids = new Set(ps.map((p) => p.pane));
    st.cols = st.cols.map((c) => ({ ...c, panes: c.panes.filter((id) => ids.has(id)) })).filter((c) => c.panes.length);
    const known = new Set(st.cols.flatMap((c) => c.panes));
    const fresh = ps.filter((p) => !known.has(p.pane));
    if (fresh.length && !st.cols.length) {
      // First sight of this tab: each pane its own column, in Herdr's order.
      for (const p of fresh) st.cols.push({ panes: [p.pane], w: NEW_W, h: 1, y: 0 });
    } else {
      for (const p of fresh) { this.place(st, p.pane); st.focus = p.pane; this.pendingFocus = p.terminal; }
    }
    this.state[tab] = st;
    return st;
  }

  place(st, id) {
    const intent = shared("strip.intent");
    const usable = intent && intent.at !== this.usedIntent && Date.now() - intent.at < 5000;
    if (usable) this.usedIntent = intent.at;
    const dir = usable ? intent.dir : "right";
    const at = this.where(st, usable ? intent.from : st.focus) ?? { ci: st.cols.length - 1, ri: 0 };
    if (dir === "down" || dir === "up") {
      const col = st.cols[at.ci];
      col.panes.splice(dir === "down" ? at.ri + 1 : at.ri, 0, id);
    } else {
      st.cols.splice(dir === "left" ? at.ci : at.ci + 1, 0, { panes: [id], w: NEW_W, h: 1, y: 0 });
    }
  }

  // Columns in view: from x, as many as fit (always at least one).
  inView(st) {
    const x = clamp(st.x ?? 0, 0, Math.max(0, st.cols.length - 1));
    let sum = 0, e = x;
    while (e < st.cols.length && (e === x || sum + st.cols[e].w <= 1 + EPS)) { sum += st.cols[e].w; e++; }
    return [x, e, sum];
  }

  // Slides the view so a pane is in it, horizontally and in its column.
  reveal(st, id) {
    const at = this.where(st, id);
    if (!at) return;
    st.x = clamp(st.x ?? 0, 0, Math.max(0, st.cols.length - 1));
    if (at.ci < st.x) st.x = at.ci;
    while (at.ci >= this.inView(st)[1] && st.x < at.ci) st.x++;
    const col = st.cols[at.ci], n = rows(col);
    col.y = clamp(col.y ?? 0, 0, Math.max(0, col.panes.length - n));
    if (at.ri < col.y) col.y = at.ri;
    if (at.ri >= col.y + n) col.y = at.ri - n + 1;
  }

  // No empty space on the right while columns wait on the left.
  settle(st) {
    st.x = clamp(st.x ?? 0, 0, Math.max(0, st.cols.length - 1));
    while (st.x > 0) {
      const sum = st.cols.slice(st.x - 1).reduce((s, c) => s + c.w, 0);
      if (sum > 1 + EPS) break;
      st.x--;
    }
    for (const c of st.cols) c.y = clamp(c.y ?? 0, 0, Math.max(0, c.panes.length - rows(c)));
  }

  // ---- Actions -------------------------------------------------------------------

  command(name) {
    const tab = this.tab();
    const st = tab && this.state[tab];
    if (!st) return;
    const ps = panes().filter((p) => p.tab === tab);
    const id = this.focusPane(ps) ?? st.focus;
    const at = id && this.where(st, id);
    const go = (ci, ri) => {
      const col = st.cols[ci];
      if (!col) return;
      const target = col.panes[clamp(ri ?? col.y ?? 0, 0, col.panes.length - 1)];
      this.focusOn(st, target, ps);
    };
    const split = (dir) => {
      if (!id) return;
      setShared("strip.intent", { dir, from: id, at: Date.now() });
      run("pane.split", { pane: id, direction: dir === "down" || dir === "up" ? "down" : "right" });
    };
    switch (name) {
      case "go-left": if (at) go(at.ci - 1); break;
      case "go-right": if (at) go(at.ci + 1); break;
      case "go-up": if (at) go(at.ci, at.ri - 1); break;
      case "go-down": if (at) go(at.ci, at.ri + 1); break;
      case "move-left": case "move-right":
        if (at) {
          const to = at.ci + (name === "move-left" ? -1 : 1);
          if (to >= 0 && to < st.cols.length) { [st.cols[at.ci], st.cols[to]] = [st.cols[to], st.cols[at.ci]]; this.reveal(st, id); }
        }
        break;
      case "move-up": case "move-down":
        if (at) {
          const col = st.cols[at.ci], to = at.ri + (name === "move-up" ? -1 : 1);
          if (to >= 0 && to < col.panes.length) { [col.panes[at.ri], col.panes[to]] = [col.panes[to], col.panes[at.ri]]; this.reveal(st, id); }
        }
        break;
      case "new-right": split("right"); break;
      case "new-left": split("left"); break;
      case "new-down": split("down"); break;
      case "new-up": split("up"); break;
      case "close": if (id) run("pane.close", { pane: id }); break;
      case "width": if (at) { st.cols[at.ci].w = step(W_STEPS, st.cols[at.ci].w); this.reveal(st, id); } break;
      case "height": if (at) { st.cols[at.ci].h = step(H_STEPS, st.cols[at.ci].h); this.reveal(st, id); } break;
      case "scroll-left": st.x = Math.max(0, (st.x ?? 0) - 1); break;
      case "scroll-right": st.x = Math.min(st.cols.length - 1, (st.x ?? 0) + 1); break;
    }
  }

  focusOn(st, id, ps) {
    const p = ps.find((q) => q.pane === id);
    if (!p) return;
    st.focus = id;
    this.reveal(st, id);
    this.pendingFocus = p.terminal;
  }

  // A header asked for something (shared "strip.req").
  request(st, ps) {
    const req = shared("strip.req");
    if (!req || req.n === this.lastReq) return;
    this.lastReq = req.n;
    if (req.op === "scroll") {
      st.x = clamp((st.x ?? 0) + (req.d > 0 ? 1 : -1), 0, Math.max(0, st.cols.length - 1));
      this.settle(st);
    } else if (req.op === "width") {
      const at = this.where(st, req.pane);
      if (at) { st.cols[at.ci].w = step(W_STEPS, st.cols[at.ci].w); this.reveal(st, req.pane); }
    } else if (req.op === "move") {
      this.move(st, req.pane, req.to, req.stack);
      this.focusOn(st, req.pane, ps);
    }
  }

  // Ctrl+drag a header onto another: the pane becomes a column beside the
  // target (on the side it came from); with Shift it stacks under the target.
  move(st, id, to, stack) {
    const from = this.where(st, id), target = this.where(st, to);
    if (!from || !target || id === to) return;
    const width = st.cols[from.ci].w;
    const fromLeft = from.ci < target.ci;
    st.cols[from.ci].panes.splice(from.ri, 1);
    if (!st.cols[from.ci].panes.length) st.cols.splice(from.ci, 1);
    const t = this.where(st, to);
    if (stack) st.cols[t.ci].panes.splice(t.ri + 1, 0, id);
    else st.cols.splice(fromLeft ? t.ci + 1 : t.ci, 0, { panes: [id], w: width, h: 1, y: 0 });
  }

  // ---- The tree ------------------------------------------------------------------

  build(st, ps) {
    const byId = new Map(ps.map((p) => [p.pane, p]));
    const [s, e, sum] = this.inView(st);
    const weight = (f) => Math.max(1, Math.round(f * 1000));
    const filler = (id, f) => ({ id, type: "block", size: { weight: weight(f) }, content: { mod: "kanso-strip", props: { filler: true } } });
    const cell = (id, size) => {
      const p = byId.get(id);
      return {
        id: `strip-${id}`, type: "column", size, background: "background",
        children: [
          { id: `head-${id}`, type: "block", size: { px: HEADER_H }, content: { mod: "kanso-pane", props: { pane: id, terminal: p.terminal, strip: true } } },
          { id: `term-${id}`, type: "block", content: { terminal: p.terminal } },
        ],
      };
    };
    const out = [];
    for (let i = s; i < e; i++) {
      const c = st.cols[i], n = rows(c);
      const shown = c.panes.slice(c.y ?? 0, (c.y ?? 0) + n);
      const used = shown.length * c.h;
      // One pane filling its column: the cell is the column (no wrapper to fold).
      if (shown.length === 1 && used >= 1 - EPS) { out.push(cell(shown[0], { weight: weight(c.w) })); continue; }
      const kids = shown.map((id) => cell(id, { weight: weight(c.h) }));
      if (used < 1 - EPS) kids.push(filler(`strip-fill-${c.panes[0]}`, 1 - used));
      out.push({ id: `strip-col-${c.panes[0]}`, type: "column", gap: 1, background: "border", resizable: false, size: { weight: weight(c.w) }, children: kids });
    }
    if (sum < 1 - EPS) out.push(filler("strip-rest", 1 - sum));
    return out;
  }

  // Puts `nodes` where "main" (or the last strip) is in work-body, keeping its
  // other children (the side panel). Only when it differs from what we last
  // sent; at most 6 layout writes in 3 s, else the strip pauses itself rather
  // than keep the window busy.
  apply(nodes) {
    const text = JSON.stringify(nodes);
    if (text === this.applied) return false;
    const tree = layout();
    const body = findWithParent(tree, "work-body")?.node;
    if (!body?.children) return false;
    const mine = (n) => n.id === "main" || String(n.id).startsWith("strip-");
    // Herdr's own view already in place: nothing to write.
    if (nodes.length === 1 && nodes[0] === TAB_BLOCK && body.children.filter(mine).length === 1 && body.children.find(mine)?.content?.tab) { this.applied = text; return false; }
    const at = body.children.findIndex(mine);
    const rest = body.children.filter((n) => !mine(n));
    body.children = [...rest.slice(0, Math.max(0, at)), ...nodes, ...rest.slice(Math.max(0, at))];
    const now = Date.now();
    this.sets = this.sets.filter((t) => now - t < 3000);
    if (this.sets.length >= 6) { this.halted = now; return false; }
    this.sets.push(now);
    this.applied = text;
    try { run("layout.set", { layout: tree }); } catch { this.halted = now; return false; }
    return true;
  }

  save() {
    // Forget tabs that no longer exist.
    const tabs = new Set(spaces().flatMap((s) => (s.tabs ?? []).map((t) => t.id)));
    for (const id of Object.keys(this.state)) if (!tabs.has(id)) delete this.state[id];
    const text = JSON.stringify(this.state);
    if (text !== this.saved) { this.saved = text; setShared(KEY, JSON.parse(text)); }
  }

  // ---- Drawing -------------------------------------------------------------------

  render() {
    if (this.filler) return div().size_full().bg(theme().background);
    if (this.halted && Date.now() - this.halted > 10000) { this.halted = 0; this.sets = []; this.applied = null; }
    if (this.halted) return h_flex().h_full().px(10).items_center().text_size(11).text_color(theme().blocked).child("Strip paused");
    const t = theme();
    const tab = this.tab();
    const ps = tab ? panes().filter((p) => p.tab === tab) : [];
    // A mod pane can't sit in the strip (its props aren't readable): that tab
    // gets Herdr's own split view.
    const usable = ps.length > 0 && ps.every((p) => p.terminal);
    if (!usable) { this.apply([TAB_BLOCK]); this.save(); return div(); }

    const st = this.sync(tab, ps);
    this.request(st, ps);
    const now = this.focusPane(ps);
    if (now && now !== st.lastSeen) { st.lastSeen = now; st.focus = now; this.reveal(st, now); }
    this.settle(st);
    this.apply(this.build(st, ps));
    this.save();

    // Focus a pane once its block is in the layout (focusing earlier would land
    // on the hidden model pane).
    if (this.pendingFocus) {
      const shownNow = JSON.stringify(findWithParent(layout(), "work-body")?.node ?? {}).includes(`"terminal":"${this.pendingFocus}"`);
      if (shownNow) { run("pane.focus", { terminal: this.pendingFocus }); this.pendingFocus = null; }
    }

    if (st.cols.length < 2 && (st.cols[0]?.panes.length ?? 0) < 2) return div();
    const [s, e] = this.inView(st);
    const at = this.where(st, st.focus);
    return h_flex().id("strip-map").h_full().px(10).gap(3).items_center()
      .on_scroll_wheel((ev) => {
        const d = Math.abs(ev.delta.x) > Math.abs(ev.delta.y) ? -ev.delta.x : ev.delta.y;
        const now2 = Date.now();
        if (now2 - (this.wheelAt ?? 0) > 300) this.wheelSum = 0;
        this.wheelAt = now2; this.wheelSum = (this.wheelSum ?? 0) + d;
        if (Math.abs(this.wheelSum) < 40 && Math.abs(ev.delta_lines?.y ?? 0) < 1) return;
        this.command(this.wheelSum > 0 || (ev.delta_lines?.y ?? 0) > 0 ? "scroll-left" : "scroll-right");
        this.wheelSum = 0;
      })
      .children(st.cols.map((c, i) => {
        const visible = i >= s && i < e, focus = at?.ci === i;
        return v_flex().id(`strip-mark-${i}`).w(Math.round(8 + c.w * 30)).h(12).gap(1).flex_none().cursor_pointer()
          .tooltip(`${c.panes.length} ${c.panes.length === 1 ? "pane" : "panes"}`)
          .on_click(() => this.focusOn(st, c.panes[c.y ?? 0], ps))
          .children(c.panes.map((id, r) => div().id(`strip-cell-${id}`).flex_1().rounded(2)
            .bg(focus && at?.ri === r ? t.foreground : visible && r >= (c.y ?? 0) && r < (c.y ?? 0) + rows(c) ? t.muted : t.input)));
      }));
  }
}

function structuredCloneSafe(v) {
  try { return JSON.parse(JSON.stringify(v)); } catch { return {}; }
}
