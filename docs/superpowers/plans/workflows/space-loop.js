export const meta = {
  name: 'deckstudio-space-loop',
  description: 'Space-usage loop: measure every screen in the real DOM (coverage above the fold, largest slide render) at two viewports, fix per screen family in worktrees, re-measure, up to 3 rounds',
  phases: [{ title: 'Measure', detail: 'four screens, two viewports' }, { title: 'Fix', detail: 'per screen family, worktrees' }],
}
// args: { url, repo, wt, outDir, maxRounds }
const { url, repo, wt, outDir, maxRounds } = args
const RULE = `
Space rule (decided by the creator and the architect): deckstudio is a presentation tool, so the slide render is always the largest element on screen. On every screen the before/after renders fill the available width; empty paper above the fold is at most 25% of the viewport at 1440x900 and at 1920x1080; the largest slide render is at least 40% of the viewport width on focus and on the slide screen, and at least 30% on main when a slide is selected. A move shows both strips large, with the moved slide bigger than its neighbours, never two 5-thumb excerpts in a corner. Text columns stay under 80 characters, so freed width goes to the renders, not to longer lines.`
const MEASURE = { type: 'object', properties: { screen: { type: 'string' }, results: { type: 'array', items: { type: 'object', properties: { viewport: { type: 'string' }, coverage_above_fold: { type: 'number' }, largest_render_width_ratio: { type: 'number' }, empty_bands: { type: 'array', items: { type: 'string' } }, screenshot: { type: 'string' }, verdict: { type: 'string', enum: ['pass', 'fail'] }, why: { type: 'string' } }, required: ['viewport', 'coverage_above_fold', 'largest_render_width_ratio', 'empty_bands', 'screenshot', 'verdict', 'why'] } } }, required: ['screen', 'results'] }
const FIX = { type: 'object', properties: { scope: { type: 'string' }, branch: { type: 'string' }, commit: { type: 'string' }, applied: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } }, tests_ok: { type: 'boolean' } }, required: ['scope', 'branch', 'applied', 'skipped', 'tests_ok'] }

const SCREENS = [
  { key: 'main', open: `open ${url}; then click slide 4 (a selection with its conversation panel); measure both states (nothing selected, slide 4 selected)` },
  { key: 'slide', open: `open ${url}, click slide 5, press Enter (the /slide/<id> screen)` },
  { key: 'focus', open: `open ${url}, find a lane row (open a draft from a remark if none), click a cell to reach /lane/<id>/change/<id>; if the lane has a move change, measure that one too` },
  { key: 'history', open: `open ${url}history; click v1 then shift-click the latest (dispatch a MouseEvent with shiftKey when agent-browser cannot hold shift)` },
]
const measurePrompt = (s, round) => `You measure how the deckstudio screen "${s.key}" uses the viewport, on the real app, with agent-browser only (never edit files). Steps: for each viewport in [1440x900, 1920x1080]: agent-browser set viewport W H; ${s.open}; wait for thumbnails (poll snapshots, no fixed sleeps); screenshot to ${outDir}/round-${round}/${s.key}-WxH.png (mkdir -p). Then measure in the page with agent-browser eval: coverage_above_fold = area of the union of bounding boxes of visible elements that carry content (img, canvas, text nodes' parents with non-empty text, button, input, textarea) clipped to the viewport, divided by the viewport area (approximate the union with a 20px grid: mark cells covered by any content box, count cells); largest_render_width_ratio = width of the largest visible slide render (img under a slide preview/thumb/figure, or the stage) divided by the viewport width; empty_bands = list of horizontal bands above the fold taller than 120px with no content ("y 300-780 across x 120-1600"). Verdict pass when coverage ≥ 0.75 and largest_render_width_ratio meets the rule for this screen; else fail with a one-sentence why naming the biggest empty band.${RULE}
Return the structured result (screen = "${s.key}").`

const FAMILIES = [
  { key: 'main', files: 'web/src/screens/Main.tsx, web/src/components/{Filmstrip,LaneRow,Thread,Remark,RemarkRow,Thumb}.tsx, web/src/theme.css (main rules), tests/web/{main,mainPanel,laneRow}.test.tsx', screens: ['main'] },
  { key: 'slide-focus', files: 'web/src/screens/{Slide,Focus}.tsx, web/src/components/{SlidePreview,TextDiff}.tsx, web/src/theme.css (slide/focus rules), tests/web/{slide,focus}.test.tsx', screens: ['slide', 'focus'] },
  { key: 'history', files: 'web/src/screens/History.tsx, web/src/components/{DiffFilmstrips,VersionLine}.tsx, web/src/theme.css (history rules), tests/web/history.test.tsx', screens: ['history'] },
]
const fixPrompt = (f, measures, round) => `You make the deckstudio screens ${f.screens.join(' and ')} use the viewport, inside the git worktree ${wt}/space-${f.key}-r${round} (branch wt/space-${f.key}-r${round}). ALWAYS work there; never touch ${repo}. node_modules is symlinked. Files in scope: ${f.files}.
Measurements that failed (real DOM, two viewports, with screenshots to open with the Read tool): ${JSON.stringify(measures)}.${RULE}
Design constraints: ledger layout from docs/superpowers/plans/decisions.md (M6), light theme, existing tokens, sentence case, accent only for diffs/selection/primary actions. Concretely: focus → the before/after pair spans the whole body width (each render about 45% of the body, 16:9), the diff under it uses the remaining height, the thread column stays 320px; a move shows two full strips (the moved slide at about 2x its neighbours, strips scrolled to it) instead of two excerpts in a corner. Slide screen → the render fills the left column width (up to 1100px) and the conversation sits under it with no empty band; right column lanes/remarks fill their height. Main → with a slide selected, the stage under the strip shows the selected slide's render at ≥ 30% of the viewport width with the conversation beside it, pushing lanes down; with nothing selected, lanes and the versions rail take the height (no empty band above the rail). History → the two strips scale their thumbs to use the width (up to 240px each) and the compare sits with no empty band under the rail.
Rules: TDD where a behaviour changes, TypeScript ESM (.js suffixes), strict, no fixed sleeps, throwaway files under /tmp only, do not edit package.json; run tests with "pnpm test --reporter=dot [file]" (never "pnpm test -- …"). Verify on a copy of the demo deck (copy ${repo}/decks/dss-sf-2026 to /tmp/space-${f.key}-r${round}-deck, pnpm build, DECKSTUDIO_PORT=<4300+> DECKSTUDIO_NO_OPEN=1 node bin/deckstudio.js <copy>) with agent-browser at 1440x900 and 1920x1080, screenshots under /tmp/space-${f.key}-r${round}/, then stop the server. When done: pnpm typecheck && pnpm test --reporter=dot green; git add <files> && git commit -m "space: ${f.screens.join('+')} fill the viewport (round ${round})" (plain commit, no Co-Authored-By). Return the structured result.`

const rounds = []
let failing = null
for (let r = 1; r <= (maxRounds ?? 3); r++) {
  phase('Measure')
  const measures = (await parallel(SCREENS.map(s => () => agent(measurePrompt(s, r), { label: `measure:${s.key}:r${r}`, phase: 'Measure', schema: MEASURE, model: 'opus' })))).filter(Boolean)
  const failed = measures.filter(m => m.results.some(x => x.verdict === 'fail'))
  const summary = measures.map(m => `${m.screen}: ${m.results.map(x => `${x.viewport} cov ${x.coverage_above_fold} render ${x.largest_render_width_ratio} ${x.verdict}`).join(' | ')}`)
  rounds.push({ round: r, summary })
  log(`round ${r}: ${failed.length}/${measures.length} screens fail`)
  failing = failed
  if (failed.length === 0) break
  if (r === (maxRounds ?? 3)) break
  phase('Fix')
  const fams = FAMILIES.filter(f => failed.some(m => f.screens.includes(m.screen)))
  await parallel(fams.map(f => () => agent(fixPrompt(f, failed.filter(m => f.screens.includes(m.screen)), r), { label: `fix:${f.key}:r${r}`, phase: 'Fix', schema: FIX, model: 'opus' })))
  // The architect merges, rebuilds and restarts between rounds: this script returns after one fix wave.
  return { rounds, pendingMerge: fams.map(f => `wt/space-${f.key}-r${r}`), failing }
}
return { rounds, pendingMerge: [], failing }
