// Derived from the `workspace-chrome` mod shipped with Herdr (Apache-2.0, https://github.com/herdrdev/herdr-app).
// Modified by 0OZ: brand bar, solid sidebar footer with Settings, Add machine and an account chip.
// Modified by José Gutiérrez (minimalistic, 0oz design fork): renamed from oz-chrome.
// Modified by jlopezlira (Kanso, https://github.com/jlopezlira/herdr-kanso): renamed from mn-chrome; sidebar footer as centred squares when collapsed, one icon set (icons/), Herdr's mark beside the traffic lights; an "Update Kanso" row for Kanso's own releases (update.js).
import { View, div, svg, image } from "gpui-kit";
import { h_flex, v_flex } from "gpui-base";
import { theme, run, props, shared, updates, agents, home, window, nextCommand } from "herdr";
import { Updater } from "./update.js";

const basename = (path) => path.replace(/\/+$/, "").split("/").pop();

export default class WorkspaceChrome extends View {
  // Only the footer copy looks for Kanso releases (update.js); the top bar's never does.
  init(_props, cx) {
    if (!props()?.footer) return;
    this.updater = new Updater();
    this.updater.start(cx);
    // The "available" toast's click: kanso-chrome.update; kanso-chrome.check looks now.
    cx.spawn(async (cx) => {
      for (;;) {
        let c;
        try { c = await nextCommand(); } catch { break; }
        if (c === "update") this.updater.install(cx);
        else if (c === "check") { await this.updater.check(cx, true, true); this.updater.fit(); cx.notify(); }
      }
    });
  }

  render() {
    const t = theme();
    const collapsed = shared("sidebar.collapsed") === true;
    if (props()?.footer) {
      // Secondary nav (Settings, Add machine), then the account chip, as in shadcn's dashboard-01.
      // Collapsed, every item is a centred square with its label as a tooltip.
      const row = (id, icon, label, action) => h_flex().id(id).relative().h(34).flex_none().items_center().rounded(6)
        .text_color(t.muted).hover(s => s.bg(t.hover).text_color(t.foreground)).cursor_pointer()
        .on_click(action).child(svg(icon).size(17).flex_none())
        .when(collapsed, el => el.w(34).justify_center().tooltip(label))
        .when(!collapsed, el => el.px(10).gap(10).child(div().flex_1().child(label)));
      const dot = () => div().size(6).rounded_full().bg(t.accent).flex_none();
      const who = basename(home()) || "me";
      const n = agents().length;
      const count = `${n} ${n === 1 ? "agent" : "agents"}`;
      const avatar = div().size(collapsed ? 28 : 32).flex_none().rounded(6).bg(t.selected).flex().items_center().justify_center()
        .font_semibold().text_size(13).text_color(t.foreground).child(who[0].toUpperCase());
      const chip = h_flex().id("account").h(collapsed ? 40 : 48).flex_none().items_center().rounded(6).cursor_pointer()
        .hover(s => s.bg(t.hover)).on_click(() => run("app.settings")).child(avatar)
        .when(collapsed, el => el.w(40).justify_center().tooltip(`${who} · ${count}`))
        .when(!collapsed, el => el.px(8).gap(10).child(v_flex().flex_1().min_w(0)
          .child(div().truncate().text_size(13).font_medium().text_color(t.foreground).child(who))
          .child(div().truncate().text_size(11.5).text_color(t.muted).child(count))));
      const ready = Boolean(updates().app.ready);
      // Kanso's own release, apart from Herdr's: its own row, shown only when there is one.
      const kanso = this.updater?.available();
      const busy = this.updater?.busy;
      const kansoLabel = busy ? "Updating Kanso..." : `Update Kanso to ${kanso}`;
      return v_flex().size_full().bg(t.chrome).px(collapsed ? 0 : 8).pt(8).pb(12).gap(2).text_size(13).justify_end()
        .when(collapsed, el => el.items_center())
        .when(Boolean(kanso), el => el.child(row("kanso-update", "mods/kanso-chrome/icons/refresh.svg", kansoLabel,
          (_e, cx) => this.updater.install(cx))
          .when(!busy && !collapsed, el => el.child(dot()))
          .when(!busy && collapsed, el => el.child(dot().absolute().top(6).right(6)))))
        .child(row("settings", "mods/kanso-chrome/icons/settings.svg", ready ? "Settings · update ready" : "Settings", () => run("app.settings"))
          .when(ready && !collapsed, el => el.child(dot()))
          .when(ready && collapsed, el => el.child(dot().absolute().top(6).right(6))))
        // A server, not a second "+": the rail already has one for New space.
        .child(row("machine", "mods/kanso-chrome/icons/server.svg", "Add machine", () => run("mod.open", { name: "machine-add" })))
        .child(div().h(8).flex_none())
        .child(chip);
    }
    // The top bar holds the traffic lights and lets you drag the window. Open,
    // Herdr's mark sits at its right end, clear of the lights (collapsed, the
    // rail shows it lower, over the buttons). The actions live one row lower.
    const lights = window()?.platform === "macos" ? 76 : 14;
    return h_flex().size_full().bg(t.chrome).items_center().justify_end().pl(lights).pr(14).gap(8)
      .when(!collapsed, el => el.child(image("frame/welcome/herdr.png").size(20).rounded(6))
        .child(div().font_semibold().text_size(13).text_color(t.foreground).child("Herdr")));
  }
}
