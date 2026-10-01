# deckstudio

A local workbench for slide decks and their AI co-author. The deck on disk is the source of truth; the co-author never edits it directly. It proposes lanes (sets of changes under main) that you accept or refuse one change at a time, leaves remarks pinned to slides, and runs background checks (arc, order, gaps, render) against your brief.

## Run

```
pnpm install
pnpm build && node bin/deckstudio.js                      # home screen: every deck of the home folder
node bin/deckstudio.js decks/dss-sf-2026                  # same server, opened on that deck
pnpm import:sf                                            # optional: imports the SF talk deck into the home folder
```

The home folder holds one sub-folder per deck: `DECKSTUDIO_HOME`, else `./decks` when it exists, else `~/deckstudio/decks` (created). Given a deck folder, the CLI serves its parent as the home. The app opens on http://127.0.0.1:4177 (port from `DECKSTUDIO_PORT`, `DECKSTUDIO_NO_OPEN=1` skips the browser). New decks and deck.html imports are made from the home screen; a deck folder copied into the home while the server runs shows up without a restart. The co-author uses your Claude Code login through the Agent SDK; no API key is read.

## Start a new presentation

On the home screen, "New presentation" asks for a title, the audience and the message (the one sentence the deck must land), plus an optional abstract and design rules. The deck opens empty: describe the talk in the whole-deck conversation and the co-author proposes an outline as a lane of inserted slides, which you accept one at a time. Then select a slide, talk about it under the strip, and judge each proposal with its before/after. "Import a deck.html" brings an existing single-file deck in, slides and assets included.

## Layout

A deck folder holds `deck.json` (order, version, brief), `slides/`, `assets/`, `lanes/`, `remarks.json`, `threads/`, `theme.css` and content-addressed `objects/` + `versions/`. Everything is plain files, so a deck can be copied, diffed or thrown away. The folder name is the deck id.

URLs: `/` is the home screen, `/api/decks` lists and creates decks, and each deck lives under `/d/<id>/` with its own API (`/d/<id>/api/...`), socket (`/d/<id>/ws`) and assets (`/d/<id>/assets/...`). One Chromium renders the thumbnails of every deck.

Screens of a deck: main (filmstrip, lanes, remarks, thread), focus (before/after of one change with a text diff), brief and checks, history (compare two versions, restore one entry, open a version as a lane), present.

Design rules live in the brief (brief screen, Design section). A new deck starts with generic rules and the default theme. The co-author gets the rules with every message, in every thread, and must keep each slide it creates or modifies within them; the render check flags a slide that breaks one. The image style there prefixes every generated image. The look itself (fonts, colours, classes) stays in the deck's `theme.css`, edited on disk.

## Develop

`pnpm dev` (server) and `pnpm dev:web` (vite). `pnpm typecheck && pnpm test` must stay green; `DECKSTUDIO_E2E=1 pnpm e2e` drives the real co-author. Design notes: `docs/superpowers/specs`, decisions and findings under `docs/superpowers/plans`.
