# Kanso

A quiet layout for the [Herdr](https://herdr.dev) app: warm stone greys, no
outlines, color only when an agent needs you, and nothing running that you
aren't looking at. Side panels exist only while open, and background checks
slow down when the window is behind. Panes live on an endless strip, as in
Omarchy's scrolling layout: a new one opens beside the focused one at its own
width, nothing shrinks, and the view slides to it. You choose how many panes
the view holds at once, 1 to 8.

| Keys | What they do |
|---|---|
| Cmd+1 ... Cmd+9 | Go to pane 1 to 9 |
| Cmd+[ and Cmd+] | Previous and next pane (the view glides to it) |
| Cmd+D and Cmd+Shift+D | New pane to the right and to the left |
| Cmd+W | Close the pane |
| Cmd+Shift+[ and Cmd+Shift+] | Move the pane left and right |
| Cmd+Shift+- and Cmd+Shift+= | Fewer or more panes per view (1 to 8) |
| Cmd+Shift+0 | Even the panes out |
| Cmd+Shift+Enter | Make the pane wider or narrower |
| Drag the thin handle at a header's right edge | Resize that pane; the others reflow |
| Drag the six-dot grip onto another pane | Move it before or after that pane |
| Wheel over a header or the minimap | Slide the view |

![Kanso](kanso/preview.png)

## Install

Ask your agent: "add herdr.dev/layouts/jlopezlira/kanso". Or by hand, from a
clone of this repo:

```sh
cp kanso/layouts/kanso.json ~/.config/herdr-app/layouts/
cp kanso/layouts/kanso.png  ~/.config/herdr-app/layouts/
cp kanso/themes/*.json      ~/.config/herdr-app/themes/
cp -R kanso/mods/kanso-*    ~/.config/herdr-app/mods/
# then add the "layout:kanso" section (it also keeps Cmd+Alt+arrows and Cmd+Alt+H/L as alternatives) of kanso/keys.json to ~/.config/herdr-app/keys.json
herdr-app do layout.switch --name kanso
```

`ctrl-shift-l` switches back to your previous layout. Deleting the files
removes Kanso.

## What it runs

The mods run `git` (the spaces list, Files, Changes), `sh` (the Files listing)
and `hc machine ls` (machines). They read files only inside the folders you
work in. Nothing reaches the network.

Specs (`sdd-focused`, from the minimalistic layout) and Insights are optional:
install either mod and its button appears in the tab bar.

How it is built, in enough detail to rebuild it: [kanso/RECIPE.md](kanso/RECIPE.md).

## License

Apache License 2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
