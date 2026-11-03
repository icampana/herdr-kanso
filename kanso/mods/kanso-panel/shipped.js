// Kanso's Shipped panel, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// Vanity metrics, on purpose: what you delivered, counted as generously as
// GitHub allows, drawn the way Spend draws what you spent (one centered
// column, a big light number, periods with arrows, then the breakdowns).
//
// Statistics only, never one item at a time from GitHub. The store
// (shipped-store.js, SQLite) holds your commits as your machines read them in
// local git, shared through a private gist, and each repository's weekly
// contributor sums from GitHub; a repository's week counts the larger of the
// two. Each refresh reads only what changed: repositories pushed since,
// branches that moved, machines that published. One GraphQL query of counts
// per period adds contributions (private ones included, as your profile counts
// them), reviews, merged pull requests, the last year's calendar (streak, best
// day, the heat map) and every pull request you ever merged. GitHub's sums are
// weekly, so a day leads with contributions. Records are kept in
// shared("kanso.shipped.bests"); setting one toasts once.
//
// One of the kanso-panel mod's panels: it exists only while shown.
import { div, svg } from "gpui-kit";
import { v_flex, h_flex, Button } from "gpui-base";
import { exec, theme, shared, setShared, notify } from "herdr";
import { Store } from "./shipped-store.js";

const ICON = "mods/kanso-chrome/icons/";
const G = { xs: 4, sm: 8, md: 12, lg: 16, xl: 24 };
const DAY = 86400000;
const RECORDS = "kanso.shipped.bests";
const REFRESH_MS = 5 * 60 * 1000;
const PARALLEL = 6;
const RETRIES = 6; // GitHub answers 202 while it computes a repository's statistics
const REPO_ROWS = 8;
const CELL_GAP = 3;
export const PERIODS = ["day", "week", "month", "year"];
const PERIOD_NAMES = { day: "Day", week: "Week", month: "Month", year: "Year" };
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const FULL_MONTHS = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];
const WEEKDAYS = ["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"];

function tokens(t) {
  return {
    canvas: t.canvas ?? t.background, text: t.foreground, muted: t.muted ?? t.dim, dim: t.dim,
    border: t.border, subtle: t.hover ?? t.raised, selected: t.selected ?? t.hover ?? t.raised,
    accent: t.accent ?? t.foreground, red: t.ansi1, green: t.ansi2,
  };
}

export const fmt = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
const dayName = (ms) => { const d = new Date(ms); return `${d.getDate()} ${MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const monthName = (ms) => { const d = new Date(ms); return `${FULL_MONTHS[d.getMonth()]} ${d.getFullYear()}`; };
const isoDay = (d) => `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
const fromIsoDay = (s) => { const [y, m, d] = s.split("-").map(Number); return new Date(y, m - 1, d).getTime(); };
const iso = (ms) => new Date(ms).toISOString().replace(/\.\d{3}Z$/, "Z");

// A period in local time: kind "day" | "week" (from Monday) | "month" | "year",
// offset 0 for the current one, -1 for the one before.
export function periodRange(kind, offset, now = Date.now()) {
  const t = new Date(now), y = t.getFullYear(), m = t.getMonth(), d = t.getDate();
  let start, end;
  if (kind === "day") { start = new Date(y, m, d + offset); end = new Date(y, m, d + offset + 1); }
  else if (kind === "week") { const monday = d - ((t.getDay() + 6) % 7) + 7 * offset; start = new Date(y, m, monday); end = new Date(y, m, monday + 7); }
  else if (kind === "month") { start = new Date(y, m + offset, 1); end = new Date(y, m + offset + 1, 1); }
  else { start = new Date(y + offset, 0, 1); end = new Date(y + offset + 1, 0, 1); }
  return { start: start.getTime(), end: end.getTime() };
}

// The span to compare with: the period before, cut at the same point when the
// current one is still running ("vs this point last month").
export function comparedRange(kind, offset, now = Date.now()) {
  const prev = periodRange(kind, offset - 1, now);
  if (offset !== 0) return prev;
  const { start } = periodRange(kind, 0, now);
  return { start: prev.start, end: Math.min(prev.end, prev.start + (now - start)) };
}

export function periodLabel(kind, offset, now = Date.now()) {
  const { start, end } = periodRange(kind, offset, now);
  const s = new Date(start), e = new Date(end - DAY);
  if (kind === "day") return offset === 0 ? "Today" : offset === -1 ? "Yesterday" : `${WEEKDAYS[s.getDay()]} ${s.getDate()} ${MONTHS[s.getMonth()]}`;
  if (kind === "week") return offset === 0 ? "This week" : offset === -1 ? "Last week" : `${s.getDate()} ${MONTHS[s.getMonth()]} – ${e.getDate()} ${MONTHS[e.getMonth()]}`;
  if (kind === "month") return offset === 0 ? "This month" : `${FULL_MONTHS[s.getMonth()]} ${s.getFullYear()}`;
  return offset === 0 ? "This year" : String(s.getFullYear());
}

// Weekly sums can't be cut inside a week, so a running week compares with the whole last one.
const comparedLabel = (kind, offset) => offset === 0
  ? { day: "vs this time yesterday", week: "vs last week", month: "vs this point last month", year: "vs this point last year" }[kind]
  : { day: "vs the day before", week: "vs the week before", month: "vs the month before", year: "vs the year before" }[kind];

// ---- GitHub's weekly sums ----
// A repository's entry: { fetched (ms), pushed (ISO), weeks: [[week start ms, additions, deletions, commits]] }.

// Your weeks from a stats/contributors answer (only weeks with something in
// them); null while GitHub is still computing (it answers {} then).
export function yourWeeks(body, login) {
  if (!Array.isArray(body)) return null;
  const me = body.find((e) => e?.author?.login?.toLowerCase() === String(login).toLowerCase());
  return (me?.weeks ?? []).filter((w) => w.a || w.d || w.c).map((w) => [w.w * 1000, w.a, w.d, w.c]);
}

// GitHub's weeks start on Sunday, UTC. Placed at Monday noon UTC, a week lands
// in the local Monday-to-Sunday week it mostly covers, whatever the time zone.
export const weekAt = (w) => w + 1.5 * DAY;

// Lines and commits of the weeks that land in [start, end), in total and per repository.
export function sumWeeks(stats, start, end) {
  const byRepo = [];
  let add = 0, del = 0, commits = 0;
  for (const [name, entry] of Object.entries(stats?.repos ?? {})) {
    let a = 0, d = 0, c = 0;
    for (const w of entry.weeks ?? []) {
      const at = weekAt(w[0]);
      if (at >= start && at < end) { a += w[1]; d += w[2]; c += w[3]; }
    }
    if (a || d || c) byRepo.push({ name, add: a, del: d, commits: c });
    add += a; del += d; commits += c;
  }
  byRepo.sort((x, y) => (y.add + y.del) - (x.add + x.del) || y.commits - x.commits);
  return { add, del, commits, byRepo };
}

// The current and longest run of days with at least one contribution. Today
// without one yet does not break the current run.
export function streaks(days, today) {
  let longest = { n: 0, end: null }, run = 0;
  for (const d of days ?? []) {
    if (d.contributionCount > 0) { run++; if (run > longest.n) longest = { n: run, end: d.date }; }
    else run = 0;
  }
  let current = 0, i = (days ?? []).length - 1;
  if (i >= 0 && days[i].date === today && days[i].contributionCount === 0) i--;
  for (; i >= 0 && days[i].contributionCount > 0; i--) current++;
  return { current, longest };
}

// The contributions of [start, end): the calendar's days (private ones
// included) when it reaches back that far, else the period's totals.
export function contributionsIn(days, start, end, totals) {
  if (days?.length && fromIsoDay(days[0].date) <= start) {
    let n = 0;
    for (const d of days) { const at = fromIsoDay(d.date); if (at >= start && at < end) n += d.contributionCount; }
    return n;
  }
  if (!totals) return null;
  return totals.totalCommitContributions + totals.totalPullRequestContributions + totals.totalPullRequestReviewContributions
    + totals.totalIssueContributions + totals.restrictedContributionsCount;
}

// Personal bests from the calendar and the weekly sums.
export function computeRecords({ days, stats }) {
  const r = {};
  for (const d of days ?? []) if (d.contributionCount > 0 && (!r.bestDay || d.contributionCount > r.bestDay.n)) r.bestDay = { n: d.contributionCount, date: d.date };
  const { longest } = streaks(days, null);
  if (longest.n) r.longestStreak = longest;
  const weeks = new Map(), months = new Map();
  for (const entry of Object.values(stats?.repos ?? {})) {
    for (const [w, a, , c] of entry.weeks ?? []) {
      const at = weekAt(w), week = periodRange("week", 0, at).start, month = periodRange("month", 0, at).start;
      const row = weeks.get(week) ?? { add: 0, commits: 0 };
      row.add += a; row.commits += c; weeks.set(week, row);
      months.set(month, (months.get(month) ?? 0) + a);
    }
  }
  for (const [start, w] of weeks) {
    if (w.add > 0 && (!r.bestWeek || w.add > r.bestWeek.add)) r.bestWeek = { add: w.add, start };
    if (w.commits > 0 && (!r.busiestWeek || w.commits > r.busiestWeek.n)) r.busiestWeek = { n: w.commits, start };
  }
  for (const [start, add] of months) if (add > 0 && (!r.bestMonth || add > r.bestMonth.add)) r.bestMonth = { add, start };
  return r;
}

const BETTER = {
  bestDay: (a, b) => a.n > b.n, bestWeek: (a, b) => a.add > b.add, bestMonth: (a, b) => a.add > b.add,
  longestStreak: (a, b) => a.n > b.n, busiestWeek: (a, b) => a.n > b.n,
};
export const RECORD_NAMES = { bestDay: "Best day", bestWeek: "Best week", bestMonth: "Best month", longestStreak: "Longest streak", busiestWeek: "Most commits in a week" };
const recordAt = (k, r) => k === "bestDay" ? fromIsoDay(r.date) : k === "longestStreak" ? (r.end ? fromIsoDay(r.end) : 0) : r.start;

// Keeps the best of what was stored and what was just read. `beaten`: the
// records you just set, improving on a stored one within the last week (a
// month for the best month). A first reading beats nothing, and an older best
// found later (a repository read for the first time) updates it quietly.
export function mergeRecords(stored, found, now = Date.now()) {
  const kept = { ...(stored ?? {}) }, beaten = [];
  for (const [k, better] of Object.entries(BETTER)) {
    const r = found[k];
    if (!r) continue;
    if (!kept[k]) kept[k] = r;
    else if (better(r, kept[k])) {
      kept[k] = r;
      if (stored?.[k] && now - recordAt(k, r) <= (k === "bestMonth" ? 31 : 7) * DAY) beaten.push(k);
    }
  }
  return { kept, beaten };
}

export function recordText(k, r) {
  if (k === "bestDay") return { value: fmt(r.n), unit: r.n === 1 ? "contribution" : "contributions", detail: dayName(fromIsoDay(r.date)) };
  if (k === "longestStreak") return { value: fmt(r.n), unit: r.n === 1 ? "day" : "days", detail: r.end ? `to ${dayName(fromIsoDay(r.end))}` : "" };
  if (k === "bestWeek") return { value: `+${fmt(r.add)}`, unit: "lines", detail: `week of ${dayName(r.start)}` };
  if (k === "bestMonth") return { value: `+${fmt(r.add)}`, unit: "lines", detail: monthName(r.start) };
  return { value: fmt(r.n), unit: "commits", detail: `week of ${dayName(r.start)}` };
}

// How many weeks of the calendar fit `width`, and how big each square is:
// as many whole weeks as fit, up to a year, with squares of 9 to 16 that
// fill the width.
export function heatLayout(width) {
  const w = Math.max(120, Math.floor(width));
  const weeks = Math.max(4, Math.min(53, Math.floor((w + CELL_GAP) / (9 + CELL_GAP))));
  const cell = Math.max(9, Math.min(16, Math.floor((w - (weeks - 1) * CELL_GAP) / weeks)));
  return { weeks, cell };
}

// The per-period query: contributions now and before, merged counts, the
// year's calendar and every merged pull request you ever had, counted.
export function periodQuery(cur, prev, now) {
  const end = (r) => Math.max(r.start, Math.min(r.end, now) - 1000);
  const span = (r) => `from:"${iso(r.start)}",to:"${iso(end(r))}"`;
  const merged = (r) => `is:pr author:@me is:merged merged:${iso(r.start)}..${iso(end(r))}`;
  const totals = "totalCommitContributions totalPullRequestContributions totalPullRequestReviewContributions totalIssueContributions restrictedContributionsCount";
  return `query{viewer{login name createdAt
cal:contributionsCollection(from:"${iso(now - 364 * DAY)}",to:"${iso(now)}"){contributionCalendar{weeks{contributionDays{date contributionCount contributionLevel weekday}}}}
cur:contributionsCollection(${span(cur)}){${totals}}
prev:contributionsCollection(${span(prev)}){${totals}}}
curMerged:search(query:"${merged(cur)}",type:ISSUE,first:0){issueCount}
prevMerged:search(query:"${merged(prev)}",type:ISSUE,first:0){issueCount}
ever:search(query:"is:pr author:@me is:merged",type:ISSUE,first:0){issueCount}}`;
}

// Every repository you contributed to or can reach (yours, as a collaborator,
// in your organizations), with when it was last pushed.
export const REPOS = `query($after:String,$own:String){viewer{databaseId
contributed:repositoriesContributedTo(first:100,after:$after,includeUserRepositories:true,contributionTypes:[COMMIT,PULL_REQUEST,PULL_REQUEST_REVIEW,REPOSITORY]){pageInfo{hasNextPage endCursor} nodes{nameWithOwner pushedAt}}
access:repositories(first:100,after:$own,affiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],ownerAffiliations:[OWNER,COLLABORATOR,ORGANIZATION_MEMBER],orderBy:{field:PUSHED_AT,direction:DESC}){pageInfo{hasNextPage endCursor} nodes{nameWithOwner pushedAt}}}}`;

async function gh(args) {
  const r = await exec("gh", args);
  if (r.code !== 0) throw new Error((r.stderr || r.stdout).trim().split("\n")[0] || "GitHub could not be read.");
  return r.stdout;
}

async function gql(query, vars = {}) {
  const args = ["api", "graphql", "-f", `query=${query}`];
  for (const [k, v] of Object.entries(vars)) if (v !== null && v !== undefined) args.push("-f", `${k}=${v}`);
  const out = JSON.parse(await gh(args));
  if (!out.data) throw new Error(out.errors?.[0]?.message ?? "GitHub could not be read.");
  return out.data;
}

export class Shipped {
  init(cx) {
    this.kind = "week"; this.offset = 0;
    this.github = {}; // by period key: the period query's data, or { error }
    this.stats = null; this.syncing = false; this.syncError = null; this.phase = null; this.rhythm = {};
    this.store = new Store();
    this.records = shared(RECORDS) ?? {}; this.fresh = new Set();
    this.loading = false; this.pending = false; this.reposOpen = false; this.width = 368;
    this.refresh(cx);
    cx.timer.every(REFRESH_MS, (cx) => this.refresh(cx, true));
  }

  key() { return `${this.kind}:${this.offset}`; }

  pick(kind, offset, cx) {
    this.kind = kind; this.offset = Math.min(0, offset);
    this.refresh(cx);
    cx.spawn(async (cx) => { await this.readRhythm(); cx.notify(); });
    cx.notify();
  }

  // The period's query; the repositories' sums are read alongside, on their own.
  refresh(cx, again = false) {
    if (this.loading) { this.pending = this.pending || again || "missing"; return; }
    this.loading = true;
    cx.spawn(async (cx) => {
      try {
        const key = this.key(), now = Date.now();
        const cur = periodRange(this.kind, this.offset, now), prev = comparedRange(this.kind, this.offset, now);
        if (again || !this.github[key]) {
          try {
            const data = await gql(periodQuery(cur, prev, now));
            this.github[key] = data;
            this.login = data.viewer.login; this.name = data.viewer.name;
            this.weeks = data.viewer.cal.contributionCalendar.weeks;
            this.days = this.weeks.flatMap((w) => w.contributionDays);
          } catch (e) {
            const why = String(e?.message ?? e);
            this.github[key] = { error: why.includes("ENOENT") ? "Install the GitHub CLI (gh) and run `gh auth login`." : why };
          }
        }
        this.checkRecords();
      } catch {}
      finally {
        this.loading = false;
        cx.notify();
        if (again || !this.stats) this.startSync(cx);
        const next = this.pending; this.pending = false;
        if (next) this.refresh(cx, next === true);
      }
    });
  }

  startSync(cx) {
    if (this.syncing || !this.login) return;
    this.syncing = true; this.syncError = null;
    cx.spawn(async (cx) => {
      try { await this.sync(cx); }
      catch (e) { this.syncError = String(e?.message ?? e); }
      finally {
        this.syncing = false; this.phase = null; this.firstRead = false;
        try { this.stats = await this.store.weekly(); } catch {}
        this.rhythm = {}; await this.readRhythm();
        this.checkRecords(); cx.notify();
      }
    });
    cx.notify();
  }

  // When and where you ship in the shown period (read from the store, once per period).
  async readRhythm() {
    const key = this.key();
    if (this.rhythm[key] || !this.stats) return;
    const r = periodRange(this.kind, this.offset);
    try { this.rhythm[key] = await this.store.rhythm(r.start / 1000, r.end / 1000); } catch {}
  }

  // Everything you sign commits with: GitHub's names for you, this machine's
  // git identity and the ones your other machines published.
  async identities(databaseId) {
    const conf = await Promise.all(["user.email", "user.name"].map((k) => exec("git", ["config", "--global", k]).catch(() => null)));
    const synced = JSON.parse((await this.store.meta("identities")) ?? "[]");
    const mine = [this.login, this.name, `${this.login}@users.noreply.github.com`, databaseId ? `${databaseId}+${this.login}@users.noreply.github.com` : null,
      ...conf.map((r) => (r?.code === 0 ? r.stdout.trim() : null))];
    return { mine: [...new Set(mine.filter(Boolean))], all: [...new Set([...mine, ...synced].filter(Boolean))] };
  }

  // GitHub's sums for the repositories pushed since they were read, this
  // machine's git for the repositories whose branches moved, then your other
  // machines through the gist. Each step keeps what it read in the store.
  async sync(cx) {
    await this.store.open();
    this.stats = await this.store.weekly();
    this.firstRead = !Object.keys(this.stats.repos).length;
    cx.notify();

    this.phase = "your repositories on GitHub"; cx.notify();
    const repos = new Map();
    let databaseId = null;
    for (const field of ["contributed", "access"]) {
      let after = null;
      for (;;) {
        const v = (await gql(REPOS, field === "contributed" ? { after } : { own: after })).viewer;
        databaseId = v.databaseId; const page = v[field];
        for (const n of page.nodes ?? []) if (n?.nameWithOwner) repos.set(n.nameWithOwner, n.pushedAt);
        if (!page.pageInfo.hasNextPage) break;
        after = page.pageInfo.endCursor;
      }
    }
    const known = new Map((await this.store.ghRepos()).map((r) => [r.repo, r]));
    for (const [name, r] of known) if (!repos.has(name)) repos.set(name, r.pushed);
    let due = [...repos].filter(([name, pushed]) => { const had = known.get(name); return !had || had.pending || (pushed && Date.parse(pushed) > had.fetched); });
    for (let round = 0; due.length && round < RETRIES; round++) {
      if (round) await exec("sleep", ["5"]);
      const later = [], read = [];
      for (let i = 0; i < due.length; i += PARALLEL) {
        this.phase = `GitHub's sums, ${fmt(Math.max(0, due.length - i))} repositories to go`; cx.notify();
        await Promise.all(due.slice(i, i + PARALLEL).map(async ([repo, pushed]) => {
          let weeks;
          try { weeks = yourWeeks(JSON.parse(await gh(["api", `repos/${repo}/stats/contributors`]) || "{}"), this.login); }
          catch { weeks = []; } // gone, or not yours to read: nothing to add
          if (weeks === null) { later.push([repo, pushed]); read.push({ repo, pushed, fetched: known.get(repo)?.fetched ?? 0, pending: true }); }
          else read.push({ repo, pushed, fetched: Date.now(), weeks });
        }));
      }
      await this.store.saveGithub(read); // GitHub still computing after a while: asked again next time
      due = later;
    }

    const ids = await this.identities(databaseId);
    const idKey = JSON.stringify([...ids.all].sort());
    if ((await this.store.meta("scanned-identities")) !== idKey) { await this.store.sql("DELETE FROM scans;"); await this.store.setMeta("scanned-identities", idKey); }
    this.phase = "this machine's repositories"; cx.notify();
    await this.store.scanLocal(ids.all, (done, total) => { this.phase = `this machine's repositories, ${fmt(total - done)} to go`; cx.notify(); });

    this.phase = "your other machines"; cx.notify();
    try {
      const synced = await this.store.syncMachines(ids.mine);
      const before = JSON.parse((await this.store.meta("identities")) ?? "[]");
      const learned = [...new Set([...before, ...synced.identities])];
      if (learned.length !== before.length) await this.store.setMeta("identities", JSON.stringify(learned)); // read with them on the next refresh
      this.machines = synced.machines;
    } catch (e) { this.machineError = String(e?.message ?? e); }
  }

  // Keeps the bests, and toasts the ones just set. The sums' records wait
  // until every repository is in, so a half-read one is never a "new record".
  checkRecords() {
    if (!this.days) return;
    const whole = this.stats && !this.syncing ? this.stats : null;
    const { kept, beaten } = mergeRecords(shared(RECORDS), computeRecords({ days: this.days, stats: whole }));
    this.records = kept;
    setShared(RECORDS, kept);
    for (const k of beaten) {
      this.fresh.add(k);
      const t = recordText(k, kept[k]);
      notify({ title: `New record: ${RECORD_NAMES[k].toLowerCase()}`, body: `${t.value} ${t.unit} · ${t.detail}`, level: "success" });
    }
  }

  // ---- drawing, as Spend draws ----

  iconButton(id, icon, tip, onClick, c, options = {}) {
    const glyph = svg(`${ICON}${icon}.svg`).size(15).text_color(options.disabled ? c.border : c.muted);
    return Button.new(id).size(26).flex_none().items_center().justify_center().rounded(6)
      .when(!options.disabled, (el) => el.cursor_pointer().hover((s) => s.bg(c.subtle)).on_click((_e, cx) => onClick(cx)))
      .accessibility_label(tip).tooltip(tip)
      .child(options.spin ? glyph.spin(900) : glyph);
  }

  section(c, title, note) {
    return h_flex().w_full().items_end().justify_between().gap(G.md).pb(G.sm)
      .child(div().flex_none().text_size(15).text_color(c.text).child(title))
      .child(div().min_w(0).truncate().text_size(12).text_color(c.dim).child(note ?? ""));
  }

  periods(c) {
    const tab = (kind) => {
      const on = this.kind === kind;
      return Button.new(`shipped-${kind}`).h(26).px(10).flex_none().items_center().rounded(6).cursor_pointer()
        .selected(on).when(on, (el) => el.bg(c.selected)).when(!on, (el) => el.hover((s) => s.bg(c.subtle)))
        .accessibility_label(PERIOD_NAMES[kind])
        .on_click((_e, cx) => this.pick(kind, 0, cx))
        .child(div().text_size(12).text_color(on ? c.text : c.muted).child(PERIOD_NAMES[kind]));
    };
    return h_flex().w_full().flex_wrap().gap(G.sm).items_center().justify_between()
      .child(h_flex().gap(G.xs).items_center().children(PERIODS.map(tab)))
      .child(h_flex().gap(G.xs).items_center()
        .child(this.iconButton("shipped-prev", "chevron-left", "Previous period", (cx) => this.pick(this.kind, this.offset - 1, cx), c))
        .child(div().min_w(96).text_center().text_size(12).text_color(c.text).child(periodLabel(this.kind, this.offset)))
        .child(this.iconButton("shipped-next", "chevron-right", "Next period", (cx) => this.pick(this.kind, this.offset + 1, cx), c, { disabled: this.offset >= 0 })));
  }

  hero(c, narrow) {
    const now = Date.now();
    const cur = periodRange(this.kind, this.offset, now), prev = comparedRange(this.kind, this.offset, now);
    // A running week compares with the whole last one: its sum can't be cut.
    const before = this.kind === "week" && this.offset === 0 ? periodRange("week", -1, now) : prev;
    const gh = this.github[this.key()], v = gh?.viewer;
    const contributions = v ? contributionsIn(this.days, cur.start, cur.end, v.cur) : null;
    const contributionsBefore = v ? contributionsIn(this.days, prev.start, prev.end, v.prev) : null;
    const sums = this.stats ? sumWeeks(this.stats, cur.start, cur.end) : null;
    const sumsBefore = this.stats ? sumWeeks(this.stats, before.start, before.end) : null;
    const byDay = this.kind === "day"; // GitHub's sums are weekly: a day leads with contributions
    const value = byDay ? contributions : sums?.add, was = byDay ? contributionsBefore : sumsBefore?.add;
    const settled = byDay || !(this.syncing && this.firstRead);
    const delta = settled && value !== null && value !== undefined && was > 0 ? Math.round(((value - was) / was) * 100) : null;
    // Past double, a multiple reads better than a four-digit percentage.
    const deltaText = delta === null ? "" : delta >= 200 ? `${fmt(value / was)}x` : `${delta >= 0 ? "+" : ""}${delta}%`;
    const when = periodLabel(this.kind, this.offset).toLowerCase();
    const stats = [
      byDay ? null : { value: contributions === null ? "—" : fmt(contributions), unit: "contributions" },
      { value: gh?.curMerged ? fmt(gh.curMerged.issueCount) : "—", unit: "pull requests merged" },
      { value: sums && !byDay ? fmt(Math.max(sums.commits, v?.cur.totalCommitContributions ?? 0)) : v ? fmt(v.cur.totalCommitContributions) : "—", unit: "commits" },
      { value: v ? fmt(v.cur.totalPullRequestReviewContributions) : "—", unit: "reviews" },
      byDay ? null : { value: sums ? fmt(sums.byRepo.length) : "—", unit: sums?.byRepo.length === 1 ? "repository" : "repositories" },
    ].filter(Boolean);
    const ever = this.stats ? sumWeeks(this.stats, 0, Infinity) : null;
    return v_flex().w_full().gap(G.lg)
      .child(v_flex().w_full().gap(G.xs)
        .child(h_flex().w_full().flex_wrap().items_end().gap_x(G.md).gap_y(G.xs)
          .child(div().text_size(narrow ? 40 : 56).line_height(1).font_light().text_color(c.text)
            .child(value === null || value === undefined ? "…" : byDay ? fmt(value) : `+${fmt(value)}`))
          .when(!byDay && Boolean(sums), (el) => el.child(div().pb(6).text_size(narrow ? 18 : 22).line_height(1).font_light().text_color(c.muted).child(`−${fmt(sums.del)}`))))
        .child(h_flex().w_full().flex_wrap().gap_x(G.sm).gap_y(2).items_center()
          .child(div().text_size(13).text_color(c.muted).child(byDay ? `contributions, ${when}` : `lines shipped, ${when}${settled ? "" : ", still adding up"}`))
          .when(delta !== null, (el) => el.child(h_flex().gap(6).items_center()
            .child(div().size(6).rounded_full().bg(delta >= 0 ? c.green : c.red))
            .child(div().text_size(13).text_color(delta >= 0 ? c.green : c.red).child(`${deltaText} ${comparedLabel(this.kind, this.offset)}`))))))
      .child(h_flex().w_full().flex_wrap().gap_x(narrow ? G.lg : 32).gap_y(G.lg)
        .children(stats.map((s) => v_flex().gap(4).min_w(64)
          .child(div().text_size(narrow ? 22 : 28).line_height(1).font_light().text_color(c.text).child(s.value))
          .child(div().text_size(11).text_color(c.dim).child(s.unit)))))
      .when(Boolean(gh?.ever), (el) => el.child(div().text_size(12).text_color(c.muted)
        .child([
          `${fmt(gh.ever.issueCount)} pull requests merged`,
          ever?.add ? `+${fmt(ever.add)} lines and ${fmt(ever.commits)} commits in ${fmt(ever.byRepo.length)} repositories` : "",
        ].filter(Boolean).join(", ") + `${v?.createdAt ? ` since you joined GitHub in ${new Date(v.createdAt).getFullYear()}` : ""}.`)))
      .when(Boolean(gh?.error), (el) => el.child(div().text_size(12).text_color(c.red).child(gh.error)));
  }

  // The current streak, then as many weeks of the calendar as fit, its
  // squares sized to fill the width, in the accent.
  streak(c, width) {
    const { current, longest } = streaks(this.days, isoDay(new Date()));
    const level = { NONE: null, FIRST_QUARTILE: "40", SECOND_QUARTILE: "70", THIRD_QUARTILE: "b0", FOURTH_QUARTILE: "ff" };
    const { weeks: n, cell } = heatLayout(width);
    const weeks = (this.weeks ?? []).slice(-n);
    const radius = Math.max(2, Math.round(cell / 5));
    const square = (d, key) => {
      if (!d) return div().id(key).size(cell).flex_none(); // before the calendar, or still to come
      const a = level[d.contributionLevel];
      return div().id(key).size(cell).flex_none().rounded(radius).bg(a ? c.accent + a : c.subtle)
        .tooltip(`${fmt(d.contributionCount)} ${d.contributionCount === 1 ? "contribution" : "contributions"} on ${dayName(fromIsoDay(d.date))}`);
    };
    return v_flex().w_full().gap(G.md)
      .child(this.section(c, "Streak", `longest ${fmt(longest.n)} ${longest.n === 1 ? "day" : "days"}`))
      .child(h_flex().items_end().gap(G.sm)
        .child(div().text_size(40).line_height(1).font_light().text_color(c.text).child(fmt(current)))
        .child(div().pb(4).text_size(12).text_color(c.dim).child(current === 1 ? "day in a row" : "days in a row")))
      .child(h_flex().w_full().gap(CELL_GAP).children(weeks.map((w, wi) => {
        const byDay = new Map(w.contributionDays.map((d) => [d.weekday, d]));
        return v_flex().flex_none().gap(CELL_GAP).children([0, 1, 2, 3, 4, 5, 6].map((i) => square(byDay.get(i), `heat-${wi}-${i}`)));
      })));
  }

  recordsList(c) {
    const keys = Object.keys(RECORD_NAMES).filter((k) => this.records[k]);
    if (!keys.length) return null;
    return v_flex().w_full()
      .child(this.section(c, "Records", this.fresh.size ? `${this.fresh.size} new` : "your bests"))
      .children(keys.map((k, i) => {
        const r = this.records[k], t = recordText(k, r), fresh = this.fresh.has(k);
        return h_flex().id(`record-${k}`).w_full().py(10).gap(G.md).items_center()
          .when(i > 0, (el) => el.border_t_1().border_color(c.border))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(h_flex().gap(G.sm).items_center()
              .child(div().truncate().text_size(13).text_color(c.text).child(RECORD_NAMES[k]))
              .when(fresh, (el) => el.child(div().flex_none().px(6).py(1).rounded(6).bg(c.accent + "26").text_size(11).text_color(c.accent).child("New record"))))
            .child(div().truncate().text_size(11.5).text_color(c.dim).child(t.detail)))
          .child(h_flex().flex_none().items_end().gap(6)
            .child(div().text_size(20).line_height(1).font_light().text_color(fresh ? c.accent : c.text).child(t.value))
            .child(div().text_size(11).text_color(c.dim).child(t.unit)));
      }));
  }

  byRepo(c) {
    const now = Date.now(), cur = periodRange(this.kind, this.kind === "day" ? 0 : this.offset, now);
    // A day's lines live in its week: the breakdown shows that week.
    const span = this.kind === "day" ? periodRange("week", 0, cur.start) : cur;
    const { byRepo } = sumWeeks(this.stats, span.start, span.end);
    const note = this.kind === "day" ? `this week · ${fmt(byRepo.length)}` : fmt(byRepo.length);
    if (!byRepo.length) return v_flex().w_full().child(this.section(c, "By repository", "")).child(div().text_size(12).text_color(c.dim).child(this.syncing ? "Adding up…" : "Nothing in this period yet."));
    const top = Math.max(1, ...byRepo.map((r) => r.add + r.del)), rows = this.reposOpen ? byRepo : byRepo.slice(0, REPO_ROWS);
    return v_flex().w_full()
      .child(this.section(c, "By repository", note))
      .children(rows.map((r, i) => v_flex().w_full().py(G.sm).gap(6)
        .when(i > 0, (el) => el.border_t_1().border_color(c.border))
        .child(h_flex().w_full().flex_wrap().gap_x(G.md).gap_y(2).items_center()
          .child(div().flex_1().min_w(120).truncate().text_size(13).text_color(c.text).child(r.name))
          .child(div().flex_none().text_size(12).text_color(c.dim).child(`${fmt(r.commits)} commits · +${fmt(r.add)} −${fmt(r.del)}`)))
        .child(h_flex().w_full().h(4).rounded(2).bg(c.subtle)
          .child(div().h_full().rounded(2).bg(c.accent).w(`${(Math.max(0.02, (r.add + r.del) / top) * 100).toFixed(1)}%`)))))
      .when(byRepo.length > REPO_ROWS, (el) => el.child(h_flex().pt(G.sm).child(Button.new("shipped-repos-more").cursor_pointer()
        .on_click((_e, cx) => { this.reposOpen = !this.reposOpen; cx.notify(); })
        .child(div().text_size(12).text_color(c.muted).child(this.reposOpen ? "Show fewer" : `Show ${byRepo.length - REPO_ROWS} more`)))));
  }

  status(c) {
    if (this.syncError) return div().text_size(12).text_color(c.red).child(`Adding up stopped: ${this.syncError}`);
    if (!this.syncing || !this.phase) return null;
    return div().text_size(12).text_color(this.firstRead ? c.muted : c.dim)
      .child(`${this.firstRead ? "Adding up" : "Updating"}: ${this.phase}.${this.firstRead ? " The first time takes a few minutes; after that only what changed is read." : ""}`);
  }

  // When you ship (commits by hour, local time) and from which machines, in
  // the shown period: from the commits the machines read, not GitHub's sums.
  rhythmView(c) {
    const r = this.rhythm[this.key()];
    const total = r ? r.hours.reduce((a, b) => a + b, 0) : 0;
    if (!total) return null;
    const top = Math.max(...r.hours), peak = r.hours.indexOf(top);
    const late = r.hours.slice(21).reduce((a, b) => a + b, 0) + r.hours.slice(0, 5).reduce((a, b) => a + b, 0);
    const hour = (h) => `${String(h).padStart(2, "0")}:00`;
    const note = [`most at ${hour(peak)}`, late ? `${Math.round((late / total) * 100)}% after 9 pm` : ""].filter(Boolean).join(" · ");
    return v_flex().w_full().gap(G.md)
      .child(this.section(c, "When you ship", note))
      .child(h_flex().w_full().h(56).items_end().gap(2).children(r.hours.map((n, h) => div().id(`hour-${h}`).flex_1().min_w(2)
        .h(Math.max(2, Math.round((n / top) * 56))).rounded(2).bg(n ? c.accent + (h === peak ? "ff" : "90") : c.subtle)
        .tooltip(`${fmt(n)} ${n === 1 ? "commit" : "commits"} at ${hour(h)}`))))
      .child(h_flex().w_full().justify_between().text_size(10.5).text_color(c.dim)
        .children(["00", "06", "12", "18", "23"].map((t) => div().child(t))))
      .when(r.machines.length > 0, (el) => el.child(v_flex().w_full().pt(G.sm)
        .children(r.machines.map((m, i) => h_flex().w_full().py(6).gap(G.md).items_center()
          .when(i > 0, (e) => e.border_t_1().border_color(c.border))
          .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(c.text).child(m.machine))
          .child(div().flex_none().text_size(12).text_color(c.dim).child(`${fmt(m.n)} commits · +${fmt(m.a)} −${fmt(m.d)}`))))));
  }

  render(cx) {
    const c = tokens(theme());
    const width = this.width || 368, narrow = width < 560;
    const pad = narrow ? G.lg : 32;
    const inner = Math.min(1080, width - 2 * pad);
    const gh = this.github[this.key()], status = this.status(c);
    const body = !gh && !this.stats
      ? v_flex().w_full().gap(G.sm).child(div().text_size(15).text_color(c.muted).child("Adding up what you shipped")).child(div().text_size(12).text_color(c.dim).child("This takes a second."))
      : v_flex().w_full().gap(narrow ? 36 : 48)
        .child(this.hero(c, narrow))
        .when(Boolean(status), (el) => el.child(status))
        .when(Boolean(this.days), (el) => el.child(this.streak(c, inner)))
        .when(Object.keys(this.records).length > 0, (el) => el.child(this.recordsList(c)))
        .when(Boolean(this.rhythmView(c)), (el) => el.child(this.rhythmView(c)))
        .child(this.byRepo(c))
        .child(div().text_size(10.5).text_color(c.dim).child("Statistics only, kept in data/kanso-panel/shipped.db: your commits as every machine of yours read them (repository, hash, time, lines; no messages or code), shared between machines through a private gist, and GitHub's weekly sums for the rest. A repository's week counts the larger of the two. Contributions count the way your profile does, private ones included."));
    return v_flex().id("kanso-shipped").size_full().min_h(0).bg(c.canvas).text_color(c.text).overflow_y_scrollbar()
      .on_size_change((size, sizeCx) => { if (Math.abs((this.width || 0) - size.width) >= 1) { this.width = size.width; sizeCx.notify(); } })
      .child(h_flex().w_full().justify_center().px(pad).py(narrow ? G.lg : 28)
        .child(v_flex().w_full().max_w(1080).gap(narrow ? 32 : 44)
          .child(h_flex().w_full().items_center().justify_between().gap(G.md)
            .child(div().truncate().text_size(narrow ? 17 : 20).text_color(c.text).child("Shipped"))
            .child(this.iconButton("shipped-refresh", "refresh", "Refresh", (cx) => this.refresh(cx, true), c, { spin: this.loading || this.syncing })))
          .child(this.periods(c))
          .child(body)));
  }
}
