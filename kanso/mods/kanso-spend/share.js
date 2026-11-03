// Kanso's share card, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// One way to share for every Kanso panel that brags (Shipped, Spend): the
// panel hands over its global numbers as a card spec, and this draws the
// image, saves it, and posts it to X, LinkedIn or Bluesky.
//
// Herdr loads a mod's files from its own folder only, so this file is kept
// byte for byte in kanso-panel/ and kanso-spend/; `npm run sync:share` copies
// it and the tests fail when the copies differ. Edit kanso-panel/share.js.
//
// The card is an SVG, turned into a PNG by the first renderer this machine
// has: a Chromium browser (Chrome, Chromium, Brave, Edge) headless,
// rsvg-convert or ImageMagick, or QuickLook on macOS. The networks' links
// take text only, so the image goes on the clipboard, the composer opens with
// the text, and once the page is up the image is pasted into it (on macOS
// that needs Herdr in Accessibility; without it you paste it yourself).
import { div } from "gpui-kit";
import { h_flex, Button } from "gpui-base";
import { exec, home, readTextFile, writeTextFile, window, notify, theme, appHome } from "herdr";

export const NETWORKS = {
  x: { name: "X", wait: 4, url: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}` },
  linkedin: { name: "LinkedIn", wait: 5, url: (text) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}` },
  bluesky: { name: "Bluesky", wait: 3, url: (text) => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}` },
};
export const REPO_URL = "github.com/jlopezlira/herdr-kanso";
const W = 1200, PAD = 72, INNER = W - 2 * PAD;
const FONT = "Inter, 'SF Pro Display', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

// The card's colors, from Herdr's theme.
export function palette(t = theme() ?? {}) {
  return {
    canvas: t.canvas ?? t.background, text: t.foreground, muted: t.muted ?? t.dim, dim: t.dim,
    border: t.border ?? t.dim, subtle: t.hover ?? t.raised, accent: t.accent ?? t.foreground, red: t.ansi1, green: t.ansi2,
  };
}

const esc = (s) => String(s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
// #rrggbb (or #rrggbbaa) as fill plus opacity, which every renderer understands.
function paint(hex, alpha) {
  const h = String(hex ?? "#888888").replace(/^#/, "");
  const base = `#${h.slice(0, 6).padEnd(6, "8")}`;
  const a = alpha ?? (h.length === 8 ? parseInt(h.slice(6), 16) / 255 : 1);
  return `fill="${base}"${a < 1 ? ` fill-opacity="${Math.round(a * 1000) / 1000}"` : ""}`;
}
// Lines of at most `width` characters, broken between words.
export function wrap(body, width) {
  const lines = [];
  let line = "";
  for (const word of String(body).split(/\s+/)) {
    if (line && line.length + 1 + word.length > width) { lines.push(line); line = word; }
    else line = line ? `${line} ${word}` : word;
  }
  if (line) lines.push(line);
  return lines;
}
const text = (x, y, size, color, body, extra = "") => `<text x="${x}" y="${y}" font-size="${size}" ${paint(color)} ${extra}>${esc(body)}</text>`;

// The post's words: one line of numbers, then where they come from. Short
// enough for X (280).
export function postText(parts, fallback) {
  const line = parts.length ? `${parts.join(", ")}.` : fallback;
  return `${line[0].toUpperCase()}${line.slice(1)}\n\nCounted by Kanso for Herdr: ${REPO_URL}`.slice(0, 280);
}

// The card, top to bottom: { svg, width, height }.
//   spec: { title, right, hero: { big, small, label, delta: { up, text } | null },
//           stats: [{ value, unit }], note, blocks: [block] }
//   block: { kind: "streak", title, right, n, unit, weeks (GitHub's calendar) }
//        | { kind: "list", title, rows: [{ name, detail, value, unit }] }
//        | { kind: "bars", title, right, values: [n], ticks: [label] }
export function cardSvg(spec, c) {
  const out = [];
  let y = PAD;
  // Header: the panel's name, and whose numbers for which period.
  y += 30;
  out.push(text(PAD, y, 30, c.text, spec.title, 'font-weight="600"'));
  if (spec.right) out.push(text(W - PAD, y, 24, c.muted, spec.right, 'text-anchor="end"'));
  // The hero.
  const hero = spec.hero ?? {};
  y += 150;
  out.push(`<text x="${PAD}" y="${y}" font-size="132" font-weight="300" ${paint(c.text)} letter-spacing="-3">${esc(hero.big ?? "—")}${hero.small ? `<tspan font-size="52" dx="24" ${paint(c.muted)}>${esc(hero.small)}</tspan>` : ""}</text>`);
  if (hero.label) { y += 52; out.push(text(PAD, y, 26, c.muted, hero.label)); }
  if (hero.delta?.text) {
    y += 44;
    const color = hero.delta.up ? c.green : c.red;
    out.push(`<circle cx="${PAD + 7}" cy="${y - 9}" r="7" ${paint(color)}/>`);
    out.push(text(PAD + 26, y, 26, color, hero.delta.text));
  }
  // The numbers, in a row that wraps after three.
  const stats = spec.stats ?? [];
  if (stats.length) {
    y += 80;
    const col = INNER / Math.min(3, stats.length);
    stats.forEach((x, i) => {
      if (i && i % 3 === 0) y += 128;
      const cx = PAD + (i % 3) * col;
      out.push(text(cx, y + 56, 64, c.text, x.value, 'font-weight="300"'));
      out.push(text(cx, y + 92, 22, c.dim, x.unit));
    });
    y += 128;
  }
  if (spec.note) {
    for (const line of wrap(spec.note, 88)) { out.push(text(PAD, y + 12, 22, c.muted, line)); y += 32; }
    y += 8;
  }
  for (const b of spec.blocks ?? []) {
    if (b.kind === "streak") {
      y += 48;
      out.push(text(PAD, y, 30, c.text, b.title));
      if (b.right) out.push(text(W - PAD, y, 22, c.dim, b.right, 'text-anchor="end"'));
      y += 100;
      out.push(`<text x="${PAD}" y="${y}" font-size="96" font-weight="300" ${paint(c.text)}>${esc(b.n)}<tspan font-size="24" dx="16" ${paint(c.dim)}>${esc(b.unit)}</tspan></text>`);
      y += 32;
      // Always a year's 53 columns, the latest at the right, so the squares keep their size.
      const weeks = (b.weeks ?? []).slice(-53), gap = 4, cell = Math.floor((INNER - 52 * gap) / 53), first = 53 - weeks.length;
      const level = { NONE: null, FIRST_QUARTILE: 0.3, SECOND_QUARTILE: 0.55, THIRD_QUARTILE: 0.8, FOURTH_QUARTILE: 1 };
      weeks.forEach((w, wi) => {
        for (const d of w.contributionDays) {
          const a = level[d.contributionLevel];
          out.push(`<rect x="${PAD + (first + wi) * (cell + gap)}" y="${y + d.weekday * (cell + gap)}" width="${cell}" height="${cell}" rx="${Math.max(2, Math.round(cell / 5))}" ${a ? paint(c.accent, a) : paint(c.subtle)}/>`);
        }
      });
      y += 7 * cell + 6 * gap;
    } else if (b.kind === "list" && b.rows?.length) {
      y += 76;
      out.push(text(PAD, y, 30, c.text, b.title));
      y += 16;
      b.rows.forEach((r, i) => {
        if (i) out.push(`<rect x="${PAD}" y="${y}" width="${INNER}" height="1" ${paint(c.border)}/>`);
        out.push(text(PAD, y + 40, 24, c.text, r.name));
        if (r.detail) out.push(text(PAD, y + 70, 20, c.dim, r.detail));
        out.push(`<text x="${W - PAD}" y="${y + 56}" font-size="40" font-weight="300" text-anchor="end" ${paint(c.text)}>${esc(r.value)}${r.unit ? `<tspan font-size="20" dx="10" ${paint(c.dim)}>${esc(r.unit)}</tspan>` : ""}</text>`);
        y += 92;
      });
    } else if (b.kind === "bars" && b.values?.some((n) => n > 0)) {
      y += 64;
      out.push(text(PAD, y, 30, c.text, b.title));
      if (b.right) out.push(text(W - PAD, y, 22, c.dim, b.right, 'text-anchor="end"'));
      y += 28;
      const values = b.values, top = Math.max(...values), peak = values.indexOf(top), n = values.length;
      const gap = n > 40 ? 3 : 6, bw = (INNER - (n - 1) * gap) / n, bh = 140;
      values.forEach((v, i) => {
        const height = Math.max(4, Math.round((v / top) * bh));
        out.push(`<rect x="${PAD + i * (bw + gap)}" y="${y + bh - height}" width="${bw}" height="${height}" rx="3" ${v ? paint(c.accent, i === peak ? 1 : 0.55) : paint(c.subtle)}/>`);
      });
      y += bh + 30;
      const ticks = b.ticks ?? [], last = ticks.length - 1;
      ticks.forEach((t, i) => out.push(text(PAD + (last ? (i * INNER) / last : 0), y, 18, c.dim, t, `text-anchor="${i === 0 ? "start" : i === last ? "end" : "middle"}"`)));
    }
  }
  // Footer.
  y += 72;
  out.push(`<rect x="${PAD}" y="${y - 40}" width="${INNER}" height="1" ${paint(c.border)}/>`);
  out.push(text(PAD, y, 20, c.dim, "Kanso for Herdr"));
  out.push(text(W - PAD, y, 20, c.dim, REPO_URL, 'text-anchor="end"'));
  const height = y + PAD - 20;
  const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="${W}" height="${height}" viewBox="0 0 ${W} ${height}" font-family="${esc(FONT)}">
<rect width="${W}" height="${height}" ${paint(c.canvas)}/>
${out.join("\n")}
</svg>
`;
  return { svg, width: W, height };
}

const CHROMIUMS = [
  "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome", "/Applications/Chromium.app/Contents/MacOS/Chromium",
  "/Applications/Brave Browser.app/Contents/MacOS/Brave Browser", "/Applications/Microsoft Edge.app/Contents/MacOS/Microsoft Edge",
  "chromium", "chromium-browser", "google-chrome", "google-chrome-stable", "brave", "brave-browser", "microsoft-edge",
];

const exists = async (path) => (await exec("sh", ["-c", 'test -s "$1"', "sh", path]).catch(() => null))?.code === 0;
const macos = () => window()?.platform === "macos";
const pause = (seconds) => exec("sleep", [String(seconds)]).catch(() => null);

// Writes the card as a PNG at twice its size. Returns the renderer used, or throws.
export async function renderPng(card, svgPath, pngPath) {
  await writeTextFile(svgPath, card.svg, await readTextFile(svgPath));
  await exec("rm", ["-f", pngPath]).catch(() => {});
  const html = svgPath.replace(/\.svg$/, ".html");
  await writeTextFile(html, `<!doctype html><html><head><style>html,body{margin:0;background:transparent}</style></head><body>${card.svg}</body></html>`, await readTextFile(html));
  const tries = [
    ...CHROMIUMS.map((bin) => [bin, ["--headless=new", "--disable-gpu", "--hide-scrollbars", "--no-first-run", "--force-device-scale-factor=2",
      `--window-size=${card.width},${card.height}`, `--screenshot=${pngPath}`, `file://${html}`]]),
    ["rsvg-convert", ["-z", "2", "-o", pngPath, svgPath]],
    ["magick", ["-density", "192", svgPath, pngPath]],
  ];
  for (const [bin, args] of tries) {
    let r = null;
    try { r = await exec(bin, args); } catch { continue; } // not installed here
    if (r.code === 0 && await exists(pngPath)) return bin.split("/").pop();
  }
  if (macos()) {
    const dir = svgPath.replace(/\/[^/]+$/, "");
    const r = await exec("qlmanage", ["-t", "-s", String(card.width * 2), "-o", dir, svgPath]).catch(() => null);
    if (r?.code === 0 && await exists(`${svgPath}.png`)) { await exec("mv", ["-f", `${svgPath}.png`, pngPath]); return "QuickLook"; }
  }
  throw new Error("Install Chrome, Chromium or rsvg-convert to make the image.");
}

// Puts the PNG on the clipboard.
export async function copyImage(pngPath) {
  const tries = macos()
    ? [["osascript", ["-e", `set the clipboard to (read (POSIX file "${pngPath.replace(/"/g, '\\"')}") as «class PNGf»)`]]]
    : [["sh", ["-c", 'wl-copy --type image/png < "$1"', "sh", pngPath]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-i", pngPath]]];
  for (const [bin, args] of tries) {
    const r = await exec(bin, args).catch(() => null);
    if (r?.code === 0) return true;
  }
  return false;
}

export const openPath = (target) => exec(macos() ? "open" : "xdg-open", [target]).catch(() => null);

// The app in front, by bundle id (macOS), or null when it can't be told.
async function frontApp() {
  const r = await exec("osascript", ["-l", "JavaScript", "-e",
    'ObjC.import("AppKit"); var a = $.NSWorkspace.sharedWorkspace.frontmostApplication; a ? ObjC.unwrap(a.bundleIdentifier) : ""']).catch(() => null);
  return r?.code === 0 && r.stdout.trim() ? r.stdout.trim() : null;
}

// Pastes the clipboard into the composer that was just opened: once the
// browser is in front and the page had time to load. False when it could not.
async function pasteInto(network, before) {
  if (macos()) {
    let front = await frontApp();
    for (let i = 0; i < 12 && front && front === before; i += 1) { await pause(0.5); front = await frontApp(); }
    if (front && front === before) return false; // the browser never came up
    await pause(network.wait);
    if (front && (await frontApp()) !== front) return false; // you moved on: not into another app
    const r = await exec("osascript", ["-e", 'tell application "System Events" to keystroke "v" using command down']).catch(() => null);
    return r?.code === 0;
  }
  await pause(network.wait);
  for (const [bin, args] of [["wtype", ["-M", "ctrl", "-k", "v", "-m", "ctrl"]], ["xdotool", ["key", "--clearmodifiers", "ctrl+v"]]]) {
    const r = await exec(bin, args).catch(() => null);
    if (r?.code === 0) return true;
  }
  return false;
}

// Where the image is kept: Downloads when there is one, else home.
export async function outputPath(name) {
  const downloads = (await exec("test", ["-d", `${home()}/Downloads`]).catch(() => null))?.code === 0;
  const dir = downloads ? `${home()}/Downloads` : home();
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const slug = (s) => String(s).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "");
  return `${dir}/kanso-${slug(name)}-${day}.png`;
}

// The image made, saved, and posted: to a network's composer with the text
// and the image in it, or with no network just saved and opened.
//   make() → { spec, text, name, title }  (title: "Shipped", "Spend")
export async function shareImage(network, make, workDir) {
  const { spec, text: words, name, title } = make();
  const card = cardSvg(spec, palette());
  const png = await outputPath(name);
  await exec("mkdir", ["-p", workDir]);
  await renderPng(card, `${workDir}/share.svg`, png);
  const where = png.replace(/^.*\/(Downloads\/)?/, (m, d) => (d ? "Downloads/" : ""));
  if (!network) {
    await openPath(png);
    notify({ title: `${title} image saved`, body: where, level: "success" });
    return;
  }
  const n = NETWORKS[network];
  const copied = await copyImage(png);
  const before = macos() ? await frontApp() : null;
  await openPath(n.url(words));
  const pasted = copied && await pasteInto(n, before);
  const key = macos() ? "Cmd-V" : "Ctrl-V";
  notify(pasted
    ? { title: `Your ${n.name} post has the image and the text`, body: `Check it and post. Not there? It is on the clipboard: ${key}. Saved in ${where}.`, level: "success" }
    : copied
      ? { title: `Paste the image into your ${n.name} post: ${key}`, body: macos() ? `It is on the clipboard and in ${where}. To have it pasted for you, allow Herdr in System Settings > Privacy & Security > Accessibility.` : `It is on the clipboard and in ${where}.`, level: "success" }
      : { title: `Attach ${png.split("/").pop()} to your ${n.name} post`, body: png, level: "success" });
  if (!copied) await openPath(png.replace(/\/[^/]+$/, ""));
}

// The "Share to" row and its state, the same in every panel.
//   id: a prefix for element ids; make: as for shareImage; note: what the image holds.
export class Share {
  constructor(id, workDir) { this.id = id; this.workDir = workDir ?? `${appHome()}/data/${id}`; this.open = false; this.busy = null; }

  toggle(cx) { this.open = !this.open; cx.notify(); }

  run(network, make, cx) {
    if (this.busy) return;
    this.busy = network ?? "save"; cx.notify();
    cx.spawn(async (cx) => {
      try {
        await shareImage(network, make, this.workDir);
        this.open = false;
      } catch (e) {
        notify({ title: "The image could not be made", body: String(e?.message ?? e), level: "error" });
      } finally { this.busy = null; cx.notify(); }
    });
  }

  row(c, make, note, gap = 8) {
    const choice = (key, label, network) => Button.new(`${this.id}-share-${key}`).h(26).px(10).flex_none().items_center().rounded(6).cursor_pointer()
      .border_1().border_color(c.border).hover((s) => s.bg(c.subtle))
      .accessibility_label(label)
      .on_click((_e, cx) => this.run(network, make, cx))
      .child(div().text_size(12).text_color(this.busy === key ? c.dim : c.text).child(this.busy === key ? "Making the image…" : label));
    return h_flex().w_full().flex_wrap().gap(gap).items_center()
      .child(div().text_size(12).text_color(c.dim).child("Share to"))
      .children(Object.entries(NETWORKS).map(([key, n]) => choice(key, n.name, key)))
      .child(choice("save", "Save image", null))
      .child(div().w_full().text_size(11).text_color(c.dim).child(note));
  }
}
