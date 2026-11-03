// Kanso's own updates, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// Not Herdr's: the app updates itself and shows its dot on Settings. This
// updates only Kanso's files. A release is a vX.Y.Z tag whose
// mods/kanso-chrome/version.json says X.Y.Z. When Herdr starts and every 5
// minutes after (and on kanso-chrome.check) the footer asks
// GitHub for the tags (`git ls-remote`, no API quota); a newer one shows an
// "Update Kanso" row and one toast per version. Updating downloads that tag,
// checks each mod loads (`herdr-app check`), then swaps each mod folder whole
// (the old one keeps running until its new folder is in place), copies the
// themes and the preview, and touches the layout and your keys only where the
// release changed them: a key you changed yourself is never replaced, and the
// layout you had is kept as layouts/kanso.json.old-<time>.
import { exec, readTextFile, writeTextFile, appHome, shared, setShared, notify, layout, run } from "herdr";

export const SOURCE = {
  remote: "https://github.com/jlopezlira/herdr-kanso.git",
  tarball: (v) => `https://github.com/jlopezlira/herdr-kanso/archive/refs/tags/v${v}.tar.gz`,
  file: (v, path) => `https://raw.githubusercontent.com/jlopezlira/herdr-kanso/v${v}/${path}`,
};

const STATE = "kanso.update"; // { latest, checked, notified, done: { version, notes } }
// `git ls-remote` is one small request with no API quota, so a new release
// shows within 5 minutes. EVERY keeps copies and reloads from asking twice.
const TICK = 5 * 60 * 1000;
const EVERY = 4 * 60 * 1000;
// The footer block is sized for Settings, Add machine and the account chip;
// while a release waits it grows by one row (34 + its gap) to hold it.
const FOOTER = "sidebar-footer";
const FOOTER_PX = 156, FOOTER_UPDATE_PX = 192;

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

export const parseVersion = (v) => {
  const m = /^v?(\d+)\.(\d+)\.(\d+)$/.exec(String(v ?? "").trim());
  return m ? m.slice(1).map(Number) : null;
};

export function compareVersions(a, b) {
  const x = parseVersion(a), y = parseVersion(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The newest vX.Y.Z in `git ls-remote --tags --refs` output, without the v.
export function newestTag(stdout) {
  let best = null;
  for (const line of String(stdout).split("\n")) {
    const tag = line.split("refs/tags/")[1]?.trim();
    if (parseVersion(tag) && (!best || compareVersions(tag, best) > 0)) best = tag;
  }
  return best && best.replace(/^v/, "");
}

// Three-way merge of Kanso's keys.json sections into yours. `before` and
// `after` are what the installed and the new release ship. A key you never
// had is added only when the release adds it (one you removed stays removed);
// one you left as shipped follows the release, also when it drops it; one you
// changed stays yours and is reported in `kept`.
export function mergeKeys(user, before, after) {
  const keys = JSON.parse(JSON.stringify(user));
  const kept = [];
  let changed = false;
  const sections = new Set([...Object.keys(before), ...Object.keys(after)]);
  for (const section of sections) {
    const was = before[section] ?? {}, now = after[section] ?? {};
    const mine = keys[section] ?? {};
    for (const key of new Set([...Object.keys(was), ...Object.keys(now)])) {
      if (was[key] === now[key]) continue;
      if (!(key in mine)) {
        if (!(key in was) && key in now) { mine[key] = now[key]; changed = true; }
      } else if (mine[key] === now[key]) {
        continue;
      } else if (mine[key] === was[key]) {
        if (key in now) mine[key] = now[key]; else delete mine[key];
        changed = true;
      } else {
        kept.push(key);
      }
    }
    if (Object.keys(mine).length || section in keys) keys[section] = mine;
  }
  return { keys, changed, kept };
}

const sameJson = (a, b) => {
  try { return JSON.stringify(JSON.parse(a)) === JSON.stringify(JSON.parse(b)); } catch { return a === b; }
};

// Downloads the release into <stage>/src and checks it is the one asked for.
// $1 tarball URL, $2 stage folder, $3 version.
export const STAGE_SCRIPT = `set -eu
rm -rf "$2"; mkdir -p "$2/src"
curl -fsSL --max-time 25 -o "$2/release.tar.gz" "$1"
tar -xzf "$2/release.tar.gz" -C "$2/src" --strip-components=1
rm -f "$2/release.tar.gz"
got=$(sed -n 's/.*"version"[^"]*"\\([^"]*\\)".*/\\1/p' "$2/src/kanso/mods/kanso-chrome/version.json" 2>/dev/null || true)
[ "$got" = "$3" ] || { echo "the v$3 release says it is \${got:-no version}" >&2; exit 3; }
for dir in "$2/src/kanso/mods"/*/; do basename "$dir"; done
`;

// Puts the staged release in place: keys and layout first (only when staged),
// then themes and the preview, then each mod folder, swapped whole.
// $1 stage folder, $2 Herdr's home, $3 a time for the old layout's name.
export const SWAP_SCRIPT = `set -eu
src="$1/src/kanso"
mkdir -p "$1/old" "$2/mods" "$2/themes" "$2/layouts"
if [ -f "$1/keys.json" ]; then mv "$1/keys.json" "$2/keys.json"; fi
if [ -f "$1/kanso.json" ]; then
  if [ -f "$2/layouts/kanso.json" ]; then cp "$2/layouts/kanso.json" "$2/layouts/kanso.json.old-$3"; fi
  mv "$1/kanso.json" "$2/layouts/kanso.json"
fi
cp "$src"/themes/*.json "$2/themes/"
cp "$src/layouts/kanso.png" "$2/layouts/kanso.png"
for dir in "$src/mods"/*/; do
  name=$(basename "$dir")
  if [ -e "$2/mods/$name" ]; then rm -rf "$1/old/$name"; mv "$2/mods/$name" "$1/old/$name"; fi
  if ! mv "$src/mods/$name" "$2/mods/$name"; then
    if [ -e "$1/old/$name" ]; then mv "$1/old/$name" "$2/mods/$name"; fi
    echo "could not put $name in place" >&2; exit 1
  fi
done
rm -rf "$1"
`;

const lastLine = (r, fallback) => (r?.stderr || r?.stdout || "").trim().split("\n").pop() || fallback;
const stamp = () => new Date().toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 13);

export class Updater {
  constructor(source = SOURCE) {
    this.source = source;
    this.installed = null;
    this.busy = false;
    this.error = null;
  }

  state() { return shared(STATE) ?? {}; }
  setState(patch) { setShared(STATE, { ...this.state(), ...patch }); }

  // The newer release, or null.
  available() {
    const { latest } = this.state();
    if (!parseVersion(latest) || !parseVersion(this.installed)) return null;
    return compareVersions(latest, this.installed) > 0 ? latest : null;
  }

  start(cx) {
    cx.spawn(async (cx) => {
      try { this.installed = JSON.parse(await readTextFile(`${appHome()}/mods/kanso-chrome/version.json`) ?? "{}").version ?? null; } catch {}
      this.finished();
      await this.check(cx, true); // on every start, whenever the last look was
      this.fit();
      cx.notify();
    });
    cx.timer.every(TICK, (cx) => cx.spawn(async (cx) => { await this.check(cx); this.fit(); cx.notify(); }));
  }

  // Grows the footer while the row is shown and gives the room back after.
  // A footer you sized yourself is left alone.
  fit() {
    let size;
    try { size = findNode(layout()?.root ?? layout(), FOOTER)?.size?.px; } catch { return; }
    const want = this.available() ? FOOTER_UPDATE_PX : FOOTER_PX;
    if (size !== want && (size === FOOTER_PX || size === FOOTER_UPDATE_PX)) run("layout.resize", { id: FOOTER, px: want });
  }

  // A finished update reports itself once, from whichever copy sees it first:
  // the one that ran it, or the fresh copy its new files started.
  finished() {
    const { done } = this.state();
    if (!done) return;
    this.setState({ done: null });
    if (done.version !== this.installed) return;
    notify({ title: `Kanso updated to ${done.version}`, body: done.notes || undefined, level: "success" });
  }

  // `report`: say so when there is nothing new or GitHub can't be reached
  // (kanso-chrome.check); the timer stays quiet.
  async check(cx, force = false, report = false) {
    const { checked } = this.state();
    if (this.busy || (!force && checked && Date.now() - checked < EVERY)) return;
    let r = null;
    try { r = await exec("git", ["ls-remote", "--tags", "--refs", this.source.remote]); } catch {}
    if (r?.code !== 0) { // offline: the next tick tries again
      if (report) notify({ title: "Kanso could not check for updates", body: "GitHub could not be reached.", level: "warning" });
      return;
    }
    this.setState({ latest: newestTag(r.stdout), checked: Date.now() });
    const v = this.available();
    if (report && !v) notify({ title: "Kanso is up to date", body: `You have ${this.installed}, the newest release.`, level: "success" });
    if (report && v && this.state().notified === v) this.setState({ notified: null }); // asked: say it again
    if (v && this.state().notified !== v) {
      this.setState({ notified: v });
      notify({
        title: `Kanso ${v} is available`,
        body: `You have ${this.installed}. Update it from the sidebar; Herdr's own updates stay under Settings.`,
        action: { name: "kanso-chrome.update" },
      });
    }
  }

  async install(cx) {
    const v = this.available();
    if (!v || this.busy) return;
    this.busy = true;
    this.error = null;
    cx.notify();
    const home = appHome(), stage = `${home}/.kanso-update`, src = `${stage}/src/kanso`;
    try {
      const staged = await exec("sh", ["-c", STAGE_SCRIPT, "sh", this.source.tarball(v), stage, v]);
      if (staged.code !== 0) throw new Error(lastLine(staged, "the download failed"));
      for (const name of staged.stdout.split("\n").map((s) => s.trim()).filter(Boolean)) {
        const c = await exec("herdr-app", ["check", `${src}/mods/${name}`]);
        if (c.code !== 0) throw new Error(`${name} does not load on this Herdr: ${lastLine(c, "check failed")}`);
      }
      const notes = await this.stageKeysAndLayout(v, home, stage, src);
      this.setState({ done: { version: v, notes } });
      // Swapping kanso-chrome restarts this mod; the fresh copy reports.
      const swapped = await exec("sh", ["-c", SWAP_SCRIPT, "sh", stage, home, stamp()]);
      if (swapped.code !== 0) {
        this.setState({ done: null });
        throw new Error(lastLine(swapped, "the files could not be put in place"));
      }
      this.installed = v;
      this.finished();
    } catch (e) {
      this.error = String(e?.message ?? e);
      notify({ title: "Kanso was not updated", body: this.error, level: "error" });
      try { await exec("rm", ["-rf", stage]); } catch {}
    } finally {
      this.busy = false;
      this.fit();
      cx.notify();
    }
  }

  // Stages keys.json and kanso.json next to the release when it changed them,
  // judged against what the installed release shipped. Returns what to tell you.
  async stageKeysAndLayout(v, home, stage, src) {
    const shipped = async (path) => {
      try {
        const r = await exec("curl", ["-fsSL", "--max-time", "15", this.source.file(this.installed, path)]);
        return r.code === 0 ? r.stdout : null;
      } catch { return null; }
    };
    const [oldKeys, oldLayout] = await Promise.all([shipped("kanso/keys.json"), shipped("kanso/layouts/kanso.json")]);
    const newKeys = await readTextFile(`${src}/keys.json`), newLayout = await readTextFile(`${src}/layouts/kanso.json`);
    const notes = [];
    if (oldLayout !== null && newLayout !== null && !sameJson(oldLayout, newLayout)) {
      await writeTextFile(`${stage}/kanso.json`, newLayout, null);
      notes.push("New layout; the one you had is in layouts/kanso.json.old-*.");
    }
    const userKeys = await readTextFile(`${home}/keys.json`);
    if (oldKeys !== null && newKeys !== null && userKeys !== null && !sameJson(oldKeys, newKeys)) {
      try {
        const merged = mergeKeys(JSON.parse(userKeys), JSON.parse(oldKeys), JSON.parse(newKeys));
        if (merged.changed) {
          await writeTextFile(`${stage}/keys.json`, `${JSON.stringify(merged.keys, null, 2)}\n`, null);
          notes.push("Kanso's keys updated.");
        }
        if (merged.kept.length) notes.push(`Kept your own ${merged.kept.join(", ")}.`);
      } catch {
        notes.push("Your keys.json could not be read, so Kanso's keys were left as they are.");
      }
    }
    return notes.join(" ");
  }
}
