# Changelog

Every change to what Kanso installs, newest first. Versions follow
[Semantic Versioning](https://semver.org): a release that lists Breaking or
Removed changes is a major version, one that lists Added or Deprecated is a
minor version, anything else is a patch. The format follows
[Keep a Changelog](https://keepachangelog.com). `npm run check:version`
checks all of this, and merging to main releases the version in
`kanso/mods/kanso-chrome/version.json`, which is what the updater offers.

## [2.1.0] - 2026-11-03

### Added

- Worktrees: a panel that finds every git worktree on your computer, in your repositories' folders and wherever agents left them (temp folders and scratchpads included), with how much disk they take and what each one holds: merged (squash merges included), commits kept on its branch, uncommitted changes, commits only there, or in use. Clean up removes, after a second press, every one that loses nothing and has been idle a day, and deletes the merged branches; one at a time or a whole repository, it says first what would be lost. Folders whose repository moved or was deleted are listed too. A worktree whose repository moved (its `.git` names the old place) is never removed: Repair the link reconnects it. Each one is checked again right before it goes, and one that changed since the scan stays instead of failing.
- Worktrees keeps a history in SQLite (`data/kanso-panel/worktrees.db`): each worktree once, rewritten only when it changes, and the gone ones with the size they freed, whether removed here or elsewhere. Freed shows the total, the worktrees, merged branches and leftovers cleared, and 30 days of what was freed and of what the worktrees took. The panel opens on the last scan while it checks again.
- Worktrees: Share posts an image to X, LinkedIn or Bluesky with the totals only, never a repository, branch or folder name: what was freed, or before that, what the worktrees take.
- Worktrees: Explain it on a worktree, or Review the ones that need a look, asks your agent in a new tab what that work is and whether it already lives somewhere else. The agent changes nothing.

## [2.0.1] - 2026-11-03

### Changed

- The button of the open panel shows its name beside its icon, so you can tell which panel is open without hovering it.

## [2.0.0] - 2026-11-03

### Added

- The panel buttons at the top right are icons; the one under the pointer shows its name beside it. Press one and let go on another to move it there. Right-click one to open Panels, where you drag them into order and turn each one on or off. The order and the switches are kept for every space.

### Removed

- Specs (the separate `sdd-focused` mod) is no longer offered in the tab bar, and a Specs panel left open closes. Kanso never included it; remove `mods/sdd-focused` if it is installed.

## [1.5.0] - 2026-11-03

### Added

- Spend is part of Kanso. It shows what your AI coding sessions cost at API list price, per model, project and task, and it ships with the layout: its button is always in the tab bar. It was the separate token-spend mod; its first start carries that mod's data over, and its keys are now under `mod:kanso-spend` (#32).
- Spend: Share to X, LinkedIn or Bluesky, or save the image, the same way as Shipped. The image has only the totals of the unfiltered view: what the period is worth, tasks, tokens, how many projects and models, and the days. Never a project, task or session name; the button hides while a filter or a detail is open (#32).

### Changed

- Spend keeps its index in SQLite, `data/kanso-spend/spend.db`, instead of one JSON file: a scan writes only what changed, and opening the panel skips what only scans need. The first scan moves `store.json` in and keeps it as `store.json.migrated` (#32).
- Sharing pastes the image into the post for you: the composer opens with the text, and once the page is up the image goes in. On macOS this needs Herdr in Accessibility; without it, the toast says to paste it. Shipped and Spend share through one module (#32).

### Fixed

- Spend no longer docks a second panel at the window's right edge when it is installed (`"place": "none"`) (#32).

## [1.4.0] - 2026-11-03

### Added

- Shipped: Share to X, LinkedIn or Bluesky, or save the image. It makes a PNG of the global numbers only: the totals, the streak with a year of contributions, the records and when you ship. No repository or machine names. It copies the image to paste into the post, and opens the composer with the words filled in, because these networks take only text from a link (#31).

## [1.3.1] - 2026-11-03

### Changed

- Kanso looks for its own releases when Herdr starts and every 5 minutes, instead of every 6 hours, so a release shows within minutes. `kanso-chrome.check` looks right away and says whether you are up to date (#30).

## [1.3.0] - 2026-11-03

### Added

- Shipped (#29): a side panel of vanity metrics for what you delivered, drawn like Spend. It covers every repository and organization, by day, week, month or year, and shows:
  - the lines you added and removed, compared with the period before;
  - contributions (private ones included), pull requests merged, commits, reviews and repositories;
  - your totals since you joined GitHub;
  - your streak, with a heat map that fills the panel, up to a year;
  - your records (best day, best week, best month, longest streak, most commits in a week), with a toast when you set one;
  - when in the day you ship, and from which machine;
  - a breakdown by repository.

  Each machine reads its own git (every branch, every identity you commit with) into a local SQLite store of statistics only (repository, hash, time, lines, machine), and your machines share it through a private gist. GitHub's weekly contributor sums cover what no machine has cloned. A repository's week counts the larger of the two, and each refresh reads only what changed.

## [1.2.0] - 2026-11-03

### Added

- PR panel: the list's new Closed tab shows the repository's 30 most recently merged or closed pull requests. Like the open ones, they are grouped as this branch, yours, and your colleagues'. A finished pull request shows only when you pick it (#28).

### Fixed

- PR panel: a branch's merged or closed pull request no longer opens as the branch's own. The newest open one stands in, or the panel offers to create one (#28).

## [1.1.0] - 2026-11-03

### Added

- Kanso updates itself, apart from Herdr. When there is a newer release, an "Update Kanso to X" row appears above Settings, with one toast per version. Installing it checks every mod first, keeps the keys you changed, and keeps your previous layout as `layouts/kanso.json.old-<time>` (#26).
- `kanso.panels` in `shared.json`: other mods can add their own side panels to the tab bar (#25, by Iván Campaña).

### Fixed

- Specs and Insights show in the tab bar only when their mods are really installed (#24, by Iván Campaña).

## [1.0.0] - 2026-11-03

The first release. It holds everything from the first commit (31 October 2026) to the v1.0.0 tag.

### Added

- Kanso: a quiet Herdr layout with side panels that open on demand (Files, Changes), light and dark themes (`kanso-day`, `kanso`), and a recipe to rebuild it (5db1c86).
- An endless horizontal strip of panes with a minimap, keyboard navigation, and a view that glides to the focused pane (b245258, 77215ff, c4b12fd, 437c17a).
- Choose how many panes fit in the view, from 1 to 8, and resize them on the dividers (6c9fe03).
- A grip that moves a pane before or after another (736918f).
- A terminal menu that knows about the strip (2eccd5f).
- Open with: open a pane's folder in a code editor (#1).
- PR panel: the branch's pull request, managed from Kanso (#2).
- Focus memory, pinned panes, and a sidebar that lists and reorders every session (#3).
- Drop a pane to stack it. Stacked panes are linked in the sidebar, and a preview shows where a held pane will land (#6).
- Preview a file in the side panel from Open with, without an editor (#9).
- Order the sidebar's sessions: pinned first, then by last update, attention, kind, screen order, or your own order (#10).
- PR panel: lists every open pull request in the repository, with a quiet state outside a repository (#12).
- PR panel: one pull request at a time, with the open ones in a dropdown (#16).
- Strip: a swipe over an edge tab slides the view too (#17).
- PR panel: the description and a copy-link button (#21).
- Strip: the selected pane has a fine accent border (#22).

### Changed

- Side panels share the work area's background, and a panel that closes itself unmounts (0ee86f2).
- A quieter minimap and simpler canvas keys (1aa9a72, 9516587).
- Split down stacks the new pane in its column. There are no vertical moves (aecfaa6).
- Whole panes only: tabs at the edges replace the peeks of the continuous canvas (8d837d5, #4).
- An edge rail, resizing on Herdr's own dividers, and gutters instead of lines (#5).
- Kanso leans on the SDK: one panel mod, the header inside the strip, and fewer redraws (#7).
- A README about what Kanso does for you, tests grouped by feature, and a reusable benchmark (#14).
- New screenshots and previews that lead with the strip, the PR handoff, and Open with (cb6540c, 4e16fba, #15, #23).
- README: install optional mods while another layout is shown (#20).

### Fixed

- Drags survive peeks and fillers, and the resize grip is visible (5585ee2).
- The edge rail and dragging in the sidebar (#8).
- Layout writes no longer drop each other, and work that still ran hot was cut (#11).
- Layout writers never save another layout's tree into `kanso.json` (#18, by Iván Campaña).
- The side panel resizes again (#21).
