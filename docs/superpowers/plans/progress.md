# Progress

## M1
- Task 1 scaffold: done (architect). Verified: `pnpm typecheck && pnpm test` on smoke test.
- Contracts written by architect: src/model/types.ts, src/model/schema.ts.
- M1 wave 1 (Tasks 2–5): done by 4 Opus agents in worktrees, merged (ids.ts conflict resolved with Task 2's recursive sorted-key hash). Verified: `pnpm typecheck && pnpm test` → 60 tests green.
- Integration by architect: schema template literals (OriginSchema, ThreadKeySchema); scripts/import-sf.ts wired to DeckStore (decks/dss-sf-2026 has v0, v1, 29 slides, 20 assets); FONTS_LINK added to assembleSlideHtml.
- M1 wave 2 (Tasks 6, 7): done by 2 Opus agents, merged. Verified: 74 tests green.
- Integration by architect: ThumbService.thumbHash/thumbPath so /api/thumbs serves from disk (no in-memory map); default theme fallback (src/render/defaultTheme.ts); CLI src/cli/main.ts (serves dist/web, opens browser); vite assetsDir 'app' (the web build collided with the deck /assets route, blank page). Verified: `node bin/deckstudio.js decks/dss-sf-2026` → main screen with 29 thumbs; /api/present plays the deck.
- M1 review: 7 lenses, 23 confirmed / 0 rejected (docs/superpowers/plans/review-m1.json, findings.md). Fixes running as three parallel agents (security / store+model / render).
## M2
- Wave A (Tasks 8, 9): done, merged. Verified: 134 tests green. Notes: tools ctx has runCheck; link_remark_lane added; lane preview returns thumbs map for changed slides; orphan-only lanes get closed (open question for the UI).
- M1 fixes: three agents (security / store+model / render) merged; one import conflict in theme.ts resolved. Verified: `pnpm typecheck && pnpm test` → 159 tests green; /fonts served; CSP on /api/present; thumbnails re-rendered with vendored fonts.
- M1 complete.
- Wave B (Tasks 10, 11): done, merged (conflicts in app.ts imports and Main.tsx resolved, failed-thumb retry kept). Verified: 178 tests green; `DECKSTUDIO_E2E=1 pnpm e2e` green (real SDK: lane proposed on slides 1–6, one insert accepted → v2, 30 slides, thumb rendered, 59 s).
- Architect: allowedTools shadowing hole closed (Bash was auto-approved, bypassing the write guard); imageGen wired (src/agent/imageGen.ts).
## M3
- Tasks 12, 13 merged (focus screen, local thread routing). Verified: 191 tests green.
- Persona M2 (real UI via agent-browser): scenario completed. Top frictions fixed: (1) proposed slide unreadable → focus screen from M3; (2) version chips with internal ids → human labels from /api/versions; (3) co-author replied in French to English, raw markdown, pixel jargon → reply rules in SYSTEM_APPEND, inline markdown + plain tool names in the thread. Remaining minor frictions logged in review-m2-persona (see findings.md).
## M4
- Tasks 14, 15 merged (CheckRunner + arc/order/gaps/render, remarks + checks routes, brief/checks screen, post-its on main). Architect: `checks` injectable through buildApp (null in tests so no real SDK query starts on accept). Verified: 218 → 236 tests green after the M2 review fixes merged (host/origin guard 403, interrupt generation counter + await on close, stale session retry, thumb.failed for lane previews, lane cells on explicit columns, coalesced events, reconnect resync).
- Running: M5 implementation, M3+M4 review, M4 persona, real e2e (smoke + checks).
