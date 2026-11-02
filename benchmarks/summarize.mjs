import { readFileSync, writeFileSync, existsSync, statSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const dir = resolve(process.argv[2] ?? "benchmarks/results/macos");
const data = JSON.parse(readFileSync(join(dir, "raw.json"), "utf8"));
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
const med = (values) => quantile(values, 0.5);
const num = (n, digits = 2) => n === undefined || Number.isNaN(n) ? "-" : n.toFixed(digits);
const int = (n) => n === undefined ? "-" : Math.round(n).toLocaleString("en-US");
const delta = (value, base) => {
  const pct = (value / base - 1) * 100;
  return `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}% (${pct >= 0 ? "slower" : "faster"})`;
};
const variants = ["base", "pr", "current"];
const label = { base: "base", pr: "PR", current: "current" };
const os = Object.fromEntries(data.host.os.split("\n").map((line) => line.split(/:\s+/)));
const run = (r) => `${r.variant}-${r.rows}-${r.iteration}`;

const lines = [
  "# Kanso PR #11: macOS benchmarks", "",
  `Run at ${data.timestamp} (UTC) on an ${data.host.cpu}, ${data.host.logicalCpus} logical cores, ${data.host.memoryBytes / 2 ** 30} GiB RAM, ${data.host.arch}, ${os.ProductName} ${os.ProductVersion} (${os.BuildVersion}), ${data.host.herdr}, Node ${data.host.node}.`, "",
  "Three versions are compared:", "",
  `- **base**: \`${data.refs.base}\`, the commit before the PR.`,
  `- **PR**: \`${data.refs.pr}\`, the PR as first pushed.`,
  "- **current**: the PR plus `working-tree.patch` in this folder, the fixes that were uncommitted when the benchmark ran.", "",
  "## Method", "",
  "- **Listing**: real synthetic folders of empty files on the local disk, listed by each version's real `directory()` from `files.js`, with `exec` backed by Node's `spawn` (Herdr's own adds the same process start for every version). Wall time covers the process(es) it starts and parsing their output. Two warm-up rounds, then 21 samples per version and size, in rotating order, with a warm file cache.",
  "- **Rendering**: a native Herdr process with its own temporary `HERDR_APP_HOME` (your Herdr session is not touched), dark theme. The window was requested at 420 × 800 pt; the screenshots are 960 × 1600 px at 2x, so it ran at 480 × 800 pt. 1.5 s warm-up, then 8 s measured while a timer asks for a redraw every 16 ms (62.5/s). Three runs per version in rotating order. A version that errors once is not run again, so failed cases have a single run. No disk, Git or file watchers are involved: the tree is built in memory.",
  "- **Tree shapes**: 500 rows is one flat folder of 500 files. 5,000 rows is 10 expanded folders of 499 files each (10 folder rows plus 4,990 file rows), the most the panel loads (500 per folder, 5,000 in total).",
  "- **CPU** is the change in CPU time of the whole Herdr process over the window; 100% is one logical core. **RSS** is the highest value sampled every 200 ms, median across runs, for the whole process, not just the mod.",
  "- **Redraws/s** counts completed calls to the mod's `render`, not frames the GPU presented. The p95 interval is the time between those calls, not input latency.",
  "- **Layout**: a microbenchmark of the strip's real `apply` in Node/V8. 1,000 updates spaced 60 ms apart on a fake clock (a sustained burst, alternating between two widths), 9 runs after two warm-ups. Host calls are replaced by JSON copies, so it measures JS work and payload size, not GPU, persistence or other mods' redraws.",
  "- Other apps kept running on the Mac; this is not a controlled lab.", "",
  "## Listing a folder", "",
  "Median (p50) and p95 wall time in ms. Base and current read at most 501 entries, so they can tell a folder has more than 500; the PR read 500 and could not.", "",
  "| Files | Base p50 / p95 | PR p50 / p95 | Current p50 / p95 | Current vs. base, p50 |",
  "|---:|---:|---:|---:|---:|",
];
for (const count of [...new Set(data.listing.map((r) => r.count))]) {
  const samples = variants.map((v) => data.listing.filter((r) => r.variant === v && r.count === count).map((r) => r.elapsedMs));
  lines.push(`| ${int(count)} | ${samples.map((s) => `${num(med(s))} / ${num(quantile(s, 0.95))}`).join(" | ")} | ${delta(med(samples[2]), med(samples[0]))} |`);
}

lines.push("", "## Rendering the Files tree", "",
  "Medians across valid runs. A run is valid when it finished with no error.", "",
  "| Rows | Version | Valid runs | CPU | Max RSS, MiB | Redraws/s | Rows built per redraw | Interval p95, ms |",
  "|---:|---|---:|---:|---:|---:|---:|---:|");
const failures = [];
for (const rows of [...new Set(data.native.map((r) => r.rows))]) for (const variant of variants) {
  const all = data.native.filter((r) => r.rows === rows && r.variant === variant), valid = all.filter((r) => !r.errors.length);
  if (!all.length) { lines.push(`| ${int(rows)} | ${label[variant]} | 0 | not run (failed at a smaller size) | - | - | - | - |`); continue; }
  for (const r of all.filter((r) => r.errors.length)) failures.push(r);
  if (!valid.length) {
    const r = all[0];
    const what = r.renders ? `failed: ${int(r.renders)} redraws, ${num(r.cpuPercent, 1)}% CPU` : `failed: 0 redraws in ${num(r.elapsedMs / 1000, 1)} s, ${num(r.cpuPercent, 1)}% CPU`;
    lines.push(`| ${int(rows)} | ${label[variant]} | 0 of ${all.length} | ${what} | - | - | - | - |`);
    continue;
  }
  lines.push(`| ${int(rows)} | ${label[variant]} | ${valid.length} of ${all.length} | ${num(med(valid.map((r) => r.cpuPercent)), 1)}% | ${num(med(valid.map((r) => r.maxSampledRssBytes / 2 ** 20)), 1)} | ${num(med(valid.map((r) => r.redrawsPerSecond)), 1)} | ${num(med(valid.map((r) => r.rowsBuilt / r.renders)), 1)} | ${num(med(valid.map((r) => r.intervalP95Ms)), 1)} |`);
}

const failed = (variant, rows) => failures.find((r) => r.variant === variant && r.rows === rows);
lines.push("", "Failed runs:", "");
for (const r of failures) {
  const shot = basename(r.screenshot ?? "");
  lines.push(`- \`${run(r)}\` (screenshot \`${shot}\`): ${r.errors[0].replace(/\s+/g, " ")}`);
}
if (failed("pr", 500)) lines.push("",
  "**The PR breaks the Files panel.** It registers `on_click` and `on_mouse_down` inside the virtual list's item renderer, and Herdr rejects them when it lays the rows out: every row renders as the benchmark's error placeholder (`native-pr-500-0.png`), so clicks on files and folders would not work. Its CPU and redraw figures are not a valid result. The PR description reports `herdr-app check` passing; the check did not catch this. Current moves the handlers to the list's `on_item_click` and `on_item_secondary_click`. The error text above is cut off as Herdr reported it.");
if (failed("base", 5000)?.renders === 0) {
  const r = failed("base", 5000);
  lines.push("",
    `**Base cannot draw 5,000 rows.** It builds every row on every redraw; with 5,000 it did not complete a single redraw in ${num(r.elapsedMs / 1000, 1)} s while holding ${num(r.cpuPercent, 1)}% CPU, and Herdr interrupted the render: \`native-base-5000-0.png\` shows \"This view could not be rendered: interrupted\" with the stack in \`Files.rows\`. That is a real failure of base, not a measurement fault, but there is no base number to compute a percentage against at 5,000 rows.`);
}

lines.push("", "## Updating the layout", "",
  "Median per 1,000 `apply` calls.", "",
  "| Panes | Version | ms | vs. base | `layout.set` calls | `setShared` calls | KiB serialized |",
  "|---:|---|---:|---:|---:|---:|---:|");
for (const count of [...new Set(data.layout.map((r) => r.count))]) {
  const baseMs = med(data.layout.filter((r) => r.count === count && r.variant === "base").map((r) => r.elapsedMs));
  for (const variant of variants) {
    const rows = data.layout.filter((r) => r.count === count && r.variant === variant), ms = med(rows.map((r) => r.elapsedMs));
    lines.push(`| ${count} | ${label[variant]} | ${num(ms)} | ${variant === "base" ? "-" : delta(ms, baseMs)} | ${int(med(rows.map((r) => r.writes)))} | ${int(med(rows.map((r) => r.sharedWrites)))} | ${num(med(rows.map((r) => r.bytes / 1024)), 1)} |`);
  }
}

const logs = data.native.map((r) => join(dir, `native-${r.variant}-${r.rows}-${r.iteration}.log`)).filter(existsSync);
const emptyLogs = logs.length && logs.every((path) => statSync(path).size === 0);

// The conclusions quote the tables above, so they follow a rerun.
const listMed = (variant, count) => med(data.listing.filter((r) => r.variant === variant && r.count === count).map((r) => r.elapsedMs));
const listCounts = [...new Set(data.listing.map((r) => r.count))];
const listGains = listCounts.map((n) => 1 - listMed("current", n) / listMed("base", n));
const layoutMed = (variant, count) => med(data.layout.filter((r) => r.count === count && r.variant === variant).map((r) => r.elapsedMs));
const layoutCounts = [...new Set(data.layout.map((r) => r.count))];
const pct = (x) => `${Math.round(x * 100)}%`;
const nativeMed = (variant, rows, field) => {
  const valid = data.native.filter((r) => r.variant === variant && r.rows === rows && !r.errors.length);
  return valid.length ? med(valid.map(field)) : undefined;
};
const cpu = (r) => r.cpuPercent;
const cur500 = nativeMed("current", 500, cpu), base500 = nativeMed("base", 500, cpu), cur5000 = nativeMed("current", 5000, cpu);
lines.push("", "## What the numbers say", "",
  `- **Rendering**: current builds only the rows on screen (about ${num(nativeMed("current", 500, (r) => r.rowsBuilt / r.renders), 0)} per redraw). At 500 rows it uses ${num(cur500, 1)}% CPU against base's ${num(base500, 1)}% (${pct(1 - cur500 / base500)} less) and keeps up with the 16 ms timer; at 5,000 rows it uses ${num(cur5000, 1)}%, where base cannot draw at all. The PR's own numbers do not count, because its rows are broken.`,
  `- **Listing**: current runs one \`find\` with no shell (the PR's bash loop stays as a fallback), so a folder costs one process start. It is ${listGains.map(pct).join(", ")} faster than base at ${listCounts.map(int).join(", ")} files.`,
  (() => {
    const counts = layoutCounts.join(" and ");
    const vsBase = layoutCounts.map((n) => layoutMed("current", n) / layoutMed("base", n) - 1);
    const writes = med(data.layout.filter((r) => r.variant === "current").map((r) => r.writes));
    const head = `- **Layout**: the shared intent fixes writes that dropped each other. Current keeps the strip's columns under their own key, so the strip no longer reads back and copies the whole intent, and it writes at most every 100 ms (base and the PR: 50 ms), checked before it reads the tree: a burst writes its first step at once, then its latest state. Of these 1,000 updates it wrote ${int(writes)} trees; the rest were steps nobody would have seen, or already on screen.`;
    const cmp = vsBase.every((x) => x < 0)
      ? ` That makes it ${vsBase.map((x) => pct(-x)).join(" and ")} cheaper than base (${counts} panes) and ${layoutCounts.map((n) => pct(1 - layoutMed("current", n) / layoutMed("pr", n))).join(" and ")} cheaper than the PR, even though each write now also sends one \`setShared\`.`
      : ` Against base it is ${vsBase.map((x) => `${x >= 0 ? "+" : ""}${pct(x)}`).join(" and ")} (${counts} panes).`;
    return head + cmp + " The cost: during a fast fling the view moves at most 10 times a second instead of 20; a single step still lands at once.";
  })(),
  "- Not measured: battery, agent load, terminal scrolling, or interaction latency in a full session.", "",
  "## Reproduce", "",
  "```sh", "node benchmarks/macos.mjs", "node benchmarks/summarize.mjs", "```", "",
  `\`raw.json\` holds every sample; \`working-tree.patch\` is the exact diff measured as current; the PNGs are the window at the end of each run.${emptyLogs ? " The `.log` files are empty: Herdr wrote nothing to stdout or stderr in these runs, so the errors above come from the benchmark mod's own capture and the screenshots." : " The `.log` files hold each run's Herdr output."}`, "");
writeFileSync(join(dir, "REPORT.md"), lines.join("\n"));
console.log(join(dir, "REPORT.md"));
