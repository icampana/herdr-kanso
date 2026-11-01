// Added by José Gutiérrez (minimalistic): agents nested under their space. Pure drawing helpers; the
// fold state lives in main.js. statusMark and agentIcon mirror sdd-focused/lib/ui.js
// (Herdr doesn't let one mod import another's files): keep them in step.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run } from "herdr";

const AGENT_ROW = 28;
const AGENT_PAD = 30; // under the space name: 8px row padding + 20px avatar + gap
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// The agent's own title ("Subida de inventarios…"), unless it is only a path,
// a user@host prompt or the program's name: then the tab's name.
export function agentLabel(a) {
  const live = clean(a.title);
  const telling = live && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@")
    && live.toLowerCase() !== a.program?.key && live !== a.program?.name;
  if (telling) return live;
  return /^\d+$/.test(a.tab_name ?? "") ? a.program?.name || a.tab_name : a.tab_name || a.program?.name || a.address;
}

export function agentIcon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

// Same marks as the shipped agents list: spinner, "!" / "Needs you", done dot, idle ring.
export function statusMark(t, status, compact = false) {
  // A slow breathing dot, not a spinner: .frames redraws ~2 times a second where
  // .spin redraws the whole window ~30 times a second while any agent works.
  if (status === "working") return h_flex().w(12).h(12).mx(1).flex_none().items_center().justify_center().text_size(10).text_color(t.working).child(div().frames(["\u00b7", "\u2022", "\u25cf", "\u2022"], 450));
  if (status === "blocked" && compact) return div().size(14).flex_none().rounded(4).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "blocked") return div().flex_none().px(6).h(18).rounded(5).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (status === "done") return div().size(7).mx(3).flex_none().rounded(4).bg(t.done);
  return div().size(7).mx(3).flex_none().rounded(4).border(1.5).border_color(t.idle ?? t.dim);
}

// Herdr's agents() lists only programs that report a status. Agents that
// don't (Codex, for one) are still recognized by name: panes whose program is
// one of `keys` (knownAgents) join the list, in the same shape, with no status.
export function withQuiet(list, ps, ss, keys) {
  const known = new Set(list.map((a) => a.pane));
  const where = {};
  for (const s of ss) (s.tabs ?? []).forEach((tb, i) => { where[tb.id] = { space: s.id, space_name: s.name, tab_index: i, tab_name: tb.name }; });
  const quiet = ps.filter((p) => p.terminal && !known.has(p.pane) && keys.has(p.program?.key) && where[p.tab])
    .map((p) => ({ address: p.terminal, pane: p.pane, tab: p.tab, ...where[p.tab], status: null, app: null, program: p.program, title: p.title, seq: 0, focused: p.focused }));
  return quiet.length ? [...list, ...quiet] : list;
}

// The most urgent state among agents: blocked > done > working > idle.
export const mostUrgent = (list) => list.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);

// The fold toggle at the end of a space row. Folded, it tells how many agents and
// the most urgent state among them, so a blocked agent is never hidden.
export function agentFold(id, mine, open, onToggle, t) {
  const top = mostUrgent(mine);
  return h_flex().id(`agents-fold-${id}`).flex_none().h(20).px(3).gap(4).items_center().rounded(5)
    .text_size(11).text_color(t.dim).cursor_pointer()
    .hover((s) => s.bg(t.input).text_color(t.foreground))
    // The row selects on mouse up and drags on mouse down: keep both to the toggle.
    .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
    .on_mouse_up("left", (_e, cx) => { cx.stop_propagation(); onToggle(cx); })
    .when(!open, (el) => el
      .when(Boolean(top) && top !== "idle", (el) => el.child(statusMark(t, top, true)))
      .child(div().child(String(mine.length))))
    .child(svg(`mods/kanso-chrome/icons/chevron-${open ? "down" : "right"}.svg`).size(12).flex_none());
}

// One agent under its space: icon, title, machine (remote), state. Zen: the
// focused one carries full ink and a faint wash, the rest stay muted; clicking
// goes to its pane.
export function agentRow(a, indent, t) {
  const pic = agentIcon(a.program, 15, t.foreground);
  const idle = (a.status === "idle" || a.status === "done") && !a.focused;
  const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
  return h_flex().id(`space-agent-${a.address}`).h(AGENT_ROW).flex_none().pl(AGENT_PAD + indent).pr(8).gap(8)
    .items_center().rounded(8).text_size(12.5).cursor_pointer()
    .when(a.focused, (el) => el.bg(t.foreground + "0c"))
    .hover((s) => s.bg(t.foreground + "0c"))
    .on_click(() => run("pane.focus", { pane: a.pane }))
    .when(Boolean(pic), (el) => el.child(pic.opacity(a.focused ? 1 : 0.8)))
    .child(div().flex_1().min_w(0).truncate()
      .text_color(a.focused ? t.foreground : idle ? t.dim : t.muted)
      .when(a.focused, (el) => el.font_medium())
      .child(agentLabel(a)))
    .when(Boolean(machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(machine)))
    .child(statusMark(t, a.status, true));
}
