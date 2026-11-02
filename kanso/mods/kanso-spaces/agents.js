// Added by José Gutiérrez (minimalistic): agents nested under their space. Pure drawing helpers; the
// fold state lives in main.js. statusMark and agentIcon mirror sdd-focused/lib/ui.js
// (Herdr doesn't let one mod import another's files): keep them in step.
import { div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { run, terminals, openOverlay } from "herdr";

const AGENT_ROW = 28;
const AGENT_PAD = 30; // under the space name: 8px row padding + 20px avatar + gap
const RANK = { blocked: 4, done: 3, working: 2, idle: 1 };

const clean = (s) => (s ?? "").replace(/^[^\p{L}\p{N}]+/u, "").trim();

// What you told Kanso about a terminal lives as labels on the terminal
// itself, in herdr-core, so it survives a restart and every Kanso mod reads
// the same: `kanso.name` is the name you gave it (double-click its row or
// its pane header), `kanso.pin` its place among the pinned sessions (the
// pin on its row). By address.
export const NAME_LABEL = "kanso.name";
export const PIN_LABEL = "kanso.pin";
export function labelsOf() {
  const out = new Map();
  for (const term of terminals()) if (term?.labels) out.set(term.address, term.labels);
  return out;
}
export function givenNames() {
  const out = new Map();
  for (const [address, labels] of labelsOf()) if (labels[NAME_LABEL]) out.set(address, labels[NAME_LABEL]);
  return out;
}

// ---- Order ----------------------------------------------------------------------

// How a space's sessions are listed, as T3 Code lists its threads: the
// pinned ones first, in the order you drag them, then the rest by the order
// you chose. `seq` is Herdr's "changed more recently" counter.
export const ORDERS = {
  updated: "Last update",
  attention: "Needs you first",
  type: "By kind",
  screen: "As on screen",
  custom: "Your order (drag)",
};
export const DEFAULT_ORDER = "updated";
const KIND = (a) => (a.program?.agent || a.app ? 0 : a.program?.shell ? 1 : 2);
const kindName = (a) => (a.app || a.program?.name || "").toLowerCase();

// `list` comes in screen order (the stable tiebreak); `custom` is the
// addresses in the order you dragged them, for the custom order.
export function orderSessions(list, mode, custom = []) {
  const by = (cmp) => list.map((a, i) => [a, i]).sort((x, y) => cmp(x[0], y[0]) || x[1] - y[1]).map(([a]) => a);
  const fresh = (x, y) => (y.seq ?? 0) - (x.seq ?? 0);
  const rest = mode === "attention" ? by((x, y) => (RANK[y.status] ?? 0) - (RANK[x.status] ?? 0) || fresh(x, y))
    : mode === "type" ? by((x, y) => KIND(x) - KIND(y) || kindName(x).localeCompare(kindName(y)) || fresh(x, y))
    : mode === "screen" ? list
    : mode === "custom" ? by((x, y) => { const i = custom.indexOf(x.address), j = custom.indexOf(y.address); return (i < 0 ? 1e9 : i) - (j < 0 ? 1e9 : j) || fresh(x, y); })
    : by(fresh);
  const pinned = rest.filter((a) => a.pin != null).sort((x, y) => x.pin - y.pin);
  return [...pinned, ...rest.filter((a) => a.pin == null)];
}

// A list with `address` moved before or after `target` (both in it).
export function moved(order, address, target, side) {
  const out = order.filter((x) => x !== address);
  const at = out.indexOf(target);
  out.splice(side === "after" ? at + 1 : at, 0, address);
  return out;
}

// Renaming a terminal: the same dialog Herdr opens to rename a space or a
// tab (`kanso-prompt`, a copy of Herdr's prompt that writes the label). It
// opens with the name the terminal shows now; Enter saves, Esc leaves it,
// and an empty name brings the automatic one back.
export const PROMPT_W = 420;
export function renameTerminal(terminal, shown) {
  openOverlay({ mod: "kanso-prompt", kind: "dialog", width: PROMPT_W, props: {
    title: "Rename terminal", value: shown ?? "", hint: "Empty: the name the program gives it",
    label: { terminal, key: NAME_LABEL } } });
}

// The name you gave the terminal; else the agent's own title ("Subida de
// inventarios…"), unless it is only a path, a user@host prompt or the
// program's name: then the tab's name.
export function agentLabel(a) {
  if (a.name) return a.name;
  const live = clean(a.title);
  const telling = live && !/^[~/]|^[A-Za-z]:\\/.test(live) && !live.includes("@")
    && live.toLowerCase() !== a.program?.key && live !== a.program?.name;
  if (telling) return live;
  // A shell says nothing about itself: name it after its folder.
  const dir = a.program?.shell && a.cwd ? a.cwd.replace(/\/+$/, "").split("/").pop() : null;
  if (dir) return dir;
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
  if (status === "blocked" && compact) return div().size(14).flex_none().rounded(6).bg(t.blocked + "26").text_size(10.5).font_bold().text_color(t.blocked).flex().items_center().justify_center().child("!");
  if (status === "blocked") return div().flex_none().px(6).h(18).rounded(6).bg(t.blocked + "26").text_size(10.5).font_semibold().text_color(t.blocked).flex().items_center().child("Needs you");
  if (status === "done") return div().size(7).mx(3).flex_none().rounded_full().bg(t.done);
  // No status (a terminal that doesn't report one): no mark, same width.
  if (!status) return div().size(7).mx(3).flex_none();
  return div().size(7).mx(3).flex_none().rounded_full().border(1.5).border_color(t.idle ?? t.dim);
}

// Herdr's agents() lists only programs that report a status. Every other
// terminal (an agent that doesn't report, such as Codex or a model's own CLI,
// a shell, a server) joins the list in the same shape, with no status, so the
// sidebar shows every session in the space.
export function withTerminals(list, ps, ss) {
  const known = new Set(list.map((a) => a.pane));
  const where = {};
  for (const s of ss) (s.tabs ?? []).forEach((tb, i) => { where[tb.id] = { space: s.id, space_name: s.name, tab_index: i, tab_name: tb.name }; });
  const rest = ps.filter((p) => p.terminal && !known.has(p.pane) && where[p.tab])
    .map((p) => ({ address: p.terminal, pane: p.pane, tab: p.tab, ...where[p.tab], status: null, app: null, program: p.program, title: p.title, cwd: p.cwd, seq: 0, focused: p.focused }));
  return rest.length ? [...list, ...rest] : list;
}

// The most urgent state among agents: blocked > done > working > idle.
export const mostUrgent = (list) => list.reduce((m, a) => ((RANK[a.status] ?? 0) > (RANK[m] ?? 0) ? a.status : m), null);

// The fold toggle at the end of a space row. Folded, it tells how many agents and
// the most urgent state among them, so a blocked agent is never hidden.
export function agentFold(id, mine, open, onToggle, t) {
  const top = mostUrgent(mine);
  return h_flex().id(`agents-fold-${id}`).flex_none().h(20).px(3).gap(4).items_center().rounded(6)
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

// One session under its space: icon, name, machine (remote), pin, state.
// Zen: the focused one carries full ink and a faint wash, the rest stay
// muted; clicking goes to its pane; a double-click renames it.
// `row`: { drag: { target, down, up } | null (the row can be dragged to
// reorder its section), hovered, hover(h, cx), pin(cx) (toggles the pin) }.
// Each event has one handler: a second one would replace the first.
export function agentRow(a, indent, t, row) {
  const pic = agentIcon(a.program, 15, t.foreground);
  const idle = (a.status === "idle" || a.status === "done" || !a.status) && !a.focused;
  const machine = a.address.includes("/") ? a.address.split("/")[0] : null;
  const pinned = a.pin != null, drag = row?.drag;
  return h_flex().id(`space-agent-${a.address}`).h(AGENT_ROW).flex_none().pl(AGENT_PAD + indent).pr(8).gap(8)
    .items_center().rounded(6).text_size(12.5).cursor_pointer()
    .when(a.focused, (el) => el.bg(t.foreground + "0c"))
    .hover((s) => s.bg(t.foreground + "0c"))
    .on_click(() => run("pane.focus", { pane: a.pane }))
    .on_mouse_down("left", (e) => { if (e.click_count === 2) renameTerminal(a.address, agentLabel(a)); else drag?.down(); })
    .when(Boolean(drag), (el) => el.on_mouse_up("left", (_e, cx) => drag.up(cx)))
    .when(Boolean(row), (el) => el.on_hover((h, cx) => row.hover(h, cx)))
    // Dropping: a line on the side the session will land on.
    .when(drag?.target === "before", (el) => el.border_t(2).border_color(t.accent))
    .when(drag?.target === "after", (el) => el.border_b(2).border_color(t.accent))
    .when(Boolean(pic), (el) => el.child(pic.opacity(a.focused ? 1 : 0.8)))
    .child(div().flex_1().min_w(0).truncate()
      .text_color(a.focused ? t.foreground : idle ? t.dim : t.muted)
      .when(a.focused, (el) => el.font_medium())
      .child(agentLabel(a)))
    .when(Boolean(machine), (el) => el.child(div().flex_none().text_size(10).text_color(t.dim).child(machine)))
    // The pin: always shown on a pinned session, on hover on the rest; a
    // click pins or unpins (the row's own click stays a focus).
    .when(Boolean(row) && (pinned || row.hovered), (el) => el.child(div().id(`pin-${a.address}`).size(18).flex_none().rounded(6)
      .flex().items_center().justify_center().text_color(pinned ? t.foreground : t.dim).tooltip(pinned ? "Unpin" : "Pin to the top")
      .hover((s) => s.bg(t.input).text_color(t.foreground))
      .on_mouse_down("left", (_e, cx) => cx.stop_propagation())
      .on_click((_e, cx) => { cx.stop_propagation(); row.pin(cx); })
      .child(svg("mods/kanso-chrome/icons/pin.svg").size(11))))
    .child(statusMark(t, a.status, true));
}
