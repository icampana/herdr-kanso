#!/usr/bin/env node
import { randomUUID } from "node:crypto";
import { realpathSync, renameSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { migrateLoadedConfig, normalizeConfig, sourcesSignature } from "./core/config.mjs";
import { scanSources } from "./core/scan.mjs";
import {
  clearCollectedData,
  loadStore,
  saveStore,
  snapshotRows,
} from "./core/store.mjs";
import { withStoreLock } from "./core/util.mjs";

// herdr stops an exec after 30 s. Leave room for the store save, the
// dashboard derivation and process startup, then continue on the next run.
export const SCAN_BUDGET_MS = 18_000;

function usage() {
  return [
    "Usage:",
    "  collector.mjs snapshot --store <file> [--home <dir>] [--rebuild]",
    "  collector.mjs configure --store <file> [--home <dir>] --config <json> [--rebuild]",
  ].join("\n");
}

function parseArgs(argv) {
  const command = argv[0];
  const options = { rebuild: false };
  for (let index = 1; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === "--rebuild") {
      options.rebuild = true;
      continue;
    }
    if (arg === "--help" || arg === "-h") {
      options.help = true;
      continue;
    }
    const match = /^--(store|home|config)(?:=(.*))?$/.exec(arg);
    if (!match) throw new Error(`unknown argument ${arg}`);
    const key = match[1];
    let value = match[2];
    if (value === undefined) {
      index += 1;
      value = argv[index];
      if (value === undefined) throw new Error(`--${key} needs a value`);
    }
    options[key] = value;
  }
  return { command, options };
}

/** The in-process caller (presenter) reuses the scanned store instead of parsing it again. */
function withStore(snapshot, store) {
  Object.defineProperty(snapshot, "store", { value: store, enumerable: false });
  return snapshot;
}

async function buildSnapshot(store, scan, nowIso, loadWarnings = [], loadErrors = 0) {
  const warnings = [...loadWarnings, ...scan.warnings];
  if (scan.stats.partial) {
    warnings.push(`First scan in progress: ${scan.stats.processed} of ${scan.stats.total} files indexed; it continues on the next refresh.`);
  }
  const stats = {
    ...scan.stats,
    errors: scan.stats.errors + loadErrors,
  };
  return {
    version: 1,
    generatedAt: nowIso,
    lastScanAt: nowIso,
    config: store.config,
    rows: snapshotRows(store),
    stats,
    sourceStats: scan.sourceStats ?? undefined,
    warnings,
  };
}

/**
 * Best-effort scan progress sidecar next to the store. The native view polls
 * it only while a refresh is running; it is removed when the scan settles.
 */
export function progressWriter(storePath) {
  const progressPath = `${storePath}.progress.json`;
  const tempPath = `${progressPath}.${process.pid}-${randomUUID()}.tmp`;
  let lastWrite = 0;
  return {
    update(state) {
      const now = Date.now();
      if (now - lastWrite < 250 && state.processed < state.total) return;
      lastWrite = now;
      try {
        // Atomic replacement also avoids following an existing sidecar link.
        writeFileSync(tempPath, `${JSON.stringify(state)}\n`, { mode: 0o600, flag: "wx" });
        renameSync(tempPath, progressPath);
      } catch { /* progress is best-effort */ }
      finally {
        try { unlinkSync(tempPath); } catch { /* renamed or not created */ }
      }
    },
    clear() {
      try {
        unlinkSync(progressPath);
      } catch { /* already gone */ }
    },
  };
}

async function snapshotWithStore(storePath, home, { rebuild = false } = {}) {
  const scanStartedAt = Date.now();
  return withStoreLock(storePath, async () => {
    const loaded = await loadStore(storePath);
    const store = loaded.store;
    let dirty = loaded.dirty;
    if (rebuild) {
      clearCollectedData(store);
      dirty = true;
    }
    const progress = progressWriter(storePath);
    let scan;
    try {
      scan = await scanSources(store, {
        home,
        onProgress: (state) => progress.update(state),
        deadline: scanStartedAt + SCAN_BUDGET_MS,
      });
    } finally {
      progress.clear();
    }
    if (dirty || scan.dirty) await saveStore(storePath, store);
    const now = new Date().toISOString();
    return withStore(await buildSnapshot(store, scan, now, loaded.warnings, loaded.errors), store);
  });
}

async function configureStore(storePath, home, rawConfig, { rebuild = false } = {}) {
  const scanStartedAt = Date.now();
  let config;
  try {
    const parsed = typeof rawConfig === "string" ? JSON.parse(rawConfig) : rawConfig;
    config = migrateLoadedConfig(normalizeConfig(parsed)).config;
  } catch (error) {
    const invalid = new Error(`invalid --config: ${error.message}`);
    invalid.exitCode = 2;
    throw invalid;
  }

  return withStoreLock(storePath, async () => {
    const loaded = await loadStore(storePath);
    const store = loaded.store;
    let dirty = loaded.dirty;
    const configChanged = JSON.stringify(store.config) !== JSON.stringify(config);
    const mappingsChanged =
      sourcesSignature(store.config) !== sourcesSignature(config);
    if (configChanged) {
      store.config = config;
      dirty = true;
    }
    if (mappingsChanged || rebuild) {
      clearCollectedData(store);
      dirty = true;
    }

    // Persist the accepted config before scanning. If the scan fails, the UI
    // still has the newly configured sources and can show the scan error.
    if (dirty) {
      await saveStore(storePath, store);
      dirty = false;
    }

    const progress = progressWriter(storePath);
    let scan;
    try {
      scan = await scanSources(store, {
        home,
        onProgress: (state) => progress.update(state),
        deadline: scanStartedAt + SCAN_BUDGET_MS,
      });
    } finally {
      progress.clear();
    }
    if (dirty || scan.dirty) await saveStore(storePath, store);
    const now = new Date().toISOString();
    return withStore(await buildSnapshot(store, scan, now, loaded.warnings, loaded.errors), store);
  });
}

export async function run(argv) {
  const { command, options } = parseArgs(argv);
  if (options.help || !command) {
    return { exitCode: 0, stdout: "", stderr: `${usage()}\n` };
  }
  if (command !== "snapshot" && command !== "configure") {
    return { exitCode: 2, stdout: "", stderr: `unknown command ${command}\n${usage()}\n` };
  }
  if (!options.store) {
    return { exitCode: 2, stdout: "", stderr: "--store is required\n" };
  }
  if (command === "configure" && options.config === undefined) {
    return { exitCode: 2, stdout: "", stderr: "--config is required\n" };
  }
  const snapshot = await collectSnapshot(command, options);
  return {
    exitCode: 0,
    stdout: `${JSON.stringify(snapshot)}\n`,
    stderr: "",
  };
}

/** In-process API: the presenter never serializes and reparses raw rows. */
export async function collectSnapshot(command, options) {
  if (!["snapshot", "configure"].includes(command)) throw new Error("unknown collector command");
  if (!options?.store) throw new Error("--store is required");
  if (command === "configure" && options.config === undefined) throw new Error("--config is required");
  const storePath = path.resolve(options.store);
  const home = path.resolve(options.home ?? os.homedir());
  return command === "snapshot"
    ? snapshotWithStore(storePath, home, { rebuild: options.rebuild })
    : configureStore(storePath, home, options.config, { rebuild: options.rebuild });
}

async function main() {
  try {
    const result = await run(process.argv.slice(2));
    if (result.stdout) process.stdout.write(result.stdout);
    if (result.stderr) process.stderr.write(result.stderr);
    process.exitCode = result.exitCode;
  } catch (error) {
    process.stderr.write(`kanso-spend collector: ${error.message}\n`);
    process.exitCode = error.exitCode ?? 1;
  }
}

function isInvokedDirectly() {
  const entry = process.argv[1];
  if (!entry) return false;
  try {
    return realpathSync(entry) === realpathSync(fileURLToPath(import.meta.url));
  } catch {
    return pathToFileURL(entry).href === import.meta.url;
  }
}

if (isInvokedDirectly()) {
  await main();
}
