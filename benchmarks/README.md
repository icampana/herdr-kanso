# Benchmarks

`macos.mjs` measures Kanso at a git ref against your working tree, on macOS,
with a real Herdr app:

- **Folder listing**: each version's own Files `directory()` over real
  folders of 100 to 50,000 files.
- **Drawing the Files tree**: 500 and 5,000 rows in an isolated native Herdr
  window (its own `HERDR_APP_HOME`; your session is not touched), CPU, memory
  and redraws over 8 s.
- **Layout writes**: the strip's real `apply`, 1,000 updates in a burst,
  against a simulated host.

```sh
npm run bench -- --base origin/main   # or any ref: a tag, a commit
npm run bench:report                  # writes benchmarks/results/macos/REPORT.md
```

`--quick` runs fewer sizes and samples; `--listing-only` and `--native-only`
run one part and keep the other's last samples. Results, screenshots and the
report stay in `benchmarks/results/`, which is not committed.

## Latest results

Apple M4, 16 GiB, macOS 27.2, Herdr 0.1.11, November 2026. Base is Kanso
before the performance work (`1bd9669`); current is `main` after it.

| | Before | Now | |
|---|---:|---:|---:|
| List a folder of 100 files | 10.4 ms | 3.3 ms | 69% faster |
| List a folder of 1,000 files | 37.3 ms | 4.8 ms | 87% faster |
| List a folder of 10,000 files | 188.7 ms | 16.7 ms | 91% faster |
| List a folder of 50,000 files | 986.5 ms | 74.7 ms | 92% faster |
| Files tree, 500 rows (CPU, one core = 100%) | 103.7% | 23.1% | 78% less |
| Files tree, 5,000 rows | could not draw | 41.4% | |
| 1,000 strip layout updates, 2 panes | 52.6 ms | 21.9 ms | 58% less |
| 1,000 strip layout updates, 8 panes | 94.3 ms | 45.4 ms | 52% less |

What these are not: GPU frame times, battery life, or latency in a full
session with agents running. Other apps kept running during the runs. The
layout figure comes from a simulated host; during a fast fling the strip now
moves at most 10 times a second instead of 20, which is where most of its
saving comes from.
