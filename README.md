# deckstudio

A local workbench for one slide deck and its AI co-author. The deck on disk is the source of truth; the co-author never edits it directly. It proposes lanes (sets of changes under main) that you accept or refuse one change at a time, leaves remarks pinned to slides, and runs background checks (arc, order, gaps, render) against your brief.

## Run

```
pnpm install
pnpm import:sf            # imports the SF talk deck into decks/dss-sf-2026 (optional)
pnpm build && node bin/deckstudio.js decks/dss-sf-2026
```

The app opens on http://127.0.0.1:4177 (port from `DECKSTUDIO_PORT`, `DECKSTUDIO_NO_OPEN=1` skips the browser). The co-author uses your Claude Code login through the Agent SDK; no API key is read.

## Layout

A deck folder holds `deck.json` (order, version, brief), `slides/`, `assets/`, `lanes/`, `remarks.json`, `threads/` and content-addressed `objects/` + `versions/`. Everything is plain files, so a deck can be copied, diffed or thrown away.

Screens: main (filmstrip, lanes, remarks, thread), focus (before/after of one change with a text diff), brief and checks, history (compare two versions, restore one entry, open a version as a lane), present.

## Develop

`pnpm dev` (server) and `pnpm dev:web` (vite). `pnpm typecheck && pnpm test` must stay green; `DECKSTUDIO_E2E=1 pnpm e2e` drives the real co-author. Design notes: `docs/superpowers/specs`, decisions and findings under `docs/superpowers/plans`.
