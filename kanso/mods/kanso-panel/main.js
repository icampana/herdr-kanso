// Kanso's side panels, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// One mod, three panels: `props.panel` is "files" (a lazy file browser),
// "changes" (git status, diffs and a commit) or "pr" (the branch's pull
// request). kanso-tabs mounts one of them in the panel stack on demand and
// empties the stack to close it, so a panel exists only while it is shown
// and never has to watch whether it is. Each panel is a plain class with
// init(cx) and render(cx); what they share (where the focused pane is, diff
// rows) is in lib.js. Herdr lets a mod import its own files, not another's:
// this is why the three live together.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Files } from "./files.js";
import { Changes } from "./changes.js";
import { PullRequest } from "./pr.js";

const PANELS = { files: Files, changes: Changes, pr: PullRequest };

export default class Panel extends View {
  init(_props, cx) {
    const Impl = PANELS[props()?.panel] ?? Files;
    this.panel = new Impl();
    this.panel.init(cx);
  }

  render(cx) {
    return this.panel.render(cx);
  }
}
