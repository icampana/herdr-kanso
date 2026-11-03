// Costs: the subsidy (what the same tokens would cost at API list price) per
// model, project and task, over a chosen period. Pricing follows pi-usage:
// OpenRouter catalog rates, matched by model name with the provider's first
// word as a vendor prefix; no price, no guess (those tokens show as unpriced).
import { readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { atomicWriteJson, isPlainObject } from "./util.mjs";
import { labelText } from "./labels.mjs";

export const CATALOG_URL = "https://openrouter.ai/api/v1/models";
export const CATALOG_TTL = 24 * 60 * 60 * 1000;
const FETCH_MS = 8_000;

// ---------------------------------------------------------------------------
// Rates (ported from pi-usage pricing.ts)

const dash = (id) => String(id).toLowerCase().replace(/[_.]/g, "-");
const tail = (id) => {
  const name = dash(id);
  return name.slice(name.lastIndexOf("/") + 1);
};
const price = (value) => {
  const n = Number(value);
  return value !== undefined && value !== null && value !== "" && Number.isFinite(n) && n >= 0 ? n : undefined;
};

export function parseCatalog(payload) {
  const rows = payload?.data;
  if (!Array.isArray(rows)) return [];
  const rates = [];
  for (const row of rows) {
    const id = typeof row?.id === "string" ? row.id : "";
    if (!id || id.includes(":") || id.startsWith("~")) continue;
    const input = price(row.pricing?.prompt);
    const output = price(row.pricing?.completion);
    if (input === undefined || output === undefined) continue;
    const cacheRead = price(row.pricing?.input_cache_read);
    const cacheWrite = price(row.pricing?.input_cache_write);
    rates.push({ id, input, output, ...(cacheRead !== undefined ? { cacheRead } : {}), ...(cacheWrite !== undefined ? { cacheWrite } : {}) });
  }
  return sortRates(rates);
}

function sortRates(rates) {
  return rates.sort((a, b) => tail(b.id).length - tail(a.id).length);
}

export function rateFor(rates, provider, model) {
  const name = tail(model);
  const vendor = dash(provider).split("-")[0];
  const needles = vendor && !name.startsWith(`${vendor}-`) ? [name, `${vendor}-${name}`] : [name];
  for (const needle of needles) {
    for (const rate of rates) {
      const key = tail(rate.id);
      if (needle === key || needle.startsWith(`${key}-`)) return rate;
    }
  }
  return undefined;
}

export const isFree = (provider, model) =>
  /:free$/.test(model) || model === "openrouter/free" || model === "free"
  || ["ollama", "lmstudio", "llama-cpp", "llamacpp"].includes(provider);

function estimate(tokens, rate) {
  const cacheRead = tokens.cacheRead && rate.cacheRead !== undefined ? tokens.cacheRead * rate.cacheRead : 0;
  const cacheWrite = tokens.cacheWrite && rate.cacheWrite !== undefined ? tokens.cacheWrite * rate.cacheWrite : 0;
  const unpriced = (tokens.cacheRead && rate.cacheRead === undefined ? tokens.cacheRead : 0)
    + (tokens.cacheWrite && rate.cacheWrite === undefined ? tokens.cacheWrite : 0);
  return { usd: tokens.input * rate.input + tokens.output * rate.output + cacheRead + cacheWrite, unpriced };
}

async function readCatalog(file) {
  try {
    const parsed = JSON.parse(await readFile(file, "utf8"));
    if (Array.isArray(parsed?.rates) && parsed.rates.length) return { fetchedAt: Number(parsed.fetchedAt) || 0, rates: parsed.rates };
  } catch { /* missing */ }
  return null;
}

export function catalogPath(storePath) {
  return path.join(path.dirname(storePath), "pricing.json");
}

/**
 * The freshest catalog between ours and pi-usage's. With `refresh`, a catalog
 * older than 24h is fetched again; a failed fetch keeps the last good one.
 */
export async function loadCatalog(storePath, { home = os.homedir(), refresh = false } = {}) {
  const own = await readCatalog(catalogPath(storePath));
  const shared = await readCatalog(path.join(home, ".prjct/pi-usage/pricing.json"));
  let best = [own, shared].filter(Boolean).sort((a, b) => b.fetchedAt - a.fetchedAt)[0] ?? null;
  if (refresh && (!best || Date.now() - best.fetchedAt > CATALOG_TTL)) {
    try {
      const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(FETCH_MS), headers: { accept: "application/json" } });
      if (response.ok) {
        const rates = parseCatalog(await response.json());
        if (rates.length) {
          best = { fetchedAt: Date.now(), rates };
          await atomicWriteJson(catalogPath(storePath), best);
        }
      }
    } catch { /* offline: keep the cached catalog */ }
  }
  return best ?? { fetchedAt: 0, rates: [] };
}

/**
 * Optional `prices.json` next to the store:
 *   { "models": { "<model>": { "input": 1.25, "output": 10, "cacheRead": 0.125 } },  // USD per 1M tokens
 *     "plans": [ { "name": "ChatGPT Pro", "usdPerMonth": 200 } ] }
 */
export async function loadOverrides(storePath) {
  try {
    const parsed = JSON.parse(await readFile(path.join(path.dirname(storePath), "prices.json"), "utf8"));
    const models = {};
    for (const [model, value] of Object.entries(isPlainObject(parsed?.models) ? parsed.models : {})) {
      const input = price(value?.input);
      const output = price(value?.output);
      if (input === undefined || output === undefined) continue;
      const cacheRead = price(value.cacheRead);
      const cacheWrite = price(value.cacheWrite);
      models[dash(model)] = {
        id: `override/${model}`,
        input: input / 1e6,
        output: output / 1e6,
        ...(cacheRead !== undefined ? { cacheRead: cacheRead / 1e6 } : {}),
        ...(cacheWrite !== undefined ? { cacheWrite: cacheWrite / 1e6 } : {}),
      };
    }
    const plans = (Array.isArray(parsed?.plans) ? parsed.plans : [])
      .map((plan) => ({ name: String(plan?.name ?? "Plan"), usdPerMonth: price(plan?.usdPerMonth) ?? 0 }))
      .filter((plan) => plan.usdPerMonth > 0);
    return { models, plans };
  } catch {
    return { models: {}, plans: [] };
  }
}

/**
 * Anthropic first-party list prices (USD per 1M tokens), which win over the
 * OpenRouter catalog for Claude models: the catalog has had wrong cache rates
 * for some of them. Cache writes cost 1.25x input for the 5-minute TTL and 2x
 * for the 1-hour TTL.
 */
const ANTHROPIC_PRICES = {
  "claude-opus-5-5": { input: 4, output: 20, cacheRead: 0.2 },
  "claude-fable-5-1": { input: 10, output: 50, cacheRead: 0.25 },
  "claude-sonnet-5-5": { input: 2, output: 10, cacheRead: 0.2 },
};

/** Claude Code writes its prompt cache with the 1-hour TTL. */
const ONE_HOUR_CACHE_HARNESSES = new Set(["claude"]);

function anthropicRate(model, harness) {
  const key = Object.keys(ANTHROPIC_PRICES).find((name) => dash(model) === name || dash(model).startsWith(`${name}-`));
  if (!key) return null;
  const p = ANTHROPIC_PRICES[key];
  const writeFactor = ONE_HOUR_CACHE_HARNESSES.has(harness) ? 2 : 1.25;
  return {
    id: `anthropic/${key}${writeFactor === 2 ? " (1h cache writes)" : ""}`,
    input: p.input / 1e6,
    output: p.output / 1e6,
    cacheRead: p.cacheRead / 1e6,
    cacheWrite: (p.input * writeFactor) / 1e6,
  };
}

function pricer(catalog, overrides) {
  const memo = new Map();
  return (provider, model, harness = "") => {
    const key = `${provider}\u0001${model}\u0001${harness}`;
    if (memo.has(key)) return memo.get(key);
    let rate = null;
    if (isFree(provider, model)) rate = { id: "free", input: 0, output: 0, cacheRead: 0, cacheWrite: 0 };
    else if (model && model !== "unknown") {
      rate = overrides.models[dash(model)]
        ?? anthropicRate(model, harness)
        ?? rateFor(catalog.rates, provider, model)
        ?? null;
    }
    memo.set(key, rate);
    return rate;
  };
}

// ---------------------------------------------------------------------------
// Periods

const pad = (n) => String(n).padStart(2, "0");
const dayKey = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
const MONTHS_LONG = ["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"];

function parseDay(day) {
  const [y, m, d] = String(day).split("-").map(Number);
  return new Date(y, m - 1, d);
}

/** start/end are inclusive day keys; buckets are days or months. */
export function costRange(period, offset, today, firstDay) {
  const now = parseDay(today);
  const shift = Number.isInteger(offset) ? Math.min(0, offset) : 0;
  if (period === "30d") {
    const end = new Date(now); end.setDate(end.getDate() + shift * 30);
    const start = new Date(end); start.setDate(start.getDate() - 29);
    return { period, start: dayKey(start), end: dayKey(end), unit: "day", label: `${dayLabelShort(start)} – ${dayLabelShort(end)}`, name: shift === 0 ? "the last 30 days" : `${dayLabelShort(start)} – ${dayLabelShort(end)}`, months: 30 / 30.44 };
  }
  if (period === "year") {
    const year = now.getFullYear() + shift;
    return { period, start: `${year}-01-01`, end: `${year}-12-31`, unit: "month", label: String(year), name: String(year), months: 12 };
  }
  if (period === "all") {
    const first = firstDay ? parseDay(firstDay) : now;
    const start = new Date(first.getFullYear(), first.getMonth(), 1);
    const months = (now.getFullYear() - start.getFullYear()) * 12 + now.getMonth() - start.getMonth() + 1;
    return { period, start: dayKey(start), end: today, unit: "month", label: "All time", name: `since ${MONTHS_LONG[start.getMonth()]} ${start.getFullYear()}`, months };
  }
  const first = new Date(now.getFullYear(), now.getMonth() + shift, 1);
  const last = new Date(first.getFullYear(), first.getMonth() + 1, 0);
  return { period: "month", start: dayKey(first), end: dayKey(last), unit: "day", label: `${MONTHS_LONG[first.getMonth()]} ${first.getFullYear()}`, name: MONTHS_LONG[first.getMonth()] + (first.getFullYear() === now.getFullYear() ? "" : ` ${first.getFullYear()}`), months: 1 };
}

function dayLabelShort(d) {
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

function previousRange(range, today, firstDay) {
  if (range.period === "all") return null;
  const now = parseDay(today);
  const start = parseDay(range.start);
  let offset;
  if (range.period === "year") offset = start.getFullYear() - now.getFullYear() - 1;
  else if (range.period === "month") offset = (start.getFullYear() - now.getFullYear()) * 12 + start.getMonth() - now.getMonth() - 1;
  else offset = Math.round((parseDay(range.end) - now) / (30 * 86400000)) - 1;
  return costRange(range.period, offset, today, firstDay);
}

function buckets(range) {
  const out = [];
  if (range.unit === "day") {
    const end = parseDay(range.end);
    for (let d = parseDay(range.start); d <= end; d.setDate(d.getDate() + 1)) {
      out.push({ key: dayKey(d), label: String(d.getDate()), tip: dayLabelShort(d), usd: 0, tokens: 0 });
    }
  } else {
    const end = parseDay(range.end);
    for (let d = parseDay(range.start); d <= end; d.setMonth(d.getMonth() + 1)) {
      out.push({ key: dayKey(d).slice(0, 7), label: MONTHS[d.getMonth()], tip: `${MONTHS[d.getMonth()]} ${d.getFullYear()}`, usd: 0, tokens: 0 });
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Display text, prepared here so the native render pass only lays it out.

const group3 = (n) => String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ",");
export function usdText(value, exact = false) {
  const n = Number(value);
  if (!Number.isFinite(n) || n === 0) return "$0";
  if (exact) {
    const [whole, cents] = Math.abs(n).toFixed(2).split(".");
    return `${n < 0 ? "-" : ""}$${group3(Number(whole))}.${cents}`;
  }
  const abs = Math.abs(n);
  if (abs < 0.01) return "<$0.01";
  if (abs < 100) return `$${n.toFixed(2)}`;
  return `${n < 0 ? "-" : ""}$${group3(abs)}`;
}
export function compactText(value) {
  const n = Number(value) || 0;
  for (const [d, s] of [[1e12, "T"], [1e9, "B"], [1e6, "M"], [1e3, "K"]]) {
    if (n >= d * 0.9995) {
      const v = n / d;
      return `${v >= 100 ? Math.round(v) : Number(v.toFixed(v >= 10 ? 1 : 2))}${s}`;
    }
  }
  return String(Math.round(n));
}
const intText = (n) => group3(Number(n) || 0);
const rateText = (n) => (n >= 1 ? String(Number(n.toFixed(2))) : String(Number(n.toPrecision(2))));
function dayText(day) {
  const d = parseDay(day);
  return `${MONTHS[d.getMonth()]} ${d.getDate()}`;
}

// ---------------------------------------------------------------------------
// Derivation

const sumTokens = (t) => (t.input || 0) + (t.output || 0) + (t.cacheRead || 0) + (t.cacheWrite || 0);
const projectLabel = (p) => {
  const text = String(p ?? "").replace(/[\\/]+$/, "");
  if (!text || text === "unknown") return "Unknown project";
  return text.split(/[\\/]/).pop() || text;
};

function group(map, key, init) {
  let entry = map.get(key);
  if (!entry) { entry = { ...init(), usd: 0, tokens: 0, unpriced: 0 }; map.set(key, entry); }
  return entry;
}

/**
 * Everything the Costs view shows, compact enough for QuickJS. `rows` are the
 * snapshot rows (day × session × model × project).
 */
/**
 * Sessions still being written (their file changed in the last half hour),
 * whole-session totals regardless of the period and filters: "what is this
 * conversation costing me right now".
 */
function liveCosts(rows, live, price, labels) {
  if (!live?.size) return [];
  const sessions = new Map();
  for (const row of rows) {
    if (!live.has(row.session)) continue;
    const tokens = row.tokens ?? {};
    const count = sumTokens(tokens);
    if (!count) continue;
    const rate = price(row.provider, row.model, row.harness);
    const usd = rate ? estimate(tokens, rate).usd : 0;
    let s = sessions.get(row.session);
    if (!s) {
      s = { session: row.session, harness: row.harness, project: row.project, usd: 0, tokens: 0, models: new Map(), breakdown: newBreakdown() };
      sessions.set(row.session, s);
    }
    addToBreakdown(s.breakdown, row, usd, count);
    s.usd += usd;
    s.tokens += count;
    s.models.set(row.model, (s.models.get(row.model) ?? 0) + usd + count * 1e-12);
  }
  const harnessName = HARNESS_NAMES;
  return [...sessions.values()]
    .sort((a, b) => (live.get(b.session) ?? 0) - (live.get(a.session) ?? 0))
    .slice(0, 5)
    .map((s) => {
      const label = labels?.sessions?.[s.session];
      const ticket = label?.tickets?.[0] ?? null;
      const model = [...s.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      const minutes = Math.max(0, Math.round((Date.now() - (live.get(s.session) ?? Date.now())) / 60000));
      return {
        detail: breakdownDetail(s.breakdown, {
          title: cleanTitle(label?.prompt || labelText(label, s.session)), ticket, project: s.project, usd: s.usd, tokens: s.tokens,
        }),
        ticket,
        title: cleanTitle(ticket ? (label?.prompt || ticket) : labelText(label, s.session)),
        tip: label?.prompt || labelText(label, s.session),
        meta: [harnessName[s.harness] ?? s.harness, model, projectLabel(s.project), minutes < 1 ? "active now" : `${minutes} min ago`],
        usdText: usdText(s.usd),
        tokensText: `${compactText(s.tokens)} tok`,
      };
    });
}

const HARNESS_NAMES = { claude: "Claude Code", codex: "Codex", pi: "Pi", opencode: "OpenCode" };

/** Per-task (or per-session) breakdown, filled row by row, for the detail view. */
function newBreakdown() {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, models: new Map(), sessions: new Map(), harnesses: new Set() };
}

function addToBreakdown(b, row, usd, count) {
  const t = row.tokens ?? {};
  b.input += t.input || 0; b.output += t.output || 0; b.cacheRead += t.cacheRead || 0; b.cacheWrite += t.cacheWrite || 0;
  b.harnesses.add(row.harness);
  const m = b.models.get(row.model) ?? { usd: 0, tokens: 0 };
  m.usd += usd; m.tokens += count; b.models.set(row.model, m);
  const s = b.sessions.get(row.session) ?? { usd: 0, tokens: 0, first: row.day, last: row.day };
  s.usd += usd; s.tokens += count;
  if (row.day < s.first) s.first = row.day;
  if (row.day > s.last) s.last = row.day;
  b.sessions.set(row.session, s);
}

function breakdownDetail(b, { title, ticket, project, usd, tokens }) {
  const span = (first, last) => (first === last ? dayText(first) : `${dayText(first)} – ${dayText(last)}`);
  const sessions = [...b.sessions.entries()].sort((a, c) => c[1].usd - a[1].usd);
  const first = sessions.reduce((min, [, s]) => (!min || s.first < min ? s.first : min), null);
  const last = sessions.reduce((max, [, s]) => (!max || s.last > max ? s.last : max), null);
  return {
    title,
    ticket,
    project: projectLabel(project),
    projectPath: project,
    when: first ? span(first, last) : "",
    tools: [...b.harnesses].map((h) => HARNESS_NAMES[h] ?? h).join(", "),
    usdText: usdText(usd),
    usdExact: usdText(usd, true),
    tokensText: compactText(tokens),
    parts: [
      { label: "Input", value: compactText(b.input) },
      { label: "Output", value: compactText(b.output) },
      { label: "Cache read", value: compactText(b.cacheRead) },
      { label: "Cache write", value: compactText(b.cacheWrite) },
    ],
    models: [...b.models.entries()].sort((a, c) => c[1].usd - a[1].usd).slice(0, 6)
      .map(([name, m]) => ({ name, usdText: usdText(m.usd), tokensText: compactText(m.tokens) })),
    sessions: sessions.slice(0, 8).map(([id, s]) => ({
      name: `Session ${String(id).split(":").pop().slice(0, 8)}`,
      when: span(s.first, s.last),
      usdText: usdText(s.usd),
      tokensText: compactText(s.tokens),
    })),
    sessionCount: sessions.length,
  };
}

/** Pasted-image markers say nothing about the task. */
function cleanTitle(text) {
  return String(text ?? "").replace(/\[Image #\d+\]\s*/g, "").trim() || String(text ?? "");
}

export function deriveCosts(rows, { catalog, overrides, labels, options = {}, today, live = null }) {
  const price = pricer(catalog ?? { rates: [] }, overrides ?? { models: {}, plans: [] });
  const firstDay = rows.reduce((min, row) => (!min || row.day < min ? row.day : min), null);
  const range = costRange(options.period ?? "month", Number(options.offset) || 0, today, firstDay);
  const previous = previousRange(range, today, firstDay);
  const project = options.project && options.project !== "all" ? options.project : null;
  const model = options.model && options.model !== "all" ? options.model : null;

  const chart = buckets(range);
  const chartIndex = new Map(chart.map((bucket, index) => [bucket.key, index]));
  const projects = new Map();
  const models = new Map();
  const tasks = new Map();
  const projectFacet = new Map();
  const modelFacet = new Map();
  const total = { usd: 0, tokens: 0, unpriced: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, sessions: new Set() };
  let previousUsd = 0;

  for (const row of rows) {
    const tokens = row.tokens ?? {};
    const count = sumTokens(tokens);
    if (!count) continue;
    const rate = price(row.provider, row.model, row.harness);
    let usd = 0;
    let unpriced = count;
    if (rate) ({ usd, unpriced } = estimate(tokens, rate));

    const inPrevious = previous && row.day >= previous.start && row.day <= previous.end;
    const inRange = row.day >= range.start && row.day <= range.end;
    if (!inRange && !inPrevious) continue;

    // Facets ignore their own filter so the menu always lists every choice.
    if (inRange && (!model || row.model === model)) {
      const f = group(projectFacet, row.project, () => ({}));
      f.usd += usd; f.tokens += count;
    }
    if (inRange && (!project || row.project === project)) {
      const f = group(modelFacet, row.model, () => ({ provider: row.provider }));
      f.usd += usd; f.tokens += count;
    }
    if ((project && row.project !== project) || (model && row.model !== model)) continue;
    if (inPrevious && !inRange) { previousUsd += usd; continue; }

    total.usd += usd; total.tokens += count; total.unpriced += unpriced;
    total.input += tokens.input || 0; total.output += tokens.output || 0;
    total.cacheRead += tokens.cacheRead || 0; total.cacheWrite += tokens.cacheWrite || 0;
    total.sessions.add(row.session);

    const bucket = chart[chartIndex.get(range.unit === "day" ? row.day : row.day.slice(0, 7))];
    if (bucket) { bucket.usd += usd; bucket.tokens += count; }

    const p = group(projects, row.project, () => ({ sessions: new Set() }));
    p.usd += usd; p.tokens += count; p.unpriced += unpriced; p.sessions.add(row.session);

    const m = group(models, row.model, () => ({
      model: row.model, providers: new Set(), rate, input: 0, output: 0, cacheRead: 0, cacheWrite: 0,
    }));
    m.providers.add(row.provider);
    if (!m.rate && rate) m.rate = rate;
    m.usd += usd; m.tokens += count; m.unpriced += unpriced;
    m.input += tokens.input || 0; m.output += tokens.output || 0;
    m.cacheRead += tokens.cacheRead || 0; m.cacheWrite += tokens.cacheWrite || 0;

    // A task is a ticket when the session names one, else the session itself.
    const label = labels?.sessions?.[row.session];
    const ticket = label?.tickets?.[0];
    const taskKey = ticket ? `ticket:${row.project}:${ticket}` : row.session;
    const t = group(tasks, taskKey, () => ({
      label: ticket ? (label?.name ? `${ticket} · ${label.name}` : ticket) : labelText(label, row.session),
      prompt: ticket && label?.prompt ? label.prompt : "",
      ticket: ticket ?? null,
      project: row.project,
      harness: row.harness,
      sessions: new Set(),
      models: new Map(),
      first: row.day,
      last: row.day,
      breakdown: newBreakdown(),
    }));
    addToBreakdown(t.breakdown, row, usd, count);
    t.usd += usd; t.tokens += count; t.unpriced += unpriced; t.sessions.add(row.session);
    t.models.set(row.model, (t.models.get(row.model) ?? 0) + usd);
    if (row.day < t.first) t.first = row.day;
    if (row.day > t.last) t.last = row.day;
  }

  const share = (usd) => (total.usd > 0 ? usd / total.usd : 0);
  const byUsd = (a, b) => b.usd - a.usd || b.tokens - a.tokens;
  const sessions = total.sessions.size;
  const taskList = [...tasks.values()].sort(byUsd);
  const plans = overrides?.plans ?? [];
  const planMonthly = plans.reduce((sum, plan) => sum + plan.usdPerMonth, 0);
  const planUsd = planMonthly * range.months;

  const change = previous && previousUsd > 0 ? (total.usd - previousUsd) / previousUsd : null;
  const perMonth = range.months > 0 ? total.usd / range.months : total.usd;
  const longPeriod = range.period === "all" || range.period === "year";
  const maxBucket = chart.reduce((max, b) => Math.max(max, b.usd), 0);
  const labelStep = chart.length > 16 ? 5 : 1;
  const when = catalog?.fetchedAt ? new Date(catalog.fetchedAt) : null;

  const prevName = previous ? (range.period === "30d" ? "the 30 days before" : previous.name) : null;
  let note = "";
  if (change !== null && Math.abs(change) >= 0.01) note = `${Math.abs(Math.round(change * 100))}% ${change > 0 ? "more" : "less"} than ${prevName}`;
  else if (change !== null) note = `About the same as ${prevName}`;
  else if (range.period === "all") note = `${usdText(perMonth)} a month ${range.name}`;
  note = note ? note[0].toUpperCase() + note.slice(1) : "";

  return {
    version: 3,
    live: liveCosts(rows, live, price, labels),
    hero: {
      value: usdText(total.usd),
      tip: `${usdText(total.usd, true)} at API list price`,
      title: range.period === "all" ? "All time" : range.period === "30d" ? "Last 30 days" : range.label,
      note,
      empty: total.tokens === 0 ? `Nothing used in ${range.name}. Try another period.` : null,
      stats: [
        { value: intText(tasks.size), unit: tasks.size === 1 ? "task" : "tasks", tip: `${intText(sessions)} sessions` },
        { value: usdText(tasks.size ? total.usd / tasks.size : 0), unit: "per task", tip: "API value divided by tasks" },
        ...(longPeriod ? [{ value: usdText(perMonth), unit: "a month", tip: `Average over ${Math.round(range.months)} months` }] : []),
        {
          value: compactText(total.tokens),
          unit: "tokens",
          tip: `in ${intText(total.input)} · out ${intText(total.output)} · cache read ${intText(total.cacheRead)} · cache write ${intText(total.cacheWrite)}${total.unpriced > 0 ? ` · ${intText(total.unpriced)} without a list price` : ""}`,
        },
      ],
      plan: planMonthly > 0 ? `Your plans cost ${usdText(planUsd)} in this period, so they saved you ${usdText(total.usd - planUsd)}.` : null,
    },
    range: { period: range.period, start: range.start, end: range.end, label: range.label, unit: range.unit, offset: Number(options.offset) || 0 },
    filters: { project: project ?? "all", model: model ?? "all" },
    chart: {
      title: range.unit === "day" ? "Per day" : "Per month",
      first: chart[0]?.tip ?? "",
      last: chart[chart.length - 1]?.tip ?? "",
      peak: maxBucket > 0 ? `peak ${usdText(maxBucket)}` : "",
      bars: chart.map((b, index) => ({
        ratio: maxBucket > 0 ? b.usd / maxBucket : 0,
        peak: maxBucket > 0 && b.usd === maxBucket,
        value: maxBucket > 0 && b.usd === maxBucket ? usdText(b.usd) : "",
        label: index % labelStep === 0 ? b.label : "",
        tip: `${b.tip} · ${usdText(b.usd)} · ${compactText(b.tokens)} tokens`,
      })),
    },
    projects: [...projects.entries()].map(([value, p]) => ({
      value, name: projectLabel(value), detail: value, usd: p.usd, share: share(p.usd),
      usdText: usdText(p.usd), tokensText: compactText(p.tokens),
    })).sort((a, b) => b.usd - a.usd).slice(0, 30),
    projectCount: intText(projects.size),
    models: [...models.values()].sort(byUsd).slice(0, 30).map((m) => {
      const providers = [...m.providers].join(", ");
      const rate = m.rate;
      return {
        value: m.model,
        name: rate ? m.model : `${m.model} · unpriced`,
        detail: rate
          ? `${providers} · $${rateText(rate.input * 1e6)} in / $${rateText(rate.output * 1e6)} out${rate.cacheRead !== undefined ? ` / $${rateText(rate.cacheRead * 1e6)} cached` : ""} per 1M (${rate.id})`
          : `${providers} · no list price`,
        usd: m.usd, share: share(m.usd), usdText: usdText(m.usd), tokensText: compactText(m.tokens),
      };
    }),
    modelCount: intText(models.size),
    tasks: taskList.slice(0, 20).map((t) => {
      const days = t.first === t.last ? dayText(t.first) : `${dayText(t.first)} – ${dayText(t.last)}`;
      const top = [...t.models.entries()].sort((a, b) => b[1] - a[1])[0]?.[0] ?? "unknown";
      const title = cleanTitle(t.ticket ? (t.prompt || t.label.replace(`${t.ticket} · `, "")) : t.label);
      return {
        detail: breakdownDetail(t.breakdown, { title: cleanTitle(t.prompt || t.label), ticket: t.ticket, project: t.project, usd: t.usd, tokens: t.tokens }),
        ticket: t.ticket,
        title,
        tip: t.prompt || t.label,
        meta: [projectLabel(t.project), top, days, t.sessions.size > 1 ? `${t.sessions.size} sessions` : null].filter(Boolean),
        projectPath: t.project,
        usdText: usdText(t.usd),
        tokensText: `${compactText(t.tokens)} tok`,
      };
    }),
    tasksNote: `${intText(tasks.size)} in ${range.label}`,
    facets: {
      project: [...projectFacet.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 80)
        .map(([value, f]) => ({ value, label: projectLabel(value), meta: usdText(f.usd) })),
      model: [...modelFacet.entries()].sort((a, b) => b[1].usd - a[1].usd).slice(0, 80)
        .map(([value, f]) => ({ value, label: value, detail: f.provider, meta: usdText(f.usd) })),
    },
    footnote: [
      `Prices are OpenRouter list prices${when ? ` from ${MONTHS[when.getMonth()]} ${when.getDate()}` : ""}, the same ones pi-usage uses. Tokens with no list price are left out, not guessed.`,
      "Sessions that mention the same ticket count as one task. Set your own prices or plans in Settings or prices.json.",
    ],
  };
}
