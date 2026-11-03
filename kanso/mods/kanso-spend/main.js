// Spend, by jlopezlira (https://github.com/jlopezlira/herdr-kanso). Apache-2.0.
// Part of Kanso since 1.5.0; it was the separate herdr-token-spend mod, and
// the first start moves that mod's data (data/token-spend) here.
//
// Spend: what your AI coding sessions cost at API list price, per model,
// project and task. Native view only: Node (presenter.mjs) scans, prices and
// formats; this view keeps the small result and lays it out.
//
// QuickJS runs every step under a time limit, so nothing heavy happens here:
// the payload is ~35 KB of ready-made strings, and render builds < 100 rows.
import { View, div, svg } from "gpui-kit";
import { v_flex, h_flex, Button, Popover, Input, InputState } from "gpui-base";
import { exec, appHome, home, theme, nextCommand, readTextFile, writeTextFile, layout } from "herdr";
import { G, H, R, T, tokens, toggleSwitch, controlInput } from "./ui.js";
import { Share } from "./share.js";
import { spendSpec, spendText } from "./spend-card.js";

// The folder name: change it here if you install the mod under another name.
const MOD = "kanso-spend";
const RUNTIME_FILE = `mods/${MOD}/runtime.json`;
const PRESENTER_FILE = `mods/${MOD}/presenter.mjs`;
const DATA_DIR = `data/${MOD}`;
const PAYLOAD_KIND = "kanso-spend-costs";
const PAYLOAD_VERSION = 1;
const STEP_TIMEOUT_MS = 35_000;
const TICK_MS = 15_000;
const REFRESH_MS = 60_000;
const LIVE_REFRESH_MS = 30_000;
const LIST_ROWS = 6;
const TASK_ROWS = 8;

// ---------------------------------------------------------------------------
// Helpers

function sanitizeError(error) {
  const raw = error && typeof error === "object" ? (error.message ?? error.error ?? "") : String(error ?? "");
  const text = String(raw).replace(/\s+/g, " ").trim() || "Unknown error";
  return text.length > 300 ? `${text.slice(0, 297)}…` : text;
}

function resultError(result) {
  const text = String(result?.stderr ?? "").trim() || String(result?.stdout ?? "").trim();
  if (!text) return `The collector stopped with code ${result?.code ?? "?"}.`;
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
  const errorLine = lines.find((line) => /^(?:[A-Za-z][\w.]*Error|Error|error|token-spend|kanso-spend):/.test(line));
  return sanitizeError(errorLine || lines.find((line) => !/^at\s/.test(line)) || text);
}

function parseRuntimeNode(raw) {
  const config = JSON.parse(raw);
  const node = typeof config?.node === "string" ? config.node.trim() : "";
  if (!node || /[\u0000-\u001f\u007f]/.test(node)) throw new Error("runtime.json needs a node path.");
  return node;
}

function projectName(value) {
  const text = String(value ?? "").replace(/[\\/]+$/, "");
  return text.split(/[\\/]/).pop() || text || "Unknown project";
}

function findNode(node, id) {
  if (node?.id === id) return node;
  for (const child of node?.children ?? []) {
    const found = findNode(child, id);
    if (found) return found;
  }
  return null;
}

/**
 * True when this mod's block is in the layout but not on screen: under a
 * hidden node, or in a stack showing another child. Herdr keeps such a copy
 * alive (and its timers running), so the view checks before doing any work.
 */
function hiddenInLayout() {
  try {
    const path = [];
    const walk = (node) => {
      path.push(node);
      if (node?.content?.mod === MOD) return true;
      for (const child of node?.children ?? []) if (walk(child)) return true;
      path.pop();
      return false;
    };
    if (!walk(layout())) return false; // a pane or overlay: shown whenever it runs
    return path.some((node, index) => node.hidden
      || (node.type === "stack" && node.active && path[index + 1] && node.active !== path[index + 1].id));
  } catch {
    return false;
  }
}

function formatTime(iso) {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  return `${String(date.getHours()).padStart(2, "0")}:${String(date.getMinutes()).padStart(2, "0")}`;
}

/** Text tabs: the selected one is full-tone text, the rest recede. */
function quietTabs(id, items, value, onChange, c) {
  return h_flex().id(id).flex_wrap().gap(G.lg).items_center()
    .children(items.map((item, index) => {
      const selected = value === item.key;
      return Button.new(`${id}-${item.key}`).h(H.compact).items_center().cursor_pointer()
        .selected(selected)
        .set_position(index + 1, items.length)
        .accessibility_label(item.label)
        .when(!selected, (el) => el.hover((style) => style.opacity(0.7)))
        .focus((style) => style.opacity(0.7))
        .on_click((_event, cx) => {
          if (!selected) onChange(item.key, cx);
        })
        .child(div().text_size(13).text_color(selected ? c.text : c.dim).when(selected, (el) => el.font_medium()).child(item.label));
    }));
}

/** A text-only action for choices that should not compete with the numbers. */
function quietLink(id, label, onClick, c, options = {}) {
  const disabled = Boolean(options.disabled);
  return Button.new(id).h(H.compact).items_center().cursor_pointer()
    .disabled(disabled)
    .accessibility_label(options.label ?? label)
    .when(!disabled, (el) => el.hover((style) => style.opacity(0.7)))
    .focus((style) => style.opacity(0.7))
    .on_click((_event, cx) => { if (!disabled) onClick(cx); })
    .child(div().text_size(options.size ?? 12).text_color(disabled ? c.border : c.mutedForeground).child(label));
}

// ---------------------------------------------------------------------------

export default class TokenSpend extends View {
  init(_props, cx) {
    this.closed = false;
    this.width = 960;
    this.nodeBinary = null;
    this.runtimeError = null;
    this.runtimeTask = null;
    this.scan = null;
    this.costs = null;
    this.share = new Share(MOD, `${appHome()}/${DATA_DIR}`);
    this.error = null;
    this.running = null; // "snapshot" | "prepare" | null
    this.queued = { snapshot: false, prepare: false };
    this.generation = 0;
    this.task = null;
    this.watchdog = null;
    this.continueTimer = null;
    this.lastSnapshotAt = 0;
    this.cost = { period: "month", offset: 0, project: "all", model: "all" };
    this.expanded = {};
    this.page = "home"; // "home" | "settings"
    this.stack = []; // detail views: { kind: "project" | "model" | "task", label, value?, task?, prevCost? }
    this.settings = null;
    this.planInputs = [];
    this.settingsNote = null;
    this.openMenu = null;
    this.menuOptions = null;

    this.ticker = null;
    this.awake = false;

    // On demand: Herdr starts this copy the first time it shows. From then on
    // it works only while visible; hidden, it stops its timer and lets go of
    // its data, and the panel button wakes it again (`kanso-spend.open`).
    if (!hiddenInLayout()) this.wake(cx);

    this.commandTask = cx.spawn(async (commandCx) => {
      for (;;) {
        let command;
        try {
          command = await nextCommand();
        } catch {
          break;
        }
        const name = String(command).replace(new RegExp(`^${MOD}\\.`), "");
        if (name === "refresh") this.run("snapshot", commandCx);
        else if (name === "open") this.wake(commandCx);
        else if (name === "settings") this.openSettings(commandCx);
        else if (name === "back") this.back(commandCx);
      }
    });
  }

  /** Shown: load what is missing, then keep fresh while visible. */
  wake(cx) {
    if (this.closed) return;
    this.awake = true;
    if (!this.ticker) {
      this.ticker = cx.timer.every(TICK_MS, (tickCx) => {
        if (hiddenInLayout()) {
          this.sleep();
          return;
        }
        // Live sessions are followed every 30 s; otherwise once a minute.
        const every = this.costs?.live?.length ? LIVE_REFRESH_MS : REFRESH_MS;
        if (Date.now() - this.lastSnapshotAt >= every) this.run("snapshot", tickCx);
      });
    }
    if (!this.nodeBinary && !this.runtimeError) {
      if (this.runtimeTask) return;
      this.runtimeTask = cx.spawn(async (runtimeCx) => {
        try {
          // Once: the separate token-spend mod's data, so its history carries over.
          await exec("sh", ["-c", 'if [ ! -e "$2/store.json" ] && [ -d "$1" ]; then mkdir -p "$2" && cp -R "$1/." "$2/" && rm -rf "$2"/*.lock; fi', "sh",
            `${appHome()}/data/token-spend`, `${appHome()}/${DATA_DIR}`]).catch(() => null);
          this.nodeBinary = parseRuntimeNode(await readTextFile(`${appHome()}/${RUNTIME_FILE}`));
        } catch (error) {
          this.runtimeError = `Spend needs ${RUNTIME_FILE} with the path to Node 22: ${sanitizeError(error)}`;
        }
        this.runtimeTask = null;
        if (this.closed) return;
        if (this.nodeBinary) this.run("snapshot", runtimeCx);
        runtimeCx.notify();
      });
      return;
    }
    if (Date.now() - this.lastSnapshotAt >= REFRESH_MS) this.run("snapshot", cx);
    else if (!this.costs) this.run("prepare", cx);
    cx.notify();
  }

  /** Hidden: no timer, no Node process, no data kept. */
  sleep() {
    this.awake = false;
    for (const handle of [this.ticker, this.continueTimer]) {
      try { handle?.cancel(); } catch { /* already gone */ }
    }
    this.ticker = null;
    this.continueTimer = null;
    this.costs = null;
    this.menuOptions = null;
    this.openMenu = null;
  }

  close() {
    this.closed = true;
    this.generation += 1;
    for (const handle of [this.task, this.watchdog, this.continueTimer, this.ticker, this.commandTask, this.runtimeTask]) {
      try { handle?.cancel(); } catch { /* already gone */ }
    }
  }

  options() {
    const d = new Date();
    const today = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
    return { today, cost: { ...this.cost } };
  }

  /**
   * One presenter call at a time. A request made while another runs is
   * queued (a scan wins over a re-price), so filters never race a refresh.
   */
  run(command, cx, extra = null) {
    if (this.closed || !this.nodeBinary) return;
    if (this.running) {
      if (command === "configure") this.queuedSources = extra;
      this.queued[command === "configure" ? "snapshot" : command] = true;
      return;
    }
    const generation = ++this.generation;
    const sent = this.options();
    this.running = command;
    if (command === "snapshot") this.lastSnapshotAt = Date.now();
    cx.notify();

    try { this.watchdog?.cancel(); } catch { /* already gone */ }
    this.watchdog = cx.timer.after(STEP_TIMEOUT_MS, (timerCx) => {
      if (generation !== this.generation) return;
      this.generation += 1;
      try { this.task?.cancel(); } catch { /* already gone */ }
      this.finish(timerCx, "Spend took too long to answer. It will try again shortly.");
    });

    this.task = cx.spawn(async (taskCx) => {
      let failure = null;
      let payload = null;
      try {
        const result = await exec(this.nodeBinary, [
          `${appHome()}/${PRESENTER_FILE}`, command,
          "--store", `${appHome()}/${DATA_DIR}/store.json`,
          "--home", home(),
          "--options", JSON.stringify(sent),
          ...(command === "configure" ? ["--sources", JSON.stringify(extra ?? {})] : []),
        ]);
        if (result.code !== 0) throw new Error(resultError(result));
        payload = JSON.parse(String(result.stdout ?? ""));
        if (payload?.kind !== PAYLOAD_KIND || payload.version !== PAYLOAD_VERSION || !payload.costs) {
          throw new Error("Spend got an answer it does not understand. Reload the panel.");
        }
      } catch (error) {
        failure = sanitizeError(error);
      }
      if (generation !== this.generation || this.closed) return;
      if (payload) {
        this.scan = payload.scan ?? this.scan;
        if (this.awake) this.costs = payload.costs;
        if (payload.settings) this.settings = payload.settings;
        // Filters changed while this ran: price again with the current ones.
        if (JSON.stringify(sent.cost) !== JSON.stringify(this.cost)) this.queued.prepare = true;
      }
      this.finish(taskCx, failure);
    });
  }

  finish(cx, failure) {
    try { this.watchdog?.cancel(); } catch { /* already gone */ }
    this.watchdog = null;
    this.task = null;
    this.running = null;
    this.error = failure;
    if (!this.closed) {
      if (this.queued.snapshot) {
        this.queued = { snapshot: false, prepare: false };
        const sources = this.queuedSources;
        this.queuedSources = null;
        if (sources) this.run("configure", cx, sources);
        else this.run("snapshot", cx);
      } else if (this.queued.prepare) {
        this.queued.prepare = false;
        this.run("prepare", cx);
      } else if (this.scan?.partial && !failure && this.awake) {
        // The first scan is time-boxed; keep going until it has read everything.
        try { this.continueTimer?.cancel(); } catch { /* already gone */ }
        this.continueTimer = cx.timer.after(1000, (timerCx) => {
          this.continueTimer = null;
          this.run("snapshot", timerCx);
        });
      }
    }
    cx.notify();
  }

  setCost(patch, cx) {
    this.cost = { ...this.cost, ...patch };
    this.run("prepare", cx);
    cx.notify();
  }

  // -------------------------------------------------------------------------
  // Navigation: Home -> project / model / task, each with a way back.

  openDetail(kind, item, cx) {
    this.openMenu = null;
    if (kind === "task") {
      this.stack = [...this.stack, { kind, label: item.title, task: item }];
      cx.notify();
      return;
    }
    const entry = { kind, label: kind === "project" ? projectName(item.value) : item.value, value: item.value, prevCost: { ...this.cost } };
    this.stack = [...this.stack, entry];
    this.setCost({ [kind]: item.value }, cx);
  }

  back(cx) {
    if (this.page === "settings") {
      this.page = "home";
      cx.notify();
      return;
    }
    const top = this.stack[this.stack.length - 1];
    if (!top) return;
    this.stack = this.stack.slice(0, -1);
    if (top.prevCost) this.setCost({ project: top.prevCost.project, model: top.prevCost.model }, cx);
    else cx.notify();
  }

  openSettings(cx) {
    this.page = "settings";
    this.settingsNote = null;
    // Inputs need a live host call: build them here, never in render.
    this.planInputs = (this.settings?.plans ?? []).map((plan) => ({
      name: InputState.new({ value: plan.name, placeholder: "Plan" }),
      amount: InputState.new({ value: String(plan.usdPerMonth), placeholder: "0" }),
    }));
    cx.notify();
  }

  addPlan(cx) {
    this.planInputs = [...this.planInputs, {
      name: InputState.new({ placeholder: "ChatGPT Pro, Claude Max…" }),
      amount: InputState.new({ placeholder: "200" }),
    }];
    cx.notify();
  }

  removePlan(index, cx) {
    this.planInputs = this.planInputs.filter((_, i) => i !== index);
    cx.notify();
  }

  /** Plans live in prices.json next to the store; other keys there are kept. */
  savePlans(cx) {
    const file = this.settings?.pricesPath ?? `${appHome()}/${DATA_DIR}/prices.json`;
    const plans = this.planInputs
      .map((input) => ({ name: input.name.value().trim(), usdPerMonth: Number(String(input.amount.value()).replace(/[^0-9.]/g, "")) }))
      .filter((plan) => plan.name && Number.isFinite(plan.usdPerMonth) && plan.usdPerMonth > 0);
    this.settingsNote = "Saving…";
    cx.notify();
    cx.spawn(async (saveCx) => {
      try {
        const before = await readTextFile(file);
        let data = {};
        try { data = before ? JSON.parse(before) : {}; } catch { data = {}; }
        data.plans = plans;
        await writeTextFile(file, `${JSON.stringify(data, null, 2)}\n`, before);
        this.settingsNote = plans.length ? `Saved ${plans.length} ${plans.length === 1 ? "plan" : "plans"}.` : "Saved. No plans.";
        this.run("prepare", saveCx);
      } catch (error) {
        this.settingsNote = `Could not save: ${sanitizeError(error)}`;
      }
      saveCx.notify();
    });
  }

  toggleSource(id, enabled, cx) {
    if (this.settings) {
      this.settings = { ...this.settings, sources: this.settings.sources.map((s) => (s.id === id ? { ...s, enabled } : s)) };
    }
    this.run("configure", cx, { [id]: enabled });
    cx.notify();
  }

  // -------------------------------------------------------------------------
  // Render

  render(cx) {
    // Shown again without the button (a space switch restored the panel):
    // wake on the next tick, outside this render pass.
    if (!this.awake && !this.closed && !this.waking && !hiddenInLayout()) {
      this.waking = true;
      cx.timer.after(0, (wakeCx) => {
        this.waking = false;
        if (!hiddenInLayout()) this.wake(wakeCx);
      });
    }
    const c = tokens(theme());
    const narrow = (this.width || 960) < 560;
    const top = this.stack[this.stack.length - 1];
    let body;
    if (this.page === "settings") body = this.settingsView(c);
    else if (top?.kind === "task") body = this.taskView(c, top.task, narrow);
    else body = this.costs?.hero ? this.costsView(c, narrow, top) : this.waitingView(c, narrow);
    return v_flex().id("spend-root").size_full().min_h(0).bg(c.canvas).text_color(c.text)
      .overflow_y_scrollbar()
      .on_size_change((size, sizeCx) => {
        const changed = Math.abs((this.width || 0) - size.width) >= 1;
        this.width = size.width;
        if (changed) sizeCx.notify();
      })
      .child(h_flex().w_full().justify_center().px(narrow ? G.lg : 32).py(narrow ? G.lg : 28)
        .child(v_flex().w_full().max_w(1080).gap(narrow ? 32 : 44)
          .child(this.header(c, narrow))
          .when(this.share.open && this.canShare(), (el) => el.child(this.share.row(c, () => this.shareCard(),
            "Only the totals and the days: no project, task or session names. The post opens with the image in it.", G.sm)))
          .child(body)));
  }

  // Only the unfiltered totals are shared, so a filter or a detail view hides it.
  canShare() {
    return this.page === "home" && !this.stack.length && Boolean(this.costs?.hero?.value)
      && this.cost.project === "all" && this.cost.model === "all";
  }

  shareCard() {
    return { spec: spendSpec(this.costs), text: spendText(this.costs), name: `spend-${this.costs.range?.label ?? "now"}`, title: "Spend" };
  }

  iconButton(id, icon, tip, onClick, c, options = {}) {
    const glyph = svg(`mods/${MOD}/icons/${icon}.svg`).size(15).text_color(options.active ? c.text : c.mutedForeground);
    return Button.new(id).size(26).flex_none().items_center().justify_center().rounded(R.control).cursor_pointer()
      .accessibility_label(tip)
      .tooltip(tip)
      .when(!options.disabled, (el) => el.hover((style) => style.bg(c.subtle)))
      .focus((style) => style.bg(c.subtle))
      .on_click((_event, cx) => { if (!options.disabled) onClick(cx); })
      .child(options.spin ? glyph.spin(900) : glyph);
  }

  header(c, narrow) {
    const busy = Boolean(this.running);
    const updated = this.scan?.lastScanAt ? `Updated ${formatTime(this.scan.lastScanAt)}` : "";
    const reading = this.running !== "prepare" && busy && this.scan?.partial
      ? `Reading sessions, ${this.scan.processed} of ${this.scan.total}` : "";
    const tip = busy ? "Updating…" : updated ? `Refresh · ${updated}` : "Refresh";
    const top = this.stack[this.stack.length - 1];
    const inner = this.page === "settings" || Boolean(top);
    const title = this.page === "settings" ? "Settings" : top ? top.label : "Spend";
    const crumb = this.page === "settings" ? "" : top ? ({ project: "Project", model: "Model", task: "Task" })[top.kind] : "";
    return h_flex().w_full().items_center().justify_between().gap(G.md)
      .child(h_flex().flex_1().min_w(0).items_center().gap(G.sm)
        .when(inner, (el) => el.child(this.iconButton("spend-back", "back", "Back", (cx) => this.back(cx), c)))
        .child(v_flex().flex_1().min_w(0).gap(1)
          .when(Boolean(crumb), (el) => el.child(div().text_size(11).text_color(c.dim).child(crumb)))
          .child(div().truncate().text_size(inner ? (narrow ? 15 : 17) : (narrow ? 17 : 20)).text_color(c.text).tooltip(title).child(title))))
      .child(h_flex().gap(G.xs).items_center().flex_none()
        .when(Boolean(reading), (el) => el.child(div().pr(G.xs).text_size(11).text_color(c.dim).child(reading)))
        .when(this.canShare(), (el) => el.child(this.iconButton("spend-share", "share", "Share", (cx) => this.share.toggle(cx), c, { active: this.share.open })))
        .child(this.iconButton("spend-refresh", "refresh", tip, (cx) => this.run("snapshot", cx), c, { spin: busy, active: busy, disabled: busy }))
        .when(this.page !== "settings", (el) => el.child(this.iconButton("spend-settings", "settings", "Settings", (cx) => this.openSettings(cx), c))));
  }

  /**
   * The loader is the view's own silhouette: where the figure, the chart and
   * the rows will be, in the faintest tone, breathing slowly while it loads.
   * One native loop on the whole shape, and only while it is drawn.
   */
  skeleton(c, narrow) {
    const block = (w, h, radius = 3) => div().w(w).h(h).flex_none().rounded(radius).bg(c.border);
    const heights = [18, 26, 22, 40, 64, 92, 48, 52, 36, 44, 20, 38, 70, 50, 42, 46, 28, 34, 58, 30, 44, 24, 14, 10, 8, 8, 6, 6, 6, 6, 8];
    const row = (i) => h_flex().w_full().items_center().gap(G.md).py(9)
      .child(block([120, 96, 140, 84, 110, 72][i % 6], 9))
      .child(div().flex_1())
      .child(block(48, 11));
    return v_flex().w_full().gap(narrow ? 36 : 48)
      .loop("opacity", { from: 0.35, to: 0.8, period: 1800 })
      .child(h_flex().w_full().gap(G.lg).items_center()
        .children([44, 52, 34, 52].map((w) => block(w, 10))))
      .child(v_flex().gap(G.md)
        .child(block(110, 12))
        .child(block(narrow ? 170 : 250, narrow ? 40 : 58, 6))
        .child(block(170, 11))
        .child(h_flex().gap(narrow ? G.xl : 48).pt(G.md).children([46, 64, 58].map((w) => block(w, narrow ? 18 : 22, 4)))))
      .child(h_flex().w_full().h(150).items_end()
        .children(heights.map((h) => v_flex().flex_1().min_w(0).items_center().justify_end().child(block(2, h, 1)))))
      .child(v_flex().w_full()
        .child(h_flex().pb(G.sm).child(block(70, 12)))
        .children([0, 1, 2, 3, 4].map(row)));
  }

  waitingView(c, narrow) {
    const failed = this.runtimeError || (this.error && !this.running);
    if (!failed) {
      const scan = this.scan;
      return v_flex().w_full().gap(G.lg)
        .when(Boolean(scan?.partial), (el) => el.child(div().text_size(12).text_color(c.dim)
          .child(`Reading your history for the first time: ${scan.processed} of ${scan.total} files.`)))
        .child(this.skeleton(c, narrow));
    }
    const scan = this.scan;
    const title = failed ? "Spend could not read your sessions." : "Adding up your sessions";
    const detail = failed ? (this.runtimeError || this.error)
      : scan?.partial ? `First read: ${scan.processed} of ${scan.total} files. This happens once.` : "This takes a second.";
    return v_flex().w_full().gap(G.sm)
      .child(div().text_size(15).text_color(failed ? c.destructive : c.mutedForeground).child(title))
      .child(div().text_size(12).text_color(c.dim).child(detail))
      .when(Boolean(failed) && !this.runtimeError, (el) => el.child(h_flex().pt(G.xs)
        .child(quietLink("spend-retry", "Try again", (cx) => this.run("snapshot", cx), c))));
  }

  costsView(c, narrow, top = null) {
    const data = this.costs;
    // Inside a project, list its models; inside a model, its projects.
    const lists = [
      top?.kind === "project" ? null : this.list(c, "Projects", `${data.projectCount} projects`, data.projects, "project"),
      top?.kind === "model" ? null : this.list(c, "Models", `${data.modelCount} models`, data.models, "model"),
    ].filter(Boolean);
    const wide = (this.width || 960) >= 860;
    return v_flex().w_full().gap(narrow ? 36 : 48)
      .opacity(this.running === "prepare" ? 0.55 : 1)
      .when(Boolean(this.error) && !this.running, (el) => el.child(h_flex().w_full().gap(G.md).items_center()
        .child(div().flex_1().min_w(0).text_size(12).text_color(c.destructive).truncate().tooltip(this.error)
          .child(`Last update failed: ${this.error}`))
        .child(quietLink("spend-retry-inline", "Try again", (cx) => this.run("snapshot", cx), c))))
      .child(this.controls(c, Boolean(top)))
      .child(this.hero(c, data.hero, narrow))
      .when(!data.hero.empty, (el) => el
        .child(this.chart(c, data.chart))
        .when(!top && Array.isArray(data.live) && data.live.length > 0, (live) => live.child(this.live(c, data.live)))
        .child(wide
          ? h_flex().w_full().gap(56).items_start().children(lists.map((list) => div().flex_1().min_w(0).max_w(lists.length === 1 ? 560 : 10_000).child(list)))
          : v_flex().w_full().gap(narrow ? 36 : 48).children(lists))
        .child(this.tasks(c, data)))
      .child(v_flex().w_full().gap(2).children(data.footnote.map((line) => div().text_size(T.small).text_color(c.dim).child(line))));
  }

  controls(c, inDetail = false) {
    const filtered = !inDetail && (this.cost.project !== "all" || this.cost.model !== "all");
    const label = [
      this.cost.project !== "all" ? projectName(this.cost.project) : null,
      this.cost.model !== "all" ? this.cost.model : null,
    ].filter(Boolean).join(" and ");
    return v_flex().w_full().gap(G.md)
      .child(h_flex().w_full().flex_wrap().gap_x(G.lg).gap_y(G.sm).items_center().justify_between()
        .child(quietTabs("ins-period", [
          { key: "month", label: "Month" },
          { key: "30d", label: "30 days" },
          { key: "year", label: "Year" },
          { key: "all", label: "All time" },
        ], this.cost.period, (key, cx) => this.setCost({ period: key, offset: 0 }, cx), c))
        .when(!inDetail, (row) => row.child(h_flex().gap(G.lg).items_center()
          .child(this.menu("project", c))
          .child(this.menu("model", c)))))
      .when(filtered, (el) => el.child(h_flex().gap(G.md).items_center()
        .child(div().text_size(12).text_color(c.mutedForeground).child(`Showing ${label}`))
        .child(quietLink("ins-clear", "Show everything", (cx) => this.setCost({ project: "all", model: "all" }, cx), c))));
  }

  menu(field, c) {
    const value = this.cost[field];
    const facet = this.costs.facets?.[field] ?? [];
    const allLabel = field === "project" ? "All projects" : "All models";
    const shown = value === "all" ? allLabel : (facet.find((entry) => entry.value === value)?.label ?? projectName(value));
    const id = `ins-menu-${field}`;
    const trigger = Button.new(`${id}-trigger`).h(H.compact).gap(6).items_center().cursor_pointer()
      .accessibility_label(`${field === "project" ? "Project" : "Model"}: ${shown}`)
      .hover((style) => style.opacity(0.75))
      .focus((style) => style.opacity(0.75))
      .child(div().max_w(170).truncate().text_size(12).text_color(value === "all" ? c.mutedForeground : c.text).child(shown))
      .child(div().text_size(10).text_color(c.dim).child("⌄"));
    const popover = Popover.new(id).trigger(trigger)
      .open(this.openMenu === id)
      .on_open_change((open, cx) => {
        this.openMenu = open ? id : null;
        // Options are built in this event, never in the render pass.
        this.menuOptions = open ? [
          { value: "all", label: allLabel, detail: "", meta: "" },
          ...facet.map((entry) => ({
            value: entry.value,
            label: entry.label,
            detail: entry.detail ?? (field === "project" ? entry.value : ""),
            meta: entry.meta,
          })),
        ] : null;
        cx.notify();
      });
    if (this.openMenu === id && this.menuOptions) {
      popover.content(v_flex().w(260).max_h(340).overflow_y_scrollbar().p(G.xs).gap(1).rounded(R.card)
        .bg(c.popover).border_1().border_color(c.border)
        .children(this.menuOptions.map((option, index) => {
          const selected = option.value === value;
          return Button.new(`${id}-option-${index}`).w_full().px(8).py(5).gap(G.sm).items_center().rounded(R.control)
            .cursor_pointer()
            .selected(selected)
            .set_position(index + 1, this.menuOptions.length)
            .when(selected, (el) => el.bg(c.selected))
            .when(!selected, (el) => el.hover((style) => style.bg(c.subtle)))
            .focus((style) => style.bg(c.selected))
            .accessibility_label(option.label)
            .on_click((_event, cx) => {
              this.openMenu = null;
              this.menuOptions = null;
              this.setCost({ [field]: option.value }, cx);
            })
            .child(v_flex().flex_1().min_w(0).gap(1)
              .child(div().text_size(12).text_color(c.text).truncate().child(option.label))
              .when(Boolean(option.detail), (el) => el.child(div().text_size(10).text_color(c.dim).truncate().child(option.detail))))
            .child(div().text_size(11).text_color(c.dim).child(option.meta ?? ""));
        })));
    }
    return popover;
  }

  hero(c, hero, narrow) {
    const offset = this.cost.offset || 0;
    const stepper = this.cost.period !== "all";
    return v_flex().w_full().gap(G.xl)
      .child(v_flex().gap(G.xs)
        .child(h_flex().gap(G.md).items_center()
          .child(div().text_size(15).text_color(c.mutedForeground).child(hero.title))
          .when(stepper, (el) => el
            .child(quietLink("ins-older", "‹", (cx) => this.setCost({ offset: offset - 1 }, cx), c, { size: 16, label: "Previous period" }))
            .child(quietLink("ins-newer", "›", (cx) => this.setCost({ offset: Math.min(0, offset + 1) }, cx), c, {
              size: 16, label: "Next period", disabled: offset >= 0,
            }))
            .when(offset < 0, (row) => row.child(quietLink("ins-now", "Back to now", (cx) => this.setCost({ offset: 0 }, cx), c)))))
        .child(h_flex().flex_wrap().items_end().gap_x(G.md)
          .child(div().text_size(narrow ? 48 : 72).line_height(1).font_light().text_color(c.text).tooltip(hero.tip).child(hero.value))
          .child(div().pb(narrow ? 6 : 10).text_size(13).text_color(c.dim).child("API value")))
        .when(Boolean(hero.note), (el) => el.child(div().text_size(15).text_color(c.dim).child(hero.note)))
        .when(Boolean(hero.empty), (el) => el.child(div().text_size(15).text_color(c.mutedForeground).child(hero.empty)))
        .when(Boolean(hero.plan), (el) => el.child(div().text_size(13).text_color(c.mutedForeground).child(hero.plan)))
        .when(Boolean(this.scan?.partial), (el) => el.child(div().text_size(12).text_color(c.dim)
          .child(`Still reading your history: ${this.scan.processed} of ${this.scan.total} files so far.`))))
      .when(!hero.empty, (el) => el.child(h_flex().w_full().flex_wrap().gap_x(narrow ? G.xl : 48).gap_y(G.lg)
        .children(hero.stats.map((stat) => h_flex().items_end().gap(6).tooltip(stat.tip)
          .child(div().text_size(narrow ? 22 : 28).line_height(1).font_light().text_color(c.text).child(stat.value))
          .child(div().pb(3).text_size(12).text_color(c.dim).child(stat.unit))))));
  }

  chart(c, chart) {
    const height = 132;
    return v_flex().w_full().gap(G.sm)
      .child(h_flex().w_full().items_end()
        .children(chart.bars.map((bar) => v_flex().flex_1().min_w(0).h(height + 18).items_center().justify_end().gap(4)
          .tooltip(bar.tip)
          .when(bar.peak, (el) => el.child(div().text_size(10).text_color(c.text).whitespace_nowrap().child(bar.value)))
          .child(div().w(bar.peak ? 3 : 2).flex_none().rounded_t(1)
            .h(bar.ratio > 0 ? Math.max(3, Math.round(bar.ratio * height)) : 1)
            .bg(bar.peak ? c.accent : bar.ratio > 0 ? c.mutedForeground : c.border)
            .opacity(bar.peak || bar.ratio === 0 ? 1 : 0.55)))))
      .child(h_flex().w_full().justify_between()
        .child(div().text_size(10).text_color(c.dim).child(chart.first))
        .child(div().text_size(10).text_color(c.dim).child(chart.title))
        .child(div().text_size(10).text_color(c.dim).child(chart.last)));
  }

  list(c, title, count, items, field) {
    const selected = this.cost[field];
    const open = Boolean(this.expanded[field]);
    const shown = open ? items : items.slice(0, LIST_ROWS);
    return v_flex().w_full().gap(G.xs)
      .child(h_flex().w_full().items_end().justify_between().pb(G.sm)
        .child(div().text_size(15).text_color(c.text).child(title))
        .child(div().text_size(12).text_color(c.dim).child(count)))
      .when(items.length === 0, (el) => el.child(div().text_size(12).text_color(c.dim).child("Nothing here in this period.")))
      .children(shown.map((item, index) => {
        const active = selected === item.value;
        return Button.new(`ins-${field}-${index}`).w_full().py(7).cursor_pointer()
          .hover((style) => style.opacity(0.75))
          .focus((style) => style.opacity(0.75))
          .accessibility_label(`${item.name}, ${item.usdText}`)
          .on_click((_event, cx) => this.openDetail(field, item, cx))
          .child(h_flex().w_full().items_end().gap(G.md)
            .child(div().flex_1().min_w(0).truncate().text_size(13)
              .text_color(active || selected === "all" ? c.text : c.mutedForeground)
              .when(active, (name) => name.font_medium())
              .tooltip(item.detail).child(item.name))
            .child(div().text_size(11).text_color(c.dim).child(item.tokensText))
            .child(div().min_w(64).text_right().text_size(15).font_light().text_color(c.text).child(item.usdText)));
      }))
      .when(items.length > LIST_ROWS, (el) => el.child(h_flex().pt(G.sm)
        .child(quietLink(`ins-${field}-more`, open ? "Show fewer" : `Show ${items.length - LIST_ROWS} more`, (cx) => {
          this.expanded = { ...this.expanded, [field]: !open };
          cx.notify();
        }, c))));
  }

  /** One task or session: what it cost, in what, and when. */
  taskView(c, d, narrow) {
    const section = (title, note) => h_flex().w_full().items_end().justify_between().pb(G.sm)
      .child(div().text_size(15).text_color(c.text).child(title))
      .child(div().text_size(12).text_color(c.dim).child(note ?? ""));
    const row = (name, sub, usd, tokens, index) => h_flex().w_full().items_end().gap(G.md).py(7)
      .when(index > 0, (el) => el.border_t(1).border_color(c.border))
      .child(v_flex().flex_1().min_w(0).gap(2)
        .child(div().truncate().text_size(13).text_color(c.text).child(name))
        .when(Boolean(sub), (el) => el.child(div().text_size(11).text_color(c.dim).child(sub))))
      .child(div().text_size(11).text_color(c.dim).child(tokens))
      .child(div().min_w(64).text_right().text_size(15).font_light().text_color(c.text).child(usd));
    return v_flex().w_full().gap(narrow ? 36 : 44)
      .child(v_flex().w_full().gap(G.sm)
        .when(Boolean(d.ticket), (el) => el.child(div().text_size(12).font_medium().text_color(c.mutedForeground).child(d.ticket)))
        .child(div().w_full().text_size(15).line_height(1.45).text_color(c.text).child(d.title))
        .child(h_flex().w_full().flex_wrap().gap_x(G.md).gap_y(2)
          .children([d.project, d.tools, d.when].filter(Boolean).map((part) => div().text_size(12).text_color(c.dim).child(part)))))
      .child(v_flex().gap(G.xl)
        .child(h_flex().flex_wrap().items_end().gap_x(G.md)
          .child(div().text_size(narrow ? 44 : 60).line_height(1).font_light().text_color(c.text).tooltip(`${d.usdExact} at API list price`).child(d.usdText))
          .child(div().pb(narrow ? 5 : 8).text_size(13).text_color(c.dim).child("API value")))
        .child(h_flex().w_full().flex_wrap().gap_x(narrow ? G.xl : 40).gap_y(G.lg)
          .children(d.parts.map((part) => v_flex().gap(4)
            .child(div().text_size(narrow ? 20 : 24).line_height(1).font_light().text_color(c.text).child(part.value))
            .child(div().text_size(11).text_color(c.dim).child(part.label))))))
      .child(v_flex().w_full()
        .child(section("Models", `${d.models.length}`))
        .children(d.models.map((m, index) => row(m.name, "", m.usdText, m.tokensText, index))))
      .child(v_flex().w_full()
        .child(section("Sessions", d.sessionCount > d.sessions.length ? `top ${d.sessions.length} of ${d.sessionCount}` : `${d.sessionCount}`))
        .children(d.sessions.map((s, index) => row(s.name, s.when, s.usdText, s.tokensText, index))))
      .child(h_flex().gap(G.lg)
        .child(quietLink("ins-task-project", `Open ${d.project}`, (cx) => this.openDetail("project", { value: d.projectPath }, cx), c)));
  }

  settingsView(c) {
    const s = this.settings;
    const section = (title, note) => v_flex().w_full().gap(4).pb(G.md)
      .child(div().text_size(15).text_color(c.text).child(title))
      .when(Boolean(note), (el) => el.child(div().text_size(12).text_color(c.dim).child(note)));
    const busy = this.running === "configure" || (this.running === "snapshot" && this.queuedSources);
    return v_flex().w_full().gap(44)
      .child(v_flex().w_full()
        .child(section("Sources", "Where Spend reads your sessions. Turning one off removes it from every number."))
        .when(!s, (el) => el.child(div().text_size(12).text_color(c.dim).child("Loading…")))
        .children((s?.sources ?? []).map((source, index) => h_flex().w_full().items_center().gap(G.md).py(G.sm)
          .when(index > 0, (el) => el.border_t(1).border_color(c.border))
          .child(v_flex().flex_1().min_w(0).gap(2)
            .child(div().text_size(13).text_color(source.enabled ? c.text : c.mutedForeground).child(source.label))
            .child(div().truncate().text_size(11).text_color(c.dim).tooltip(source.roots).child(source.roots)))
          .child(toggleSwitch(`ins-source-${source.id}`, source.enabled, (next, cx) => this.toggleSource(source.id, next, cx), c, {
            label: `${source.label}: ${source.enabled ? "on" : "off"}`,
          }))))
        .when(Boolean(busy), (el) => el.child(div().pt(G.sm).text_size(11).text_color(c.dim).child("Updating sources…"))))
      .child(v_flex().w_full()
        .child(section("Plans", "What you pay each month. Spend subtracts it from the API value to show what your plans save you."))
        .children(this.planInputs.map((input, index) => h_flex().w_full().items_center().gap(G.sm).py(4)
          .child(div().flex_1().min_w(0).child(controlInput(Input.new(input.name).w_full(), c)))
          .child(div().text_size(12).text_color(c.dim).child("$"))
          .child(div().w(84).flex_none().child(controlInput(Input.new(input.amount).w_full(), c)))
          .child(div().text_size(11).text_color(c.dim).child("/ mo"))
          .child(this.iconButton(`ins-plan-remove-${index}`, "close", "Remove plan", (cx) => this.removePlan(index, cx), c))))
        .child(h_flex().w_full().gap(G.lg).items_center().pt(G.sm)
          .child(quietLink("ins-plan-add", "Add plan", (cx) => this.addPlan(cx), c))
          .child(quietLink("ins-plan-save", "Save plans", (cx) => this.savePlans(cx), c))
          .when(Boolean(this.settingsNote), (el) => el.child(div().text_size(11).text_color(c.dim).child(this.settingsNote)))))
      .child(v_flex().w_full()
        .child(section("Prices", null))
        .child(div().text_size(12).line_height(1.5).text_color(c.mutedForeground)
          .child("Claude models use Anthropic's list prices, Claude Code with its 1-hour cache writes. Other models use the OpenRouter catalog, refreshed once a day; tokens without a list price are left out, not guessed."))
        .child(div().pt(G.sm).text_size(11).text_color(c.dim).child(`Your own per-model prices: "models" in ${s?.pricesPath ?? `${DATA_DIR}/prices.json`}`)))
      .child(v_flex().w_full()
        .child(section("Updates", null))
        .child(div().text_size(12).line_height(1.5).text_color(c.mutedForeground)
          .child("While this panel is open: every minute, or every 30 seconds while a session is active. Closed, Spend does nothing.")));
  }

  /** Sessions being written right now, this conversation included. */
  live(c, sessions) {
    return v_flex().w_full()
      .child(h_flex().w_full().items_center().gap(G.sm).pb(G.sm)
        .child(div().size(6).flex_none().rounded_full().bg(c.accent).loop("opacity", { from: 0.35, to: 1, period: 2400 }))
        .child(div().text_size(15).text_color(c.text).child("Active now")))
      .children(sessions.map((s, index) => Button.new(`ins-live-${index}`).w_full().cursor_pointer()
        .hover((style) => style.opacity(0.75))
        .focus((style) => style.opacity(0.75))
        .accessibility_label(`${s.title}, ${s.usdText}`)
        .on_click((_event, cx) => this.openDetail("task", s.detail, cx))
        .child(h_flex().w_full().items_center().gap(G.lg).py(G.sm)
        .when(index > 0, (el) => el.border_t(1).border_color(c.border))
        .child(v_flex().flex_1().min_w(0).gap(3)
          .child(h_flex().w_full().gap(G.sm).items_end()
            .when(Boolean(s.ticket), (el) => el.child(div().flex_none().text_size(12).font_medium().text_color(c.mutedForeground).child(s.ticket)))
            .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(c.text).tooltip(s.tip).child(s.title)))
          .child(h_flex().w_full().flex_wrap().gap_x(G.md).children(s.meta.map((part) => div().text_size(11).text_color(c.dim).whitespace_nowrap().child(part)))))
        .child(v_flex().items_end().gap(2).flex_none()
          .child(div().text_size(17).font_light().text_color(c.text).child(s.usdText))
          .child(div().text_size(11).text_color(c.dim).child(s.tokensText))))));
  }

  tasks(c, data) {
    const open = Boolean(this.expanded.tasks);
    const shown = open ? data.tasks : data.tasks.slice(0, TASK_ROWS);
    return v_flex().w_full()
      .child(h_flex().w_full().items_end().justify_between().pb(G.md)
        .child(div().text_size(15).text_color(c.text).child("Tasks"))
        .child(div().text_size(12).text_color(c.dim).child(data.tasksNote)))
      .children(shown.map((task, index) => Button.new(`ins-task-${index}`).w_full().py(G.md).cursor_pointer()
        .border_t(1).border_color(c.border)
        .hover((style) => style.opacity(0.75))
        .focus((style) => style.opacity(0.75))
        .accessibility_label(`${task.title}, ${task.usdText}`)
        .on_click((_event, cx) => this.openDetail("task", task.detail, cx))
        .child(h_flex().w_full().items_center().gap(G.lg)
          .child(v_flex().flex_1().min_w(0).gap(4)
            .child(h_flex().w_full().gap(G.sm).items_end()
              .when(Boolean(task.ticket), (el) => el.child(div().flex_none().text_size(12).font_medium().text_color(c.mutedForeground).child(task.ticket)))
              .child(div().flex_1().min_w(0).truncate().text_size(13).text_color(c.text).tooltip(task.tip).child(task.title)))
            .child(h_flex().w_full().flex_wrap().gap_x(G.md).children(task.meta.map((part) => div().text_size(11).text_color(c.dim).whitespace_nowrap().child(part)))))
          .child(v_flex().items_end().gap(2).flex_none()
            .child(div().text_size(17).font_light().text_color(c.text).child(task.usdText))
            .child(div().text_size(11).text_color(c.dim).child(task.tokensText))))))
      .when(data.tasks.length > TASK_ROWS, (el) => el.child(h_flex().pt(G.md).border_t(1).border_color(c.border)
        .child(quietLink("ins-tasks-more", open ? "Show fewer" : `Show ${data.tasks.length - TASK_ROWS} more`, (cx) => {
          this.expanded = { ...this.expanded, tasks: !open };
          cx.notify();
        }, c))));
  }
}
