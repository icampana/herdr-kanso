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
import { panes, props, run, theme, home, focused, shared, setShared } from "herdr";

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

  button(t, id, icon, command, args) {
    return div()
      .id(id)
      .p(5)
      .rounded(6)
      .text_color(t.muted)
      .hover((s) => s.bg(t.hover).text_color(t.foreground))
      .on_click((_e, cx) => {
        cx.stop_propagation();
        this.act(command, args);
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
    // No background and no rule under it: the header is part of the pane, and
    // only the focused pane's title carries full ink.
    const strip = Boolean(props()?.strip);
    const on = p.focused || (strip && p.terminal && focused()?.terminal === p.terminal);
    // Ctrl+drag a header onto another to rearrange the strip (Shift: stack).
    const drag = strip ? shared("strip.drag") : null;
    const dropping = Boolean(drag && drag.pane !== pane && this.hovered);
    return h_flex()
      .id(`pane-head-${pane}`)
      .size_full()
      .px(14)
      .gap(10)
      .items_center()
      .text_size(12.5)
      .when(dropping, (el) => el.bg(t.foreground + "12"))
      .when(Boolean(drag) && drag.pane === pane, (el) => el.opacity(0.5))
      .on_hover((hovered, cx) => { this.hovered = hovered; cx.notify(); })
      .when(strip, (el) => el
        .on_scroll_wheel((e) => this.wheel(e))
        .on_mouse_down("left", (e) => {
          if (e.modifiers.control) setShared("strip.drag", { pane, at: Date.now() });
          else if (shared("strip.drag")) setShared("strip.drag", null); // a drag dropped elsewhere
        })
        .on_mouse_up("left", (e) => {
          const d = shared("strip.drag");
          if (!d) return;
          if (d.pane !== pane && Date.now() - d.at < 15000) setShared("strip.req", { op: "move", pane: d.pane, to: pane, stack: e.modifiers.shift, n: Date.now() + Math.random() });
          setShared("strip.drag", null);
        }))
      .on_click(() => run("pane.focus", strip && p.terminal ? { terminal: p.terminal } : { pane }))
      .when(Boolean(pic), (el) => el.child(pic.opacity(on ? 1 : 0.75)))
      .child(div().flex_none().truncate().max_w(260).text_size(12.5).when(on, el => el.font_medium()).text_color(on ? t.foreground : t.muted).child(name))
      .when(Boolean(p.cwd), (el) => el.child(this.where(t, folder(p.cwd), null, on)))
      .when(Boolean(p.branch), (el) => el.child(this.where(t, p.branch, "mods/kanso-chrome/icons/branch.svg", on)))
      .child(div().flex_1())
      .when(st === "working" && !this.hovered, el => el.child(h_flex().w(12).h(12).flex_none().items_center().justify_center().text_size(10).text_color(t.working).child(div().frames(["\u00b7", "\u2022", "\u25cf", "\u2022"], 450))))
      .when(st === "blocked", el => el.child(h_flex().flex_none().gap(6).items_center().text_size(11.5).text_color(t.blocked)
        .child(div().size(6).rounded_full().bg(t.blocked)).child("Needs you")))
      .when(st === "done" && !this.hovered, el => el.child(div().size(6).flex_none().rounded_full().bg(t.done)))
      .when(this.hovered, el => el
        .child(this.button(t, `ph-r-${pane}`, "split-right", "pane.split", { direction: "right", pane }))
        .child(this.button(t, `ph-d-${pane}`, "split-down", "pane.split", { direction: "down", pane }))
        .child(this.button(t, `ph-z-${pane}`, p.zoomed ? "unzoom" : "zoom", "pane.zoom", { pane }))
        .child(this.button(t, `ph-x-${pane}`, "close", "pane.close", { pane })));
  }
}
