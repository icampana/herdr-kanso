import assert from "node:assert/strict";
import test from "node:test";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { load, temporary } from "./helpers.mjs";

const names = ["cardSvg", "shareText", "renderPng", "copyImage", "NETWORKS", "wrap", "outputPath"];
const card = (host = {}) => load("kanso-panel/shipped-card.js", names, host);
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

test("The share card carries the global numbers and nothing that names your work", async () => {
  const { cardSvg } = await card();
  const { svg, width, height } = cardSvg(summary, extra, colors);
  assert.equal(width, 1200);
  assert.ok(height > 1000 && height < 2600, `${height}: one tall post`);
  assert.match(svg, /^<svg [^>]*width="1200"/);
  assert.match(svg, /<\/svg>\n$/);
  for (const shown of ["+137,013", "5.8x vs last week", "pull requests merged", "Streak", "Records", "+785,158", "When you ship", "most at 15:00", "@me"]) assert.ok(svg.includes(shown), shown);
  assert.equal((svg.match(/<text/g) ?? []).length, (svg.match(/<\/text>/g) ?? []).length, "balanced");
  assert.ok(!/[<>&](?![a-z/#!]|amp;|lt;|gt;|quot;)/i.test(svg.replace(/<[^>]+>/g, "")), "text is escaped");
  assert.doesNotMatch(svg, /github\.com\/(?!jlopezlira\/herdr-kanso)/, "no repository links but Kanso's");
  const tricky = cardSvg({ ...summary, login: "a<b&c" }, extra, colors).svg;
  assert.ok(tricky.includes("@a&lt;b&amp;c"));
});

test("Sharing words fit a post and the networks take them from a link", async () => {
  const { shareText, NETWORKS, wrap } = await card();
  const words = shareText(summary, extra);
  assert.ok(words.length <= 280);
  assert.match(words, /^\+137,013 lines shipped this week, 30 pull requests merged, a 17-day streak\./);
  assert.match(NETWORKS.x.url(words), /^https:\/\/x\.com\/intent\/post\?text=%2B137%2C013/);
  assert.match(NETWORKS.linkedin.url(words), /^https:\/\/www\.linkedin\.com\/feed\/\?shareActive=true&text=/);
  assert.match(NETWORKS.bluesky.url(words), /^https:\/\/bsky\.app\/intent\/compose\?text=/);
  assert.deepEqual([...wrap("one two three four", 9)], ["one two", "three", "four"]);
});

test("The image comes from the first renderer this machine has", async (t) => {
  const dir = await temporary(t);
  const tried = [];
  const host = {
    window: () => ({ platform: "linux" }), home: () => dir,
    readTextFile: async (p) => { try { return await readFile(p, "utf8"); } catch { return null; } },
    writeTextFile: async (p, text) => { await mkdir(join(p, ".."), { recursive: true }); await writeFile(p, text); return null; },
    exec: async (bin, args) => {
      if (bin === "sh" || bin === "rm" || bin === "test") {
        if (bin === "sh" && args[1].startsWith("test -s")) { try { return { code: (await readFile(args[3])).length ? 0 : 1, stdout: "", stderr: "" }; } catch { return { code: 1, stdout: "", stderr: "" }; } }
        return { code: 0, stdout: "", stderr: "" };
      }
      tried.push(bin.split("/").pop());
      if (bin === "rsvg-convert") { await writeFile(args[args.indexOf("-o") + 1], "PNG"); return { code: 0, stdout: "", stderr: "" }; }
      if (bin === "xclip") return { code: 0, stdout: "", stderr: "" };
      throw new Error("ENOENT"); // not installed
    },
  };
  const { renderPng, cardSvg, copyImage } = await card(host);
  const used = await renderPng(cardSvg(summary, extra, colors), join(dir, "card.svg"), join(dir, "card.png"));
  assert.equal(used, "rsvg-convert");
  assert.ok(tried.indexOf("rsvg-convert") > tried.indexOf("chromium"), "browsers first");
  assert.equal(await copyImage(join(dir, "card.png")), true, "copied for pasting (xclip here)");
});
