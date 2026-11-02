// Shared by the three panels of the kanso-panel mod (files, changes, pull request).
import { spaces, panes, focused } from "herdr";

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
