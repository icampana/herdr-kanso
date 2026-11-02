# Kanso

Kanso is a quiet Herdr layout for long days with coding agents. Warm stone
greys, no outlines, no decoration: the selected pane's header is a shade
lighter and its title the only text in full ink, and color appears only when
an agent's state matters (working, needs you, finished). Its second idea is that nothing you aren't looking at runs:
side panels exist only while open, and background checks slow down when the
window is behind others. Its third is an endless strip of panes: a new pane
opens beside the focused one at its own
width, nothing shrinks, and the view slides to it. The name is the Japanese
principle of simplicity, removing what is not needed.

![Kanso](preview.png)

## What you see

Left to right, then top to bottom. Sizes are px at zoom 1.

- **Sidebar**, theme `chrome` (`#161615` dark, `#e3dfd6` light).
  - **Top strip**, 48 tall: the macOS traffic lights (at `[12, 16]`) and,
    at its right end (14 in), Herdr's mark: its icon
    (`frame/welcome/herdr.png`, 20, radius 6) and "Herdr" (13, semibold,
    `foreground`), so you know what you're in. It drags the window.
    Collapsed, the strip is empty and the mark sits lower, over the rail's
    buttons.
  - **Spaces** (`kanso-spaces`), filling the middle.
    - Open (256 wide): a 40-tall row with a + (New space) at the left, and
      Search and Hide sidebar at the right. Each is a 32 square with a 17 icon
      in `muted` that turns `foreground` on hover over a `foreground`+`12`
      wash.
    - Space rows are 32 tall with radius 6. Each starts with a 22 avatar
      (radius 6): the name's first letter, semibold 12, in the space's color
      over that color at alpha `26`. Then come the name (13, medium when
      active) and, right-aligned, the repo, branch and ahead/behind counts in
      11.5.
    - The active space has a `foreground`+`14` wash; hover shows
      `foreground`+`0c`.
    - Worktree spaces nest under their repo on 1px `input` guide lines.
    - A space's agents are listed under it in 28-tall rows: program icon 15,
      title 12.5, status mark at the right. The focused agent is in full ink
      over a `foreground`+`0c` wash; the others are `muted`, and idle ones
      `dim`.
    - Collapsed (76 wide): only the + and Hide buttons, stacked, then one
      centred 32 square per space holding its avatar. A 7 dot sits at its
      top-right corner when the space is blocked or done. The name shows in
      a tooltip.
  - **Footer** (`kanso-chrome`, `footer: true`), 156 tall, bottom-aligned:
    - Settings (gear) and Add machine (server icon), 34 tall, icon 17.
    - An 8 space.
    - An account chip: a 32 avatar (28 when collapsed) with the home folder
      name's first letter, then the name and "N agents".
    - Collapsed, each item is a centred square with its label as a tooltip.
      When an app update is ready, a 6 `accent` dot shows on Settings.
- **Corners**: two radii and nothing else. Surfaces (panes, cards, popovers,
  menus) are 8; controls and rows (buttons, tabs, list rows, tiles, chips,
  fields) are 6; dots are circles.
- **Work area**, padding 6, gap 4, on `chrome`. No card and no lines: the
  panes are `background` slabs with radius 8 on the frame, 6 apart, and
  that 6 gutter is where Herdr's own dividers are dragged.
    - **Tab bar** (`kanso-tabs`), 48 tall, no line under it. It drags the
      window.
      - Tabs are 26 tall with radius 6: program icon 15, name 12.5, then the
        tab's status. The active tab has a `foreground`+`12` wash and the
        rest are `muted`, with no borders and no tray behind them. A close x
        (13) shows on the active tab only when there is more than one tab.
      - After the tabs, a + (16 icon, 28 square) opens the shipped
        `new-menu`.
      - At the right are the panel buttons: Files, Insights, Changes, PR
        and Specs. They are ghost buttons 26 tall (icon 15, text 12) with a wash
        when their panel is open. Insights and Specs show only when their
        mods are installed.
    - **Panes**: an endless canvas (`kanso-strip`). Panes sit side by side
      in columns. You choose how many fit in the view at once, 1 to 8
      (default 2): a new column takes 1/n of it, so on a wide screen you can
      hold 3, 4 or more side by side. A lone pane fills the view. Every header ends in a
      six-dot grip (14 icon, `dim`, `foreground` on hover or while held,
      grab cursor), 6 from the edge. The header's top corners round with
      the slab's (8). Resizing is Herdr's own: drag the 6
      gutter between two columns sideways, or between two stacked panes up
      and down (a column never goes under 140 px, a stacked pane under 90).
      Once the drag has rested 250 ms, the strip reads the sizes back from
      the layout and its ruler blocks (one under each terminal, 8 tall,
      for its width, which also draws the slab's rounded bottom since a
      terminal paints square corners; one 1px wide at the end of work-body
      for the height) and keeps them as
      shares, so later trees keep what you dragged. The view always starts at a
      column's edge and shows only whole, live panes: as many as fit, which
      then share the width by their weights. It never slides past the first
      start from which the rest of the row fits. When columns lie beyond an
      edge, a 28-wide edge rail stands there in `chrome` (`hover` on hover),
      so it reads as frame, not pane. At its middle, a ‹ or › (14, `muted`)
      over a stack of 20 tiles (`input`, rounded 6, 5 apart, up to 8 then
      "+N"), one per pane beyond in row order, each with its program icon
      (12, `muted` when tinted) and, at its top-right corner, its state (a 7
      dot: breathing `working`, breathing `blocked`, `done`; none when the
      program reports nothing). Resting the pointer on the stack (350 ms)
      opens a card beside it (220 wide, `chrome`, a soft shadow, rounded
      9): "N panes beyond the left edge" (11, `dim`) and a 26-tall row per
      pane with its icon, its name (12.5) and its state dot. A click on a
      tile or a row brings that pane in; a click on the bare rail brings in
      the nearest one.
      Off-screen columns aren't drawn. A split down stacks a pane
      under the focused one in the same column; stacked panes share the
      column's height equally until you drag the gutter between them
      (evening out resets that). Panes never move vertically: dragging one out
      of a stack makes it its own column. A tab holding a mod pane falls back to
      Herdr's own split view.
      A column can be pinned (the header's pin button on hover, "Pin pane"
      in the right-click menu, Cmd+Alt+P). It stays on the side of the view
      it was on, always whole and at its width, and never changes place:
      dragging it, moving it, dropping a pane on it and new panes leave it
      where it is. The rest slides in what the pinned columns leave (never
      under 20% of the view; a pin that would leave less is refused). A
      pinned header has the `accent` at 14% (25% when selected) and a 12 px
      pin by the title; it has no grip.
      Each pane has a 34-tall header (a `{pane}` copy of `kanso-strip`,
      always shown). The
      selected pane's header has the `selected` background (in the strip, the
      pane the strip remembers, so it stays marked while a side panel has the
      keyboard). A pane whose agent needs you has `blocked` at 40% instead,
      a 2px `blocked` bar along the header's bottom breathing between 45% and
      full (1.6 s), its title in full ink, and "Needs you" in `foreground`
      after a breathing dot.
      - Program icon 15 (75% opacity when unfocused) and the title, 12.5 in
        `foreground` and medium weight when focused, `muted` otherwise.
      - The folder (`~/...`) and branch (with a branch glyph) as plain 11.5
        text.
      - At the right, the pane's status. On hover the status gives way to
        open with (a terminal pane only), split right, split down, zoom and
        close (15 icons).
      - Terminal padding is `[14, 10]`.
    - **Side panel**, at the right of the panes: 368 wide (280 to 900),
      hidden by default. It holds whichever panel is open: `kanso-panel`
      told `files`, `changes` or `pr` (`props.panel`), `token-spend`
      (Insights) or `sdd-focused`.
      The PR panel (`kanso-panel` with `pr`) shows one pull request at a time: the focused
      pane's branch's own, as T3 Code does, else the newest open one in that repository
      ("the newest open; <branch> has none" after its author and age), drawn like the Spend panel: one
      centered column (max 1080, 16 px sides under 560 wide, else 32), no
      cards or uppercase labels, `canvas` behind, hierarchy from size, weight
      and tone, hairlines between list rows. Top to bottom:
      - Header: "Pull request" (17, 20 when wide), then at the right a
        hairline pill "N open" with a chevron, refresh (spins while reading)
        and open on GitHub. The pill is hidden when the only open one is the
        one shown.
      - The page of open ones: the pill turns the panel to it (the title
        reads "Open pull requests", the pill "Back to #n"); it scrolls with
        the panel, as a popover's layer did not. The repository's open pull
        requests (`gh pr list --state open`, by anyone) under section titles
        with a count: This branch, Yours, Others. A row reads as the hero in
        small: the whole title (14, wraps; medium and on `selected` with
        "Shown" at the right when shown), then `#n · author ("you") · updated
        <age>` (11.5, dim), then a 6 dot and its state in its color (draft,
        checks failing, changes requested, checks running, approved, waiting
        for a review, checks passed) and `+a −d`. A click shows it and leaves
        the page; the branch's own goes back to following the branch. When
        the branch has none, the page ends with "Create one for <branch>".
        Every `gh pr` action names the pull request by URL.
      - Hero: `#n · head → base` (15, muted); the title (22, 28 wide, light,
        line height 1.25); a 6 dot and the verdict (15): ready to merge
        (green), checks failing, conflicts or changes requested (red),
        checks running or waiting for a review (yellow, breathing), draft
        (dim), merged (`ansi5`), closed (red); author and age (12, dim).
        Then light numbers (22/28) with 12 dim units: files, added, removed,
        threads, checks. Then, while open, a 30-tall primary Merge button
        (`solid`; a second press within 4 s merges with the first method the
        repository allows; red while armed; disabled while draft,
        conflicting or blocked) and quiet links Ready for review or Back to
        draft, and Close. A closed PR offers Reopen.
      - People and labels, as T3 Code's meta rows: a 76-wide dim label,
        the values, and at the right a 22 icon button that opens T3 Code's
        candidate picker (a popover 288 wide: a search field, then the
        candidates with a check on those applied; a click applies or takes
        one back through GitHub's REST API and the picker stays open; a
        breathing silhouette while it reads; a note when the repository has
        more than 100). Assignees (with "Assign to me" when you aren't),
        Reviewers (who reviewed with the outcome, then who is still asked;
        the author is never offered) and Labels (chips in the label's own
        color at 15% with a dot of it). Candidates come from GraphQL
        `assignableUsers` (GitHub's own picker list, readable without push
        access) and the repository's labels, as in T3 Code.
      - Checks (when there are any): failing first, 5 shown, "Show N more";
        a row opens the check's page.
      - Unresolved threads (when there are any): the first comment, then
        path:line, author, replies, outdated; a row opens it on GitHub.
      - Ask your agent: Explain it, Address feedback (open PRs), Resolve
        conflicts (only when conflicting), as quiet links. Each opens a tab
        named `#<n> <task>` in the repository, running the first installed
        agent (`knownAgents`) with T3 Code's task prompt as its first message.
      - Files: name (13) over folder and add/delete mark (11, dim), +/- at the
        right; 8 shown, "Show N more"; a row shows its diff inline (first 400
        lines, monospace, in a hairline box).
      - A footnote (10.5, dim): read from GitHub with gh, when.
      - Loading is the view's silhouette in `border` tone, breathing between
        35% and 80%. Without a PR: "No pull request for <branch>." and
        "Create it on GitHub" (the web form, once the branch has an
        upstream). Errors read the same way, with "Try again". Outside a git
        repository it is a place, not a failure: "No repository here" in
        `muted`, no retry.
  - **Status bar**, 26 tall: `kanso-status` with `{side: "left"}`, a
    180-wide minimap (`kanso-strip`) exactly in the middle, and
    `kanso-status` with `{side: "right"}`. The minimap is a centred row of
    soft pills, one per column (6 + 18 x its share wide, 4 tall, gap 3, no
    frame): `muted` in view, `input` off-screen,
    `foreground` focused; a stacked column shows one 2px bar per pane. Click a pill to go there. After the pills, a tiny
    "− n +" control: fewer or more panes per view, and the number itself
    evens the columns out to 1/n.
    `kanso-status`, text 11.5 `muted`:
    - At the left, the machine (monitor or server icon, "This computer") and
      the branch.
    - At the right, "N agent(s) need you" in `blocked` with a dot (only when
      some agent is blocked), then a dot and "X of N working" (or "N agents
      idle" / "No agents"), then the palette shortcut "⌘⇧P" with the tooltip
      "Command palette".
- **Themes**: `kanso` (dark) and `kanso-day` (light), in `themes/`.
  - Dark: background `#1b1b19`, foreground `#d8d4cb`, chrome and canvas
    `#161615`, border `#272725`, input `#353430`, muted `#949086`, dim
    `#6b6862`, accent `#a3b09a`, working `#c4b07e`, blocked `#c99189`, done
    `#98ad8f`.
  - Light: background `#f4f1eb`, foreground `#3c3934`, chrome `#e3dfd6`,
    working `#8f7d52`, blocked `#9a6e68`, done `#6d7d62`.
- **Icons**: one Lucide-style set in `mods/kanso-chrome/icons/`, every one
  with the same stroke (2 on a 24 grid, 1.4 on a 16 grid), so they read as
  one family.

## How it behaves

- **Agent status**:
  - Working: a breathing dot in `working`, a 10px glyph cycling
    `· • ● •` every 450 ms (`.frames`). It shows on the tab, in the pane
    header, on the agent row and on the status bar dot. It is never a
    spinning icon.
  - Blocked: a `blocked` dot. The pane header adds the text "Needs you",
    the status bar says "N agent(s) need you", and a collapsed space shows
    its corner dot.
  - Done: a 6 `done` dot (tab, header, corner dot).
  - Idle: a 7 ring in `idle` on agent rows, with nothing on the tab or
    header.
- **Spaces**:
  - Click a space to select it. Clicking the space you are in folds or
    unfolds its agents; the folded state is kept.
  - Drag a space to reorder it (a 2px `accent` line shows where it lands).
    Double-click a space to rename it (Herdr's `space.rename` prompt).
  - Double-click a session row to rename the terminal: the same dialog
    Herdr opens for a space or a tab (`kanso-prompt`, 420 wide, with the
    name it shows now selected; Enter saves, Esc leaves it). The name is
    the terminal's own `kanso.name` label in herdr-core (`hc label <t>
    kanso.name=<name>`; empty removes it and the automatic name is back),
    so it survives a restart and the pane header, the edge tabs and the
    drop cards show the same name. Herdr has no terminal rename of its
    own; labels are its metadata.
    Right-click opens the shipped space menu.
  - Click a session row to focus its pane. Sessions are listed as T3 Code
    lists its threads: the pinned ones first, in the order you drag them,
    then the rest in the order chosen with the order button at the top of
    the sidebar (a Popover over the list, a check on the current one,
    remembered in localStorage `spaces.order`): last update (Herdr's `seq`,
    the default, as in T3 Code), needs you first (blocked, done, working,
    idle, then last update), by kind (agents by their program, then
    shells, then the rest), as on screen (the strip's order, tab by tab,
    with the panes stacked in one column held together in one soft slab,
    `foreground` at 3%, radius 6), or your own order (drag a session where
    you want it; per space, localStorage `spaces.custom`; new sessions
    join at the end by last update). The pin is the `kanso.pin` label on
    the terminal (its number is its place; pinning adds it last among the
    pinned, a drag among the pinned renumbers them through `hc label`),
    shown always on a pinned row and on hover on the rest; a click pins or
    unpins. A drag only reorders within its section (the pinned, or your
    order) and shows a 2px `accent` line where it lands; moving a pane in
    the strip is the header grip's job.
  - Every terminal in the space is listed, not only the agents that report
    a status to Herdr: after those come the rest (Codex and other models'
    CLIs, shells, servers) with their program's icon, their title (a shell's
    folder when the title says nothing) and no status mark.
- **Sidebar**:
  - Hide sidebar collapses it to a fixed 76 rail whose edge cannot be
    dragged.
  - Open, the edge drags between 200 and 480. The width you leave is
    remembered and used the next time you open it.
- **Tabs**:
  - Click selects a tab, drag reorders, double-click renames, and
    right-click opens the shipped tab menu.
  - Scrolling over the bar moves one tab per mouse-wheel notch, or per
    trackpad swipe (about 40px of travel).
- **The strip** (keys in `keys.json`, section `layout:kanso`; in Kanso they
  replace Herdr's tab keys, since the canvas is where you move):
  - Cmd+1 to Cmd+9 go to that pane; Cmd+[ and Cmd+] go to the previous and
    next one. The view glides to it (eases over about 0.3 s).
  - Cmd+D opens a pane to the right, Cmd+Alt+D to the left, Cmd+Shift+D
    below (stacked in the same column). The new pane is focused. The header's
    split buttons and the right-click menu do the same.
  - Cmd+W closes the focused pane. Cmd+Shift+[ and Cmd+Shift+] move it left
    and right. Cmd+Shift+Enter (or the header's zoom button) cycles its width
    1/4, 1/3, 1/2, 2/3, 1.
  - Cmd+Shift+- and Cmd+Shift+= show fewer or more panes per view (every
    column becomes 1/n, the focused one stays in view); Cmd+Shift+0 evens
    the columns out at the current count. `kanso-strip.per-N` sets N directly.
  - Cmd+Alt+Up/Down (or K/J) move the focus within a stacked column.
  - Kept as alternatives: Cmd+Alt+Left/Right or H/L (focus), with Shift
    (move), Cmd+Alt+1-9, Cmd+Alt+Home/End, Cmd+Alt+C (centre). There is no
    vertical move; those keys go to the program.
  - The wheel or a swipe over any pane header or the minimap slides the view
    one column per quarter view of travel (600px per view width) without
    moving the focus; if the focused pane leaves the view, the keyboard
    moves to the nearest pane still in view. Cmd+Alt+, and Cmd+Alt+. slide
    one column. Clicking an edge tab or a minimap mark slides to that pane.
  - Hold a header's six-dot grip (or Ctrl+drag the header) and drag onto
    another pane to move the pane. While a pane is held the strip is
    sorting: every pane's terminal gives its place to a drop card (a
    `kanso-strip` copy with `{drop: pane}`; the terminal lives on, the tree
    just stops showing it), so the whole pane takes the drop, not only its
    34px header. The card shows the pane's icon and name in `muted`,
    centered; the held pane's own card and header are at 40%. Over a card
    the pointer names a side: the left and right quarters mean a column of
    its own before or after that pane, the middle stacks it above (upper
    half) or below (lower half); the header counts as the pane's top (its
    middle means above) and the foot as its bottom (below). That side is
    shared `strip.drop` `{to, side}`, and header, card and foot draw from
    it: the half the held pane will take fills with `accent` at 25% and
    carries the held pane's icon and name in full ink, the resident's name
    steps to the other half, and the header's matching half (or all of it,
    for above) is washed the same. Any number of panes can stack; the 90px
    minimum height is the only limit. The edge tabs light in the accent too
    (brighter under the pointer): dropping there puts the pane just beyond
    that edge. Letting go on the held pane itself, the sidebar, the tab bar
    or the minimap moves nothing; a pane let go on a gutter stays held
    until the next press, or 12 s, then goes back. When the hold ends the
    terminals return and the keyboard goes back to the strip's focused pane.
- **Side panels, on demand**:
  - Clicking a panel button rewrites the panel stack to hold only that
    panel's block and shows it. Clicking it again, or closing the panel any
    other way, empties the stack. Herdr then ends that mod, and its timers,
    file watches and processes stop.
  - The open panel is remembered per space and restored when you switch
    spaces.
  - Files, Changes and PR are idle whenever they aren't the shown panel.
    PR rereads every minute while shown, every 20 s while a check runs.
  - The Specs count on its button shows only while Specs is open.
- **Background**:
  - While the window is behind others, the spaces list checks git every 5 s
    instead of every 0.5 s.
  - `hc machine ls` runs every 30 s with the window in front, and every
    2 min with it behind.

## Built from

- **Layout tree** (`layouts/kanso.json`), root `row`, `titlebar: "none"`,
  `traffic_lights: [12, 16]`, `resizable: true`, `terminal_menu: "kanso-menu"`:
  - `sidebar` (column, `chrome`, 256 px, min 200, max 480):
    - `brand`: block `kanso-chrome` (Herdr's mark), 48 px, `window_drag`.
    - `spaces`: block `kanso-spaces`.
    - `sidebar-footer`: block `kanso-chrome` with `{footer: true}`, 156 px.
  - `work` (column, padding 6, gap 4):
    - `inset` (column, no fill, no border):
      - `tabs`: block `kanso-tabs`, 48 px, `window_drag`.
      - `work-body` (row, `chrome` background, gap 6):
        - `main`: `{tab: "active"}` with the `kanso-strip` header (height 34),
          radius 8, gap 6 and no pane borders. `kanso-strip` replaces it with
          the canvas's columns (`strip-*` nodes, `background`, radius 8) and
          puts it back for tabs it can't show.
        - `panel-body`: stack, 368 px (280 to 900), hidden, no children.
          `kanso-tabs` mounts the open panel in it.
    - `status-row` (row, 26 px): `status` (`kanso-status` `{side: "left"}`,
      weight 1), `strip-map` (`kanso-strip`, 180 px), `status-right`
      (`kanso-status` `{side: "right"}`, weight 1).
- **Mods**:
  - `kanso-spaces`: spaces, agents (`agents.js`), git per space via `exec`,
    machines via `hc machine ls`.
  - `kanso-tabs`: tabs, panel buttons and the on-demand panel mount via
    `layout.set`.
  - `kanso-strip`: the canvas. The copy in the status row is the controller
    and minimap; copies with `{edge, side, count, panes}` draw an edge rail. State per
    tab lives in shared `strip.state` (`{cols: [{panes, w, pin, hs}], vx,
    n}`; `hs` is each stacked pane's share of the height); the last chosen
    `n` is in shared `strip.n` for new tabs. Copies with `{ruler}` are the
    1px rulers; what they measure is in shared `strip.px`.
    Headers talk to it through shared `strip.req` (scroll, move, width, pin),
    `strip.intent` (where the next new pane goes), `strip.drag` (the held
    pane) and `strip.drop` (where it would land). Copies with `{drop}` are
    the cards that stand in for terminals while a pane is held.
    A `{pane, terminal}` copy (the app passes those to a header; the strip
    adds `strip: true`) is the pane header: icon, name, folder, branch,
    status, hover buttons, the grip and the wheel. Double-click it to
    rename the terminal (the same dialog and `kanso.name` label as the
    sidebar). The header lives in the strip so that one mod owns the
    drag, the drop zones, the names and the icons; Herdr doesn't let a mod
    import another's files.
  - `kanso-prompt`: Herdr's prompt dialog, copied, for what Herdr has no
    command for. Props `{title, value, hint}` and either `command: {name,
    args}` (runs it with `name`, as Herdr's prompt) or `label: {terminal,
    key}` (`hc label <terminal> <key>=<text>`; empty removes the label).
    Opened as a dialog 420 wide.
  - `kanso-menu`: the terminal right-click menu (root `terminal_menu`):
    split right, left and down through the strip, width, right-clicks
    to the program, send back, "Open with…" (when the pane has a folder),
    close.
  - `open-with`: a popup (380 wide, at the top; 340 at the pointer from the
    menu and the header) that opens a folder in a code editor. Props
    `{folder, machine}`; without them, the focused pane's folder. With
    `{file}` (a full path; the Files panel sends it on a right-click or
    its open button) the editors open that file, and a text file (by
    extension: md, txt, json, yaml, code and the like) is offered first to
    "Preview in the panel": `kanso-panel` with `{panel: "preview", path,
    on}` mounted in `panel-body` the way kanso-tabs mounts its panels. It lists the
    editors found on this computer (macOS app folders, `command -v`, Flatpak),
    the last one used first (shared `open-with.recent`), with each app's own
    icon on macOS. Enter, 1 to 9 or a click opens; Esc leaves. Terminal
    editors open with `terminal.open {place: "right"}`. A folder on another
    machine opens over SSH in the VS Code family (`--remote ssh-remote+<machine>`)
    and Zed (`ssh://<machine>/<path>`); the rest show "local only".
    Cmd+Shift+O (`mod.open:open-with`, in `keys.json`) opens it.
  - `kanso-chrome`: the top strip's mark and the sidebar footer, plus the icon set.
  - `kanso-status`: status bar.
  - `kanso-panel`: the side panels in one mod, chosen by `props.panel`;
    each is a plain class in its own file (`files.js`: lazy file tree via
    `sh`, git status marks, a file shown in place: Markdown rendered, else
    read-only code; `changes.js`: git diff and commit; `pr.js`: the pull
    request panel, read with `gh pr view`, `gh pr diff` and one GraphQL
    query for unresolved review threads; `preview.js`: one file by full
    path, `{path, on}`, drawn the same way, read again whenever its folder
    changes, with Open with, read-again and close buttons) and `lib.js`
    holds what they share (where the focused pane is, diff rows, the two
    file renderers: `codeState` is a read-only `EditorState` in the
    terminal's font with the theme's ANSI hues, `markdownView` is the
    SDK's `TextView.markdown`, selectable, in a scrolling column with 16 px
    sides; and `showPanel`, which mounts a block in `panel-body`). A panel
    exists only while `kanso-tabs` shows it, so it never polls the layout
    to learn whether it is visible.
  - All are derived from Herdr's shipped mods (Apache-2.0) through the 0OZ
    and minimalistic forks, and all use `"place": "none"`.
- **Optional mods it can show, not included**: `sdd-focused` (Specs, by José
  Gutiérrez, from the minimalistic layout) and `insights` (cost analytics).
  When either is in `mods/`, its button appears.
- **Herdr functions**: `spaces`, `panes`, `agents`, `terminals`, `machines`,
  `layout`, `theme`, `shared`/`setShared`, `window`, `exec`, `hc`,
  `watchFolder`, `readTextFile`, `openOverlay`, `run`, `home`, `appHome`,
  `updates`.
- **Commands**: `layout.set`, `layout.resize`, `space.*`, `tab.*`, `pane.*`,
  `app.settings`, `app.palette`, `mod.open` (`picker`, `machine-add`,
  `open-with`), `terminal.open`.
- **Shipped overlays used**: `menu`, `new-menu`, `picker`, `machine-add`.
- **Programs run**: `git` (spaces, Files, Changes), `sh` (Files listing),
  `hc` (machines) and, for Open with, `sh`, `open`, `plutil` and `sips`
  (macOS) and the chosen editor. The PR panel runs `gh` (GitHub's API) and
  `git`, only while it is shown. Nothing else reaches the network.

## Watch out

- A layout may nest at most 16 levels (`layout.set` refuses deeper ones).
  Put the strip's columns directly in `work-body` (column > cell column >
  block), never inside another row.
- Herdr folds the layout on its own: empty containers go, containers with a
  single child are replaced by that child, and terminal blocks whose
  terminal ended go. Never rely on an empty column for space (use a filler
  block) or on a single-child wrapper's id. The side panel's toggle lives on
  `panel-body` itself for that reason.
- Herdr won't let a mod handle the mouse over terminal text, so a hold on a
  grip takes the terminals out of the tree for its duration and puts drop
  cards in their place: that is how the whole pane, not only its header,
  can show where the held pane lands and take the drop. Nothing tells a mod
  about a release over a gutter (no `on_mouse_up_out`), hence the
  next-press and 12 s ends. Resizing isn't a mod's drag at all: it is
  Herdr's divider, read back afterwards.
- A host argument nests at most 16 levels, and the layout tree counts each
  node and its `children` array: there is no room for a wrapper around the
  strip's columns in `work-body`, which is why the rulers sit inside the
  columns and at the row's end instead.
- A terminal block takes the keyboard on click, so `focused().pane` is null
  and implicit pane commands fail. Pass `pane` or `terminal` explicitly
  (`pane.split {pane}`, `pane.focus {terminal}`), and focus a new pane only
  once its block is in the layout.
- Herdr's own focus stays on a tab's model pane, and lands there whenever you
  come to a tab (another space or tab, a layout switch, a restart). That pane
  isn't on screen, so the keyboard would go nowhere until a click. The strip
  remembers the selected pane per tab (`focus` in "strip.state") and, when a
  model pane holds the focus, hands it to a block: the remembered pane on
  coming back, or the model pane itself when Herdr's focus moved to a new one
  (an agent notification, a closed pane). Otherwise it leaves the keyboard
  alone, so a side panel you click keeps it.
- Herdr's own terminal menu passes a terminal block's id (`term-<pane>`) as
  its target pane, so its Split and Close fail with "no pane". Kanso ships
  its own menu, which finds the real pane from the clicked terminal.
- Cap layout writes: the strip writes only when its tree changes, at most
  once every 100 ms (checked before it reads the tree, so a skipped write
  costs nothing; a burst writes its first step at once and then its latest
  state), and pauses itself for 10 s if more than 30 writes in 3 s ever get
  past that, so a mistake can't keep the window busy.
- `layout.set` replaces the whole tree, and a set that has not landed still
  reads as the old one. The strip, the tabs, the panel and the sidebar keep
  their piece in shared state and put all three back on every write, so one
  writer cannot drop another's: the strip's columns in `kanso.layout.strip`
  (`nodes`, `sizesBefore`), written by the strip alone so it never reads the
  rest back, and the panel and rail in `kanso.layout` (`panel`, `rail`).
  The strip also records `sizesBefore`: other writers preserve new native
  divider sizes while its adopt timer catches up, but replay pending strip
  width commands over the old sizes they were based on.
- On Unix, Files lists a folder with one `find -print0` and no shell: a
  directory is printed twice in a row (no name repeats in a folder), so its
  type costs no extra call, and NUL separators keep names with newlines
  whole. It keeps 501 entries and displays 500, the extra one only to detect
  truncation. If `find` can't run or its output passes exec's 8 MiB, it falls
  back to Bash reading the same `find` with a bounded loop.

- Never use `.spin()` for a busy state. It redraws the whole window about
  30 times a second while any agent works, and every redraw repaints every
  visible terminal. Use `.frames` with a slow period.
- A block stays alive while it is in the layout, even hidden. On-demand
  panels must be removed from the tree (`layout.set`), not only hidden.
  `kanso-tabs` reconciles: hidden with a child unmounts it, shown with none
  mounts the remembered panel. It waits up to 1 s for its own `layout.set`
  to land before reading the state as a choice.
- `layout.set` only works on a personal layout. Kanso is one once copied in,
  but the shipped `main` is not.
- The collapsed rail must be at least 76 wide on macOS, or the traffic
  lights overlap the tab bar. Its non-resizable state lives on the root row
  (`resizable`) together with the sidebar's `min`; `kanso-spaces` sets both
  with `layout.set` when you fold or open the sidebar, and once at start.
- Read `panes()`, `spaces()` and `layout()` once per render. Each read copies
  the whole list.
- Keep one-time fixes (`kanso.row`) in `init`, never in `render`.
- The macOS window layout (traffic lights, the empty top strip) assumes
  `titlebar: "none"`.
- Mod names are prefixed `kanso-`, so they can sit beside the minimalistic
  layout's `mn-*` mods.

## Done when

- Right-click a terminal, "Open with…": the popup names that pane's folder
  and lists the installed editors; picking one opens that folder in it.
- In a repository whose branch has an open PR, the PR panel shows its title,
  checks, review, mergeability, unresolved threads and files; clicking a file
  shows its diff, and Explain opens an agent tab with the task.
- `herdr-app check` passes for all eight `kanso-*` mods and `open-with`, and
  `herdr-app status` shows no errors after `layout.switch {name: "kanso"}`.
- With no panel open, `panel-body` in the layout file has no children. After
  clicking Files it holds exactly one `files` block, and closing it empties
  it again.
- With the panel closed, no process started by Files, Changes or Insights is
  running.
- A working agent shows a breathing dot (not a spinner) on its tab, header
  and agent row. A blocked one shows "Needs you" in its header and in the
  status bar.
- Collapsed, the sidebar is 76 wide, its edge does not drag, and the traffic
  lights sit inside it. Opened, it drags between 200 and 480 and reopens at
  the width you left.
- One trackpad swipe over the tab bar moves exactly one tab.
- At 3 per view, Cmd+D three times from one pane gives four columns at a
  third each; the view slides to the new one and the minimap shows four
  pills. Cmd+Shift+= makes it 4 per view and all four fit; Cmd+Shift+- twice
  goes back to 2 per view with the focused pane still in view.
- Dragging the gutter between two columns 200px right on a 1200px view
  makes the left one a sixth of the view wider and the right one that much
  narrower; a quarter second later the minimap pills show the new shares,
  and sliding the view or opening a pane keeps them.
- Dragging the gutter between two stacked panes gives one the height the
  other loses; Cmd+Shift+0 evens them out again.
- Cmd+Alt+Left past the first column in view slides the view.
- Pin the left pane of three and scroll: it stays at the left, whole, while
  the others slide beside it. Ctrl+dragging it, Cmd+Shift+] and dropping a
  pane on it change nothing. Pinning panes that would leave under a fifth of
  the view does nothing.
- Select the second of three panes, go to another space and back: that pane
  takes typing at once, with no click, and its header is the lighter one.
  An agent asking for input tints its pane's header in `blocked`.
  Cmd+Shift+Enter makes the focused column 2/3 wide without changing any
  other column.
- Dragging a grip onto the right half of another header moves that pane
  after it; onto the left half, before it. Ctrl+drag does the same.
