// Derived from the `workspace-status` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: no background or top border.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-status.
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-status; one quiet line; agents working and agents that need you.
// Zen: one quiet line. Where you are on the left; on the right, only what needs
// you speaks up (an agent waiting), else the agents count stays dim.
import { View, div, svg } from "gpui-kit";
import { h_flex } from "gpui-base";
import { spaces, agents, theme, run, window, props } from "herdr";

export default class WorkspaceStatus extends View {
  render() {
    const t = theme();
    // Two copies share the row. Each reads only what its side draws.
    const side = props()?.side;
    const left = side !== "right", right = side !== "left";
    const space = left ? spaces().find(s => s.active) : null;
    const list = right ? agents() : [];
    const needs = list.filter(a => a.status === "blocked").length;
    const working = list.filter(a => a.status === "working").length;
    const label = (icon, text) => h_flex().gap(6).items_center().min_w(0)
      .child(svg(`mods/kanso-chrome/icons/${icon}.svg`).size(13).flex_none()).child(div().truncate().child(text));
    const mac = window()?.platform === "macos";
    const agentsText = list.length === 0 ? "No agents"
      : working > 0 ? `${working} of ${list.length} working` : `${list.length} ${list.length === 1 ? "agent" : "agents"} idle`;
    // props.side: "left" draws where you are, "right" the agents and palette
    // (the strip's minimap sits between two copies); none draws both.
    return h_flex().size_full().px(12).gap(18).items_center().text_size(11.5).text_color(t.muted)
      .when(right && !left, el => el.justify_end())
      .when(left, el => el.child(label(space?.machine ? "server" : "monitor", space?.machine ?? "This computer"))
        .when(Boolean(space?.branch), el => el.child(label("branch", space.branch))))
      .when(left && right, el => el.child(div().flex_1()))
      .when(!right, el => el)
      .when(right && needs > 0, el => el.child(h_flex().gap(6).items_center().text_color(t.blocked)
        .child(div().size(6).rounded_full().bg(t.blocked))
        .child(needs === 1 ? "1 agent needs you" : `${needs} agents need you`)))
      .when(right, el => el.child(h_flex().gap(6).items_center()
        .child(div().size(6).rounded_full().bg(working > 0 ? t.working : t.idle))
        .child(agentsText)))
      .when(right, el => el.child(div().id("palette").px(6).py(2).rounded(6).cursor_pointer()
        .hover(s => s.bg(t.foreground + "0a").text_color(t.muted))
        .on_click(() => run("app.palette"))
        .child(mac ? "⌘⇧P" : "Ctrl+Shift+P")
        .tooltip("Command palette")));
  }
}
