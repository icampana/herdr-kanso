// Turns a run of benchmarks/macos.mjs (raw.json) into REPORT.md beside it.
//   node benchmarks/summarize.mjs [results folder]
import { readFileSync, writeFileSync } from "node:fs";
import { resolve, join, basename } from "node:path";

const dir = resolve(process.argv[2] ?? "benchmarks/results/macos");
const data = JSON.parse(readFileSync(join(dir, "raw.json"), "utf8"));
const quantile = (values, q) => [...values].sort((a, b) => a - b)[Math.min(values.length - 1, Math.ceil(values.length * q) - 1)];
const med = (values) => values.length ? quantile(values, 0.5) : undefined;
const num = (n, digits = 2) => n === undefined || Number.isNaN(n) ? "-" : n.toFixed(digits);
const int = (n) => n === undefined ? "-" : Math.round(n).toLocaleString("en-US");
const pct = (x) => `${Math.round(Math.abs(x) * 100)}%`;
const change = (value, base) => {
  const x = value / base - 1;
  return `${x >= 0 ? "+" : "-"}${pct(x)} (${x >= 0 ? "slower" : "faster"})`;
};
// Results from older runs may carry a third version ("pr"); show what is there.
const variants = ["base", "pr", "current"].filter((v) => [...data.listing, ...data.native, ...data.layout].some((r) => r.variant === v));
const label = { base: "Base", pr: "PR", current: "Current" };
const os = Object.fromEntries(data.host.os.split("\n").map((line) => line.split(/:\s+/)));
const runName = (r) => `${r.variant}-${r.rows}-${r.iteration}`;

const listMed = (variant, count) => med(data.listing.filter((r) => r.variant === variant && r.count === count).map((r) => r.elapsedMs));
const listCounts = [...new Set(data.listing.map((r) => r.count))];
const layoutRows = (variant, count) => data.layout.filter((r) => r.count === count && r.variant === variant);
const layoutMed = (variant, count) => med(layoutRows(variant, count).map((r) => r.elapsedMs));
const layoutCounts = [...new Set(data.layout.map((r) => r.count))];
const validRuns = (variant, rows) => data.native.filter((r) => r.variant === variant && r.rows === rows && !r.errors.length);
const nativeMed = (variant, rows, field) => med(validRuns(variant, rows).map(field));
const nativeRows = [...new Set(data.native.map((r) => r.rows))];

const lines = [
  "# Kanso on macOS: benchmark report", "",
  `Run at ${data.timestamp} (UTC) on an ${data.host.cpu}, ${data.host.logicalCpus} logical cores, ${data.host.memoryBytes / 2 ** 30} GiB RAM, ${os.ProductName} ${os.ProductVersion}, ${data.host.herdr}, Node ${data.host.node}.`, "",
  `- **Base**: \`${data.refs.base}\`.`,
  ...(data.refs.pr ? [`- **PR**: \`${data.refs.pr}\`.`] : []),
  "- **Current**: the working tree; `current.patch` beside this report is its exact difference from base.", "",
  "## Method", "",
  "- **Listing**: real folders of empty files on the local disk, listed by each version's own `directory()` from `files.js`, with `exec` backed by Node's `spawn`. Wall time covers the processes it starts and parsing their output. Two warm-up rounds, then 21 samples per version and size, in rotating order, warm file cache.",
  "- **Rendering**: a native Herdr window with its own temporary `HERDR_APP_HOME` (your session is not touched), 480 × 800 pt, dark theme. 1.5 s warm-up, then 8 s while a timer asks for a redraw every 16 ms (62.5/s). Three runs per version in rotating order; a version that errors is not run again. The tree is built in memory: no disk, Git or watchers. 500 rows is one flat folder; 5,000 rows is 10 expanded folders of 499 files, the most the panel loads.",
  "- **CPU** is the whole Herdr process's CPU time over the window; 100% is one logical core. **RSS** is the highest value sampled every 200 ms. **Redraws/s** counts completed `render` calls, not GPU frames.",
  "- **Layout**: the strip's real `apply` in Node/V8: 1,000 updates 60 ms apart on a fake clock (a sustained burst, alternating between two widths), 9 runs after two warm-ups. Host calls are JSON copies, so it measures JS work and payload size, not GPU or persistence.",
  "- Other apps kept running; this is not a controlled lab.", "",
  "## Listing a folder", "",
  "Median (p50) and p95 wall time in ms.", "",
  `| Files | ${variants.map((v) => `${label[v]} p50 / p95`).join(" | ")} | Current vs. base |`,
  `|---:|${variants.map(() => "---:").join("|")}|---:|`,
];
for (const count of listCounts) {
  const cells = variants.map((v) => {
    const s = data.listing.filter((r) => r.variant === v && r.count === count).map((r) => r.elapsedMs);
    return `${num(med(s))} / ${num(s.length ? quantile(s, 0.95) : undefined)}`;
  });
  lines.push(`| ${int(count)} | ${cells.join(" | ")} | ${change(listMed("current", count), listMed("base", count))} |`);
}

lines.push("", "## Drawing the Files tree", "",
  "Medians across valid runs; a run is valid when it finished with no error.", "",
  "| Rows | Version | Valid runs | CPU | Max RSS, MiB | Redraws/s | Rows built per redraw |",
  "|---:|---|---:|---:|---:|---:|---:|");
for (const rows of nativeRows) for (const variant of variants) {
  const all = data.native.filter((r) => r.rows === rows && r.variant === variant), valid = validRuns(variant, rows);
  if (!all.length) { lines.push(`| ${int(rows)} | ${label[variant]} | 0 | not run (failed at a smaller size) | - | - | - |`); continue; }
  if (!valid.length) {
    const r = all[0];
    lines.push(`| ${int(rows)} | ${label[variant]} | 0 of ${all.length} | failed: ${int(r.renders)} redraws in ${num(r.elapsedMs / 1000, 1)} s, ${num(r.cpuPercent, 1)}% CPU | - | - | - |`);
    continue;
  }
  lines.push(`| ${int(rows)} | ${label[variant]} | ${valid.length} of ${all.length} | ${num(nativeMed(variant, rows, (r) => r.cpuPercent), 1)}% | ${num(nativeMed(variant, rows, (r) => r.maxSampledRssBytes / 2 ** 20), 1)} | ${num(nativeMed(variant, rows, (r) => r.redrawsPerSecond), 1)} | ${num(nativeMed(variant, rows, (r) => r.rowsBuilt / r.renders), 1)} |`);
}
const failures = data.native.filter((r) => r.errors.length);
if (failures.length) {
  lines.push("", "Failed runs (the screenshot shows the window at the end):", "");
  for (const r of failures) lines.push(`- \`${runName(r)}\` (\`${basename(r.screenshot ?? "")}\`): ${r.errors[0].replace(/\s+/g, " ")}`);
}

lines.push("", "## Updating the layout", "",
  "Median per 1,000 strip updates.", "",
  "| Panes | Version | ms | vs. base | Trees written | KiB serialized |",
  "|---:|---|---:|---:|---:|---:|");
for (const count of layoutCounts) for (const variant of variants) {
  const rows = layoutRows(variant, count);
  if (!rows.length) continue;
  lines.push(`| ${count} | ${label[variant]} | ${num(layoutMed(variant, count))} | ${variant === "base" ? "-" : change(layoutMed(variant, count), layoutMed("base", count))} | ${int(med(rows.map((r) => r.writes)))} | ${num(med(rows.map((r) => r.bytes / 1024)), 1)} |`);
}

// The summary quotes the tables, so it follows a rerun.
const summary = [];
const listGains = listCounts.map((n) => 1 - listMed("current", n) / listMed("base", n));
if (listGains.length) summary.push(`- **Listing**: current is ${listGains.map((x) => `${pct(x)} ${x >= 0 ? "faster" : "slower"}`).join(", ")} than base at ${listCounts.map(int).join(", ")} files.`);
for (const rows of nativeRows) {
  const cur = nativeMed("current", rows, (r) => r.cpuPercent), base = nativeMed("base", rows, (r) => r.cpuPercent);
  if (cur === undefined) continue;
  const versus = base !== undefined ? ` against base's ${num(base, 1)}% (${pct(1 - cur / base)} ${cur <= base ? "less" : "more"})`
    : data.native.some((r) => r.variant === "base" && r.rows === rows) ? "; base could not draw it" : "";
  summary.push(`- **Files tree, ${int(rows)} rows**: current uses ${num(cur, 1)}% CPU${versus}.`);
}
const layoutGains = layoutCounts.map((n) => 1 - layoutMed("current", n) / layoutMed("base", n));
if (layoutGains.length) summary.push(`- **Layout**: current is ${layoutGains.map((x) => `${pct(x)} ${x >= 0 ? "cheaper" : "dearer"}`).join(" and ")} than base with ${layoutCounts.join(" and ")} panes.`);
summary.push("- Not measured: battery, agent load, terminal scrolling, interaction latency in a full session.");
lines.push("", "## Summary", "", ...summary, "");

writeFileSync(join(dir, "REPORT.md"), lines.join("\n"));
console.log(join(dir, "REPORT.md"));
