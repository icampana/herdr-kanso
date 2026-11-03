// share.js is one file used by two mods. Herdr loads a mod's files from its
// own folder only, so kanso-panel/share.js (the one you edit) is copied into
// every other mod that shares. `--check` fails instead when a copy differs.
import { readFile, writeFile } from "node:fs/promises";

const mods = new URL("../kanso/mods/", import.meta.url);
const SOURCE = "kanso-panel/share.js";
export const COPIES = ["kanso-spend/share.js"];

const check = process.argv.includes("--check");
const source = await readFile(new URL(SOURCE, mods), "utf8");
let stale = 0;
for (const copy of COPIES) {
  const target = new URL(copy, mods);
  const current = await readFile(target, "utf8").catch(() => null);
  if (current === source) continue;
  if (check) { console.error(`${copy} differs from ${SOURCE}: run npm run sync:share`); stale += 1; }
  else { await writeFile(target, source); console.log(`copied ${SOURCE} to ${copy}`); }
}
process.exit(stale ? 1 : 0);
