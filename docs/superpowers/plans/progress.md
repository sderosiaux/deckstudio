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
## M5
- Tasks 16, 17 merged (history diff/restore/open-as-lane, history screen). Verified: 252 tests green (excluding a verifier's stray throwaway test), `DECKSTUDIO_E2E=1 pnpm e2e` green (smoke + gaps check on the SF deck).
- M3+M4 review fixes merged (checks: runner owns status, dirty-flag batching, dispose stops retry/persist, failure keeps remarks, lane-scoped remarks via sourceLaneId resolved on lane close, session id kept on non-stale errors; web: lane-scoped remarks on lane rows, focus thumb stamps, brief status from events). Verified: 265 tests green.
- Contracts: Lane.status gains 'draft' (check-proposed lanes hidden from main until opened) for the M4 persona fixes.
- Running: M4 persona fix wave (fixH-server, fixI-web), M5 review.
- M5 review (review-m5.json): 15 confirmed, 0 rejected; fixes merged (restore of a modified entry copies back only entry.fields; shared rebaseOpenLanesAfterMain for accept + restore with remark resolution; versions() ignores orphan v{n}.json; open-as-lane order property tests; history screen keeps thumbs, single refresh on restore with a generation guard, openVersionAsLane typed { laneId }). Verified: 275 tests green. Not fixed: accept-order independence for chained placements (decisions.md).
- M4 persona fixes merged (draft lanes from checks with a cap of 3 per run, opt-in open from the remark or the brief; remark dedupe and stability across runs; 'slide N (title)' naming and id scrubbing; no-truncation and no-render-claim prompt rules; text diff + side-by-side focus with sticky decide bar; brief dot states, 'new' chips, auto-grow fields; propose feedback in the thread). Architect: lane.opened event so an opened draft gets the render check. Verified: 305 tests green.
- README written. Running: M5 persona.
- M5 persona (history): 10 frictions (findings.md); six fixed (one Retry path for deck+lanes+remarks with no false empty state; restore verbs per entry kind and the empty-version guard; open-as-lane disabled when main already equals vA; "back to vN" lanes scrolled into view from history; ghost slots in the older row + ink selection ring; version chips link to /history?a&b). Verified: 319 tests green.
- M5 complete.
