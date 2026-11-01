// Derived from the `spaces` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: New space button, initial tiles, nested worktrees on guide lines, ahead/behind counts.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-spaces; each space lists its agents (agents.js), folded by clicking the space. The active space is a faint wash of the text color, never a theme accent.
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-spaces; a fixed 76px rail when collapsed (resizable only when open), space avatars in the theme's hues, a breathing dot instead of a spinner, background polling slowed when the window is behind.
// Workspace spaces: stable colored avatars, worktrees under their checkout,
// grouped by machine when more than one is known. After a space's name, the repo
// its first terminal is in now, only where unusual: branch, ahead/behind. Its agents are listed under it (agents.js). Click to
// switch, right-click for its menu, drag to reorder.

import { View, div, svg, image } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { agentRow, agentFold, withTerminals } from "./agents.js";
import { spaces, machines, panes, agents, run, openOverlay, exec, hc, theme, shared, setShared, watchFolder, window, layout } from "herdr";

// Where a space is now: its first terminal's live folder, else where it was made.
// `ps`: panes(), read once by the caller (each read copies every pane).
function place(s, ps) {
  const tabs = new Set((s.tabs ?? []).map((c) => c.id));
  return ps.find((p) => tabs.has(p.tab) && p.cwd)?.cwd || s.folder;
}
const TREE_ROW = 30;
const PLAIN_ROW = 32;
const GUIDE_X = 19; // under the parent's avatar centre: 8px row padding + half its 22px width
const ELBOW_W = 11;
const GUIDE_OVERLAP = 4; // the line reaches up into the row above, so it never breaks
const CHILD_PAD = GUIDE_X + ELBOW_W + 6 - 8; // icon starts 6px after the elbow, inside the 8px row padding
const rowHeight = ({ tree }) => (tree ? TREE_ROW : PLAIN_ROW);
const where = (s, ps) => JSON.stringify([s.machine ?? null, place(s, ps)]);
const base = (path) => path.replace(/\/+$/, "").split("/").pop();
// Changes made outside Herdr (an editor's save, a commit in another app): looked
// for this often, in repos the list shows, while the window is in front.
const FALLBACK = 60000;
const SIDEBAR_W = 256;
// Collapsed, the rail is as wide as the macOS traffic lights need (12px in,
// three buttons, 12px out), so they never spill over the tab bar.
const collapsedW = () => (window()?.platform === "macos" ? 76 : 44);
const OPEN_MIN = 200; // dragged open, the sidebar never gets narrower than this

// Collapsed, the rail has a fixed width: its edge can't be dragged. Open, the
// edge drags between OPEN_MIN and 480. The root row owns that edge
// (`resizable`), so both live in the layout; then the width is applied.
function setRail(open, width) {
  const tree = layout();
  const sidebar = (tree?.children ?? []).find((n) => n.id === "sidebar");
  if (!sidebar) return;
  if (tree.resizable !== open || sidebar.min !== (open ? OPEN_MIN : collapsedW())) {
    tree.resizable = open;
    sidebar.min = open ? OPEN_MIN : collapsedW();
    run("layout.set", { layout: tree });
  }
  run("layout.resize", { id: "sidebar", px: width });
}

// What a stored color name looks like on an avatar (the same in every mod
// that draws space avatars): one strong color per hue, light and dark alike.
const MARK = { ansi6: "#22a99a", ansi3: "#e3814f", ansi4: "#5b8def", ansi5: "#8b7cf6", ansi2: "#3fae6a", ansi1: "#d9649a" };

export function tone(t, status) {
  return t[status] ?? t.unknown;
}

export default class Spaces extends View {
  init(_props, cx) {
    this.git = {}; // where() -> { name, branch, ahead, behind, repo, linked }, null: not a repo
    this.checked = {}; // where() -> when it was last looked at
    this.unsure = new Set(); // where()s git couldn't answer for (a machine away)
    this.pending = new Set(); // where()s to look at next
    this.busy = {}; // pane -> an agent working or a program in front of its shell
    this.ready = {}; // machine -> its layout was readable at the last look
    this.at = {}; // space -> its where() at the last look
    this.watching = new Set(); // local repos' git folders
    // Spaces made while this runs wait (at most a moment) for their git, so a
    // worktree appears under its repo instead of jumping there.
    this.shown = new Set(spaces().map((s) => s.id));
    this.born = {};
    this.pressed = null;
    this.over = null;
    this.machines = [];
    this.folded = new Set(JSON.parse(localStorage.getItem("machines.folded") ?? "[]"));
    this.agentsFolded = new Set(JSON.parse(localStorage.getItem("spaces.agentsFolded") ?? "[]"));
    this.migrate();
    this.refreshMachines(cx);
    // `hc machine ls` is a process: every 30 s while the window is in front,
    // every 2 min behind it.
    cx.timer.every(30000, cx => { if (window().active || ++this.machineTicks % 4 === 0) this.refreshMachines(cx); });
    this.machineTicks = 0;
    // `git status` walks the whole tree, on another machine a process there:
    // only when its answer could have changed (see `due`). Behind other
    // windows, look every 5 s instead of every 0.5 s; nothing is missed, the
    // next look compares against the last one.
    cx.timer.every(500, (cx) => this.checkNew(cx));
  }

  // One-time fixes to how this rail was left by older versions. Kept out of
  // render so drawing never changes state.
  migrate() {
    const collapsed = shared("sidebar.collapsed") === true;
    // Open the rail once so search is on the same row as +, not buried under the lights.
    if (shared("kanso.row") !== 3) {
      setShared("kanso.row", 3);
      setShared("sidebar.collapsed", false);
      setRail(true, SIDEBAR_W);
      return;
    }
    // Collapsed: a fixed 76px rail (room for the traffic lights) that can't be
    // dragged. Applied on every start, so older layouts are brought in line.
    if (collapsed) setRail(false, collapsedW());
    else setRail(true, shared("sidebar.width") ?? SIDEBAR_W);
  }

  checkNew(cx) {
    const now = Date.now();
    if (!window().active && now - (this.lastLook ?? 0) < 5000) return;
    this.lastLook = now;
    const sp = spaces();
    for (const s of sp) if (!this.shown.has(s.id)) this.born[s.id] ??= now;
    const due = this.due(now, sp, panes());
    if (due.size) this.refreshGit(due, cx);
    if (sp.some((s) => !this.shown.has(s.id))) cx.notify();
  }

  // Places whose git could have changed: new ones (a new space, a cd), where a
  // command or an agent's turn just ended (a checkout, a commit, edits), those on
  // a machine that is back, and repos in view whose fallback is due.
  due(now, sp, ps) {
    // Moved there: what it knew of that place may be old.
    const at = {};
    for (const s of sp) at[s.id] = where(s, ps);
    const keys = new Set(Object.values(at).filter((k) => JSON.parse(k)[1]));
    const due = new Set([...keys].filter((k) => !(k in this.git)));
    for (const [id, k] of Object.entries(at)) if (this.at[id] && this.at[id] !== k && keys.has(k)) due.add(k);
    this.at = at;
    const spaceOf = {};
    for (const s of sp) for (const t of s.tabs ?? []) spaceOf[t.id] = s;
    const busy = {};
    for (const p of ps) {
      if (!p.terminal || !spaceOf[p.tab]) continue;
      busy[p.pane] = p.status === "working" || !(p.program?.shell || p.program?.agent);
      if (this.busy[p.pane] && !busy[p.pane]) this.sameRepo(at[spaceOf[p.tab].id], keys).forEach((k) => due.add(k));
    }
    this.busy = busy;
    for (const m of machines()) {
      const ready = m.layout === "ready";
      if (ready && this.ready[m.name] === false) for (const k of keys) if (JSON.parse(k)[0] === m.name) due.add(k);
      this.ready[m.name] = ready;
    }
    if (window().active) {
      for (const k of keys) {
        const asks = this.git[k] || this.unsure.has(k);
        if (asks && !this.folded.has(JSON.parse(k)[0]) && now - (this.checked[k] ?? 0) > FALLBACK) due.add(k);
      }
    }
    return due;
  }

  // `key` and the other places in its repo (a commit there moves their ahead/behind).
  sameRepo(key, keys) {
    const repo = this.git[key]?.repo;
    return [key, ...(repo ? [...keys].filter((k) => this.git[k]?.repo === repo) : [])];
  }

  refreshMachines(cx) {
    cx.spawn(async cx => {
      try { const r = await hc(["machine", "ls", "--json"]); if (r.code === 0) this.machines = (JSON.parse(r.stdout).machines ?? []).filter((m) => !m.temporary); } catch {}
      cx.notify();
    });
  }

  // One look at a time, each place once however often it was asked for meanwhile.
  refreshGit(keys, cx) {
    for (const k of keys) this.pending.add(k);
    if (this.refreshing) return;
    this.refreshing = true;
    cx.spawn(async (cx) => {
      while (this.pending.size) {
        const keys = [...this.pending];
        this.pending.clear();
        for (const key of keys) await this.check(key, cx);
      }
      const used = new Set(Object.values(this.git).filter(Boolean).map((g) => JSON.parse(g.repo)).filter(([on]) => !on).map(([, repo]) => repo));
      for (const repo of this.watching) if (!used.has(repo)) this.watching.delete(repo);
      this.refreshing = false;
      cx.notify();
    });
  }

  // One place's git: branch, ahead/behind, its repo.
  async check(key, cx) {
    const [on, cwd] = JSON.parse(key);
    this.checked[key] = Date.now();
    this.unsure.delete(key);
    try {
      // No optional locks: a status that touched the index would wake the watch again.
      const r = await exec("git", ["--no-optional-locks", "status", "--porcelain=v2", "--branch"], { cwd, on });
      if (r.code !== 0) {
        // Only git's own "no" is remembered as no repo; anything else is asked again.
        if (!/not a git repository/i.test(r.stderr)) this.unsure.add(key);
        this.git[key] = null;
        return;
      }
      // The repo's own .git folder names it; a worktree's top differs from it.
      const top = await exec("git", ["rev-parse", "--show-toplevel"], { cwd, on });
      const common = await exec("git", ["rev-parse", "--path-format=absolute", "--git-common-dir"], { cwd, on });
      const repo = common.stdout.trim();
      const name = repo.endsWith("/.git") ? base(repo.slice(0, -5)) : base(repo).replace(/\.git$/, "");
      const info = { name, branch: null, ahead: 0, behind: 0, repo: JSON.stringify([on, repo]), linked: repo !== `${top.stdout.trim()}/.git` };
      for (const line of r.stdout.split("\n")) {
        if (line.startsWith("# branch.head ")) info.branch = line.slice(14);
        else if (line.startsWith("# branch.ab ")) {
          const [a, b] = line.slice(12).split(" ");
          info.ahead = Math.abs(parseInt(a, 10)) || 0;
          info.behind = Math.abs(parseInt(b, 10)) || 0;
        }
      }
      this.git[key] = info;
      if (!on) this.watch(repo, cx);
    } catch {
      // Couldn't ask (the machine is away): keep what it showed, look again later.
      this.git[key] ??= null;
      this.unsure.add(key);
    }
  }

  watch(repo, cx) {
    if (this.watching.has(repo)) return;
    this.watching.add(repo);
    cx.spawn(async (cx) => {
      try {
        while (this.watching.has(repo)) {
          await watchFolder(repo);
          const mine = JSON.stringify([null, repo]);
          if (this.watching.has(repo)) this.refreshGit(Object.keys(this.git).filter((k) => this.git[k]?.repo === mine), cx);
        }
      } catch { this.watching.delete(repo); }
    });
  }

  menu(w) {
    // A popup is as tall as its items; height is only the most.
    openOverlay({ mod: "menu", kind: "popup", width: 200, height: 260, props: { tab: "space", target: { id: w.id } } });
  }

  // Spaces in order, each worktree space moved under its main checkout's.
  ordered() {
    const sp = spaces(), ps = panes();
    const ready = (w) => this.shown.has(w.id) || where(w, ps) in this.git || Date.now() - (this.born[w.id] ??= Date.now()) > 1500;
    for (const w of sp) if (!this.shown.has(w.id) && ready(w)) this.shown.add(w.id);
    const list = sp.map((w, i) => ({ w, i, g: this.git[where(w, ps)] ?? null })).filter((r) => this.shown.has(r.w.id));
    const mains = new Set(list.filter((r) => r.g && !r.g.linked).map((r) => r.g.repo));
    const nested = (r) => r.g?.linked && mains.has(r.g.repo);
    const out = [];
    const placed = new Set(); // repos whose worktrees are listed (under the first of its spaces)
    for (const r of list) {
      if (nested(r)) continue;
      out.push({ ...r, tree: null });
      if (!r.g || r.g.linked || placed.has(r.g.repo)) continue;
      placed.add(r.g.repo);
      const kids = list.filter((k) => nested(k) && k.g.repo === r.g.repo);
      kids.forEach((k, n) => out.push({ ...k, tree: { last: n === kids.length - 1 } }));
    }
    return out;
  }

  // Sessions in the order the strip shows their panes (tab by tab), so the
  // list reads like the screen.
  inStripOrder(list) {
    const state = shared("strip.state") ?? {};
    const pos = (a) => { const ids = (state[a.tab]?.cols ?? []).flatMap((c) => c.panes ?? []); const i = ids.indexOf(a.pane); return i < 0 ? 1e6 : i; };
    return list.map((a, i) => [a, i]).sort((x, y) => (x[0].tab_index - y[0].tab_index) || (pos(x[0]) - pos(y[0])) || (x[1] - y[1])).map(([a]) => a);
  }

  // Drag a session onto another in the same tab (the one on screen) to move
  // its pane there in the strip. Pinned panes stay where they are.
  reorder(a, mine) {
    const state = shared("strip.state") ?? {};
    const pinnedOf = (x) => Boolean(state[x.tab]?.cols?.find((c) => c.panes?.includes(x.pane))?.pin);
    const shownTab = spaces().find((s) => s.active)?.tabs?.find((x) => x.active)?.id;
    const from = this.draggedAgent;
    const ok = from && from.pane !== a.pane && from.tab === a.tab && a.tab === shownTab && !pinnedOf(a) && !from.pinned;
    return {
      pinned: pinnedOf(a),
      target: ok && this.overAgent === a.pane ? (from.at < mine.indexOf(a) ? "after" : "before") : null,
      hover: (h, cx) => { if (h && this.draggedAgent && this.overAgent !== a.pane) { this.overAgent = a.pane; cx.notify(); } },
      down: () => { this.draggedAgent = { pane: a.pane, tab: a.tab, pinned: pinnedOf(a), at: mine.indexOf(a) }; this.overAgent = null; },
      up: (cx) => {
        const d = this.draggedAgent;
        this.draggedAgent = null;
        if (ok) setShared("strip.req", { op: "move", pane: d.pane, to: a.pane, side: d.at < mine.indexOf(a) ? "after" : "before", n: Date.now() + Math.random() });
        cx.notify();
      },
    };
  }

  // The rows, under a header per machine once one isn't this computer.
  grouped(t, collapsed) {
    const rows = this.ordered();
    const all = withTerminals(agents(), panes(), spaces());
    const draw = (r) => {
      if (collapsed) return this.compact(r, t);
      const mine = this.inStripOrder(all.filter((a) => a.space === r.w.id));
      const open = !this.agentsFolded.has(r.w.id);
      return [this.row(r, t, mine), ...(open ? mine.map((a) => agentRow(a, r.tree ? CHILD_PAD : 0, t, this.reorder(a, mine))) : [])];
    };
    const remote = [...new Set([...rows.map(r => r.w.machine).filter(Boolean), ...this.machines.map(m => m.name)])].sort();
    const loading = m => {
      const layout = machines().find(k => k.name === m)?.layout;
      return layout === "loading" || (!layout && this.machines.some(k => k.name === m && k.state === "connected"))
        || rows.length < spaces().length && spaces().some(s => (s.machine ?? null) === m && !this.shown.has(s.id));
    };
    const loadingRow = m => div().id(`machine-loading-${m ?? "local"}`).h(28).flex_none().px(8).text_size(12).text_color(t.dim).child(collapsed ? "…" : "Loading…");
    if (!remote.length) return loading(null) && !rows.length ? [loadingRow(null)] : rows.flatMap(draw);
    const machineNames = [null, ...remote];
    return machineNames.flatMap((m) => {
      const mine = rows.filter((r) => (r.w.machine ?? null) === m);
      const machine = this.machines.find(k => k.name === m);
      const connected = !m || machine?.state === "connected";
      const folded = this.folded.has(m);
      const head = h_flex().id(`machine-${m ?? "local"}`).h(26).flex_none().px(collapsed ? 2 : 8).gap(7).items_center().text_size(11).text_color(t.dim)
        .cursor_pointer().hover(s => s.bg(t.hover))
        .on_click((_e, cx) => {
          folded ? this.folded.delete(m) : this.folded.add(m);
          localStorage.setItem("machines.folded", JSON.stringify([...this.folded]));
          cx.notify();
        })
        .child(svg(`mods/kanso-chrome/icons/${m ? "server" : "monitor"}.svg`).size(14).flex_none())
        .when(!collapsed, el => el.child(div().flex_1().truncate().child(m ?? "This computer"))
          .when(!connected, el => el.child(div().flex_none().child((machine?.state ?? "asleep").replace(/_/g, " "))))
          .when(connected, el => el.child(div().id(`machine-add-${m ?? "local"}`).flex_none().px(4).rounded(6).hover(s => s.bg(t.hover).text_color(t.foreground))
            .on_click((_e, cx) => { cx.stop_propagation(); run("space.new", m ? { machine: m } : {}); }).child("+")))
          .child(div().size(6).rounded_full().flex_none().bg(connected ? t.ansi2 : t.dim))
          .child(svg(`mods/kanso-chrome/icons/chevron-${folded ? "right" : "down"}.svg`).size(12).flex_none()));
      const empty = h_flex().id(`machine-new-${m ?? "local"}`).h(28).flex_none().px(8).gap(7).items_center().rounded(6)
        .text_size(12).text_color(t.dim).hover(s => s.bg(t.hover).text_color(t.foreground))
        .on_click(() => run("space.new", m ? { machine: m } : {}))
        .child(svg("mods/kanso-chrome/icons/plus.svg").size(14)).tooltip("New space");
      return [head, ...(folded ? [] : mine.length ? mine.flatMap(draw) : [loading(m) ? loadingRow(m) : empty])];
    });
  }

  // After the name: "herdr  ⎇ main ↑2 ↓1". The branch always shows (main and master
  // too); only a worktree row drops it, since its name already is the branch.
  gitTail(g, tree, name, t) {
    const same = (a) => a.toLowerCase() === name.toLowerCase();
    const branch = tree ? "" : (g.branch ?? "detached");
    const repo = tree || same(g.name) ? "" : g.name;
    return h_flex()
      .flex_1()
      .min_w(0)
      .gap(5)
      .justify_end()
      .items_center()
      .text_size(11.5)
      .text_color(t.dim)
      .when(Boolean(repo), (el) => el.child(div().min_w(0).truncate().child(repo)))
      .when(Boolean(branch), (el) => el
        .child(svg("mods/kanso-chrome/icons/branch.svg").size(12).flex_none().text_color(t.muted))
        .child(div().min_w(0).truncate().text_color(t.muted).child(branch)))
      .when(g.ahead > 0, (el) => el.child(div().flex_none().text_color(t.ansi2).child(`\u2191${g.ahead}`)))
      .when(g.behind > 0, (el) => el.child(div().flex_none().text_color(t.ansi1).child(`\u2193${g.behind}`)));
  }

  // A child row's connector: a line down from its parent that bends into the row;
  // the last child's line stops at the bend.
  connector({ last }, t) {
    const mid = TREE_ROW / 2;
    return [
      div().absolute().left(GUIDE_X).top(-GUIDE_OVERLAP).w(1).h(last ? mid + GUIDE_OVERLAP : TREE_ROW + GUIDE_OVERLAP).bg(t.input),
      div().absolute().left(GUIDE_X).top(mid).w(ELBOW_W).h(1).bg(t.input),
    ];
  }

  // A space's agents fold toggle; the state is kept across restarts.
  fold(w, mine, t) {
    const open = !this.agentsFolded.has(w.id);
    return agentFold(w.id, mine, open, (cx) => { this.setAgentsFolded(w.id, open); cx.notify(); }, t);
  }

  setAgentsFolded(id, folded) {
    folded ? this.agentsFolded.add(id) : this.agentsFolded.delete(id);
    localStorage.setItem("spaces.agentsFolded", JSON.stringify([...this.agentsFolded]));
  }

  // A space's avatar color: the theme's own hue (quiet in Kanso), else a fixed one.
  fill(w, t) {
    const color = this.colors?.[w.id] ?? "ansi6";
    return color.startsWith("#") ? color : (t[color] ?? MARK[color]);
  }

  row({ w, i, g, tree }, t, mine = []) {
    const on = w.active;
    const fill = this.fill(w, t);
    const rt = t;
    // A wash of the text color, so a loud theme accent never paints the row.
    const wash = t.foreground + "14";
    const washHover = t.foreground + "0c";
    return v_flex()
      .relative()
      .id(`space-${w.id}`)
      .px(8)
      .h(rowHeight({ tree }))
      .flex_none()
      .justify_center()
      .rounded(6)
      .cursor_pointer()
      .when(on, (el) => el.bg(wash))
      .when(!on, (el) => el.hover((s) => s.bg(washHover)))
      .when(this.pressed !== null && this.over === i && this.pressed !== i, (el) => el.border_t(2).border_color(t.accent))
      .on_mouse_down("left", () => {
        this.pressed = i;
        this.over = i;
      })
      .on_mouse_up("left", (_e, cx) => {
        const from = this.pressed;
        this.pressed = null;
        if (from !== null && from !== i) run("space.move", { id: spaces()[from].id, index: i + 1 });
        else {
          // Like a desktop app's project list: the row itself folds. Arriving at a
          // space opens it; clicking the space you're in folds or opens it.
          if (mine.length) this.setAgentsFolded(w.id, on ? !this.agentsFolded.has(w.id) : false);
          if (!on) run("space.select", { id: w.id });
        }
        cx.notify();
      })
      .on_mouse_down("right", () => this.menu(w))
      .when(Boolean(tree), (el) => el.children(this.connector(tree, rt)))
      .child(
        h_flex()
          .gap(9)
          .items_center()
          .when(Boolean(tree), el => el.pl(CHILD_PAD).child(svg("mods/kanso-chrome/icons/branch.svg").size(13).text_color(rt.muted)))
          .when(!tree, el => el.child(h_flex().size(22).flex_none().rounded(6).bg(fill + "26").items_center().justify_center().text_size(12).font_semibold().text_color(fill).child(w.name[0]?.toUpperCase() ?? "?")))
          .child(div().flex_shrink(0).max_w(150).truncate().text_color(tree && !on ? rt.muted : rt.foreground).when(on, (el) => el.font_medium()).child(w.name))
          .child(g ? this.gitTail(g, tree, w.name, rt) : div().flex_1())
          .when(mine.length > 0, (el) => el.child(this.fold(w, mine, rt))),
      );
  }

  // Collapsed: the same avatar the open row shows, centred in a square, with a
  // dot only when the space needs you. The name is in the tooltip.
  compact({ w }, t) {
    const fill = this.fill(w, t);
    const speaks = w.status === "blocked" || w.status === "done";
    return h_flex().w_full().h(36).flex_none().justify_center().items_center().child(
      div()
        .id(`space-${w.id}`)
        .relative()
        .size(32)
        .flex_none()
        .flex()
        .items_center()
        .justify_center()
        .rounded(6)
        .cursor_pointer()
        .tooltip(w.name)
        .when(w.active, (el) => el.bg(t.foreground + "14"))
        .when(!w.active, (el) => el.hover((s) => s.bg(t.foreground + "0c")))
        .on_click(() => run("space.select", { id: w.id }))
        .on_mouse_down("right", () => this.menu(w))
        .child(h_flex().size(22).flex_none().rounded(6).bg(fill + "26").items_center().justify_center()
          .text_size(12).font_semibold().text_color(fill).child(w.name[0]?.toUpperCase() ?? "?"))
        .when(speaks, (el) => el.child(div().absolute().top(4).right(4).size(7).rounded_full()
          .border(1).border_color(t.chrome).bg(tone(t, w.status)))),
    );
  }

  render() {
    const t = theme();
    const collapsed = shared("sidebar.collapsed") === true;
    const palette = ["ansi6", "ansi3", "ansi4", "ansi5", "ansi2", "ansi1"];
    const sp = spaces();
    const ids = new Set(sp.map(p => p.id));
    const stored = shared("space.colors") ?? {};
    const kept = Object.fromEntries(Object.entries(stored).filter(([id]) => ids.has(id)));
    let changed = Object.keys(kept).length !== Object.keys(stored).length;
    for (const p of sp) {
      if (kept[p.id] || p.name === "~") continue;
      const uses = c => Object.values(kept).filter(v => v === c).length;
      kept[p.id] = palette.reduce((best, c) => uses(c) < uses(best) ? c : best);
      changed = true;
    }
    if (changed) setShared("space.colors", kept);
    this.colors = kept;
    const quiet = (id, icon, tip, action) => div().id(id).size(32).flex_none().flex().items_center().justify_center().rounded(6)
      .text_color(t.muted).cursor_pointer().tooltip(tip)
      .hover((s) => s.bg(t.foreground + "12").text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click(action)
      .child(svg(`mods/kanso-chrome/icons/${icon}.svg`).size(17));
    const toggle = () => {
      // Remember how wide you left it open, to open it the same width.
      if (!collapsed && this.width > OPEN_MIN - 1) setShared("sidebar.width", Math.round(this.width));
      setShared("sidebar.collapsed", !collapsed);
      setRail(collapsed, collapsed ? (shared("sidebar.width") ?? SIDEBAR_W) : collapsedW());
    };
    const plus = quiet("space-new", "plus", "New space", () => run("space.new"));
    const hide = quiet("sidebar-toggle", "sidebar", collapsed ? "Show sidebar" : "Hide sidebar", toggle);
    const search = quiet("search", "search", "Search", () => run("mod.open", { name: "picker" }));
    // Collapsed, Herdr's mark sits here over the buttons (open, it's in the
    // top bar beside the traffic lights, drawn by kanso-chrome).
    const brand = image("frame/welcome/herdr.png").size(20).rounded(6).flex_none();
    // One row when open: + at the left, search and hide at the right, same size.
    // Collapsed, stack them so two buttons never sit on top of each other.
    const add = collapsed
      ? v_flex().w_full().pt(8).gap(6).items_center().child(brand).child(plus).child(hide)
      : h_flex().h(40).px(10).gap(4).items_center()
        .child(plus)
        .child(div().flex_1())
        .child(search)
        .child(hide);
    return v_flex().id("spaces-root").size_full().min_h(0).bg(t.chrome).text_size(13)
      .on_size_change((size) => { this.width = size.width; })
      .child(add)
      .child(v_flex().flex_1().min_h(0).px(collapsed ? 0 : 8).pt(collapsed ? 6 : 0).pb(14).overflow_y_scrollbar().mode(collapsed ? "hover" : "always")
        .on_mouse_up("left", (_e, cx) => { this.pressed = null; this.draggedAgent = null; cx.notify(); })
        .children(this.grouped(t, collapsed)));
  }
}
