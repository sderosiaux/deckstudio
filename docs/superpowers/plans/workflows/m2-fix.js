export const meta = {
  name: 'deckstudio-m2-fix',
  description: 'Milestone 2 fixes: two Opus agents apply the confirmed review findings (server/session, web lanes UI) in parallel worktrees with regression tests',
  phases: [{ title: 'Fix', detail: 'server+session / web' }],
}
const REPO = '/Users/sderosiaux/code/personal/deckstudio'
const WT = '/Users/sderosiaux/code/personal/deckstudio-wt/'
const FINDINGS = `${REPO}/docs/superpowers/plans/review-m2.json`
const COMMON = `
You fix confirmed review findings of the deckstudio repo inside a dedicated git worktree at WORKTREE (absolute path below). ALWAYS work there (cd WORKTREE && <command>); never touch ${REPO}. node_modules is symlinked.
Read first: ${FINDINGS} ("confirmed" array: claim, evidence, fix_hint; only those in YOUR SCOPE are yours), then the files you will change and their tests. Contracts in src/model/types.ts and schema.ts do not change.
Rules: for each finding, add a regression test that fails, then fix, then run it and the full suite (pnpm typecheck && pnpm test). TypeScript ESM (.js suffixes), strict, no fixed sleeps, no placeholders. Only touch files in your scope (plus their tests). Do not edit package.json.
When done: git add <files> && git commit -m "M2 fixes: <scope>" (plain commit, no Co-Authored-By). Return the structured result.
`
const SCOPES = [
  { key: 'fixD-server', scope: `SERVER + SESSION (src/agent/session.ts, src/server/app.ts, src/server/routes/threads.ts, src/server/routes/lanes.ts, src/server/ws.ts, tests/agent/session.test.ts, tests/server/*.test.ts):
1. interrupt(): a generation counter captured when a turn is queued; run() skips turns queued before the last interrupt (emit agent.error 'interrupted' for them, still append nothing to the thread or append the user message only, your call, but document it in the test), abort the running turn, and await the tail so app.close() (threads.ts onClose) never leaves a turn writing after shutdown. Regression: two sends queued, interrupt → queryImpl called once.
2. Origin/Host guard: an app-wide onRequest hook in app.ts returning 403 when the Host header is not 127.0.0.1:<port>|localhost:<port> (port from the request's socket/localAddress; in tests with app.inject the host is 'localhost:80', accept any port for those two hostnames) or when a present Origin header's hostname is not 127.0.0.1/localhost; apply to the /ws upgrade too. Regression: inject with Host attacker.example → 403; normal inject → 200.
3. Stale session id: when a resumed query yields a result with subtype error_during_execution whose errors mention 'No conversation found', clear the stored session id and retry once without resume; only persist session_id from a success result. Regression with a fake queryImpl.
4. lanes.ts: on preview thumb failure emit thumb.failed (hash, slideId, message) instead of agent.error. Regression: FailingThumbs subclass → one thumb.failed event.
5. Tighten tests/agent/session.test.ts around line 120: assert the range section lists s2, s3, s4 with their story lines and not s1, s5.
6. ws.ts / api: add a reconnect notification: the server sends { type: 'hello', version } right after a socket opens (add 'hello' to BusEvent in src/server/bus.ts with version: number) so clients can resync after reconnects (the web side is handled by the other agent; you only emit it).` },
  { key: 'fixE-web', scope: `WEB (web/src/components/LaneRow.tsx, web/src/screens/Main.tsx, web/src/api.ts, web/src/components/Thread.tsx, tests/web/laneRow.test.tsx, tests/web/main.test.tsx (new)):
1. LaneRow.laneCells: every pending change gets a cell, including a modify/remove on a slide outside the anchor range (keep the cell if the slide has any live change). Regression: anchor s2..s4 with a modify on s5 renders accept/refuse buttons for that change.
2. Explicit grid columns: each cell is placed at the main column of the slide it relates to (unchanged/modified/removed → its own main index; insert/move → the column of its 'after' slide, drawn as a narrow marker/stacked card inside that column, or widen the region to include the target). No flex-index positioning. Regression: a lane with an insert after s3 and a modify on s5 puts the modify under column 5.
3. Main.reload keeps existing thumb URLs and only re-requests thumbs for slides that are new or whose content changed (compare hashSlide or a JSON of the slide fields); the others keep their URL. Regression: after a deck.changed that modifies one slide, thumbFor is called once for that slide only.
4. Granular events: lane.created/updated → refresh that lane (getLane + preview); lane.closed → drop it; deck.changed → full reload of lanes; coalesce bursts with a 100 ms debounce. Regression: a lane.updated event triggers exactly one preview fetch for that lane and none for others.
5. Reconnect resync: api.subscribe(handler) delivers a synthetic { type: 'hello', version } on every (re)open (the server also sends a real 'hello'); Main reloads deck+lanes on hello when the version differs from the one it shows; Thread reloads its messages and clears streaming/tool state on hello. Regression: simulate a second open → reload called.
6. thumb.failed for lane previews: on thumb.failed match lane preview thumbs by hash and show the failed placeholder with a retry (re-request the lane preview). Regression: event with a preview hash marks that cell.
Add 'hello' to the BusEvent union in web/src/api.ts if it re-exports from src/server/bus.ts (the server agent adds { type: 'hello'; version: number } there; if it is not present in your worktree yet, extend the union locally in api.ts with the same shape).` },
]
const RESULT = { type: 'object', properties: { scope: { type: 'string' }, branch: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, not_fixed: { type: 'array', items: { type: 'string' } }, tests_run: { type: 'number' }, tests_passed: { type: 'number' }, typecheck_ok: { type: 'boolean' }, notes: { type: 'string' } }, required: ['scope', 'branch', 'fixed', 'not_fixed', 'tests_run', 'tests_passed', 'typecheck_ok'] }
phase('Fix')
return await parallel(SCOPES.map(s => () => agent(`${COMMON.replace(/WORKTREE/g, WT + s.key)}\nWORKTREE = ${WT}${s.key} (branch wt/${s.key}).\nYOUR SCOPE: ${s.scope}`, { label: s.key, phase: 'Fix', schema: RESULT, model: 'opus' })))
