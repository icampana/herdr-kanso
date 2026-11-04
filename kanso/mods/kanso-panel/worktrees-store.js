// The Worktrees panel's store, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// A local SQLite database (data/kanso-panel/worktrees.db, through the sqlite3
// command, as Shipped keeps its own) with the history of every worktree the
// panel has seen:
// - `worktrees`: one row per worktree while it exists, by its folder. A scan
//   adds the new ones and rewrites a row only when something in it changed
//   (its branch, what it holds, its size); nothing is copied twice. When one
//   is gone, removed here or anywhere else, its row stays, with when, by whom
//   (`kanso` or `outside`) and the size it had: that is what was freed. A
//   folder made again at the same path is a new row; the old one stays
//   history.
// - `scans`: the totals of each finished scan, for the days' chart.
import { exec, appHome, writeTextFile } from "herdr";

export const STORE_DIR = "data/kanso-panel";
// Two copies of the panel (or a scan and a removal) can reach the database at
// once: each sqlite3 waits up to 10 s for the other instead of failing.
const BUSY = ["-cmd", ".timeout 10000"];

const SCHEMA = `
PRAGMA journal_mode=WAL;
CREATE TABLE IF NOT EXISTS worktrees(
  id INTEGER PRIMARY KEY, path TEXT NOT NULL, repo TEXT NOT NULL, kind TEXT NOT NULL, branch TEXT,
  size INTEGER, dirty INTEGER NOT NULL DEFAULT 0, ahead INTEGER, only INTEGER NOT NULL DEFAULT 0,
  merged INTEGER NOT NULL DEFAULT 0, recent INTEGER NOT NULL DEFAULT 0, missing INTEGER NOT NULL DEFAULT 0,
  locked INTEGER NOT NULL DEFAULT 0, last_commit INTEGER,
  first_seen INTEGER NOT NULL, changed INTEGER NOT NULL,
  gone_at INTEGER, gone_by TEXT, freed INTEGER, branch_deleted INTEGER NOT NULL DEFAULT 0);
CREATE UNIQUE INDEX IF NOT EXISTS worktrees_live ON worktrees(path) WHERE gone_at IS NULL;
CREATE INDEX IF NOT EXISTS worktrees_gone ON worktrees(gone_at);
CREATE TABLE IF NOT EXISTS scans(at INTEGER PRIMARY KEY, worktrees INTEGER NOT NULL, size INTEGER NOT NULL,
  can_go INTEGER NOT NULL, can_go_size INTEGER NOT NULL, look INTEGER NOT NULL, missing INTEGER NOT NULL,
  orphans INTEGER NOT NULL, repos INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);`;

export const sqlText = (s) => (s === null || s === undefined ? "NULL" : `'${String(s).replace(/'/g, "''")}'`);
const int = (n) => (n === null || n === undefined || !Number.isFinite(Number(n)) ? "NULL" : String(Math.round(Number(n))));
const bit = (b) => (b ? "1" : "0");

// What a row keeps of a worktree (or a left-behind folder).
export function rowOf(w) {
  return {
    path: w.path, repo: w.repo ?? "", kind: w.orphan ? "orphan" : "worktree", branch: w.branch ?? null,
    size: w.size ?? null, dirty: w.dirty ?? 0, ahead: w.ahead ?? null, only: w.only ?? 0,
    merged: w.merged ? 1 : 0, recent: w.recent ? 1 : 0, missing: w.missing ? 1 : 0, locked: w.locked ? 1 : 0,
    last_commit: w.last ?? null,
  };
}

const FIELDS = ["repo", "kind", "branch", "dirty", "ahead", "only", "merged", "recent", "missing", "locked", "last_commit"];

// SQL that adds the new ones and rewrites a live row only when it changed.
// A size not measured yet (null) keeps the one stored.
export function upsertSql(items, now) {
  return items.map((w) => {
    const r = rowOf(w);
    const values = [sqlText(r.path), sqlText(r.repo), sqlText(r.kind), sqlText(r.branch), int(r.size), int(r.dirty), int(r.ahead), int(r.only),
      bit(r.merged), bit(r.recent), bit(r.missing), bit(r.locked), int(r.last_commit), int(now), int(now)].join(",");
    const differs = [...FIELDS.map((f) => `worktrees.${f} IS NOT excluded.${f}`), "(excluded.size IS NOT NULL AND worktrees.size IS NOT excluded.size)"].join(" OR ");
    return `INSERT INTO worktrees(path,repo,kind,branch,size,dirty,ahead,only,merged,recent,missing,locked,last_commit,first_seen,changed) VALUES(${values})
ON CONFLICT(path) WHERE gone_at IS NULL DO UPDATE SET ${FIELDS.map((f) => `${f}=excluded.${f}`).join(",")}, size=COALESCE(excluded.size, worktrees.size), changed=excluded.changed
WHERE ${differs};`;
  }).join("\n");
}

// A live row as the panel's item: stored facts, not checked again yet.
export function itemOf(r) {
  return {
    path: r.path, repo: r.repo || null, orphan: r.kind === "orphan", branch: r.branch, size: r.size,
    dirty: r.dirty, ahead: r.ahead, only: r.only, merged: Boolean(r.merged), recent: Boolean(r.recent),
    missing: Boolean(r.missing), locked: Boolean(r.locked), last: r.last_commit, probed: true, fresh: false,
  };
}

export class WorktreeStore {
  constructor(dir) {
    this.dir = dir ?? `${appHome()}/${STORE_DIR}`;
    this.db = `${this.dir}/worktrees.db`;
    this.batches = 0;
  }

  async sql(text, json = false) {
    const r = await exec("sqlite3", [...BUSY, ...(json ? ["-json"] : []), this.db, text]);
    if (r.code !== 0) throw new Error((r.stderr || "sqlite3 failed").trim().split("\n")[0]);
    return json ? (r.stdout.trim() ? JSON.parse(r.stdout) : []) : r.stdout;
  }

  // Large writes go through a file: an argument can't hold hundreds of rows.
  async script(text) {
    if (!text.trim()) return;
    const path = `${this.dir}/.worktrees-${Date.now()}-${this.batches++}.sql`;
    await writeTextFile(path, `BEGIN;\n${text}\nCOMMIT;\n`, null);
    try {
      const r = await exec("sqlite3", [...BUSY, this.db, `.read '${path}'`]);
      if (r.code !== 0) throw new Error((r.stderr || "sqlite3 failed").trim().split("\n")[0]);
    } finally { await exec("rm", ["-f", path]).catch(() => {}); }
  }

  async open() {
    let ok = null;
    try { ok = await exec("sqlite3", ["-version"]); } catch {}
    if (ok?.code !== 0) throw new Error("Install sqlite3 to keep the history of your worktrees.");
    await exec("mkdir", ["-p", this.dir]);
    await this.sql(SCHEMA);
  }

  // The worktrees seen last, as they were.
  async live() {
    return (await this.sql("SELECT * FROM worktrees WHERE gone_at IS NULL;", true)).map(itemOf);
  }

  async save(items, now = Date.now()) { await this.script(upsertSql(items, now)); }

  // Rows no scan found again. A folder that no longer exists is gone (freed:
  // the size it had); a record of a folder already gone, once its repository
  // was read and no longer lists it. Anything else (a repository outside this
  // scan's folders) is left as it was.
  async sweep(seen, repos, now = Date.now()) {
    const rows = await this.sql("SELECT id, path, repo, missing, size FROM worktrees WHERE gone_at IS NULL;", true);
    const unseen = rows.filter((r) => !seen.has(r.path));
    if (!unseen.length) return 0;
    const check = unseen.filter((r) => !r.missing).map((r) => r.path);
    const absent = new Set();
    for (let i = 0; i < check.length; i += 200) {
      const r = await exec("bash", ["-c", 'for p in "$@"; do [ -e "$p" ] || printf "%s\\n" "$p"; done', "sweep", ...check.slice(i, i + 200)]);
      for (const line of String(r.stdout).split("\n")) if (line) absent.add(line);
    }
    const gone = unseen.filter((r) => (r.missing ? repos.has(r.repo) : absent.has(r.path)));
    await this.script(gone.map((r) => `UPDATE worktrees SET gone_at=${int(now)}, gone_by='outside', freed=${r.missing ? "0" : "COALESCE(size,0)"} WHERE id=${int(r.id)};`).join("\n"));
    return gone.length;
  }

  // Removed here: when, and what it freed.
  async removed(w, got, now = Date.now()) {
    await this.sql(`UPDATE worktrees SET gone_at=${int(now)}, gone_by='kanso', freed=${int(got.kb ?? 0)}, branch_deleted=${bit(got.branches)}, size=COALESCE(${int(w.size)}, size)
WHERE path=${sqlText(w.path)} AND gone_at IS NULL;`);
  }

  async recordScan(s, now = Date.now()) {
    await this.sql(`INSERT OR REPLACE INTO scans(at,worktrees,size,can_go,can_go_size,look,missing,orphans,repos) VALUES(${[now, s.worktrees, s.size, s.canGo, s.canGoSize, s.look, s.missing, s.orphans, s.repos].map(int).join(",")});`);
  }

  // What was freed, in all and by day, and the disk the worktrees took each day (the day's last scan).
  async history() {
    const [totals, byDay, disk, first] = await Promise.all([
      this.sql(`SELECT COALESCE(SUM(freed),0) kb, COALESCE(SUM(CASE WHEN gone_by='kanso' THEN freed END),0) kanso,
        SUM(kind='worktree' AND missing=0) worktrees, SUM(missing=1) records, SUM(kind='orphan') orphans, COALESCE(SUM(branch_deleted),0) branches
        FROM worktrees WHERE gone_at IS NOT NULL;`, true),
      this.sql(`SELECT strftime('%Y-%m-%d', gone_at/1000, 'unixepoch', 'localtime') day, SUM(freed) kb FROM worktrees WHERE gone_at IS NOT NULL GROUP BY day;`, true),
      this.sql(`SELECT strftime('%Y-%m-%d', at/1000, 'unixepoch', 'localtime') day, size FROM scans s WHERE at = (SELECT MAX(at) FROM scans t
        WHERE strftime('%Y-%m-%d', t.at/1000, 'unixepoch', 'localtime') = strftime('%Y-%m-%d', s.at/1000, 'unixepoch', 'localtime'));`, true),
      this.sql("SELECT MIN(at) at FROM scans;", true),
    ]);
    const t = totals[0] ?? {};
    return {
      kb: t.kb ?? 0, kanso: t.kanso ?? 0, worktrees: t.worktrees ?? 0, records: t.records ?? 0, orphans: t.orphans ?? 0, branches: t.branches ?? 0,
      since: first[0]?.at ?? null,
      freedByDay: Object.fromEntries(byDay.map((r) => [r.day, r.kb ?? 0])),
      diskByDay: Object.fromEntries(disk.map((r) => [r.day, r.size ?? 0])),
    };
  }
}
