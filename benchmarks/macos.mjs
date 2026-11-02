import assert from "node:assert/strict";
import { spawn, execFileSync } from "node:child_process";
import { readFileSync, writeFileSync, mkdirSync, mkdtempSync, cpSync, existsSync, rmSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { cpus, totalmem } from "node:os";
import { join, resolve } from "node:path";
import { performance } from "node:perf_hooks";
import vm from "node:vm";

// Compares Kanso at a git ref (--base, default origin/main) with your working
// tree: folder listing, the Files tree drawn by a real Herdr window, and the
// strip's layout writes. See benchmarks/README.md.
assert.equal(process.platform, "darwin", "This benchmark targets macOS.");
const argv = process.argv.slice(2);
const args = new Set(argv);
const baseRef = argv.includes("--base") ? argv[argv.indexOf("--base") + 1] : "origin/main";
assert.ok(baseRef && !baseRef.startsWith("--"), "--base needs a git ref, e.g. --base v1.0 or --base main");
const quick = args.has("--quick");
const root = resolve(new URL("..", import.meta.url).pathname);
const output = resolve(process.env.KANSO_BENCH_OUTPUT ?? "benchmarks/results/macos");
mkdirSync(output, { recursive: true });
// Unix socket paths must fit macOS's short sockaddr_un limit.
const scratch = mkdtempSync("/private/tmp/kb-");
const app = process.env.KANSO_BENCH_APP ?? "herdr-app";
let activeChild;
process.on("exit", () => { if (activeChild?.exitCode === null) activeChild.kill("SIGTERM"); });
process.on("SIGINT", () => process.exit(130));
const variants = ["base", "current"];
const refs = { base: execFileSync("git", ["rev-parse", baseRef], { cwd: root, encoding: "utf8" }).trim() };
const source = (variant, file) => variant === "current"
  ? readFileSync(join(root, file), "utf8")
  : execFileSync("git", ["show", `${refs[variant]}:${file}`], { cwd: root, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 });
// What "current" means, exactly: the working tree's difference from base.
writeFileSync(join(output, "current.patch"), execFileSync("git", ["diff", refs.base, "--", "kanso"], { cwd: root, encoding: "utf8", maxBuffer: 64 << 20 }));
const results = {
  timestamp: new Date().toISOString(), refs, scratch, host: {
    os: execFileSync("sw_vers", [], { encoding: "utf8" }).trim(), arch: process.arch,
    cpu: cpus()[0]?.model, logicalCpus: cpus().length, memoryBytes: totalmem(), node: process.version,
    herdr: execFileSync(app, ["--version"], { encoding: "utf8" }).trim(),
  }, listing: [], native: [], layout: [],
};
// A partial run keeps the other part's samples from the last run.
if ((args.has("--native-only") || args.has("--listing-only")) && existsSync(join(output, "raw.json"))) {
  const previous = JSON.parse(readFileSync(join(output, "raw.json"), "utf8"));
  if (args.has("--native-only")) Object.assign(results, { listing: previous.listing ?? [], layout: previous.layout ?? [] });
  else results.native = previous.native ?? [];
}
const save = () => writeFileSync(join(output, "raw.json"), JSON.stringify(results, null, 2));
const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const quantile = (list, q) => [...list].sort((a, b) => a - b)[Math.min(list.length - 1, Math.ceil(list.length * q) - 1)] ?? 0;
const median = (list) => quantile(list, 0.5);
const stripped = (text) => text.replace(/^import .*;\n/gm, "").replace(/export default /g, "").replace(/export /g, "");

async function listing() {
  for (const count of (quick ? [1000, 50000] : [100, 1000, 10000, 50000])) {
    const folder = join(scratch, `listing-${count}`); mkdirSync(folder);
    for (let i = 0; i < count; i++) writeFileSync(join(folder, `entry-${String(i).padStart(6, "0")}.txt`), "");
    // Each version's real directory(): its process(es), at the folder and cwd
    // it asks for, plus parsing the output in JS. exec mirrors Herdr's: the
    // user's environment, 8 MiB of output at most.
    const listers = {};
    for (const variant of variants) {
      const code = stripped(source(variant, "kanso/mods/kanso-panel/files.js"));
      const ctx = vm.createContext({ window: () => ({ platform: "macos" }), exec: (command, argv, options = {}) => new Promise((resolve, reject) => {
        const child = spawn(command, argv, { cwd: options.cwd });
        const out = [], err = [];
        child.stdout.on("data", (part) => out.push(part)); child.stderr.on("data", (part) => err.push(part));
        child.on("error", reject);
        child.on("close", (code) => resolve({ code, stdout: Buffer.concat(out).subarray(0, 8 << 20).toString(), stderr: Buffer.concat(err).toString() }));
      }) });
      listers[variant] = vm.runInContext(`${code}; directory`, ctx);
    }
    for (let iteration = -2; iteration < (quick ? 7 : 21); iteration++) {
      for (let k = 0; k < variants.length; k++) {
        const variant = variants[(k + iteration + variants.length) % variants.length];
        const start = performance.now();
        const list = await listers[variant](folder, null);
        const elapsedMs = performance.now() - start;
        // 501 tells the panel a folder was cut short; older versions read 500.
        assert.ok(list.length >= Math.min(count, 500) && list.length <= Math.min(count, 501), `${variant}: ${list.length} entries`);
        if (iteration >= 0) results.listing.push({ variant, count, iteration, elapsedMs, entries: list.length });
      }
    }
    save(); console.log(`Listing ${count}:`, variants.map((v) => `${v} ${median(results.listing.filter((r) => r.variant === v && r.count === count).map((r) => r.elapsedMs)).toFixed(2)} ms`).join(" | "));
  }
}

function layout() {
  const template = JSON.parse(readFileSync(join(root, "kanso/layouts/kanso.json"), "utf8"));
  const clone = (value) => JSON.parse(JSON.stringify(value));
  for (const count of [2, 8]) {
    const instances = {};
    for (const variant of variants) {
      let tree = clone(template), now = 10000, bytes = 0, writes = 0, sharedWrites = 0;
      const state = {};
      const ctx = vm.createContext({ View: class {}, Date: { now: () => now },
        layout: () => clone(tree), shared: (key) => clone(state[key] ?? null),
        setShared: (key, value) => { const text = JSON.stringify(value); bytes += Buffer.byteLength(text); sharedWrites++; state[key] = JSON.parse(text); },
        run: (_command, value) => { const text = JSON.stringify(value.layout); bytes += Buffer.byteLength(text); writes++; tree = JSON.parse(text); },
      });
      const Strip = vm.runInContext(`${stripped(source(variant, "kanso/mods/kanso-strip/main.js"))}; Strip`, ctx);
      const strip = new Strip(); strip.sets = [];
      const nodes = Array.from({ length: count }, (_, i) => ({ id: `strip-${i}`, type: "column", size: { weight: 1 }, children: [
        { id: `head-${i}`, type: "block", size: { px: 34 }, content: { mod: "kanso-strip", props: { pane: `p${i}`, terminal: `t${i}`, strip: true } } },
        { id: `term-${i}`, type: "block", content: { terminal: `t${i}` } },
      ] }));
      instances[variant] = () => {
        writes = 0; bytes = 0; sharedWrites = 0;
        const cpuStart = process.cpuUsage(), start = performance.now();
        for (let i = 0; i < 1000; i++) { now += 60; nodes[0].size.weight = 1 + (i % 2) * 0.1; strip.apply(nodes); }
        const cpu = process.cpuUsage(cpuStart);
        return { variant, count, elapsedMs: performance.now() - start, cpuMs: (cpu.user + cpu.system) / 1000, writes, sharedWrites, bytes };
      };
    }
    for (let iteration = -2; iteration < 9; iteration++) for (let k = 0; k < variants.length; k++) {
      const variant = variants[(k + iteration + variants.length) % variants.length], r = instances[variant]();
      if (iteration >= 0) results.layout.push({ ...r, iteration });
    }
    save(); console.log(`Layout ${count} panes: measured JS + serialized host payloads (not GPUI frame time).`);
  }
}

function cpuSample(pid) {
  try {
    const text = execFileSync("ps", ["-p", String(pid), "-o", "time=,rss="], { encoding: "utf8" }).trim();
    const [time, rss] = text.split(/\s+/), parts = time.split(":").map(Number);
    return { cpuMs: parts.reduce((seconds, part) => seconds * 60 + part, 0) * 1000, rssBytes: Number(rss) * 1024, at: Date.now() };
  } catch { return null; }
}

async function jsonFile(path) { try { return JSON.parse(await readFile(path, "utf8")); } catch { return null; } }

async function native() {
  const invalid = new Set();
  for (const rows of (quick ? [5000] : [500, 5000])) {
    for (let iteration = 0; iteration < (quick ? 1 : 3); iteration++) {
      for (let k = 0; k < variants.length; k++) {
        const variant = variants[(k + iteration) % variants.length];
        if (invalid.has(variant)) continue;
        const home = join(scratch, `native-${rows}-${iteration}-${variant}`), mod = join(home, "mods/benchmark");
        mkdirSync(mod, { recursive: true }); mkdirSync(join(home, "layouts"));
        cpSync(join(root, "kanso/mods/kanso-panel"), join(home, "mods/kanso-panel"), { recursive: true });
        for (const name of ["seen.json", "update-notes.json"]) {
          const original = join(process.env.HOME, ".config/herdr-app", name);
          if (existsSync(original)) cpSync(original, join(home, name));
        }
        writeFileSync(join(home, "settings.json"), JSON.stringify({ telemetry: false, appearance: "dark", font_size: 13 }));
        writeFileSync(join(home, "shared.json"), JSON.stringify({ layout: "benchmark", "frame.welcomed": "finished" }));
        writeFileSync(join(home, "window.json"), JSON.stringify({ state: "windowed", bounds: [60, 80, 420, 800] }));
        writeFileSync(join(home, "layouts/benchmark.json"), JSON.stringify({ id: "root", type: "block", content: { mod: "benchmark" } }));
        cpSync(join(root, "benchmarks/native-files.js"), join(mod, "main.js"));
        cpSync(join(root, "kanso/mods/kanso-panel/lib.js"), join(mod, "lib.js"));
        writeFileSync(join(mod, "context.js"), 'export { codeState, markdownView, isMarkdown, insideRoot } from "./lib.js"; export const key = () => "benchmark"; export const location = () => ({ cwd: "/benchmark", on: null });');
        writeFileSync(join(mod, "files.js"), source(variant, "kanso/mods/kanso-panel/files.js").replace('from "./lib.js"', 'from "./context.js"'));
        writeFileSync(join(mod, "config.js"), `export const config = ${JSON.stringify({ variant, rows, iteration, warmupMs: 1500, durationMs: quick ? 3000 : 8000 })};`);
        const env = { ...process.env, HERDR_APP_HOME: home };
        const child = activeChild = spawn(app, [], { env, stdio: ["ignore", "pipe", "pipe"] });
        let log = "";
        child.stdout.on("data", (data) => { log += data; }); child.stderr.on("data", (data) => { log += data; });
        const exited = new Promise((resolve) => child.on("exit", resolve));
        const deadline = Date.now() + 60000;
        while (!existsSync(join(home, "ready.json")) && Date.now() < deadline && child.exitCode === null) await sleep(100);
        if (!existsSync(join(home, "ready.json"))) {
          writeFileSync(join(output, `native-${variant}-${rows}-${iteration}.log`), log);
          child.kill("SIGTERM");
          throw new Error(`Native benchmark did not become ready: ${home}`);
        }
        let status = JSON.parse(execFileSync(app, ["status"], { env, timeout: 3000, encoding: "utf8" }));
        assert.equal(status.layout, "benchmark");
        // Herdr can open its own overlay (an update note, a toast) on start: close it first.
        for (let tries = 0; status.overlays.length && tries < 5; tries++) {
          console.log(`Closing overlay before measuring: ${JSON.stringify(status.overlays)}`);
          try { execFileSync(app, ["do", "overlay.close"], { env, timeout: 3000, stdio: "pipe" }); } catch {}
          await sleep(300);
          status = JSON.parse(execFileSync(app, ["status"], { env, timeout: 3000, encoding: "utf8" }));
        }
        assert.equal(status.overlays.length, 0, "An overlay would invalidate the rendering benchmark");
        const start = cpuSample(child.pid), samples = [];
        writeFileSync(join(home, "go.json"), "{}");
        let result;
        while (!(result = await jsonFile(join(home, "result.json"))) && Date.now() < deadline && child.exitCode === null) {
          const sample = cpuSample(child.pid); if (sample) samples.push(sample);
          await sleep(200);
        }
        const end = cpuSample(child.pid);
        if (!result) { child.kill("SIGTERM"); throw new Error(`Native benchmark failed to finish: ${home}`); }
        result.hostErrors = status.errors;
        if (!result.renders) result.errors.push("No redraws completed during the measurement window");
        const screenshot = join(output, `native-${variant}-${rows}-${iteration}.png`);
        try { execFileSync(app, ["shot", screenshot], { env, timeout: 1000, stdio: "pipe" }); } catch {}
        await exited;
        activeChild = null;
        result.windowBounds = (await jsonFile(join(home, "window.json")))?.bounds;
        writeFileSync(join(output, `native-${variant}-${rows}-${iteration}.log`), log);
        if (/on_click.*(render|handler)|error.*virtual/i.test(log) && !result.errors.length) result.errors.push("See runtime log for virtual-list errors");
        const cpuMs = end && start ? end.cpuMs - start.cpuMs : null;
        results.native.push({ ...result, cpuMs, cpuPercent: cpuMs / result.elapsedMs * 100,
          maxSampledRssBytes: Math.max(...samples.map((s) => s.rssBytes)), screenshot,
          renderP95Ms: quantile(result.renderSamplesMs, 0.95), intervalP95Ms: quantile(result.renderIntervalsMs, 0.95),
          redrawsPerSecond: result.renders / result.elapsedMs * 1000,
        });
        if (result.errors.length) invalid.add(variant);
        save();
        console.log(`Native ${variant}, ${rows} rows: ${result.renders} redraws, CPU ${(cpuMs / result.elapsedMs * 100).toFixed(1)}%, ${result.errors.length ? "INVALID: " + result.errors[0] : "valid"}`);
      }
    }
  }
}

save(); console.log(`macOS benchmark output: ${output}`);
if (!args.has("--native-only")) { await listing(); layout(); }
if (!args.has("--listing-only")) await native();
save();
if (!args.has("--keep-temp")) rmSync(scratch, { recursive: true, force: true });
console.log("Benchmark complete.");
