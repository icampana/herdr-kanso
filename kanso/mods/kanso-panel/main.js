// Kanso's side panels, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// One mod, five panels: `props.panel` is "files" (a lazy file browser),
// "changes" (git status, diffs and a commit), "pr" (the branch's pull
// request, or another of your open ones picked from a list), "shipped" (what
// you delivered: lines, pull requests, reviews, streak and records) or "preview" (one file, rendered: Markdown as the SDK draws it,
// anything else as read-only code; `props.path`, `props.on`). kanso-tabs mounts one of them in the panel stack on demand and
// empties the stack to close it, so a panel exists only while it is shown
// and never has to watch whether it is. Each panel is a plain class with
// init(cx, props) and render(cx); what they share (where the focused pane is, diff
// rows) is in lib.js. Herdr lets a mod import its own files, not another's:
// this is why the three live together.
import { View } from "gpui-kit";
import { props } from "herdr";
import { Files } from "./files.js";
import { Changes } from "./changes.js";
import { PullRequest } from "./pr.js";
import { Preview } from "./preview.js";
import { Shipped } from "./shipped.js";

const PANELS = { files: Files, changes: Changes, pr: PullRequest, preview: Preview, shipped: Shipped };

export default class Panel extends View {
  init(_props, cx) {
    const p = props() ?? {};
    const Impl = PANELS[p.panel] ?? Files;
    this.panel = new Impl();
    this.panel.init(cx, p);
  }

  render(cx) {
    return this.panel.render(cx);
  }
}
