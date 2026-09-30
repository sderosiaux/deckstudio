# Progress

## M1
- Task 1 scaffold: done (architect). Verified: `pnpm typecheck && pnpm test` on smoke test.
- Contracts written by architect: src/model/types.ts, src/model/schema.ts.
- M1 wave 1 (Tasks 2–5): done by 4 Opus agents in worktrees, merged (ids.ts conflict resolved with Task 2's recursive sorted-key hash). Verified: `pnpm typecheck && pnpm test` → 60 tests green.
- Integration by architect: schema template literals (OriginSchema, ThreadKeySchema); scripts/import-sf.ts wired to DeckStore (decks/dss-sf-2026 has v0, v1, 29 slides, 20 assets); FONTS_LINK added to assembleSlideHtml.
- M1 wave 2 (Tasks 6, 7): done by 2 Opus agents, merged. Verified: 74 tests green.
- Integration by architect: ThumbService.thumbHash/thumbPath so /api/thumbs serves from disk (no in-memory map); default theme fallback (src/render/defaultTheme.ts); CLI src/cli/main.ts (serves dist/web, opens browser); vite assetsDir 'app' (the web build collided with the deck /assets route, blank page). Verified: `node bin/deckstudio.js decks/dss-sf-2026` → main screen with 29 thumbs; /api/present plays the deck.
