#!/usr/bin/env node
// Checks that Kanso is versioned the way its updater needs, and prints release notes.
//
//   node scripts/check-version.mjs           check (CI runs this on every pull request and push)
//   node scripts/check-version.mjs --notes   print the CHANGELOG section of version.json's version
//
// The updater offers a release only when a vX.Y.Z tag is newer than the installed
// kanso/mods/kanso-chrome/version.json. So:
//   1. version.json holds a semantic version, X.Y.Z.
//   2. CHANGELOG.md has a section per version, newest first, from the first
//      release on: "## [X.Y.Z] - YYYY-MM-DD", then "### <Category>" headings
//      with "- " entries. Its newest section is version.json's version.
//   3. Each version is the exact semantic successor of the one before, by what
//      its section lists: Breaking or Removed -> major, Added or Deprecated ->
//      minor, otherwise (Changed, Fixed, Security) -> patch.
//   4. Every vX.Y.Z tag has its section.
//   5. When what Kanso installs (mods, themes, layouts, keys.json) changed since
//      the newest tag, version.json is newer than that tag. Merging to main
//      then releases it (.github/workflows/release.yml).
import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";

export const VERSION_FILE = "kanso/mods/kanso-chrome/version.json";
export const CHANGELOG = "CHANGELOG.md";
// What the updater installs; a change here is a release.
export const INSTALLED = ["kanso/mods", "kanso/themes", "kanso/layouts", "kanso/keys.json"];
export const CATEGORIES = ["Breaking", "Added", "Changed", "Deprecated", "Removed", "Fixed", "Security"];

export const parse = (v) => {
  const m = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(String(v ?? ""));
  return m ? m.slice(1).map(Number) : null;
};

export function compare(a, b) {
  const x = parse(a), y = parse(b);
  for (let i = 0; i < 3; i++) if (x[i] !== y[i]) return x[i] - y[i];
  return 0;
}

// The bump a section's categories call for.
export function requiredBump(categories) {
  if (categories.some((c) => c === "Breaking" || c === "Removed")) return "major";
  if (categories.some((c) => c === "Added" || c === "Deprecated")) return "minor";
  return "patch";
}

export function bump(version, kind) {
  const [major, minor, patch] = parse(version);
  if (kind === "major") return `${major + 1}.0.0`;
  if (kind === "minor") return `${major}.${minor + 1}.0`;
  return `${major}.${minor}.${patch + 1}`;
}

// CHANGELOG.md as [{ version, date, categories: { name: [entries] }, body, line }],
// in file order, plus the problems found reading it.
export function parseChangelog(text) {
  const sections = [], errors = [];
  let section = null, category = null;
  const lines = text.split("\n");
  lines.forEach((raw, i) => {
    const line = raw.trimEnd(), at = i + 1;
    if (line.startsWith("## ")) {
      const m = /^## \[([^\]]+)\] - (\d{4}-\d{2}-\d{2})$/.exec(line);
      if (!m) { errors.push(`${CHANGELOG}:${at}: a version heading reads "## [X.Y.Z] - YYYY-MM-DD", not "${line}"`); section = null; return; }
      if (!parse(m[1])) errors.push(`${CHANGELOG}:${at}: "${m[1]}" is not a semantic version (X.Y.Z)`);
      section = { version: m[1], date: m[2], categories: {}, body: [], line: at };
      sections.push(section); category = null;
      return;
    }
    if (!section) return;
    section.body.push(raw);
    if (line.startsWith("### ")) {
      const name = line.slice(4).trim();
      if (!CATEGORIES.includes(name)) errors.push(`${CHANGELOG}:${at}: "${name}" is not one of ${CATEGORIES.join(", ")}`);
      category = name; section.categories[name] ??= [];
    } else if (line.startsWith("- ")) {
      if (!category) errors.push(`${CHANGELOG}:${at}: an entry before any "### <Category>" heading`);
      else section.categories[category].push(line.slice(2));
    }
  });
  for (const s of sections) {
    s.body = s.body.join("\n").trim();
    for (const [name, entries] of Object.entries(s.categories)) {
      if (!entries.length) errors.push(`${CHANGELOG}:${s.line}: ${s.version} has an empty "### ${name}"`);
    }
    if (!Object.keys(s.categories).length) errors.push(`${CHANGELOG}:${s.line}: ${s.version} lists no changes`);
  }
  return { sections, errors };
}

// Everything wrong with the versioning, given what the repository holds.
// `tags`: the vX.Y.Z tags' versions; `installedChangedSince(tag)`: whether what
// Kanso installs differs from that tag.
export function check({ version, changelog, tags, installedChangedSince }) {
  const errors = [];
  if (!parse(version)) errors.push(`${VERSION_FILE} says "${version}", not a semantic version (X.Y.Z)`);
  const { sections, errors: read } = parseChangelog(changelog);
  errors.push(...read);
  if (!sections.length) errors.push(`${CHANGELOG} has no "## [X.Y.Z] - YYYY-MM-DD" sections`);
  const valid = sections.filter((s) => parse(s.version));
  const seen = new Set();
  for (const s of valid) {
    if (seen.has(s.version)) errors.push(`${CHANGELOG}:${s.line}: ${s.version} appears twice`);
    seen.add(s.version);
  }
  for (let i = 0; i + 1 < valid.length; i++) {
    const newer = valid[i], older = valid[i + 1];
    if (compare(newer.version, older.version) <= 0) {
      errors.push(`${CHANGELOG}:${newer.line}: ${newer.version} comes before ${older.version}; newest first`);
      continue;
    }
    if (newer.date < older.date) errors.push(`${CHANGELOG}:${newer.line}: ${newer.version} is dated before ${older.version}`);
    const kind = requiredBump(Object.keys(newer.categories)), want = bump(older.version, kind);
    if (newer.version !== want) {
      errors.push(`${CHANGELOG}:${newer.line}: after ${older.version}, a release with ${Object.keys(newer.categories).join(", ")} is a ${kind} bump: ${want}, not ${newer.version}`);
    }
  }
  if (parse(version) && valid.length && valid[0].version !== version) {
    errors.push(`${VERSION_FILE} says ${version}, but the newest ${CHANGELOG} section is ${valid[0].version}`);
  }
  for (const tag of tags.filter(parse)) {
    if (!seen.has(tag)) errors.push(`tag v${tag} has no ${CHANGELOG} section`);
  }
  const latest = tags.filter(parse).sort(compare).at(-1);
  if (latest && parse(version)) {
    if (compare(version, latest) < 0) errors.push(`${VERSION_FILE} says ${version}, older than the released v${latest}`);
    else if (compare(version, latest) === 0 && installedChangedSince(latest)) {
      errors.push(`what Kanso installs changed since v${latest}, but ${VERSION_FILE} still says ${version}: bump it and add its ${CHANGELOG} section, or the updater will never offer this change`);
    }
  }
  return errors;
}

export function notes(changelog, version) {
  return parseChangelog(changelog).sections.find((s) => s.version === version)?.body ?? null;
}

function git(args) {
  return execFileSync("git", args, { encoding: "utf8" });
}

function main() {
  let version, changelog;
  try { version = JSON.parse(readFileSync(VERSION_FILE, "utf8")).version; }
  catch (e) { console.error(`error: ${VERSION_FILE} could not be read: ${e.message}`); process.exit(1); }
  try { changelog = readFileSync(CHANGELOG, "utf8"); }
  catch (e) { console.error(`error: ${CHANGELOG} could not be read: ${e.message}`); process.exit(1); }
  if (process.argv.includes("--notes")) {
    const body = notes(changelog, version);
    if (body === null) { console.error(`${CHANGELOG} has no section for ${version}`); process.exit(1); }
    process.stdout.write(`${body}\n`);
    return;
  }
  const tags = git(["tag", "--list", "v*"]).split("\n").map((t) => t.trim().replace(/^v/, "")).filter(parse);
  const installedChangedSince = (tag) => {
    try { git(["diff", "--quiet", `v${tag}`, "HEAD", "--", ...INSTALLED]); return false; } catch { return true; }
  };
  const errors = check({ version, changelog, tags, installedChangedSince });
  if (errors.length) {
    for (const e of errors) console.error(`error: ${e}`);
    process.exit(1);
  }
  const latest = tags.sort(compare).at(-1);
  console.log(latest && compare(version, latest) === 0
    ? `Kanso ${version}: released as v${latest}, nothing new to release.`
    : `Kanso ${version}: versioned correctly; merging to main releases v${version}.`);
}

if (process.argv[1] === fileURLToPath(import.meta.url)) main();
