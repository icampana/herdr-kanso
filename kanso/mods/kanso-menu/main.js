// Kanso's terminal right-click menu, by jlopezlira (https://github.com/jlopezlira/herdr-kanso).
// Apache-2.0; derived from Herdr's shipped `menu` mod.
//
// In the strip a terminal is a layout block, so Herdr's menu gets the block's
// id ("term-<pane>") as its target pane and every pane command fails with
// "no pane". This menu finds the real pane from the clicked terminal and
// splits through the strip, so the new pane lands beside the clicked one.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex } from "gpui-base";
import { run, props, closeOverlay, openOverlay, theme, terminals, panes, spaces, setShared, keys } from "herdr";

const ICON = "mods/kanso-chrome/icons/";

// The clicked pane's folder in a code editor (the `open-with` mod), on the
// machine its space lives on.
function openWith(p) {
  const space = spaces().find((s) => s.tabs.some((x) => x.id === p.tab));
  openOverlay({ mod: "open-with", kind: "popup", width: 340, props: { folder: p.cwd, machine: space?.machine ?? null } });
}

// The model pane behind the clicked terminal (or block).
function realPane(tg) {
  const ps = panes();
  return ps.find((p) => p.pane === tg.pane)?.pane
    ?? ps.find((p) => p.terminal && p.terminal === tg.terminal)?.pane
    ?? String(tg.pane ?? "").replace(/^term-/, "");
}

function items(tg) {
  const pane = realPane(tg);
  const all = terminals();
  const term = all.find((t) => t.address === tg.terminal);
  const parent = term?.parent && all.find((t) => t.address === term.parent);
  const toProgram = term?.labels?.["herdr.right-click"] === "program";
  const info = panes().find((p) => p.pane === pane);
  // A split first tells the strip where the new pane goes.
  const split = (label, dir, icon, key) => [label, () => {
    setShared("strip.intent", { dir, from: pane, at: Date.now() });
    run("pane.split", { pane, direction: "right" });
  }, icon, key];
  return [
    split("Split right", "right", "split-right", "kanso-strip.new-right"),
    split("Split left", "left", "split-right", "kanso-strip.new-left"),
    ["Wider or narrower", () => setShared("strip.req", { op: "width", pane, n: Date.now() + Math.random() }), "zoom", "kanso-strip.width"],
    ...(term ? [[toProgram ? "Use Herdr right-click menu" : "Send right-clicks to pane",
      () => run("terminal.right_click", { terminal: term.address, to: toProgram ? "menu" : "program" }), "sidebar", null]] : []),
    ...(parent ? [[`Send back to ${parent.name || parent.address}`, () => run("terminal.park", { terminal: term.address }), "chevron-right", null]] : []),
    ...(info?.cwd ? [["Open with…", () => openWith(info), "open-with", "mod.open:open-with"]] : []),
    ["Close pane", () => run("pane.close", { pane }), "close", "kanso-strip.close"],
  ];
}

const shortcut = (action) => (action ? keys().find((b) => b.action === action)?.keys ?? "" : "");

export default class KansoMenu extends View {
  init(_props, cx) {
    this.at = 0;
    this.handle = cx.focus_handle();
    this.handle.focus();
  }

  choose(i) {
    const it = items(props()?.target ?? {})[i];
    if (!it) return;
    closeOverlay(props()?.overlay);
    it[1]();
  }

  render() {
    const t = theme();
    const list = items(props()?.target ?? {});
    return v_flex().id("kanso-menu").track_focus(this.handle).w_full().min_h(0).p(5).bg(t.popover).text_size(12.8)
      .on_key_down((e, cx) => {
        if (e.key === "down") this.at = (this.at + 1) % list.length;
        else if (e.key === "up") this.at = (this.at + list.length - 1) % list.length;
        else if (e.key === "enter") this.choose(this.at);
        else if (e.key === "escape") closeOverlay(props().overlay);
        else return;
        cx.notify();
      })
      .children(list.map((it, i) => v_flex()
        .when(i > 0 && (i === 2 || it[0] === "Open with…" || it[0] === "Close pane"),(el) => el.child(div().mx(7).my(4).h(1).bg(t.border)))
        .child(h_flex().id(`km-${i}`).h(30).px(8).gap(9).rounded(7).items_center()
          .text_color(t.foreground).when(i === this.at, (el) => el.bg(t.selected)).hover((s) => s.bg(t.hover))
          .on_click(() => this.choose(i))
          .child(svg(`${ICON}${it[2]}.svg`).size(14).flex_none().text_color(t.muted))
          .child(div().flex_1().child(it[0]))
          .child(div().text_size(11).text_color(t.dim).child(shortcut(it[3]))))));
  }
}
