// Shared by the three panels of the kanso-panel mod (files, changes, pull request).
import { div } from "gpui-kit";
import { EditorState, TextView } from "gpui-base";
import { spaces, panes, focused, layout, run, theme, settings, shared, setShared } from "herdr";

// Same helper as kanso-strip, kanso-tabs, kanso-spaces and open-with.
const LAYOUT_INTENT = "kanso.layout";
// The strip writes its columns under their own key, many times a second, so
// it never has to read back and copy the panel and rail to keep them.
const STRIP_INTENT = "kanso.layout.strip";

function walkLayout(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = walkLayout(child, id);
    if (found) return found;
  }
  return null;
}

function paintLayout(tree, preserveSizes = true) {
  if (!tree) return;
  const intent = { ...(shared(LAYOUT_INTENT) ?? {}), ...(shared(STRIP_INTENT) ?? {}) };
  if (intent.nodes) {
    const body = walkLayout(tree, "work-body");
    if (body?.children) {
      const mine = (n) => n.id === "main" || String(n.id).startsWith("strip-");
      const at = body.children.findIndex(mine);
      const rest = body.children.filter((n) => !mine(n));
      const i = Math.max(0, at);
      const nodes = JSON.parse(JSON.stringify(intent.nodes));
      // Native dividers leave px sizes before the strip's adopt timer runs.
      // Keep those edits, but not sizes from the tree a pending strip write
      // was based on: replaying those would undo an explicit width command.
      const keepSize = (node) => {
        const before = intent.sizesBefore?.[node.id], live = walkLayout(body, node.id);
        if (before !== undefined && live?.size?.px !== undefined
          && JSON.stringify(live.size) !== JSON.stringify(before)) node.size = { ...live.size };
        for (const child of node.children ?? []) keepSize(child);
      };
      if (preserveSizes) nodes.forEach(keepSize);
      body.children = [...rest.slice(0, i), ...nodes, ...rest.slice(i)];
    }
  }
  if ("panel" in intent) {
    const body = walkLayout(tree, "panel-body");
    const wrap = walkLayout(tree, "panel") ?? body;
    if (body) {
      const child = intent.panel ? JSON.parse(JSON.stringify(intent.panel)) : null;
      body.children = child ? [child] : [];
      if (child) body.active = child.id;
      else delete body.active;
      if (wrap) wrap.hidden = !child;
    }
  }
  if (intent.rail) {
    const sidebar = (tree.children ?? []).find((n) => n.id === "sidebar");
    if (sidebar) {
      tree.resizable = intent.rail.open;
      sidebar.min = intent.rail.min;
    }
  }
  edgeBesidePanel(tree);
}

// A side panel's left border is Herdr's divider, which moves only the two
// nodes beside it, so a fixed-width neighbor pins it. While a panel shows,
// the strip's right edge rail (28 px, fixed) stands after the panel instead
// of before it, and a strip column keeps the border draggable.
function edgeBesidePanel(tree) {
  const kids = walkLayout(tree, "work-body")?.children;
  const at = kids ? kids.findIndex((n) => n.id === "strip-edge-right") : -1;
  if (at < 0) return;
  const [edge] = kids.splice(at, 1);
  const panel = kids[at];
  const beside = panel && (panel.id === "panel-body" || panel.id === "panel") && !panel.hidden;
  kids.splice(beside ? at + 1 : at, 0, edge);
}

function commitLayout(patch) {
  setShared(LAYOUT_INTENT, { ...(shared(LAYOUT_INTENT) ?? {}), ...patch });
  const tree = layout();
  if (!tree) return false;
  paintLayout(tree);
  run("layout.set", { layout: tree });
  return true;
}

// A relative path that stays inside its root: no absolute path, no ".." segment.
export function insideRoot(path) {
  if (!path || typeof path !== "string" || path.includes("\0")) return false;
  if (path.startsWith("/") || path.startsWith("\\") || /^[A-Za-z]:/.test(path)) return false;
  return path.split(/[\\/]/).every((part) => part !== "..");
}

// Where the focused pane is: its folder, the machine it is on (null: this
// computer) and its space.
export function location() {
  const space = spaces().find((s) => s.active), f = focused();
  const pane = f?.pane ? panes().find((p) => p.pane === f.pane) : null;
  const on = f?.pane === null ? (f.terminal?.includes("/") ? f.terminal.split("/")[0] : null) : space?.machine ?? null;
  return { cwd: pane?.cwd || f?.cwd || space?.folder, on, space: space?.id };
}
// The context a read belongs to: the folder and the machine (not the space).
export const key = () => { const { cwd, on } = location(); return JSON.stringify({ cwd, on }); };

// Numbers each diff line once, so a frame only draws the rows on screen.
// `max` lines at most, each cut at `width` characters (both optional).
export function diffRows(lines, { max, width } = {}) {
  let old = 0, next = 0;
  return (max ? lines.slice(0, max) : lines).map((line) => {
    const m = /^@@ -(\d+)(?:,\d+)? \+(\d+)/.exec(line);
    if (m) { old = +m[1]; next = +m[2]; return { kind: "@", text: line }; }
    const kind = line[0], body = line.slice(1) || " ", text = width ? body.slice(0, width) : body;
    if (kind === "-") return { kind, number: old++, text };
    if (kind === "+") return { kind, number: next++, text };
    if (kind === " ") { old++; return { kind, number: next++, text }; }
    return { kind: "", text: line };
  });
}

// ---- Showing a file --------------------------------------------------------------

const LANG = { ts: "js", tsx: "js", mts: "js", cts: "js", jsx: "js", mjs: "js", toml: "yaml", jsonc: "json", svelte: "html", vue: "html" };
const MAX_TEXT = 400000;
export const ext = (path) => (path.includes(".") ? path.split(".").pop().toLowerCase() : "");
export const isMarkdown = (path) => ["md", "markdown", "mdx"].includes(ext(path));

// A read-only editor state for a code or text file, in the terminal's font,
// highlighted in the theme's ANSI hues. Release it when done.
export function codeState(path, text) {
  const t = theme(), e = ext(path) || "txt";
  return EditorState.new({ language: LANG[e] ?? e, readonly: true,
    value: text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n… (file truncated)" : text,
    font_family: settings().font_family, font_size: 12,
    syntax: { keyword: t.ansi5, string: t.ansi2, comment: t.dim, function: t.ansi4, type: t.ansi3, number: t.ansi1, constant: t.ansi6 } });
}

// Markdown as the SDK renders it (`TextView.markdown`), selectable, in a
// scrolling column with the panel's margins.
export function markdownView(id, text, t) {
  return div().id(`${id}-scroll`).flex_1().min_h(0).overflow_y_scrollbar()
    .child(div().px(16).py(12).text_size(13).text_color(t.foreground)
      .child(TextView.markdown(id, text.length > MAX_TEXT ? text.slice(0, MAX_TEXT) + "\n\n… (file truncated)" : text).selectable(true)));
}

// ---- The panel stack --------------------------------------------------------------

// Puts one block in the side panel (as kanso-tabs' panel buttons do) or,
// with no id, empties it: Herdr then ends the panel's mod.
export function showPanel(id, content) {
  if (!walkLayout(layout(), "panel-body")) return false;
  return commitLayout({ panel: id ? { id, type: "block", content } : null });
}
