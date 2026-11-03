import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load, temporary, clone } from "./helpers.mjs";

const SHARE = ["cardSvg", "postText", "renderPng", "copyImage", "NETWORKS", "wrap", "outputPath", "shareImage", "palette"];
const share = (host = {}) => load("kanso-panel/share.js", SHARE, host);
const shipped = async () => load("kanso-panel/shipped-card.js", ["shareText", "shippedSpec"], { postText: (await share()).postText });
const spend = async () => load("kanso-spend/spend-card.js", ["spendSpec", "spendText"], { postText: (await share()).postText });

const colors = { canvas: "#161615", text: "#e8e4dc", muted: "#9a958c", dim: "#6f6b64", border: "#2a2927", subtle: "#232220", accent: "#a7b59bff", green: "#8fbf7f", red: "#d0776b" };
const summary = {
  login: "me", period: "This week", byDay: false, big: "+137,013", small: "−52,410", label: "lines shipped, this week", delta: 480, deltaText: "5.8x vs last week",
  stats: [{ value: "59", unit: "contributions" }, { value: "30", unit: "pull requests merged" }, { value: "620", unit: "commits" }],
  everText: "3,683 pull requests merged, +12,128,050 lines and 12,440 commits in 118 repositories since you joined GitHub in 2011.",
};
const extra = {
  streak: 17, longest: 39,
  weeks: [{ contributionDays: [{ weekday: 0, contributionLevel: "FOURTH_QUARTILE" }, { weekday: 1, contributionLevel: "NONE" }] }],
  records: [{ name: "Best week", value: "+785,158", unit: "lines", detail: "week of 5 Oct 2026" }],
  rhythm: { hours: Array.from({ length: 24 }, (_, h) => (h === 15 ? 9 : 1)), note: "most at 15:00" },
};
// What Spend's presenter answers, with names that must never reach a post.
const costs = {
  hero: { value: "$1,024", tip: "$1,024.03 at API list price", title: "November 2026", note: "77% less than October", plan: null,
    stats: [{ value: "433", unit: "tasks", tip: "427 sessions" }, { value: "$2.36", unit: "per task" }, { value: "3.28B", unit: "tokens" }] },
  range: { period: "month", label: "November 2026" },
  chart: { title: "Per day", first: "Nov 1", last: "Nov 30", peak: "peak $668",
    bars: [{ ratio: 1, tip: "Nov 1 · $668" }, { ratio: 0.43, tip: "Nov 2" }, { ratio: 0, tip: "Nov 3" }] },
  projects: [{ name: "secret-project", detail: "/Users/me/Apps/secret-project", usdText: "$335" }],
  projectCount: "152", modelCount: "6",
  tasks: [{ detail: { title: "Fix the secret login", ticket: "SEC-42", project: "secret-project" } }],
  live: [{ detail: { title: "Fix the secret login", project: "secret-project" } }],
  facets: { project: [{ value: "/Users/me/Apps/secret-project", label: "secret-project" }] },
};

const wellFormed = (svg) => {
  assert.match(svg, /^<svg [^>]*width="1200"/);
  assert.match(svg, /<\/svg>\n$/);
  assert.equal((svg.match(/<text/g) ?? []).length, (svg.match(/<\/text>/g) ?? []).length, "balanced");
  assert.ok(!/[<>&](?![a-z/#!]|amp;|lt;|gt;|quot;)/i.test(svg.replace(/<[^>]+>/g, "")), "text is escaped");
};

test("One share.js for every panel: the copies Herdr loads are the same file", async () => {
  const source = await readFile(new URL("../kanso/mods/kanso-panel/share.js", import.meta.url), "utf8");
  const copy = await readFile(new URL("../kanso/mods/kanso-spend/share.js", import.meta.url), "utf8");
  assert.equal(copy, source, "run npm run sync:share");
});

test("Shipped's card carries the global numbers and nothing that names your work", async () => {
  const { cardSvg } = await share();
  const { shippedSpec } = await shipped();
  const { svg, width, height } = cardSvg(shippedSpec(summary, extra), colors);
  assert.equal(width, 1200);
  assert.ok(height > 1000 && height < 2600, `${height}: one tall post`);
  wellFormed(svg);
  for (const shown of ["+137,013", "5.8x vs last week", "pull requests merged", "Streak", "Records", "+785,158", "When you ship", "most at 15:00", "@me"]) assert.ok(svg.includes(shown), shown);
  assert.doesNotMatch(svg, /github\.com\/(?!jlopezlira\/herdr-kanso)/, "no repository links but Kanso's");
  assert.ok(cardSvg(shippedSpec({ ...summary, login: "a<b&c" }, extra), colors).svg.includes("@a&lt;b&amp;c"));
});

test("Spend's card carries the totals and never a project, task or session", async () => {
  const { cardSvg } = await share();
  const { spendSpec, spendText } = await spend();
  const spec = clone(spendSpec(costs));
  const { svg } = cardSvg(spec, colors);
  wellFormed(svg);
  for (const shown of ["Spend", "November 2026", "$1,024", "at API list price", "433", "tasks", "3.28B", "152", "projects", "6", "models", "Per day", "peak $668", "Nov 1", "Nov 30"]) assert.ok(svg.includes(shown), shown);
  const words = spendText(costs);
  for (const out of [svg, words, JSON.stringify(spec)]) {
    assert.doesNotMatch(out, /secret|SEC-42|\/Users\//, "no names");
  }
  assert.match(words, /^\$1,024 of AI work at list price in November 2026, 433 tasks, 3\.28B tokens\./);
  assert.ok(words.length <= 280);
});

test("Sharing words fit a post and the networks take them from a link", async () => {
  const { NETWORKS, wrap } = await share();
  const { shareText } = await shipped();
  const words = shareText(summary, extra);
  assert.ok(words.length <= 280);
  assert.match(words, /^\+137,013 lines shipped this week, 30 pull requests merged, a 17-day streak\./);
  assert.match(NETWORKS.x.url(words), /^https:\/\/x\.com\/intent\/post\?text=%2B137%2C013/);
  assert.match(NETWORKS.linkedin.url(words), /^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=/);
  assert.match(NETWORKS.bluesky.url(words), /^https:\/\/bsky\.app\/intent\/compose\?text=/);
  assert.deepEqual([...wrap("one two three four", 9)], ["one two", "three", "four"]);
});

// A Linux machine with rsvg-convert and xclip, and maybe a way to type.
async function machine(t, { typer = true } = {}) {
  const dir = await temporary(t);
  const tried = [], opened = [], notes = [];
  const ok = { code: 0, stdout: "", stderr: "" };
  const host = {
    window: () => ({ platform: "linux" }), home: () => dir, appHome: () => dir, theme: () => ({}),
    notify: (n) => notes.push(n),
    readTextFile: async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } },
    writeTextFile: async (p, text) => { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, text); return null; },
    exec: async (bin, args) => {
      if (["rm", "test", "mkdir", "sleep"].includes(bin)) return ok;
      if (bin === "sh" && args[1].startsWith("test -s")) { try { return { ...ok, code: (await readFile(args[3])).length ? 0 : 1 }; } catch { return { ...ok, code: 1 }; } }
      tried.push(bin.split("/").pop());
      if (bin === "rsvg-convert") { const out = args[args.indexOf("-o") + 1]; await mkdir(join(out, ".."), { recursive: true }); await writeFile(out, "PNG"); return ok; }
      if (bin === "xclip") return ok;
      if (bin === "xdg-open") { opened.push(args[0]); return ok; }
      if (bin === "wtype" && typer) return ok;
      throw new Error("ENOENT"); // not installed
    },
  };
  return { dir, tried, opened, notes, ...(await share(host)) };
}

test("The image comes from the first renderer this machine has", async (t) => {
  const m = await machine(t);
  const { shippedSpec } = await shipped();
  const used = await m.renderPng(m.cardSvg(shippedSpec(summary, extra), colors), join(m.dir, "card.svg"), join(m.dir, "card.png"));
  assert.equal(used, "rsvg-convert");
  assert.ok(m.tried.indexOf("rsvg-convert") > m.tried.indexOf("chromium"), "browsers first");
  assert.equal(await m.copyImage(join(m.dir, "card.png")), true, "copied (xclip here)");
  assert.match(await m.outputPath("spend-November 2026"), /\/kanso-spend-november-2026-\d{4}-\d{2}-\d{2}\.png$/);
});

test("A share opens the composer with the text and pastes the image into it", async (t) => {
  const m = await machine(t);
  const { spendSpec, spendText } = await spend();
  const make = () => ({ spec: spendSpec(costs), text: spendText(costs), name: "spend-November 2026", title: "Spend" });
  await m.shareImage("bluesky", make, join(m.dir, "work"));
  assert.match(m.opened[0], /^https:\/\/bsky\.app\/intent\/compose\?text=%241%2C024/);
  const order = m.tried.filter((b) => ["xclip", "xdg-open", "wtype"].includes(b));
  assert.deepEqual(order, ["xclip", "xdg-open", "wtype"], "copied, opened, then pasted");
  assert.match(m.notes[0].title, /Bluesky post has the image and the text/);

  // No way to type here: the image waits on the clipboard for you.
  const n = await machine(t, { typer: false });
  await n.shareImage("x", make, join(n.dir, "work"));
  assert.match(n.notes[0].title, /^Paste the image into your X post: Ctrl-V$/);

  // Save image: saved and opened, nothing posted.
  await n.shareImage(null, make, join(n.dir, "work"));
  assert.match(n.opened.at(-1), /kanso-spend-november-2026-.*\.png$/);
  assert.match(n.notes.at(-1).title, /^Spend image saved$/);
});
