# Kanso

A quiet layout for the [Herdr](https://herdr.dev) app: warm stone greys, no
outlines (the selected pane's header is a shade lighter; one whose agent needs
you is tinted), and nothing running that you aren't looking at. Side panels exist only while open, and background checks
slow down when the window is behind. Panes live on an endless strip, as in
Omarchy's scrolling layout: a new one opens beside the focused one at its own
width, nothing shrinks, and the view slides to it, a pane at a time, never
showing a cut one: a narrow rail at the edge stacks what lies beyond (hover it
for their names). You choose how many panes the view holds at once, 1 to 8.

| Keys | What they do |
|---|---|
| Cmd+1 ... Cmd+9 | Go to pane 1 to 9 |
| Cmd+[ and Cmd+] | Previous and next pane (the view glides to it) |
| Cmd+D, Cmd+Alt+D, Cmd+Shift+D | New pane right, left, below (stacked) |
| Cmd+Alt+Up/Down | Move the focus within a stack |
| Cmd+W | Close the pane |
| Cmd+Shift+[ and Cmd+Shift+] | Move the pane left and right |
| Cmd+Shift+- and Cmd+Shift+= | Fewer or more panes per view (1 to 8) |
| Cmd+Shift+0 | Even the panes out |
| Cmd+Shift+Enter | Make the pane wider or narrower |
| Drag the gutter between two panes | Resize them, sideways or up and down |
| Hold the six-dot grip and drag onto another pane | Every pane becomes a card while you hold; the half where yours will land lights up with its name. Left or right quarter: a column before or after. Middle: stacked above or below |
| Wheel over a header or the minimap | Slide the view |
| Cmd+Shift+O | Open the pane's folder in a code editor |
| Cmd+Alt+P | Pin the pane (or unpin it): it keeps its place and stays in view |
| The order button at the top of the sidebar | List each space's sessions by last update, needs you first, by kind, as on screen, or in your own order |
| The pin on a session (hover) | Keep it at the top of its space; drag the pinned ones to order them |
| Drag a session (your own order) | Put it where you want in its space |
| Right-click a file in the Files panel | Open it with an editor, or preview it in the panel (Markdown rendered) |
| Double-click a session in the sidebar, a pane's header, a space or a tab | Rename it (the same dialog for all; an empty name brings the automatic one back) |

![Kanso](kanso/preview.png)

## Install

Ask your agent: "add herdr.dev/layouts/jlopezlira/kanso". Or by hand, from a
clone of this repo:

```sh
cp kanso/layouts/kanso.json ~/.config/herdr-app/layouts/
cp kanso/layouts/kanso.png  ~/.config/herdr-app/layouts/
cp kanso/themes/*.json      ~/.config/herdr-app/themes/
cp -R kanso/mods/kanso-* kanso/mods/open-with ~/.config/herdr-app/mods/
# then add the "layout:kanso" section (it also keeps Cmd+Alt+arrows and Cmd+Alt+H/L as alternatives) of kanso/keys.json to ~/.config/herdr-app/keys.json
herdr-app do layout.switch --name kanso
```

`ctrl-shift-l` switches back to your previous layout. Deleting the files
removes Kanso.

## What it runs

The mods run `git` (the spaces list, Files, Changes), `find` (the Unix Files
listing, with `bash` as its fallback)
and `hc machine ls` (machines). They read files only inside the folders you
work in. Only the PR panel reaches the network (GitHub, below).

Open with (`open-with`: Cmd+Shift+O, the pane header's open button, or
"Open with…" in the right-click menu) lists the code editors installed on this
computer (Cursor, VS Code, Windsurf, Zed, Sublime Text, JetBrains IDEs, Xcode
and others; Neovim, Helix and Vim open in a split) and opens the pane's folder
in the one you pick. From the Files panel it opens a file instead
(right-click it, or the open button while it is shown), and a text file is
offered first to Kanso's own preview in the side panel: Markdown rendered,
anything else as read-only code, read again as the file changes, with no
editor at all. To find the editors it runs `sh` (app folders, `command -v`,
`flatpak`); on macOS it opens the editor with `open -a` and saves each app's
icon as a PNG with `plutil` and `sips` under
`~/.config/herdr-app/data/open-with/`.

The PR panel (`kanso-panel`, the PR button in the tab bar) shows the open pull
request of the focused pane's branch, as T3 Code does, with every other open
one in that repository, by anyone, listed above it (yours first; a click
shows one), in the Spend panel's
style: whether it can merge, checks, unresolved threads and the files with
their diff. You manage it there: assign it to yourself or others, ask for or
take back reviews, put labels on and off (T3 Code's searchable pickers), mark
it ready or back to draft, close, reopen and merge it (a second press
confirms). It asks your agent to explain it, address feedback or resolve
conflicts in a new tab. It runs `gh` and `git`, and reaches GitHub only while
the panel is shown.

Specs (`sdd-focused`, from the minimalistic layout) and Insights are optional:
install either mod and its button appears in the tab bar.

How it is built, in enough detail to rebuild it: [kanso/RECIPE.md](kanso/RECIPE.md).

Run the regression checks with `node --test tests/pr11-regressions.test.mjs`
(Node.js, Git and Bash; macOS or Linux). They exercise the mod logic with an
isolated host, real temporary Git repositories and file listings. Windows
launch checks validate the generated command strings without launching an editor.

On macOS, `node benchmarks/macos.mjs` compares the PR's base, its original
head and the working tree using real directory listings and isolated native
Herdr windows. It leaves measurements under `benchmarks/results/macos/`;
`node benchmarks/summarize.mjs` produces the report. See the
[measured results and limitations](benchmarks/results/macos/REPORT.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
