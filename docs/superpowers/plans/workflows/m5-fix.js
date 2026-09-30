export const meta = {
  name: 'deckstudio-m5-fix',
  description: 'Milestone 5 fixes: two Opus agents apply the confirmed review findings (history service; history screen) in parallel worktrees with regression tests',
  phases: [{ title: 'Fix', detail: 'history service / history screen' }],
}
const REPO = '/Users/sderosiaux/code/personal/deckstudio'
const WT = '/Users/sderosiaux/code/personal/deckstudio-wt/'
const FINDINGS = `${REPO}/docs/superpowers/plans/review-m5.json`
const COMMON = `
You fix confirmed review findings of the deckstudio repo inside a dedicated git worktree at WORKTREE (absolute path below). ALWAYS work there (cd WORKTREE && <command>); never touch ${REPO}. node_modules is symlinked.
Read first: ${FINDINGS} ("confirmed" array: claim, evidence, fix_hint; several entries repeat the same finding from different lenses; only those in YOUR SCOPE are yours), then the files you will change and their tests. Contracts in src/model/types.ts and schema.ts do not change.
Rules: for each finding, add a regression test that fails, then fix, then run it and the full suite (pnpm typecheck && pnpm test). TypeScript ESM (.js suffixes), strict, no fixed sleeps, no placeholders. Only touch files in your scope (plus their tests). Do not edit package.json. Throwaway repro files go under /tmp, never in the repo.
When done: git add <files> && git commit -m "M5 fixes: <scope>" (plain commit, no Co-Authored-By). Return the structured result.
`
const SCOPES = [
  { key: 'fixJ-history', scope: `HISTORY SERVICE (src/server/historyService.ts, src/server/routes/history.ts, src/server/laneService.ts (only to extract a shared helper), src/store/deckStore.ts (only versions()), tests/server/history.test.ts, tests/store/*.test.ts if you touch versions()):
1. restore of a 'modified' entry copies back only entry.fields from the source version onto main's current slide (other fields keep main's value); the 'no longer applies' 409 check compares those fields only. Regression: v1 → v2 title change → v3 notes change; restore the v1..v2 title entry → title back, notes 'later' kept.
2. restore rebases open lanes exactly like LaneService.accept: extract one shared helper (e.g. rebaseOpenLanesAfterMain(store, bus, ...) in laneService.ts) used by both accept and restore, which orphans changes, closes lanes with no pending change, resolves remarks whose sourceLaneId is a closed lane (resolveLaneRemarks) and emits lane.updated / lane.closed / remarks.changed. Regression: restore that orphans a lane resolves its sourceLaneId remark and emits remarks.changed.
3. Only committed versions: DeckStore.versions() (and therefore /api/versions, snapshotAt, history diff/restore/open-as-lane) ignores v{n}.json files with n > state().version. Regression: write an orphan v99.json into a temp deck → versions() does not list it; GET /api/history/diff?a=1&b=99 → 400.
4. open-as-lane is accept-order independent: for insert and move changes choose 'after' = the nearest preceding slide in the target order that is neither inserted nor moved by the lane (a stable anchor), or null. Regression: the existing property test (accept all changes in order → main equals v<n>) plus the same in reverse order and in a shuffled order (seeded, deterministic).
5. Add the missing test: restore when main has moved past version b of the compared pair (a < b < latest) still applies the single entry and keeps later edits.` },
  { key: 'fixK-history-web', scope: `HISTORY SCREEN (web/src/screens/History.tsx, web/src/api.ts (only the openVersionAsLane return type), tests/web/history.test.tsx):
1. api.openVersionAsLane returns { laneId: string } (the server answers { laneId }); History.tsx uses it accordingly (navigate to / after the call). Regression: the test asserts the call resolves to { laneId }.
2. refresh() keeps the thumbnail map and the requested set; it only clears and re-requests the ids whose slide content changed between the previous deck and the new one (compare the slide fields, like Main's shownSlides). Regression: after deck.changed where one slide changed, thumbFor is called once (that slide) and other thumbs keep their URL.
3. A restore refreshes once: drop the client-side refresh after restoreEntry and rely on the server's deck.changed event; give refresh a request-id guard so a stale response is dropped. Regression: with a subscribe fake emitting deck.changed after restore, getVersions is called exactly once more.` },
]
const RESULT = { type: 'object', properties: { scope: { type: 'string' }, branch: { type: 'string' }, fixed: { type: 'array', items: { type: 'string' } }, not_fixed: { type: 'array', items: { type: 'string' } }, tests_run: { type: 'number' }, tests_passed: { type: 'number' }, typecheck_ok: { type: 'boolean' }, notes: { type: 'string' } }, required: ['scope', 'branch', 'fixed', 'not_fixed', 'tests_run', 'tests_passed', 'typecheck_ok'] }
phase('Fix')
return await parallel(SCOPES.map(s => () => agent(`${COMMON.replace(/WORKTREE/g, WT + s.key)}\nWORKTREE = ${WT}${s.key} (branch wt/${s.key}).\nYOUR SCOPE: ${s.scope}`, { label: s.key, phase: 'Fix', schema: RESULT, model: 'opus' })))
