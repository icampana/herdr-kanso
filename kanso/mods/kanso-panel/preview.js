// One file in the side panel, without an editor: Markdown rendered by the
// SDK (TextView), anything else as read-only code. "Open with" offers it for
// text files, in place of an external editor. The file is read again when its
// folder changes (an agent writing a doc shows up as it writes), so the panel
// is a live view of the file. Props: { path, on } (the machine, null here).
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Editor } from "gpui-base";
import { readTextFile, watchFolder, theme, home, openOverlay } from "herdr";
import { codeState, markdownView, isMarkdown, showPanel } from "./lib.js";

const folderOf = (path) => path.replace(/[\\/][^\\/]*$/, "") || "/";
const nameOf = (path) => path.split(/[\\/]/).pop();

export class Preview {
  init(cx, p) {
    this.path = p.path ?? "";
    this.on = p.on ?? null;
    this.text = null; this.code = null; this.error = null;
    this.load(cx);
    this.watch(cx);
  }

  load(cx) {
    const path = this.path;
    cx.spawn(async (cx) => {
      try {
        const text = await readTextFile(path, { on: this.on });
        if (this.path !== path) return;
        if (text === null) { this.error = "This file is no longer available"; this.text = null; }
        else if (text.includes("\0")) { this.error = "Binary file: no text preview"; this.text = null; }
        else {
          this.error = null;
          if (isMarkdown(path)) this.text = text;
          else { this.code?.release(); this.code = codeState(path, text); }
        }
      } catch (e) { this.error = `Cannot read this file: ${e?.message ?? e}`; }
      finally { cx.notify(); }
    });
  }

  // Watch the file's folder (this computer only) and read the file again on
  // every change there.
  watch(cx) {
    if (this.on) return;
    const dir = folderOf(this.path);
    cx.spawn(async (cx) => {
      try { for (;;) { await watchFolder(dir); this.load(cx); } } catch {}
    });
  }

  openWith() {
    openOverlay({ mod: "open-with", kind: "popup", width: 340, props: { file: this.path, folder: folderOf(this.path), machine: this.on } });
  }

  shortFolder() {
    const dir = folderOf(this.path), h = home();
    if (this.on) return `${this.on}: ${dir}`;
    return dir === h ? "~" : dir.startsWith(h + "/") ? "~" + dir.slice(h.length) : dir;
  }

  render() {
    const t = theme();
    const button = (id, icon, tip, action) => div().id(id).p(4).rounded(6).cursor_pointer().text_color(t.muted).tooltip(tip)
      .hover((s) => s.bg(t.hover).text_color(t.foreground)).on_click((_e, cx) => { action(cx); })
      .child(svg(`mods/kanso-chrome/icons/${icon}.svg`).size(14));
    return v_flex().id("preview").size_full().min_h(0).bg(t.background).text_color(t.foreground).text_size(13)
      .child(h_flex().h(42).flex_none().px(14).gap(8).items_center().border_b(1).border_color(t.border)
        .child(div().min_w(0).truncate().font_semibold().child(nameOf(this.path)))
        .child(div().flex_1().min_w(0).truncate().text_size(12).text_color(t.dim).child(this.shortFolder()))
        .child(button("preview-open-with", "open-with", "Open with…", () => this.openWith()))
        .child(button("preview-refresh", "refresh", "Read again", (cx) => this.load(cx)))
        .child(button("preview-close", "close", "Close", () => showPanel(null))))
      .child(this.error ? div().p(12).text_color(t.dim).child(this.error)
        : this.text !== null ? markdownView("preview-md", this.text, t)
        : this.code ? Editor.new(this.code).flex_1().min_h(0)
        : div().p(12).text_color(t.dim).child("Reading…"));
  }
}
