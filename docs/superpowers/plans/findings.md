# Findings

## M1 review (base 90ae47c, head 5716ed0): 7 lenses, 23 confirmed, 0 rejected

- CONFIRMED · In Review Focus 3, render a reference slide with the same title and a sanitized body (e.g. `<div><b>unclosed</b></div>`) and assert that the result is byte-equal to it, or at least not equal to a blank-page render. That way running the scri
- CONFIRMED · Stop using the regex and sanitize with a real HTML parser (DOMPurify/jsdom or sanitize-html) that drops every on* attribute and script/javascript: URLs; at minimum change the attribute separator to `[\s/]*` and strip `(?<=[\s/"'])on[a-z0-9_
- CONFIRMED · Pick one convention. The simplest fix: have the importer store bare names (`assets: [...sources.keys()]`). The alternative: strip a leading `assets/` in ThumbService.assetPath. Either way, add a test that uses the importer's format.
- CONFIRMED · Stop stripping with a regex: parse with a real HTML sanitizer (e.g. DOMPurify/sanitize-html with script and on* denied), or at minimum run the strip passes in a loop until the output stops changing and send a CSP `script-src 'self'` (nonce 
- CONFIRMED · Make `store` required, or default it to DeckStore and always go through init()+commit(); delete the fallback writer and the duplicated DEFAULT_MODEL.
- CONFIRMED · Isolate each slide body so its tags cannot close outer elements. Parse and re-serialize each body into balanced markup before concatenating (for example with a DOM parser such as parse5 or jsdom, or with a template element), or render each 
- CONFIRMED · In hashFor, remove a leading 'assets/' from the name before resolving it (e.g. name.replace(/^\/*assets\//, '')), or have the importer store bare asset names; also add a regression test that uses 'assets/<name>'.
- CONFIRMED · Replace the regex sanitizer with an allowlist sanitizer (e.g. DOMPurify via jsdom or sanitize-html), which drops on* attributes, javascript: URLs and srcdoc. Add a CSP (script-src 'self' plus a nonce for the player) on /api/present, and add
- CONFIRMED · Swap the regex denylist for an allowlist sanitizer (e.g. DOMPurify/sanitize-html) that drops iframe/object/embed/srcdoc and javascript: URLs, and add a strict CSP (script-src 'self' or nonce, frame-src 'none') on /api/present.
- CONFIRMED · Use one asset-name convention: either have the importer store bare names (`[...sources.keys()]`), or have `hashFor` strip a leading `assets/` before `assetPath`. Then change the test fixtures to the importer's format (`assets/s02.png`) and 
- CONFIRMED · Remove the unconditional rm in scripts/import-sf.ts so the importer's deck.json guard fails the run. Only wipe the folder behind an explicit --force flag, and move it to a timestamped backup first.
- CONFIRMED · In start(), add browser.on('disconnected', () => { this.browser = null; this.page = null; }). Then in screenshot(), relaunch lazily with `if (!this.page || this.page.isClosed()) await this.start()` before calling setContent.
- CONFIRMED · In the PATCH handler, when patch.body is defined, call validateBody and return 400 with the reasons if it fails. Also reject asset names that contain '/', '\\' or '..', or that are absolute, either in SlidePatchSchema or in the route.
- CONFIRMED · Add a dedicated `{ type: 'thumb.failed'; hash; slideId; message }` BusEvent, emit it at thumbs.ts:28 instead of agent.error, and handle it in Main.tsx onEvent by marking that slide's thumb as failed with a retry option.
- CONFIRMED · Treat deck.json as the only commit point: write objects and versions/v{n}.json first (overwrite any orphan v{n}.json whose n is above deck.json's version instead of throwing), bump deck.json next, and only then rewrite slides/*.json. On ope
- CONFIRMED · In snapshotAt (src/store/deckStore.ts:159), use `slides[id] = { ...obj, id };` so the version's key, not the stored object's id, sets the slide id.
- CONFIRMED · Stop render correctness from depending on Google Fonts. Either self-host the woff2 files and serve them through the existing ASSET_ORIGIN route, or have the render context abort requests to fonts.googleapis.com and fonts.gstatic.com, or use
- CONFIRMED · Make the two layers agree on one form. Either have the importer store bare basenames in Slide.assets (and update decisions.md), or resolve Slide.assets entries against the deck root (strip a leading 'assets/' in hashFor), and add a regressi
- CONFIRMED · Remove the hand-rolled fallback: make `store` required, or default it to DeckStore, so the import always runs DeckStore.init plus commit(snapshot, {kind:'import'}) and produces versions/v0.json, v1.json and the full layout.
- CONFIRMED · Replace the regex sanitizer with an allowlist sanitizer (e.g. DOMPurify/sanitize-html) that drops iframe/object/embed/srcdoc and non-http(s)/data-image URL schemes, have validateBody reject bodies the sanitizer would change, and add a CSP (
- CONFIRMED · Stop depending on the network at render time: serve Archivo and IBM Plex Mono woff2 locally through the existing ASSET_ORIGIN route, and hash the font bytes (or the theme's font version). If fonts stay remote, check document.fonts.check('70
- CONFIRMED · Compute the longest increasing subsequence of commonB mapped through rankA. Only mark as moved the common slides that are not in the LIS.
- CONFIRMED · In snapshotAt (src/store/deckStore.ts:175), change the assignment to `slides[id] = { ...obj, id };` so each slide gets its version key back as its id.

## M2 persona test (real UI)
- major · Lane > new slide thumbnail (slide 2 'Two answers, one already exists'): The proposed slide can't be opened at a readable size. Click and double-click do nothing, the thumbnail is about 160px wide, and at that size the wrapped title appears to overlap the orange subtitle, 
- major · Footer > versions bar: Version chips are not interactive. v2 is labelled with internal IDs ('accept c_Gikf6UQ8tn (l_WRr6mTonxN)'), and v0 and v1 are both 'import' with the same timestamp. There is no way to see what changed
- major · Thread > co-author reply: The reply came in French although I wrote in English. **bold** shows as literal asterisks. It ends with implementation jargon ('tout dans 96..1184 / 160..640, min 24px').
- minor · Thread while working: Progress is shown as raw tool identifiers: 'using mcp__deck__get_slide…', 'mcp__deck__render_slide…', 'mcp__deck__propose_lane…'.
- minor · Main strip after accept: Once the change is merged, the new slide 2 looks like every other slide. Nothing marks it as just inserted, and nothing says that slides 2–29 were renumbered to 3–30.
- minor · Lane > change rationale: The explanation of the change exists only as a hover tooltip on the check and cross buttons. It refers to 'slide 2' meaning the old slide 2, which is slide 3 after the insert.
- minor · Thread > context chip after accept: The selection silently widened from 'slides 1–6' to 'slides 1–7' after the insert. It is technically the same slides, but the anchor changed without my doing anything.
- minor · Main strip > range selection: After shift-clicking, only slide 6 has the selected border. Slide 1 loses its highlight, and the range shows only as a thin orange bar underneath. Slide 6 is also half hidden behind the thread panel, 
- minor · Lane after accepting its only change: The lane disappears the moment its last change is accepted, so the refuse and discard buttons could not be tested. There was also no undo right after accepting.
- minor · Lane header: A small empty tab or box is drawn above the lane title, with no evident purpose.
- minor · Tooling note (not a product defect): agent-browser could not hold Shift across separate commands, so the shift-click had to be sent from a script with shiftKey=true. A real user would not hit this.

## M2 review (base 1efa3f2, head 8b6d008): 7 lenses, 13 confirmed, 2 rejected
- CONFIRMED · In interrupt(), bump a generation counter or set a cancelled flag that is captured when a turn is queued. run() checks it before starting a query and skips stale turns (optionally with an 'interrupted' agent.error), then
- CONFIRMED · In laneCells, also keep any slide that has a live change of any kind (e.g. `range.has(id) || byTarget.has(id)`). Alternatively, reject changes outside the anchor in propose_lane, or list out-of-cell pending changes with 
- CONFIRMED · Give each lane cell an explicit deck column instead of using its flex index: put an unchanged, modified or removed slide in its main column and stack inserts inside the column they are inserted after (or widen the region
- CONFIRMED · In lanes.ts, emit `{type:'thumb.failed', hash, slideId:id, message}` instead of agent.error. In Main.tsx, have thumb.failed also mark the matching lane preview thumb as failed (by hash) so LaneRow renders FAILED_THUMB wi
- CONFIRMED · Add a generation counter (or a closed flag) that interrupt() increments; each queued run() checks it and skips if it was queued before the interrupt. interrupt() should then abort the running turn and `await this.tail` (
- CONFIRMED · In run(), when the result has subtype error_during_execution and errors include "No conversation found", call store.setSessionId(null) instead of persisting m.session_id, and retry once without `resume`.
- CONFIRMED · At session.test.ts:120, cut the prompt to the text after the 'Selected: range s2..s4' line and check that s2, s3 and s4 each appear with their `story:` line while s1 and s5 do not.
- CONFIRMED · In reload(), keep the previous deck.slides in a ref and only call refreshThumb for ids that are new or whose slide changed (deep-compare or hash the slide). Keep the existing thumb URLs for the rest instead of clearing t
- CONFIRMED · In run(), when a resumed turn fails with "No conversation found with session ID" (error_during_execution), call store.setSessionId(null) and run the query once more without `resume`. Only save m.session_id from a success
- CONFIRMED · In Main.tsx onEvent: on lane.created/updated call refreshPreview(e.laneId) (plus getLanes for metadata), on lane.closed drop that lane from lanes/previews, and do the full reloadLanes() only on deck.changed (or debounce/
- CONFIRMED · Add an `onOpen`/reconnect callback to `subscribe()` that fires on every open after the first. Use it so Thread calls `load()` and clears `streaming`/`tool`, and Main calls `reload()`/`reloadLanes()`. On the server, make 
- CONFIRMED · Give each cell an explicit grid column under the main slide it relates to: its own main index for none/modified/removed, or the index of its `after` slide for insert/move, drawn as a narrow marker between columns. Drop o
- CONFIRMED · Add an app-wide Fastify onRequest hook in app.ts that returns 403 when Host is not `127.0.0.1:PORT` or `localhost:PORT`, or when a present Origin is not the app origin. Apply the same check to the /ws upgrade, since it a
- REJECTED · I couldn't reproduce this against the real SDK (@anthropic-ai/claude-agent-sdk 0.3.285, from the deckstudio node_modules), repo at 8b6d008 with a clean tree. Th
- REJECTED · I ran a real (live model) reproduction against the repo's pinned SDK, @anthropic-ai/claude-agent-sdk 0.3.285 at /Users/sderosiaux/code/personal/deckstudio/node_

## M3+M4 review (base 8b6d008, head a6b0b23): 7 lenses, 16 confirmed, 0 rejected
- CONFIRMED · When the outcome is not ok, keep the check's existing remarks and lanes and only add or replace its single failure remark (e.g. a failure-only persist path that skips replacing owned remarks and closing lanes). Also add 
- CONFIRMED · In attempt(), call store.setSessionId(m.session_id) for every result that is not the stale-session case (e.g. error_max_turns and non-stale error_during_execution), not only for success. Leave the staleSession break as i
- CONFIRMED · Mark remarks created by a lane-scoped run (e.g. a `laneScoped`/scope field set in `persist` when `t.laneId !== null`) and require that marker in `owned()`'s lane branch, so a deck-wide remark linked to the lane later is 
- CONFIRMED · In scheduleAfterAccept's timer, if a deck batch is already queued or running, set a `dirty` flag rather than enqueuing again. When the running batch finishes, if the flag is set, clear it and enqueue one new batch, so at
- CONFIRMED · In tests/web/main.test.tsx, add a `getRemarks: m.getRemarks` stub (default `[]`) to the api mock. Then add a test: an open slide remark renders a `post-its` child with gridColumn = anchor index + 1, and once getRemarks r
- CONFIRMED · In complete(), throw at the start if this.disposed. In evaluate(), skip the retry when this.disposed or the first failure was an abort. In execute(), check this.disposed again before persist() and throw 'check runner sto
- CONFIRMED · In Focus.reload, only call thumbFor for slides whose content changed or that have no thumb yet (keep a per-slide content stamp as Main's shownSlides does). On the server, cache the per-font and per-asset digests (keyed b
- CONFIRMED · Skip remarks with a non-null laneId in Main's post-it list and warn badge and in BriefChecks' hasWarn (or show them only on the lane row), and have LaneService.closeLane and accept close the open check:render remarks lin
- CONFIRMED · Keep running/lastRun in CheckRunner and have it dedupe run(name) against queued or in-flight runs; the route and GET status should read from the runner instead of their own Set.
- CONFIRMED · Store the scanned lane's id in a separate field instead of laneId. In runner.ts, initialise laneIds with null rather than t.laneId, and give lane-scoped remarks a new field such as sourceLaneId (or anchor them on the lan
- CONFIRMED · Keep the single source of truth for running checks in CheckRunner. Expose `status()`/`isRunning(name)` on ChecksRunner, and treat names as in flight while queued too, not only while executing. The route then dedupes and 
- CONFIRMED · Make CheckRunner the single owner of this state: have it expose status() (running plus lastRun, stamped in execute's finally), have GET /api/checks/status return runner.status(), and have POST /api/checks/run skip names 
- CONFIRMED · Make CheckRunner the one owner of check status: track running and queued checks plus lastRun inside it, expose status() and dedupe on its enqueue, and have GET/POST /api/checks read and delegate to it instead of keeping 
- CONFIRMED · In evaluate(), return right after the first ask when `this.disposed` or the first query was aborted, and have execute() skip persist() when `this.disposed` is set (throw 'check runner stopped'). complete() should also re
- CONFIRMED · Keep the running/lastRun status in CheckRunner (update it in enqueue/runDeck and emit checks.status there), and have GET /api/checks/status and POST /api/checks/run read it from the runner instead of a map local to the r
- CONFIRMED · Make CheckRunner the one owner of check state: it tracks running and lastRun per check and skips any check already queued or in flight. GET /api/checks/status and POST /api/checks/run then read and dedupe through the run

## M4 persona test (real UI, checks)
- major · Main screen / checks screen: 'unsolicited · from check: …' lanes: Running checks silently opened one lane per remark: about 22 lanes on main before I clicked anything, 30 by the end. Every remark says 'lane ready' before I propose. Main becomes a tall stack of lanes with big gaps, the 
- major · Focus screen, lane 'Fit the listing: 24px, caption clear', slide 18: The proposed code edit removed the declarations of `reader`, `parts` and `end` (the try-with-resources and partitionsFor lines) but still uses all three. On stage it is visibly non-compiling Java. The summary only says '
- major · Main / thread, hook lane from earlier (slide 2): The co-author claimed 'Rendu vérifié, aucun warning … min 24px' for slide 2. The render check then called slide 2's title/lead collision unreadable. Its reply was also in French to an English request.
- major · Checks screen, render check count: Render went from 18 remarks to 50 with the same 'last run 12:19 PM', and nothing tells me why. The remark I proposed on disappeared and new slide 18 remarks marked 'lane closed' took its place. I lost track of what I had
- major · Main screen, duplicate lanes on one slide: Slide 18 ended up with two lanes for the same caption problem: the unsolicited 'Trim the replay loop…' and my proposed 'Fit the listing…'. Slide 30 had three render remarks for the same overlap and two competing lanes (a
- minor · Checks screen, render check duration: Render was still 'running…' after 5 minutes, although it is the check I would expect to be fastest. It showed done ('last run 12:19 PM') only when I looked later. There is no progress or ETA, and render lanes had already
- minor · Checks screen, remark text: Internal slide IDs leak into prose, e.g. 's_PPasuPYt6c', 's_1BsURibNAC', 's_YOHpVcoD4n'. One lane card on main reads 'removed · s_BI52jWVrtY'.
- minor · Checks screen, status dots and accessible labels: Every check showed a green dot and the label 'no warnings … not run yet' before any run, and 'no warnings … running…' while running. Green reads as passed.
- minor · Checks screen, brief panel layout: The 'message in one sentence' textarea overflows its box and overlaps the 'narrative pattern' label. The audience input truncates the text with no wrap.
- minor · Propose to lane feedback: After 'propose', nothing appeared in the thread and there was no link to the lane once it existed. I polled main for about 2.5 min. The new lane has no provenance label, unlike the 'from check' lanes.
- minor · Focus screen layout: Before and after are stacked vertically and the after slide is cut off by the lane filmstrip at 900 px height. I had to scroll to see it and to reach accept/refuse.

## M5 persona test (history screen, real UI)
Scenario completed (compare, restore one entry, open a version as a lane, accept, reload). Ranked frictions:
1. After a restore, main showed "Could not load the deck" then, after Retry, "Lanes: Failed to fetch" next to the empty state "No open lanes" while 28 lanes existed. Cause on that run: the architect restarted the server mid-test; but Retry only reloads the deck and the empty state hides a failed fetch → both real.
2. "restore" on an "added in vN" row deletes the slide; the verb never says so (only a tooltip). Comparing against v0 (empty) gives 30 destructive "restore" buttons.
3. "open vN as a lane" stays enabled when main already equals vN → raw 409 in the header.
4. A lane opened from history is titled just "vN", lands at the bottom of the lane list with no scroll/confirmation, shows the whole strip with the insert as a second-row "+" card (two cards numbered 2).
5. Forward compare (older → newer) has no ghost slot in the older row, so rows drift by one after an insert; the selected-thumbnail outline is the same accent as the "changed" marker.
6. v0 (empty, before import) and v1 both read "imported" with the same timestamp.
7. from/to selection by click vs shift-click with identical rings; clicking the current "to" gives a vN-vs-vN view.
8. Version labels: "restored from v1" does not say what it undid; the lane title leaks into the accept label ("· v2").
9. Version chips on main look clickable but do nothing.
10. Lane titles keep referring to a slide number after the structure changed; one lane label still shows an internal id.
Not tested: modified and moved entries (the demo deck's history had none).

## M6 deck-loop (tool screens)
Targets rendered from the three mockups with the design plan; five rounds of Opus fix + fresh Opus judge at 1440x900 (.deck-loop/round-N/{main,focus,history}.png).
| round | score | tier | what the judge blocked on |
|---|---|---|---|
| 1 | 2.5 | 1 | canvas scrolled off origin, page overflow, post-it colours outside the palette |
| 2 | 4.5 | 2 | lane ribbon zigzag, removed slots without accept/refuse, clipped right edge |
| 3 | 5.5 | 3 | header differs per screen, thumbs cropped, remark cards too wide |
| 4 | 6.5 | 3 | 16:9 thumbs cropped, focus body off the title column, "main" header duplicated |
| 5 | 7.2 | 4 | moved hairlines through remark cards, 2px strip gaps, focus card label over the render |
The round-5 fix landed after that verdict (see the final judge line below). Exit criterion (8) not reached within the five rounds.
Leftovers the judge kept naming: empty paper under the rail on history (~360px) and main (~230px); alignment of ghost slots when a compare has both adds and removes is per-index, not joint.
Final judge on the round-5 captures: 7.6, tier 4. Landed: unbroken moved hairlines, one 8px gap and a whole-thumb row end everywhere, same header on the three screens, wrapped what-changed titles. Still blocking: no continuous lane line with accent ticks under lane rows (the memorable element), the history rail not pinned at main's y, the focus "this lane's slides on main" underline on the wrong columns. A sixth round was run on those four directives.
Round 6 (fresh judge on the same round-5 captures): 8.0, tier 4 → exit criterion met, no further fix. Its remaining directives, for a later pass: remark excerpts cut mid-sentence on main; bare grey remark dots and the bare "44" in the header; the focus main-strip underline leaves out the changed slide; history rail should sit under the header with the compare below it.

## QA round 1 (four persona drivers on the real app + UX critic), 2026-09-30
Full result: docs/superpowers/plans/qa-round-1.json; screenshots /tmp/deckstudio-qa/round-1/. 40 bugs, 31 frictions. UX score 4/10.
Critic's verdict: the building blocks are right (lanes as rows, remarks pinned to slides, focus before/after, slide page), but the core loop breaks the creator's principle on every screen: you ask in a right bar, the answer comes back there as prose with internal ids, the lane lands elsewhere on the canvas, judging it needs a third screen, confirming an accept a fourth. Following one change takes 3 to 4 places. The validated mockup also had the thread in a right bar: the build followed the mockup, not the principle.
Top bugs: resolve/propose clicks change the selection; versions rail clips the current version past 6 versions; lane rows clipped under the rail; co-author replies in French to English and names lanes by raw id; raw slide ids and stale slide numbers in remark text; revise_lane regenerates change ids and drops pending patch text (focus lands on "change – of 3"); no-op moves after a rebase; focus action bar over the content at 1200px; brief slides column captions overlap; "Checks running…" label stuck; "slide ?" and lane-closed remarks mixed into the live list; history strips dead at "+26".
Ranked changes: (1) conversation at the selection, not in a right bar; (2) replies carry their proposal (before/after + accept/refuse) and show work in progress inline; (3) every decision acknowledges itself where it was made; (4) stable lane identity and full titles with origin; (5) structural diffs shown as structure (moves, history strips).

## QA round 2 (same four drivers + critic), after the round-1 fixes and the inline conversation on main
Full result: docs/superpowers/plans/qa-round-2.json; screenshots /tmp/deckstudio-qa/round-2/. 34 bugs (was 40), 30 frictions (was 31). UX score 5.5 (was 4).
Critic: the principle now holds at the entry point (asking under the slide; the answer comes back there as a main-vs-proposed card) but not at the outcome: the proposal is scattered (lane row below the fold, a copy in the whole-deck bar, three views on the slide screen), remarks take over the canvas, the filmstrip is not sticky, focus hides its thread under the action bar and navigates on its own.
Still failing after round 1: co-author replies in French to English (the prompt rule alone is not enough); raw ids in old messages; "restored from v1" label for a per-slide revert; "new" on every remark; "e" after a mouse click types in the composer.
New after round 1: selection panel drawn as an empty box when the canvas is scrolled; panel growing under the versions rail; hover title over the range label; badge over the lane thumbnail title; slide-scoped turns split between the panel and the whole-deck bar.
Round-2 changes: (1) one proposal in one place, new lane first and flashed, no slide turns in the whole-deck bar; (2) remarks out of the canvas (count dots on thumbs, listed in the panel); (3) sticky filmstrip with edge chips; (4) slide screen in two columns; (5) focus thread in a right column, no auto-navigation.

## QA round 3 (measure after the round-2 fixes)
Full result: docs/superpowers/plans/qa-round-3.json; screenshots /tmp/deckstudio-qa/round-3/. 25 bugs (40 → 34 → 25), 30 frictions. UX score 5.5 (4 → 5.5 → 5.5).
Critic: main honours the principle (conversation in place under the strip; replies in English; the thread explains when no lane is needed). The rest moves away from it: the lane a reply creates lands below the fold under the open panel; on /slide and /focus the conversation went back to a right column (the round-2 critic asked for it; the creator's principle says otherwise). Lane identity is weak: duplicate lane names for the same intent, a lane built on an older base still offers to overwrite a field main changed since, stale no-op lanes still ask for accept/refuse. "That erodes trust more than any pixel issue."
Remaining majors: panel remark list clipped with no affordance; panel keeps its height when its anchor pages off-screen; a render remark opened as a lane only edits notes; stale lane not flagged after main changed; duplicate lanes from the slide thread; story/notes under the render tabs always show main's text; a lane whose change main already took stays open; "change – of 0" on a decided lane; old-version thumbnails blank on the history second page; duplicate gaps remarks; "new" markers still on every arc/order remark after a rerun.
Critic's next changes: (1) proposals as reply cards inside the conversation (thumb pair + one-line field diff + accept/refuse), the lane row only as a mirror; (2) /slide conversation under the render, not in a column; (3) group lanes by slide+field as variants, supersede on accept, flag stale lanes; (4) focus: give the diff the screen; (5) freeze the main layout (fixed rail, no resize on selection).
Stopped here for the creator's decision.

## QA round 4 (measure after the round-3 fixes)
Full result: docs/superpowers/plans/qa-round-4.json; screenshots /tmp/deckstudio-qa/round-4/. 27 bugs (40 → 34 → 25 → 27), 35 frictions. UX score 5.5 for the third round.
Critic: each screen alone is close to the mockups; /slide is the best expression of the principle; focus and history nearly faithful. Main breaks it: the slide discussed is a 90px thumbnail, the conversation is a floating card that covers the lanes it creates, its composer is clipped, a second "whole deck" composer sits in a right rail the mockup never had, and the answer to a request is prose in one place and a lane row somewhere else. Understanding one change still takes three or four places. Remarks appear in five places with counts that disagree. The co-author's judgement is good (refuses no-op lanes, explains why); the UI does not carry it: stale and no-op lanes still show accept/refuse.
Remaining majors: panel composer clipped under the panel edge; lane cells after a decision inside a multi-move lane (unlabeled thumbs, ghost cells, wrong +N); stale lane shown actionable (the rebase runs on accept/refuse/open/restore and before checks, not when main changes or on read); focus seeded with the wrong slide exchange; focus diff says "no text change" while the render changed (footer text in body not captured by plain-text diff); reply describing a main that changed during the turn; narrative-arc remark renumbered but not re-evaluated after a deck change.
Critic's changes: (1) every reply that creates or revises a lane renders an inline change card (before/after, field diff, why, accept/refuse); (2) main: replace the floating panel with an inline stage (selected slide at ~640px with the conversation beside it, pushing content down); (3) delete the permanent whole-deck rail, one composer with a scope chip; (4) remarks as one-line items, collapsed above the thread; (5) lane lifecycle: scroll and pulse on open, stale/no-op lanes closed in place.
Architect's read: three rounds at 5.5 with a different layout prescription each time means the fix loop is chasing a moving target on main; the next step is a designed decision on the main stage (mockup validated by the creator), not another fix wave.

## Space loop (overnight), real-DOM coverage above the fold at 1440x900 / 1920x1080
| screen | round 1 | round 2 | round 3 (before r3 fixes) |
|---|---|---|---|
| main, slide selected | 0.31 / 0.27 (render 0.06) | 0.43 / 0.41 (render 0.35) | 0.72 / 0.69 (render 0.66) |
| main, nothing selected | 0.22 / 0.19 | 0.48 / 0.42 | 0.55 / 0.51 |
| slide | 0.58 / 0.38 | 0.68 / 0.52 | 0.76 / 0.79 pass |
| focus (remove) | 0.29 / 0.18 | 0.48 / 0.59 | 0.79 / 0.80 pass |
| focus (move) | 0.18 / 0.11 (render 0.05) | 0.63 / 0.64 (render 0.42) | 0.82 / 0.82 pass |
| history | 0.41 / 0.34 | 0.57 / 0.56 | 0.70 / 0.73 |
Round-3 fixes merged after that measurement (main stage + lane rows, decided-change view in focus, history before/after panels). Not re-measured; QA round 5 screenshots give the final look.
