// Derived from the `pane` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: outlined folder and branch badges, no header background, focus shown by title colour.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-pane; an SDD-Focused spec pane is titled "Spec".
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-pane; quiet header: no rule or outlined badges, only the focused pane in full ink, controls replace the status on hover.
// A pane's header, for layouts that frame their panes:
//   { "tab": "active", "pane": { "header": { "content": { "mod": "kanso-pane" } } } }
// Shows the program's icon (the app's program table), the agent's name or
// the terminal's title, the folder, and the agent's status; buttons split, zoom and close
// this pane. Props from the app: { pane, terminal }. Click: focus the pane.

import { View, div, svg, image } from "gpui-kit";
import { h_flex } from "gpui-base";
import { panes, spaces, props, run, openOverlay, theme, home, focused, shared, setShared } from "herdr";

const BADGE_MAX_W = 220;

function icon(p, size, color) {
  if (!p?.icon) return null;
  return p.tint ? svg(p.icon).size(size).flex_none().text_color(color) : image(p.icon).w(size).h(size).flex_none();
}

function folder(cwd) {
  if (!cwd) return "";
  const h = home();
  return cwd === h ? "~" : cwd.startsWith(h + "/") ? "~" + cwd.slice(h.length) : cwd;
}

export default class Pane extends View {
  init() { this.hovered = false; }

  me() {
    return panes().find((p) => p.pane === props()?.pane);
  }

  // Where the pane is: quiet text, no outline. The branch keeps its glyph.
  where(t, text, iconPath, on) {
    return h_flex()
      .flex_shrink(1)
      .min_w(0)
      .max_w(BADGE_MAX_W)
      .gap(4)
      .items_center()
      .text_size(11.5)
      .text_color(on ? t.muted : t.dim)
      .when(Boolean(iconPath), (el) => el.child(svg(iconPath).size(12).flex_none()))
      .child(div().min_w(0).truncate().child(text));
  }

  // In the strip (props.strip), a split first says where the new pane goes,
  // and the zoom button cycles the column's width instead.
  act(command, args) {
    const pane = props()?.pane;
    if (props()?.strip && command === "pane.split") setShared("strip.intent", { dir: args.direction, from: pane, at: Date.now() });
    if (props()?.strip && command === "pane.zoom") { setShared("strip.req", { op: "width", pane, n: Date.now() + Math.random() }); return; }
    run(command, args);
  }

  // Wheel or swipe over a header slides the canvas continuously (600px of
  // travel = one view width; a mouse notch = 40px).
  wheel(e) {
    const lines = e.delta_lines?.y ?? 0;
    const d = lines ? -lines * 40 : (Math.abs(e.delta.x) > Math.abs(e.delta.y) ? -e.delta.x : -e.delta.y);
    if (!d) return;
    setShared("strip.req", { op: "scroll", d: d / 600, n: Date.now() + Math.random() });
  }

  // The pane's folder in a code editor (the `open-with` mod), on the machine
  // its space lives on.
  openWith(p) {
    const space = spaces().find((s) => s.tabs.some((x) => x.id === p.tab));
    openOverlay({ mod: "open-with", kind: "popup", width: 340, props: { folder: p.cwd, machine: space?.machine ?? null } });
  }

  // The six-dot grip near the header's right edge: drag it onto another
  // header to move this pane before or after that one (shared "strip.drag"
  // while held; Ctrl+drag anywhere on the header does the same).
  grip(t, pane) {
    const held = shared("strip.drag")?.pane === pane;
    return div().id(`grip-${pane}`).w(18).h_full().flex_none().flex().items_center().justify_center().cursor_grab()
      .tooltip("Drag to move before or after another pane")
      .text_color(held ? t.foreground : t.dim)
      .hover((h) => h.text_color(t.foreground))
      .on_mouse_down("left", (e, cx) => { cx.stop_propagation(); setShared("strip.drag", { pane, at: Date.now() }); })
      .child(svg("mods/kanso-chrome/icons/grip-vertical.svg").size(14));
  }

  // While a move is held, every header reports which half of it the pointer
  // is on. (Resizing is Herdr's own divider between columns, not a handle.)
  dragMove(e, cx) {
    const width = e.bounds?.width || this.width || 0;
    if (width) this.width = width;
    if (shared("strip.drag")) {
      // Three zones: the left quarter puts it before this column, the right
      // quarter after, the middle stacks it under this pane.
      const x = e.local_position.x;
      const side = x < width / 4 ? "before" : x > width * 3 / 4 ? "after" : "into";
      if (side !== this.dropSide) { this.dropSide = side; cx.notify(); }
    }
  }

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(5)
      .rounded(6)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        if (typeof command === "function") command();
        else this.act(command, args);
      })
      .child(svg(`mods/kanso-chrome/icons/${icon}.svg`).size(15));
  }

  render(cx) {
    const t = theme();
    const p = this.me();
    if (!p) return div();
    const name = p.mod === "sdd-focused" ? "Spec" : ((p.program?.agent || p.program?.shell) && p.program.name) || p.title || p.program?.name || "shell";
    const pic = icon(p.program, 15, t.muted);
    const st = p.status;
    const pane = p.pane;
    // No rule under it: the header is part of the pane. The selected pane's
    // header is a shade lighter and its title in full ink; in the strip that
    // is the pane the strip remembers, so it stays marked while a side panel
    // has the keyboard. A pane whose agent needs you can't be missed: its
    // header is tinted in the alarm color over a breathing bar of it.
    const strip = Boolean(props()?.strip);
    const remembered = strip ? shared("strip.state")?.[p.tab]?.focus : null;
    const on = remembered ? remembered === pane : p.focused || (strip && p.terminal && focused()?.terminal === p.terminal);
    // Ctrl+drag a header onto another to rearrange the strip.
    const drag = strip ? shared("strip.drag") : null;
    const dropping = Boolean(drag && drag.pane !== pane && this.hovered);
    const side = this.dropSide ?? "after";
    const ink = on || st === "blocked";
    // A pinned pane stays on its side of the view: a pin by its title says so.
    const pinned = strip && Boolean(shared("strip.state")?.[p.tab]?.cols?.find((c) => c.panes?.includes(pane))?.pin);
    const pin = () => setShared("strip.req", { op: "pin", pane, n: Date.now() + Math.random() }); // full ink: the selected pane, and one that needs you
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .pl(14)
      .pr(6)
      .gap(10)
      .items_center()
      .text_size(12.5)
      .relative()
      // The pane is a rounded slab; the header's wash follows its top corners.
      .rounded_t(8)
      // Pinned: the accent's tint, a little stronger when it's also the selected one.
      .when(pinned && st !== "blocked", (el) => el.bg(t.accent + (on ? "40" : "24")))
      .when(st === "blocked", (el) => el.bg(t.blocked + "66")
        .child(div().absolute().left_0().bottom_0().w_full().h(2).bg(t.blocked).loop("opacity", { from: 0.45, to: 1, period: 1600 })))
      .when(on && !pinned && st !== "blocked", (el) => el.bg(t.selected))
      // Dropping: a bar on the edge the pane will land on.
      .when(dropping && side === "before", (el) => el.border_l(3).border_color(t.foreground))
      .when(dropping && side === "after", (el) => el.border_r(3).border_color(t.foreground))
      .when(dropping && side === "into", (el) => el.bg(t.accent + "40"))
      .when(Boolean(drag) && drag.pane === pane, (el) => el.opacity(0.5))
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .on_size_change((sz) => { this.width = sz.width; })
      .when(strip, (el) => el
        .on_scroll_wheel((e) => this.wheel(e))
        .on_mouse_move((e, cx) => this.dragMove(e, cx))
        .on_mouse_down("left", (e) => {
          if (e.modifiers.control && !pinned) setShared("strip.drag", { pane, at: Date.now() });
          else if (shared("strip.drag")) setShared("strip.drag", null); // a drag dropped elsewhere
        })
        .on_mouse_up("left", (e) => {
          const d = shared("strip.drag");
          if (!d) return;
          if (d.pane !== pane && Date.now() - d.at < 15000) setShared("strip.req", { op: "move", pane: d.pane, to: pane, side, n: Date.now() + Math.random() });
          setShared("strip.drag", null);
          this.dropSide = null;
        }))
      .on_click(() => run("pane.focus", strip && p.terminal ? { terminal: p.terminal } : { pane }))
      .when(Boolean(pic), (el) => el.child(pic.opacity(ink ? 1 : 0.75)))
      .child(div().flex_none().truncate().max_w(260).text_size(12.5).when(ink, el => el.font_medium()).text_color(ink ? t.foreground : t.muted).child(name))
      .when(Boolean(p.cwd), (el) => el.child(this.where(t, folder(p.cwd), null, ink)))
      .when(Boolean(p.branch), (el) => el.child(this.where(t, p.branch, "mods/kanso-chrome/icons/branch.svg", ink)))
      .when(pinned && !this.hovered, (el) => el.child(svg("mods/kanso-chrome/icons/pin.svg").size(12).flex_none().text_color(t.dim)))
      .child(div().flex_1())
      .when(st === "working" && !this.hovered, el => el.child(h_flex().w(12).h(12).flex_none().items_center().justify_center().text_size(10).text_color(t.working).child(div().frames(["\u00b7", "\u2022", "\u25cf", "\u2022"], 450))))
      .when(st === "blocked", el => el.child(h_flex().flex_none().gap(6).items_center().text_size(11.5).font_medium().text_color(t.foreground)
        .child(div().size(7).rounded_full().bg(t.blocked).loop("opacity", { from: 0.45, to: 1, period: 1600 })).child("Needs you")))
      .when(st === "done" && !this.hovered, el => el.child(div().size(6).flex_none().rounded_full().bg(t.done)))
      .when(this.hovered, el => el
        .when(strip, el => el.child(this.button(t, `ph-p-${pane}`, "pin", pin).when(pinned, (b) => b.text_color(t.foreground))))
        .when(Boolean(p.cwd), el => el.child(this.button(t, `ph-o-${pane}`, "open-with", () => this.openWith(p))))
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })))
      .when(strip && !pinned, (el) => el.child(this.grip(t, pane)));
  }
}
