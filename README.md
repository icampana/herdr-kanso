# Kanso

A quiet layout for the [Herdr](https://herdr.dev) app: warm stone greys, no
outlines, color only when an agent needs you, and nothing running that you
aren't looking at. Side panels exist only while open, and background checks
slow down when the window is behind.

![Kanso](kanso/preview.png)

## Install

Ask your agent: "add herdr.dev/layouts/jlopezlira/kanso". Or by hand, from a
clone of this repo:

```sh
cp kanso/layouts/kanso.json ~/.config/herdr-app/layouts/
cp kanso/layouts/kanso.png  ~/.config/herdr-app/layouts/
cp kanso/themes/*.json      ~/.config/herdr-app/themes/
cp -R kanso/mods/kanso-*    ~/.config/herdr-app/mods/
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
