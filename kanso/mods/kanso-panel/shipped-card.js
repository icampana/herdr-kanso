// Shipped's share card, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// The panel's global numbers as an image to post: the hero, the totals, the
// streak with its year of contributions, the records and when you ship. No
// repository or machine names, so nothing private leaves with it.
//
// The card is an SVG drawn here, turned into a PNG by the first renderer this
// machine has: a Chromium browser (Chrome, Chromium, Brave, Edge) headless,
// rsvg-convert or ImageMagick, or QuickLook on macOS. Sharing copies the PNG
// to the clipboard and opens the network's composer with the text filled in:
// X, LinkedIn and Bluesky take text from a link, never an image, so you paste
// it there.
import { exec, home, readTextFile, writeTextFile, window } from "herdr";

export const NETWORKS = {
  x: { name: "X", url: (text) => `https://x.com/intent/post?text=${encodeURIComponent(text)}` },
  linkedin: { name: "LinkedIn", url: (text) => `https://www.linkedin.com/feed/?shareActive=true&text=${encodeURIComponent(text)}` },
  bluesky: { name: "Bluesky", url: (text) => `https://bsky.app/intent/compose?text=${encodeURIComponent(text)}` },
};
const REPO_URL = "github.com/jlopezlira/herdr-kanso";
const W = 1200, PAD = 72, INNER = W - 2 * PAD;
const FONT = "Inter, 'SF Pro Display', -apple-system, 'Segoe UI', Roboto, Helvetica, Arial, sans-serif";

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

// The post's words: the numbers that brag best, short enough for X (280).
export function shareText(s, extra) {
  const parts = [];
  if (s.big) parts.push(`${s.big} ${s.byDay ? "contributions" : "lines shipped"} ${s.period.toLowerCase()}`);
  const merged = s.stats.find((x) => x.unit === "pull requests merged");
  if (merged && merged.value !== "—" && merged.value !== "0") parts.push(`${merged.value} pull requests merged`);
  if (extra.streak > 1) parts.push(`a ${extra.streak}-day streak`);
  const line = parts.length ? `${parts.join(", ")}.` : "What I shipped.";
  return `${line[0].toUpperCase()}${line.slice(1)}\n\nCounted by Kanso for Herdr: ${REPO_URL}`.slice(0, 280);
}

// The card, top to bottom: { svg, width, height }. `s` is the panel's summary;
// `extra`: { streak, longest, weeks (the calendar), records [{ name, value, unit, detail }], rhythm { hours, note } }.
export function cardSvg(s, extra, c) {
  const out = [];
  let y = PAD;
  // Header: the panel's name and whose numbers, for which period.
  y += 30;
  out.push(text(PAD, y, 30, c.text, "Shipped", 'font-weight="600"'));
  out.push(text(W - PAD, y, 24, c.muted, [s.login ? `@${s.login}` : "", s.period].filter(Boolean).join("  ·  "), 'text-anchor="end"'));
  // The hero.
  y += 150;
  out.push(`<text x="${PAD}" y="${y}" font-size="132" font-weight="300" ${paint(c.text)} letter-spacing="-3">${esc(s.big ?? "—")}<tspan font-size="52" dx="24" ${paint(c.muted)}>${esc(s.small)}</tspan></text>`);
  y += 52;
  out.push(text(PAD, y, 26, c.muted, s.label));
  if (s.delta !== null && s.delta !== undefined) {
    y += 44;
    const color = s.delta >= 0 ? c.green : c.red;
    out.push(`<circle cx="${PAD + 7}" cy="${y - 9}" r="7" ${paint(color)}/>`);
    out.push(text(PAD + 26, y, 26, color, s.deltaText));
  }
  // The numbers, in a row that wraps after three.
  y += 80;
  const col = INNER / Math.min(3, s.stats.length);
  s.stats.forEach((x, i) => {
    if (i && i % 3 === 0) y += 128;
    const cx = PAD + (i % 3) * col;
    out.push(text(cx, y + 56, 64, c.text, x.value, 'font-weight="300"'));
    out.push(text(cx, y + 92, 22, c.dim, x.unit));
  });
  y += 128;
  if (s.everText) {
    for (const line of wrap(s.everText, 88)) { out.push(text(PAD, y + 12, 22, c.muted, line)); y += 32; }
    y += 8;
  }
  // The streak and the year of contributions.
  y += 48;
  out.push(text(PAD, y, 30, c.text, "Streak"));
  out.push(text(W - PAD, y, 22, c.dim, `longest ${extra.longest} ${extra.longest === 1 ? "day" : "days"}`, 'text-anchor="end"'));
  y += 100;
  out.push(`<text x="${PAD}" y="${y}" font-size="96" font-weight="300" ${paint(c.text)}>${esc(extra.streak)}<tspan font-size="24" dx="16" ${paint(c.dim)}>${extra.streak === 1 ? "day in a row" : "days in a row"}</tspan></text>`);
  y += 32;
  // Always a year's 53 columns, the latest at the right, so the squares keep their size.
  const weeks = (extra.weeks ?? []).slice(-53), gap = 4, cell = Math.floor((INNER - 52 * gap) / 53), first = 53 - weeks.length;
  const level = { NONE: null, FIRST_QUARTILE: 0.3, SECOND_QUARTILE: 0.55, THIRD_QUARTILE: 0.8, FOURTH_QUARTILE: 1 };
  weeks.forEach((w, wi) => {
    for (const d of w.contributionDays) {
      const a = level[d.contributionLevel];
      out.push(`<rect x="${PAD + (first + wi) * (cell + gap)}" y="${y + d.weekday * (cell + gap)}" width="${cell}" height="${cell}" rx="${Math.max(2, Math.round(cell / 5))}" ${a ? paint(c.accent, a) : paint(c.subtle)}/>`);
    }
  });
  y += 7 * cell + 6 * gap;
  // Records.
  if (extra.records?.length) {
    y += 76;
    out.push(text(PAD, y, 30, c.text, "Records"));
    y += 16;
    extra.records.forEach((r, i) => {
      if (i) out.push(`<rect x="${PAD}" y="${y}" width="${INNER}" height="1" ${paint(c.border)}/>`);
      out.push(text(PAD, y + 40, 24, c.text, r.name));
      out.push(text(PAD, y + 70, 20, c.dim, r.detail));
      out.push(`<text x="${W - PAD}" y="${y + 56}" font-size="40" font-weight="300" text-anchor="end" ${paint(c.text)}>${esc(r.value)}<tspan font-size="20" dx="10" ${paint(c.dim)}>${esc(r.unit)}</tspan></text>`);
      y += 92;
    });
  }
  // When you ship.
  if (extra.rhythm?.hours?.some((n) => n > 0)) {
    y += 64;
    out.push(text(PAD, y, 30, c.text, "When you ship"));
    out.push(text(W - PAD, y, 22, c.dim, extra.rhythm.note, 'text-anchor="end"'));
    y += 28;
    const hours = extra.rhythm.hours, top = Math.max(...hours), peak = hours.indexOf(top), bw = (INNER - 23 * 6) / 24, bh = 140;
    hours.forEach((n, h) => {
      const height = Math.max(4, Math.round((n / top) * bh));
      out.push(`<rect x="${PAD + h * (bw + 6)}" y="${y + bh - height}" width="${bw}" height="${height}" rx="3" ${n ? paint(c.accent, h === peak ? 1 : 0.55) : paint(c.subtle)}/>`);
    });
    y += bh + 30;
    ["00", "06", "12", "18", "23"].forEach((t, i) => out.push(text(PAD + (i * INNER) / 4, y, 18, c.dim, t, `text-anchor="${i === 0 ? "start" : i === 4 ? "end" : "middle"}"`)));
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
  if (window()?.platform === "macos") {
    const dir = svgPath.replace(/\/[^/]+$/, "");
    const r = await exec("qlmanage", ["-t", "-s", String(card.width * 2), "-o", dir, svgPath]).catch(() => null);
    if (r?.code === 0 && await exists(`${svgPath}.png`)) { await exec("mv", ["-f", `${svgPath}.png`, pngPath]); return "QuickLook"; }
  }
  throw new Error("Install Chrome, Chromium or rsvg-convert to make the image.");
}

// Puts the PNG on the clipboard, to paste into the post.
export async function copyImage(pngPath) {
  const tries = window()?.platform === "macos"
    ? [["osascript", ["-e", `set the clipboard to (read (POSIX file "${pngPath.replace(/"/g, '\\"')}") as «class PNGf»)`]]]
    : [["sh", ["-c", 'wl-copy --type image/png < "$1"', "sh", pngPath]], ["xclip", ["-selection", "clipboard", "-t", "image/png", "-i", pngPath]]];
  for (const [bin, args] of tries) {
    const r = await exec(bin, args).catch(() => null);
    if (r?.code === 0) return true;
  }
  return false;
}

export const openPath = (target) => exec(window()?.platform === "macos" ? "open" : "xdg-open", [target]).catch(() => null);

// Where the image is kept: Downloads when there is one, else home.
export async function outputPath(period) {
  const downloads = (await exec("test", ["-d", `${home()}/Downloads`]).catch(() => null))?.code === 0;
  const dir = downloads ? `${home()}/Downloads` : home();
  const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  return `${dir}/kanso-shipped-${day}-${String(period).toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(/^-|-$/g, "")}.png`;
}
