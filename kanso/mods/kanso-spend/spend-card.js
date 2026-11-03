// Spend's share card, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// The panel's global numbers as a card for share.js: what your AI work is
// worth at list price, the tasks, the tokens, how many projects and models,
// and the period day by day. Never a project, task or session name: only the
// totals of the unfiltered view are shared.
import { postText } from "./share.js";

const plain = (s) => String(s ?? "").trim();

// The card spec, from the presenter's costs (the unfiltered view).
export function spendSpec(costs) {
  const hero = costs.hero ?? {};
  const stats = (hero.stats ?? []).map((x) => ({ value: plain(x.value), unit: plain(x.unit) }));
  if (costs.projectCount) stats.push({ value: plain(costs.projectCount), unit: costs.projectCount === "1" ? "project" : "projects" });
  if (costs.modelCount) stats.push({ value: plain(costs.modelCount), unit: costs.modelCount === "1" ? "model" : "models" });
  const note = plain(hero.note);
  const chart = costs.chart;
  return {
    title: "Spend",
    right: plain(costs.range?.label ?? hero.title),
    hero: { big: plain(hero.value) || "—", label: "of AI work at API list price", delta: /more/i.test(note) ? { up: true, text: note } : null }, // a brag: only a rise
    stats,
    note: hero.plan ? plain(hero.plan) : "",
    blocks: chart?.bars?.length ? [{
      kind: "bars", title: plain(chart.title), right: plain(chart.peak),
      values: chart.bars.map((b) => (Number.isFinite(b.ratio) ? b.ratio : 0)),
      ticks: [plain(chart.first), plain(chart.last)].filter(Boolean),
    }] : [],
  };
}

// The post's words.
export function spendText(costs) {
  const hero = costs.hero ?? {};
  const parts = [];
  const when = plain(costs.range?.label ?? hero.title);
  if (hero.value) parts.push(`${plain(hero.value)} of AI work at list price${when ? ` in ${when}` : ""}`);
  for (const x of hero.stats ?? []) if (/^(tasks?|tokens)$/.test(plain(x.unit))) parts.push(`${plain(x.value)} ${plain(x.unit)}`);
  return postText(parts, "What my AI work is worth.");
}
