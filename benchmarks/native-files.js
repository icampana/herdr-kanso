// Copied into a temporary HERDR_APP_HOME by macos.mjs. No user layout is edited.
import { View, div } from "gpui-kit";
import { Files } from "./files.js";
import { readTextFile, writeTextFile, appHome, run } from "herdr";
import { config } from "./config.js";

const clock = () => typeof performance !== "undefined" ? performance.now() : Date.now();

export default class NativeFilesBenchmark extends View {
  init(_props, cx) {
    this.panel = new Files();
    Object.assign(this.panel, {
      context: "benchmark", root: "/benchmark", entries: new Map(), folders: new Set(),
      marks: {}, file: null, error: null, limited: false, loading: false,
    });
    const root = [];
    if (config.rows <= 500) {
      for (let i = 0; i < config.rows; i++) root.push({ name: `file-${i}.js`, dir: false });
    } else {
      let remaining = config.rows;
      for (let folder = 0; remaining; folder++) {
        const name = `folder-${folder}`, count = Math.min(499, remaining - 1);
        root.push({ name, dir: true }); this.panel.folders.add(name);
        this.panel.entries.set(name, Array.from({ length: count }, (_, i) => ({ name: `file-${i}.js`, dir: false })));
        remaining -= count + 1;
      }
    }
    this.panel.entries.set("", root);
    this.errors = [];
    this.reset();
    if (this.panel.row) {
      const row = this.panel.row.bind(this.panel);
      this.panel.row = (...args) => {
        const start = clock();
        try { return row(...args); }
        catch (error) { if (!this.errors.length) this.errors.push(String(error)); return div().child("Benchmark error"); }
        finally { if (this.measuring) { this.rowBuildMs += clock() - start; this.rowsBuilt++; } }
      };
    } else {
      const rows = this.panel.rows.bind(this.panel);
      this.panel.rows = (...args) => {
        const result = rows(...args);
        if (this.measuring && args[0] === "") this.rowsBuilt += result.length;
        return result;
      };
    }
    cx.timer.every(16, (cx) => { if (!this.finished) cx.notify(); });
    cx.spawn(async (cx) => {
      await cx.sleep(config.warmupMs);
      await writeTextFile(`${appHome()}/ready.json`, JSON.stringify({ ready: true }), null);
      while (!await readTextFile(`${appHome()}/go.json`)) await cx.sleep(50);
      this.reset(); this.measuring = true;
      const start = Date.now();
      await cx.sleep(config.durationMs);
      this.measuring = false; this.finished = true;
      const result = {
        ...config, elapsedMs: Date.now() - start, renders: this.renders,
        renderMs: this.renderMs, rowBuildMs: this.rowBuildMs, rowsBuilt: this.rowsBuilt,
        renderSamplesMs: this.samples, renderIntervalsMs: this.intervals, errors: this.errors,
      };
      await writeTextFile(`${appHome()}/result.json`, JSON.stringify(result), null);
      // Allow the runner to collect the final CPU/RSS sample before exiting.
      await cx.sleep(1500);
      run("app.quit");
    });
  }

  reset() {
    this.renders = 0; this.renderMs = 0; this.rowBuildMs = 0; this.rowsBuilt = 0;
    this.samples = []; this.intervals = []; this.lastRender = null;
  }

  render(cx) {
    const start = clock();
    if (this.measuring) {
      if (this.lastRender !== null) this.intervals.push(start - this.lastRender);
      this.lastRender = start;
    }
    let tree;
    try { tree = this.panel.render(cx); }
    catch (error) { if (!this.errors.length) this.errors.push(String(error)); tree = div().child("Benchmark error"); }
    if (this.measuring) {
      const elapsed = clock() - start;
      this.renders++; this.renderMs += elapsed; this.samples.push(elapsed);
    }
    return tree;
  }
}
