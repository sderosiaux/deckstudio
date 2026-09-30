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
