# Kanso PR #11: macOS benchmarks

Run at 2026-11-02T05:04:58.774Z (UTC) on an Apple M4, 10 logical cores, 16 GiB RAM, arm64, macOS 27.2 (26B123), herdr-app 0.1.11, Node v22.23.4.

Three versions are compared:

- **base**: `1bd96693a4f399adb34bd6d354ab795f4bae6cae`, the commit before the PR.
- **PR**: `e2968aaf18b2f348d0c520ae5b9bee9c7fb8648d`, the PR as first pushed.
- **current**: the PR plus `working-tree.patch` in this folder, the fixes that were uncommitted when the benchmark ran.

## Method

- **Listing**: real synthetic folders of empty files on the local disk, listed by each version's real `directory()` from `files.js`, with `exec` backed by Node's `spawn` (Herdr's own adds the same process start for every version). Wall time covers the process(es) it starts and parsing their output. Two warm-up rounds, then 21 samples per version and size, in rotating order, with a warm file cache.
- **Rendering**: a native Herdr process with its own temporary `HERDR_APP_HOME` (your Herdr session is not touched), dark theme. The window was requested at 420 × 800 pt; the screenshots are 960 × 1600 px at 2x, so it ran at 480 × 800 pt. 1.5 s warm-up, then 8 s measured while a timer asks for a redraw every 16 ms (62.5/s). Three runs per version in rotating order. A version that errors once is not run again, so failed cases have a single run. No disk, Git or file watchers are involved: the tree is built in memory.
- **Tree shapes**: 500 rows is one flat folder of 500 files. 5,000 rows is 10 expanded folders of 499 files each (10 folder rows plus 4,990 file rows), the most the panel loads (500 per folder, 5,000 in total).
- **CPU** is the change in CPU time of the whole Herdr process over the window; 100% is one logical core. **RSS** is the highest value sampled every 200 ms, median across runs, for the whole process, not just the mod.
- **Redraws/s** counts completed calls to the mod's `render`, not frames the GPU presented. The p95 interval is the time between those calls, not input latency.
- **Layout**: a microbenchmark of the strip's real `apply` in Node/V8. 1,000 updates spaced 60 ms apart on a fake clock (a sustained burst, alternating between two widths), 9 runs after two warm-ups. Host calls are replaced by JSON copies, so it measures JS work and payload size, not GPU, persistence or other mods' redraws.
- Other apps kept running on the Mac; this is not a controlled lab.

## Listing a folder

Median (p50) and p95 wall time in ms. Base and current read at most 501 entries, so they can tell a folder has more than 500; the PR read 500 and could not.

| Files | Base p50 / p95 | PR p50 / p95 | Current p50 / p95 | Current vs. base, p50 |
|---:|---:|---:|---:|---:|
| 100 | 10.43 / 11.46 | 15.12 / 17.88 | 3.27 / 3.80 | -68.7% (faster) |
| 1,000 | 37.32 / 45.18 | 40.05 / 45.43 | 4.81 / 8.24 | -87.1% (faster) |
| 10,000 | 188.70 / 195.47 | 59.01 / 62.83 | 16.68 / 19.40 | -91.2% (faster) |
| 50,000 | 986.48 / 1104.31 | 107.63 / 122.09 | 74.69 / 82.51 | -92.4% (faster) |

## Rendering the Files tree

Medians across valid runs. A run is valid when it finished with no error.

| Rows | Version | Valid runs | CPU | Max RSS, MiB | Redraws/s | Rows built per redraw | Interval p95, ms |
|---:|---|---:|---:|---:|---:|---:|---:|
| 500 | base | 3 of 3 | 103.7% | 160.1 | 47.1 | 500.0 | 22.0 |
| 500 | PR | 0 of 1 | failed: 478 redraws, 17.6% CPU | - | - | - | - |
| 500 | current | 3 of 3 | 23.1% | 132.3 | 59.7 | 28.0 | 25.1 |
| 5,000 | base | 0 of 1 | failed: 0 redraws in 8.1 s, 103.9% CPU | - | - | - | - |
| 5,000 | PR | 0 | not run (failed at a smaller size) | - | - | - | - |
| 5,000 | current | 3 of 3 | 41.4% | 135.5 | 59.9 | 28.0 | 20.3 |

Failed runs:

- `pr-500-0` (screenshot `native-pr-500-0.png`): TypeError: `on_click` cannot be registered from a virtual list's item renderer: the rows are rebuilt every frame, so a handler registered there would pile up for as long as the view stood. Use `on_item_click((key, cx) => ...)` or `on_item_secondary_click((key, event
- `base-5000-0` (screenshot `native-base-5000-0.png`): No redraws completed during the measurement window

**The PR breaks the Files panel.** It registers `on_click` and `on_mouse_down` inside the virtual list's item renderer, and Herdr rejects them when it lays the rows out: every row renders as the benchmark's error placeholder (`native-pr-500-0.png`), so clicks on files and folders would not work. Its CPU and redraw figures are not a valid result. The PR description reports `herdr-app check` passing; the check did not catch this. Current moves the handlers to the list's `on_item_click` and `on_item_secondary_click`. The error text above is cut off as Herdr reported it.

**Base cannot draw 5,000 rows.** It builds every row on every redraw; with 5,000 it did not complete a single redraw in 8.1 s while holding 103.9% CPU, and Herdr interrupted the render: `native-base-5000-0.png` shows "This view could not be rendered: interrupted" with the stack in `Files.rows`. That is a real failure of base, not a measurement fault, but there is no base number to compute a percentage against at 5,000 rows.

## Updating the layout

Median per 1,000 `apply` calls.

| Panes | Version | ms | vs. base | `layout.set` calls | `setShared` calls | KiB serialized |
|---:|---|---:|---:|---:|---:|---:|
| 2 | base | 52.55 | - | 1,000 | 0 | 1988.3 |
| 2 | PR | 83.61 | +59.1% (slower) | 1,000 | 1,000 | 2500.0 |
| 2 | current | 21.90 | -58.3% (faster) | 333 | 333 | 853.0 |
| 8 | base | 94.25 | - | 1,000 | 0 | 3488.3 |
| 8 | PR | 201.35 | +113.6% (slower) | 1,000 | 1,000 | 5500.0 |
| 8 | current | 45.42 | -51.8% (faster) | 333 | 333 | 1896.9 |

## What the numbers say

- **Rendering**: current builds only the rows on screen (about 28 per redraw). At 500 rows it uses 23.1% CPU against base's 103.7% (78% less) and keeps up with the 16 ms timer; at 5,000 rows it uses 41.4%, where base cannot draw at all. The PR's own numbers do not count, because its rows are broken.
- **Listing**: current runs one `find` with no shell (the PR's bash loop stays as a fallback), so a folder costs one process start. It is 69%, 87%, 91%, 92% faster than base at 100, 1,000, 10,000, 50,000 files.
- **Layout**: the shared intent fixes writes that dropped each other. Current keeps the strip's columns under their own key, so the strip no longer reads back and copies the whole intent, and it writes at most every 100 ms (base and the PR: 50 ms), checked before it reads the tree: a burst writes its first step at once, then its latest state. Of these 1,000 updates it wrote 333 trees; the rest were steps nobody would have seen, or already on screen. That makes it 58% and 52% cheaper than base (2 and 8 panes) and 74% and 77% cheaper than the PR, even though each write now also sends one `setShared`. The cost: during a fast fling the view moves at most 10 times a second instead of 20; a single step still lands at once.
- Not measured: battery, agent load, terminal scrolling, or interaction latency in a full session.

## Reproduce

```sh
node benchmarks/macos.mjs
node benchmarks/summarize.mjs
```

`raw.json` holds every sample; `working-tree.patch` is the exact diff measured as current; the PNGs are the window at the end of each run. The `.log` files are empty: Herdr wrote nothing to stdout or stderr in these runs, so the errors above come from the benchmark mod's own capture and the screenshots.
