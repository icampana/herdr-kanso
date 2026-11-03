// Sample data for screenshots and trying the panel without any sessions:
// create `data/kanso-spend/demo` (any content) and refresh. Nothing here is
// read from disk; delete the file to go back to your own sessions.

const PROJECTS = ["/work/web-app", "/work/api-server", "/work/mobile", "/work/docs", "/work/infra"];
const MODELS = [
  { harness: "claude", provider: "anthropic", model: "claude-opus-5-5" },
  { harness: "claude", provider: "anthropic", model: "claude-sonnet-5-5" },
  { harness: "codex", provider: "openai", model: "gpt-6-sol" },
  { harness: "pi", provider: "xai", model: "grok-4.7" },
  { harness: "pi", provider: "minimax", model: "MiniMax-M3" },
];
const TASKS = [
  ["WEB-142", "Add rate limiting to the public API"],
  [null, "Migrate the billing page to the new design system"],
  ["MOB-88", "Fix the login crash on Android 15"],
  [null, "Write the onboarding guide for new contributors"],
  ["OPS-31", "Move the staging cluster to the new region"],
  [null, "Refactor the search indexer into a worker"],
  ["WEB-150", "Dark mode for the settings screen"],
  [null, "Investigate the flaky checkout tests"],
  ["API-77", "Paginate the audit log endpoint"],
  [null, "Upgrade the build to Node 22"],
];

// A small deterministic generator so every screenshot looks the same.
function random(seed) {
  let x = seed >>> 0;
  return () => {
    x = (x * 1664525 + 1013904223) >>> 0;
    return x / 2 ** 32;
  };
}

const pad = (n) => String(n).padStart(2, "0");

/** Rows shaped like snapshotRows(), labels shaped like labels.json, live like liveSessions(). */
export function demoData(today) {
  const [year, month, dayOfMonth] = today.split("-").map(Number);
  const next = random(42);
  const rows = [];
  const labels = { version: 0, sessions: {} };
  const live = new Map();
  let session = 0;
  for (let back = 75; back >= 0; back -= 1) {
    const date = new Date(year, month - 1, dayOfMonth - back);
    const day = `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
    const sessionsToday = 1 + Math.floor(next() * 4);
    for (let i = 0; i < sessionsToday; i += 1) {
      session += 1;
      const id = `demo:${session}`;
      const taskIndex = Math.floor(next() * TASKS.length);
      const task = TASKS[taskIndex];
      const project = PROJECTS[taskIndex % PROJECTS.length];
      const model = MODELS[Math.floor(next() * MODELS.length)];
      const scale = 0.3 + next() * 2.2;
      const cacheRead = Math.round(9e6 * scale);
      rows.push({
        day, session: id, harness: model.harness, provider: model.provider, model: model.model, project,
        tokens: {
          input: Math.round(1.6e5 * scale),
          output: Math.round(6e4 * scale),
          cacheRead,
          cacheWrite: model.harness === "claude" ? Math.round(cacheRead * 0.02) : 0,
          reasoning: 0,
        },
        messages: Math.round(20 * scale),
      });
      labels.sessions[id] = { prompt: task[1], tickets: task[0] ? [task[0]] : [] };
      if (back === 0 && i < 2) live.set(id, Date.now() - i * 4 * 60 * 1000);
    }
  }
  for (const row of rows) row.tokens.total = row.tokens.input + row.tokens.output + row.tokens.cacheRead + row.tokens.cacheWrite;
  return { rows, labels, live };
}
