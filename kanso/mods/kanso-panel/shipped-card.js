// Shipped's share card, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
//
// The panel's global numbers as a card for share.js: the hero, the totals,
// the streak with its year of contributions, the records and when you ship.
// No repository or machine names, so nothing private leaves with it.
import { postText } from "./share.js";

// The post's words: the numbers that brag best.
export function shareText(s, extra) {
  const parts = [];
  if (s.big) parts.push(`${s.big} ${s.byDay ? "contributions" : "lines shipped"} ${s.period.toLowerCase()}`);
  const merged = s.stats.find((x) => x.unit === "pull requests merged");
  if (merged && merged.value !== "—" && merged.value !== "0") parts.push(`${merged.value} pull requests merged`);
  if (extra.streak > 1) parts.push(`a ${extra.streak}-day streak`);
  return postText(parts, "What I shipped.");
}

// The card spec. `s` is the panel's summary; `extra`: { streak, longest,
// weeks (the calendar), records [{ name, value, unit, detail }], rhythm { hours, note } }.
export function shippedSpec(s, extra) {
  const blocks = [
    { kind: "streak", title: "Streak", right: `longest ${extra.longest} ${extra.longest === 1 ? "day" : "days"}`,
      n: extra.streak, unit: extra.streak === 1 ? "day in a row" : "days in a row", weeks: extra.weeks },
    { kind: "list", title: "Records", rows: extra.records ?? [] },
  ];
  if (extra.rhythm) blocks.push({ kind: "bars", title: "When you ship", right: extra.rhythm.note, values: extra.rhythm.hours, ticks: ["00", "06", "12", "18", "23"] });
  return {
    title: "Shipped",
    right: [s.login ? `@${s.login}` : "", s.period].filter(Boolean).join("  ·  "),
    hero: { big: s.big, small: s.small, label: s.label, delta: s.delta === null || s.delta === undefined ? null : { up: s.delta >= 0, text: s.deltaText } },
    stats: s.stats,
    note: s.everText,
    blocks,
  };
}
