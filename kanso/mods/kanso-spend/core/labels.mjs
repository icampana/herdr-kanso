// Task labels for the Costs view: a session's /name, else its ticket, else
// how its first prompt starts. Same rules as pi-usage (scan.ts), so a Pi
// session reads the same in both places. Only the first line of the first
// prompt (120 chars) and ticket refs are kept, never the transcript.
import { createReadStream } from "node:fs";
import { readFile, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInterface } from "node:readline";
import * as zlib from "node:zlib";
import { atomicWriteJson, isPlainObject } from "./util.mjs";

export const LABELS_VERSION = 2;
const USER_SCAN = 4;
const MAX_LINES = 4000;
const MAX_BYTES = 8 * 1024 * 1024;
const RELABEL_MS = 10 * 60 * 1000;

// ---------------------------------------------------------------------------
// Tickets (ported from pi-usage scan.ts)

const JIRA = /(?<![\w-])([A-Z]{2}[A-Z0-9_]{0,8}-\d{1,6})(?![\w-])/g;
const NOT_TICKETS = new Set(["UTF", "ISO", "SHA", "GPT", "RFC", "ES", "MD", "AES", "RSA", "HTTP", "TLS", "SSL", "IPV", "CVE", "WCAG", "ECMA", "PEP", "COVID", "MP", "H", "TS", "X", "K", "V", "BASE", "ARM", "TOP", "GPU", "CPU", "P", "M", "IP", "UUID", "LTS", "NODE", "ED", "HMAC", "PBKDF"]);
const LINKS = [
  { pattern: /https?:\/\/[\w.-]+\.atlassian\.net\/browse\/([A-Z][A-Z0-9]+-\d+)/g, ref: (m) => m[1] },
  { pattern: /https?:\/\/[\w.-]+\.atlassian\.net\/wiki\/\S*?\/pages\/(\d+)/g, ref: (m) => `confluence:${m[1]}` },
  { pattern: /https?:\/\/linear\.app\/[\w-]+\/issue\/([A-Z][A-Z0-9]+-\d+)/g, ref: (m) => m[1] },
  { pattern: /https?:\/\/app\.clickup\.com\/t\/(?:\d+\/)?([\w-]+)/g, ref: (m) => `clickup:${m[1]}` },
  { pattern: /https?:\/\/github\.com\/([\w.-]+\/[\w.-]+)\/(?:issues|pull)\/(\d+)/g, ref: (m) => `${m[1]}#${m[2]}` },
  { pattern: /https?:\/\/docs\.google\.com\/(?:document|spreadsheets|presentation)\/d\/([\w-]{8})[\w-]*/g, ref: (m) => `gdoc:${m[1]}` },
  { pattern: /https?:\/\/(?:www\.)?notion\.(?:so|site)\/(?:[\w-]+\/)?([\w-]*?)-?([0-9a-f]{32})/g, ref: (m) => `notion:${m[1] || m[2].slice(0, 8)}` },
];

export function ticketsIn(text) {
  const found = [];
  const add = (ref) => { if (!found.includes(ref)) found.push(ref); };
  for (const { pattern, ref } of LINKS) for (const match of text.matchAll(pattern)) add(ref(match));
  for (const match of text.matchAll(JIRA)) {
    const key = match[1];
    if (!NOT_TICKETS.has(key.slice(0, key.indexOf("-")))) add(key);
  }
  return found;
}

function snippet(text) {
  const line = String(text).split("\n").map((part) => part.trim()).find(Boolean);
  return line ? (line.length > 120 ? `${line.slice(0, 119)}…` : line) : undefined;
}

const textOf = (content) => (typeof content === "string" ? content
  : Array.isArray(content) ? content.map((part) => (part && typeof part === "object" && typeof part.text === "string"
    && (part.type === "text" || part.type === "input_text" || part.type === undefined) ? part.text : "")).join("\n")
    : "");

/** Harness boilerplate injected as a user turn is not the user's prompt. */
function cleanPrompt(text) {
  let body = String(text ?? "");
  const request = body.indexOf("## My request for Codex:");
  if (request >= 0) body = body.slice(request + "## My request for Codex:".length);
  body = body.replace(/<system-reminder>[\s\S]*?<\/system-reminder>/g, "");
  const trimmed = body.trim();
  if (!trimmed) return "";
  if (/^<[a-z_-]+[\s>]/i.test(trimmed)) return "";
  if (/^(# AGENTS\.md|# Files mentioned by the user|Caveat:)/.test(trimmed)) return "";
  return trimmed;
}

/** The user texts of one transcript line, per harness. */
function userTexts(adapter, entry) {
  if (!isPlainObject(entry)) return { texts: [] };
  if (adapter === "claude") {
    if (entry.type !== "user" || entry.isMeta || entry.isSidechain) return { texts: [] };
    return { texts: [textOf(entry.message?.content)] };
  }
  if (adapter === "codex") {
    const payload = entry.payload;
    if (entry.type === "response_item" && payload?.type === "message" && payload.role === "user") {
      return { texts: (payload.content ?? []).map((part) => (typeof part?.text === "string" ? part.text : "")) };
    }
    return { texts: [] };
  }
  if (adapter === "pi") {
    if (entry.type === "session_info" && typeof entry.name === "string" && entry.name.trim()) return { texts: [], name: entry.name.trim() };
    if (entry.type === "message" && entry.message?.role === "user") return { texts: [textOf(entry.message.content)] };
  }
  return { texts: [] };
}

/** Reads a transcript head (decompressing .zst) until enough user turns are seen. */
export async function readLabel(adapter, filePath) {
  const label = { prompt: undefined, name: undefined, tickets: [] };
  let users = 0;
  let lines = 0;
  let bytes = 0;
  let source = createReadStream(filePath);
  let stream = source;
  if (filePath.endsWith(".zst")) {
    if (typeof zlib.createZstdDecompress !== "function") return label;
    stream = source.pipe(zlib.createZstdDecompress());
    stream.on("error", () => {});
  }
  source.on("error", () => {});
  const reader = createInterface({ input: stream, crlfDelay: Infinity });
  try {
    for await (const line of reader) {
      lines += 1;
      bytes += line.length;
      if (lines > MAX_LINES || bytes > MAX_BYTES) break;
      // Cheap prefilter: skip lines that cannot hold a user turn or a name.
      if (!line.includes('"user"') && !line.includes("session_info")) continue;
      let entry;
      try { entry = JSON.parse(line); } catch { continue; }
      const found = userTexts(adapter, entry);
      if (found.name) label.name = found.name;
      for (const raw of found.texts) {
        const text = cleanPrompt(raw);
        if (!text) continue;
        users += 1;
        // "." or "ok" says nothing about the task; wait for a real prompt.
        if (!label.prompt && (text.match(/[\p{L}\p{N}]/gu) ?? []).length >= 8) label.prompt = snippet(text);
        for (const ticket of ticketsIn(text)) if (!label.tickets.includes(ticket)) label.tickets.push(ticket);
      }
      // Pi can rename a session later; keep reading Pi heads to the line cap.
      if (users >= USER_SCAN && adapter !== "pi") break;
    }
  } finally {
    reader.close();
    source.destroy();
    if (stream !== source) stream.destroy();
  }
  return label;
}

export function labelText(label, sessionId) {
  return label?.name || label?.tickets?.[0] || label?.prompt || `Session ${String(sessionId).split(":").pop().slice(0, 8)}`;
}

// ---------------------------------------------------------------------------
// Cache

export function labelsPath(storePath) {
  return path.join(path.dirname(storePath), "labels.json");
}

export async function loadLabels(storePath) {
  try {
    const parsed = JSON.parse(await readFile(labelsPath(storePath), "utf8"));
    if (parsed?.version === LABELS_VERSION && isPlainObject(parsed.sessions)) return parsed;
  } catch { /* first run */ }
  return { version: LABELS_VERSION, sessions: {} };
}

/** pi-usage keeps names, prompts and tickets for every Pi session it saw. */
async function piUsageLabels(home) {
  const out = new Map();
  try {
    const parsed = JSON.parse(await readFile(path.join(home, ".prjct/pi-usage/scan.json"), "utf8"));
    for (const file of Object.values(parsed?.files ?? {})) {
      if (!file?.id) continue;
      out.set(`pi:${file.id}`, { name: file.name, prompt: file.prompt, tickets: Array.isArray(file.tickets) ? file.tickets : [] });
    }
  } catch { /* pi-usage not installed */ }
  return out;
}

/**
 * Brings the label cache up to date for every session in the store. A label
 * is re-read when its transcript grew (a /name or ticket can arrive later),
 * and the work stops at the deadline; the rest continues on the next refresh.
 */
export async function updateLabels(store, storePath, { home = os.homedir(), deadline = Infinity } = {}) {
  const cache = await loadLabels(storePath);
  let fromPiUsage = null;
  const now = Date.now();
  let dirty = false;
  let pending = 0;
  const sessions = new Map();
  for (const file of Object.values(store.files ?? {})) {
    for (const row of file.rows ?? []) {
      if (typeof row.session === "string" && !sessions.has(row.session)) sessions.set(row.session, file);
    }
  }
  for (const [session, file] of sessions) {
    const cached = cache.sessions[session];
    if (cached && cached.size === file.size) continue;
    // A live session grows every turn; its label rarely changes. Re-read a
    // known session at most every few minutes, not on every refresh.
    if (cached && now - (cached.readAt ?? 0) < RELABEL_MS) continue;
    fromPiUsage ??= await piUsageLabels(home);
    const known = fromPiUsage.get(session);
    if (known && (known.name || known.prompt || known.tickets.length)) {
      cache.sessions[session] = { ...known, size: file.size, readAt: now };
      dirty = true;
      continue;
    }
    if (Date.now() >= deadline) { pending += 1; continue; }
    // A label that never changes once the first prompts are in: only re-read
    // a growing Pi file, whose /name can change; others keep their label.
    if (cached && file.adapter !== "pi" && (cached.prompt || cached.tickets?.length)) {
      cache.sessions[session] = { ...cached, size: file.size, readAt: now };
      dirty = true;
      continue;
    }
    try {
      const fileStat = await stat(file.path);
      const label = await readLabel(file.adapter, file.path);
      cache.sessions[session] = { ...label, size: file.size ?? fileStat.size, readAt: now };
    } catch {
      cache.sessions[session] = { tickets: [], size: file.size, readAt: now };
    }
    dirty = true;
  }
  if (dirty) await atomicWriteJson(labelsPath(storePath), cache);
  return { labels: cache, pending };
}
