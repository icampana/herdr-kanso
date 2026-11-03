// Shipped's store, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// A local SQLite database (data/kanso-panel/shipped.db, through the sqlite3
// command) of statistics only: for each commit of yours, its repository, hash,
// time, lines added and removed and the machine it was read on; for each
// repository, GitHub's weekly sums. No messages, file names or code.
//
// Three sources fill it, each asked only for what changed:
// - this machine's git: every branch of the repositories in your panes and
//   spaces and under ~/Apps, ~/Projects and the like, by any of your
//   identities, so commits GitHub can't link to you count too;
// - your other machines: each one publishes its commits to a private gist of
//   yours ("Kanso Shipped stats", one file per machine) and reads the others';
//   a commit on several machines counts once, by its hash;
// - GitHub's weekly contributor statistics, for what no machine has cloned.
// A repository's week counts the larger of what the machines and GitHub saw.
import { exec, appHome, home, spaces, panes, readTextFile, writeTextFile } from "herdr";

export const STORE_DIR = "data/kanso-panel";
const GIST_DESCRIPTION = "Kanso Shipped stats";
const ROOTS = ["Apps", "Projects", "Developer", "code", "src", "dev", "work", "repos", "git", "github"];
const HASH = 12; // enough to tell commits apart, and short
export const WEEK0 = 3 * 86400; // 4 Jan 1970, the first Sunday: GitHub's weeks start on Sunday, UTC
export const weekOf = (sec) => Math.floor((sec - WEEK0) / 604800) * 604800 + WEEK0;

const SCHEMA = `
CREATE TABLE IF NOT EXISTS commits(repo TEXT NOT NULL, hash TEXT NOT NULL, at INTEGER NOT NULL, adds INTEGER NOT NULL, dels INTEGER NOT NULL, machine TEXT NOT NULL, PRIMARY KEY(repo, hash));
CREATE INDEX IF NOT EXISTS commits_at ON commits(at);
CREATE TABLE IF NOT EXISTS gh_weeks(repo TEXT NOT NULL, week INTEGER NOT NULL, adds INTEGER NOT NULL, dels INTEGER NOT NULL, commits INTEGER NOT NULL, PRIMARY KEY(repo, week));
CREATE TABLE IF NOT EXISTS gh_repos(repo TEXT PRIMARY KEY, pushed TEXT, fetched INTEGER NOT NULL DEFAULT 0, pending INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS scans(path TEXT PRIMARY KEY, repo TEXT NOT NULL, refs TEXT NOT NULL, scanned INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS meta(k TEXT PRIMARY KEY, v TEXT);`;

export const sqlText = (s) => `'${String(s ?? "").replace(/'/g, "''")}'`;
const int = (n) => String(Math.round(Number(n) || 0));

// A repository's name from its remote: owner/name on GitHub, host/path
// elsewhere, local/<folder> without one.
export function repoName(url, folder) {
  const u = String(url ?? "").trim().replace(/\.git$/, "").replace(/\/+$/, "");
  const gh = /github\.com[:/]+([^/]+\/[^/]+)$/i.exec(u);
  if (gh) return gh[1];
  const other = /^(?:[a-z+]+:\/\/)?(?:[^@/]+@)?([^/:]+)[:/]+(.+)$/i.exec(u);
  if (other) return `${other[1]}/${other[2]}`;
  return `local/${String(folder ?? "").replace(/\/+$/, "").split("/").pop() || "repository"}`;
}

// `git log --format='%x1e%H %at' --shortstat` as [{ hash, at (s), add, del }].
export function parseLog(stdout) {
  const out = [];
  for (const chunk of String(stdout).split("\x1e").slice(1)) {
    const [head, ...rest] = chunk.trim().split("\n");
    const [hash, at] = head.trim().split(/\s+/);
    const stat = rest.join(" ");
    out.push({
      hash: hash.slice(0, HASH), at: Number(at),
      add: Number(/(\d+) insertions?\(\+\)/.exec(stat)?.[1] ?? 0),
      del: Number(/(\d+) deletions?\(-\)/.exec(stat)?.[1] ?? 0),
    });
  }
  return out;
}

// SQL that adds commits, once each (a hash already read on another machine is kept as it was).
export function insertCommits(repo, commits, machine) {
  const rows = commits.map((c) => `(${sqlText(repo)},${sqlText(c.hash)},${int(c.at)},${int(c.add)},${int(c.del)},${sqlText(machine)})`);
  const out = [];
  for (let i = 0; i < rows.length; i += 500) out.push(`INSERT OR IGNORE INTO commits(repo,hash,at,adds,dels,machine) VALUES ${rows.slice(i, i + 500).join(",")};`);
  return out.join("\n");
}

// This machine's file in the gist: its commits, compact, and the identities it signs with.
export function machineFile(machine, identities, rows) {
  const repos = [], index = new Map();
  const commits = rows.map((r) => {
    if (!index.has(r.repo)) { index.set(r.repo, repos.length); repos.push(r.repo); }
    return [index.get(r.repo), r.hash, r.at, r.adds, r.dels];
  });
  return { v: 1, machine, updated: Math.floor(Date.now() / 1000), identities, repos, commits };
}

export function readMachineFile(text) {
  try {
    const f = JSON.parse(text);
    if (f?.v !== 1 || !Array.isArray(f.commits) || !Array.isArray(f.repos)) return null;
    return { machine: String(f.machine ?? "another machine"), identities: Array.isArray(f.identities) ? f.identities.map(String) : [], commits: f.commits.map(([r, hash, at, add, del]) => ({ repo: f.repos[r], hash, at, add, del })).filter((c) => c.repo && c.hash) };
  } catch { return null; }
}

// Repository-weeks with the larger of the machines' and GitHub's sums: { repo: { weeks: [[week ms, adds, dels, commits]] } }.
export const WEEKLY = `WITH l AS (SELECT repo, (at - ${WEEK0}) / 604800 * 604800 + ${WEEK0} AS week, SUM(adds) a, SUM(dels) d, COUNT(*) c FROM commits GROUP BY repo, week),
u AS (SELECT repo, week, a, d, c FROM l UNION ALL SELECT repo, week, adds, dels, commits FROM gh_weeks)
SELECT repo, week, MAX(a) a, MAX(d) d, MAX(c) c FROM u GROUP BY repo, week ORDER BY repo, week;`;

export function weeklyStats(rows) {
  const repos = {};
  for (const r of rows) (repos[r.repo] ??= { weeks: [] }).weeks.push([r.week * 1000, r.a, r.d, r.c]);
  return { repos };
}

export class Store {
  constructor() {
    this.dir = `${appHome()}/${STORE_DIR}`;
    this.db = `${this.dir}/shipped.db`;
    this.batches = 0;
  }

  async sql(text, json = false) {
    const r = await exec("sqlite3", [...(json ? ["-json"] : []), this.db, text]);
    if (r.code !== 0) throw new Error((r.stderr || "sqlite3 failed").trim().split("\n")[0]);
    return json ? (r.stdout.trim() ? JSON.parse(r.stdout) : []) : r.stdout;
  }

  // Large writes go through a file: an argument can't hold thousands of rows.
  async script(text) {
    if (!text.trim()) return;
    const path = `${this.dir}/.batch-${Date.now()}-${this.batches++}.sql`;
    await writeTextFile(path, `BEGIN;\n${text}\nCOMMIT;\n`, null);
    try {
      const r = await exec("sqlite3", [this.db, `.read '${path}'`]);
      if (r.code !== 0) throw new Error((r.stderr || "sqlite3 failed").trim().split("\n")[0]);
    } finally { await exec("rm", ["-f", path]).catch(() => {}); }
  }

  async open() {
    let ok = null;
    try { ok = await exec("sqlite3", ["-version"]); } catch {}
    if (ok?.code !== 0) throw new Error("Install sqlite3 to keep Shipped's statistics.");
    await exec("mkdir", ["-p", this.dir]);
    await this.sql(SCHEMA);
    await exec("rm", ["-f", `${this.dir}/shipped.json`]).catch(() => {}); // the cache before the database
  }

  async meta(k) { return (await this.sql(`SELECT v FROM meta WHERE k=${sqlText(k)};`, true))[0]?.v ?? null; }
  async setMeta(k, v) { await this.sql(`INSERT OR REPLACE INTO meta(k,v) VALUES(${sqlText(k)},${sqlText(v)});`); }

  async machine() {
    if (this.name) return this.name;
    let name = await this.meta("machine");
    if (!name) {
      const r = await exec("hostname", ["-s"]).catch(() => null);
      name = (r?.stdout ?? "").trim().replace(/[^A-Za-z0-9._-]+/g, "-") || `machine-${Date.now().toString(36)}`;
      await this.setMeta("machine", name);
    }
    return (this.name = name);
  }

  async weekly() { return weeklyStats(await this.sql(WEEKLY, true)); }

  // When and where you ship, from the commits read (local and synced) in [start, end) (s).
  async rhythm(start, end) {
    const span = `at >= ${int(start)} AND at < ${int(end)}`;
    const [hours, machines] = await Promise.all([
      this.sql(`SELECT CAST(strftime('%H', at, 'unixepoch', 'localtime') AS INTEGER) h, COUNT(*) n FROM commits WHERE ${span} GROUP BY h;`, true),
      this.sql(`SELECT machine, COUNT(*) n, SUM(adds) a, SUM(dels) d FROM commits WHERE ${span} GROUP BY machine ORDER BY n DESC;`, true),
    ]);
    const byHour = Array(24).fill(0);
    for (const r of hours) byHour[r.h] = r.n;
    return { hours: byHour, machines };
  }

  // ---- GitHub's weekly sums ----

  async ghRepos() { return this.sql("SELECT repo, pushed, fetched, pending FROM gh_repos;", true); }

  async saveGithub(entries) {
    const out = [];
    for (const e of entries) {
      out.push(`INSERT OR REPLACE INTO gh_repos(repo,pushed,fetched,pending) VALUES(${sqlText(e.repo)},${sqlText(e.pushed)},${int(e.fetched)},${e.pending ? 1 : 0});`);
      if (e.pending) continue;
      out.push(`DELETE FROM gh_weeks WHERE repo=${sqlText(e.repo)};`);
      for (const [w, a, d, c] of e.weeks) out.push(`INSERT INTO gh_weeks(repo,week,adds,dels,commits) VALUES(${sqlText(e.repo)},${int(w / 1000)},${int(a)},${int(d)},${int(c)});`);
    }
    await this.script(out.join("\n"));
  }

  // ---- this machine's git ----

  // Your repositories here, once each: where your panes and spaces are, the
  // ones read before, and those under the usual folders (4 levels deep).
  async localRepos() {
    const folders = new Set([
      ...panes().filter((p) => p.cwd && !String(p.pane).includes("/")).map((p) => p.cwd),
      ...spaces().filter((s) => !s.machine && s.folder).map((s) => s.folder),
      ...(await this.sql("SELECT path FROM scans;", true)).map((r) => r.path),
    ]);
    const found = await exec("sh", ["-c", 'for d in "$@"; do [ -d "$d" ] && find "$d" -maxdepth 4 -name .git -prune 2>/dev/null; done', "sh", ...ROOTS.map((r) => `${home()}/${r}`)]).catch(() => null);
    for (const line of (found?.stdout ?? "").split("\n")) if (line.trim()) folders.add(line.trim().replace(/\/\.git$/, ""));
    const repos = new Map();
    const list = [...folders];
    for (let i = 0; i < list.length; i += 8) {
      await Promise.all(list.slice(i, i + 8).map(async (folder) => {
        const r = await exec("sh", ["-c", 'cd "$1" 2>/dev/null && git rev-parse --path-format=absolute --git-common-dir --show-toplevel && (git config --get remote.origin.url || echo) && git for-each-ref --format="%(objectname)" | cksum', "sh", folder]).catch(() => null);
        if (r?.code !== 0) return;
        const [common, top, url, refs] = r.stdout.split("\n").map((s) => s.trim());
        if (!common || repos.has(common)) return;
        const main = common.endsWith("/.git") ? common.slice(0, -5) : top;
        repos.set(common, { path: main, repo: repoName(url, main), refs: refs ?? "" });
      }));
    }
    return [...repos.values()];
  }

  // Reads the commits of every repository whose branches moved since the last read.
  async scanLocal(identities, progress) {
    const machine = await this.machine();
    const seen = new Map((await this.sql("SELECT path, refs FROM scans;", true)).map((r) => [r.path, r.refs]));
    const repos = (await this.localRepos()).filter((r) => seen.get(r.path) !== r.refs);
    let done = 0;
    for (const r of repos) {
      const log = await exec("git", ["log", "--all", "--no-merges", "-F", ...identities.map((w) => `--author=${w}`), "--format=%x1e%H %at", "--shortstat"], { cwd: r.path }).catch(() => null);
      if (log?.code === 0) {
        await this.script(`${insertCommits(r.repo, parseLog(log.stdout), machine)}
INSERT OR REPLACE INTO scans(path,repo,refs,scanned) VALUES(${sqlText(r.path)},${sqlText(r.repo)},${sqlText(r.refs)},${int(Date.now() / 1000)});`);
      }
      progress?.(++done, repos.length);
    }
    return repos.length;
  }

  // ---- your other machines ----

  // Publishes this machine's commits to the gist and reads the other machines'.
  // Returns the identities they sign with.
  async syncMachines(identities) {
    const machine = await this.machine();
    let id = await this.meta("gist");
    if (!id) {
      const list = await exec("gh", ["api", "gists?per_page=100", "--paginate", "--jq", `.[] | select(.description == "${GIST_DESCRIPTION}") | .id`]);
      id = list.code === 0 ? list.stdout.split("\n").map((s) => s.trim()).find(Boolean) ?? null : null;
    }
    const mine = machineFile(machine, identities, await this.sql(`SELECT repo, hash, at, adds, dels FROM commits WHERE machine=${sqlText(machine)};`, true));
    const name = `shipped-${machine}.json`;
    const body = id ? { files: { [name]: { content: JSON.stringify(mine) } } } : { description: GIST_DESCRIPTION, public: false, files: { [name]: { content: JSON.stringify(mine) } } };
    const path = `${this.dir}/.gist-${Date.now()}.json`;
    await writeTextFile(path, JSON.stringify(body), null);
    let sent;
    try { sent = await exec("gh", ["api", ...(id ? ["-X", "PATCH", `gists/${id}`] : ["-X", "POST", "gists"]), "--input", path]); }
    finally { await exec("rm", ["-f", path]).catch(() => {}); }
    if (sent.code !== 0) throw new Error((sent.stderr || "the gist could not be written").trim().split("\n")[0]);
    const gist = JSON.parse(sent.stdout);
    if (!id) { id = gist.id; }
    await this.setMeta("gist", id);
    const others = [];
    for (const [file, f] of Object.entries(gist.files ?? {})) {
      if (file === name || !file.startsWith("shipped-")) continue;
      let text = f.content;
      if (f.truncated && f.raw_url) { const r = await exec("curl", ["-fsSL", "--max-time", "25", f.raw_url]).catch(() => null); text = r?.code === 0 ? r.stdout : null; }
      const other = text && readMachineFile(text);
      if (!other) continue;
      others.push(other);
      const byRepo = new Map();
      for (const c of other.commits) (byRepo.get(c.repo) ?? byRepo.set(c.repo, []).get(c.repo)).push(c);
      await this.script([...byRepo].map(([repo, commits]) => insertCommits(repo, commits, other.machine)).join("\n"));
    }
    return { gist: id, machines: others.map((o) => o.machine), identities: [...new Set(others.flatMap((o) => o.identities))] };
  }
}
