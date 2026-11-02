# Kanso

**A calm, fast layout for [Herdr](https://herdr.dev), made for working with
many coding agents at once.**

<picture>
  <source media="(prefers-color-scheme: light)" srcset="docs/screenshots/hero-light.png">
  <img alt="Kanso: three repositories in the sidebar, two agents side by side (one working, one waiting for your answer) and the pull request panel" src="kanso/preview.png">
</picture>

Kanso is the Japanese principle of simplicity: remove what is not needed.
Everything on screen is there because you need it now, and nothing you are not
looking at keeps running.

## Why Kanso

- **See which agent needs you, at a glance.** No outlines, no decoration, warm
  stone greys. Color appears only when an agent's state matters (working,
  needs you, finished), so the one waiting for you is the one thing that
  stands out.
- **Panes never shrink.** Panes sit on an endless horizontal strip. A new pane
  opens beside the one you are in, at its own width, and the view slides to
  it. Pick how many fit the view (1 to 8); a slim rail at the edge shows what
  lies beyond, and a minimap shows where you are.

  ![Three panes on the strip: an agent at work, an agent waiting for you, and a dev server](docs/screenshots/strip.png)
- **Review the work without leaving.** Side panels for **Files** (with
  Markdown and code preview), **Changes** (diffs and a commit) and **Pull
  requests**: every open one in the repository, with checks, unresolved
  threads, reviewers, labels and merge, and one click to ask your agent to
  explain a pull request, address its feedback or resolve its conflicts.

  ![The Changes panel beside two agents: the files a branch changed and their diff](docs/screenshots/changes.png)
- **Light on your machine.** Side panels exist only while open, background
  checks slow down when the window is behind others, and the Files tree draws
  only the rows on screen: 78% less CPU on a 500-row tree, and a 50,000-file
  folder listed in 75 ms. [See the benchmarks](benchmarks/README.md).
- **Your editor, one key away.** Cmd+Shift+O opens the pane's folder (or a
  file from the Files panel) in Cursor, VS Code, Zed, Windsurf, Sublime Text,
  a JetBrains IDE, Xcode, or Neovim, Helix and Vim in a split.
- **Keyboard first, mouse friendly.** Every move has a key; panes also drag,
  resize and pin with the mouse.

The repositories, agents and pull requests in these screenshots are a demo.

## Install

Ask your agent: "add herdr.dev/layouts/jlopezlira/kanso". Or by hand, from a
clone of this repository:

```sh
cp kanso/layouts/kanso.json ~/.config/herdr-app/layouts/
cp kanso/layouts/kanso.png  ~/.config/herdr-app/layouts/
cp kanso/themes/*.json      ~/.config/herdr-app/themes/
cp -R kanso/mods/kanso-* kanso/mods/open-with ~/.config/herdr-app/mods/
# then add the "layout:kanso" section of kanso/keys.json to ~/.config/herdr-app/keys.json
herdr-app do layout.switch --name kanso
```

`ctrl-shift-l` switches back to your previous layout. Deleting the files
removes Kanso. Light and dark themes are included (`kanso-day`, `kanso`).

## Keys

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
| Cmd+Shift+O | Open the pane's folder in a code editor |
| Cmd+Alt+P | Pin the pane: it keeps its place and stays in view |

With the mouse:

| Do this | To |
|---|---|
| Drag the gutter between two panes | Resize them, sideways or up and down |
| Hold a pane's six-dot grip and drag it onto another | Move it: the left or right quarter makes a column before or after, the middle stacks it above or below |
| Scroll over a header or the minimap | Slide the view |
| Use the order button at the top of the sidebar | Sort each space's sessions by last update, needs you first, kind, screen order, or your own |
| Hover a session and click its pin | Keep it at the top of its space; drag pinned ones to order them |
| Right-click a file in the Files panel | Open it in an editor, or preview it in the panel |
| Double-click a session, a pane header, a space or a tab | Rename it (an empty name brings the automatic one back) |

## Privacy: what it runs

The mods run `git` (the spaces list, Files, Changes), `find` (listing a folder
on Unix, with `bash` as a fallback) and `hc machine ls` (machines). They read
files only inside the folders you work in.

Only the pull request panel reaches the network: it runs the GitHub CLI
(`gh`) and talks to GitHub only while the panel is shown. Open with runs `sh`
to find installed editors (app folders, `command -v`, `flatpak`); on macOS it
opens an editor with `open -a` and caches each app's icon under
`~/.config/herdr-app/data/open-with/`.

Specs (`sdd-focused`) and Insights are optional: install either mod and its
button appears in the tab bar.

## Development

```sh
npm test                               # Node.js 20+, Git and Bash; macOS or Linux
npm run bench -- --base origin/main    # macOS, with the Herdr app installed
```

The tests load each mod's real code into a fake Herdr host and run it against
real temporary Git repositories and folders. The benchmark compares a git ref
with your working tree in isolated native Herdr windows; see
[benchmarks/README.md](benchmarks/README.md).

How every part is built, in enough detail to rebuild it:
[kanso/RECIPE.md](kanso/RECIPE.md). `herdr-app check kanso/mods/<mod>` loads a
mod once and reports what is wrong.

## Credits

The mods grew out of the ones shipped with Herdr, through the 0oz-design fork
and the minimalistic layout; [NOTICE](NOTICE) and each file's header say who
changed what.

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
