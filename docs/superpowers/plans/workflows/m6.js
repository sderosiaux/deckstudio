export const meta = {
  name: 'deckstudio-m6',
  description: 'Milestone 6: deck-loop on the tool screens. Targets from the mockups, then up to five rounds of fix (Opus) + fresh judge (Opus), exit at 8.',
  phases: [{ title: 'Targets', detail: 'three renders + capture round 0' }, { title: 'Loop', detail: 'fix → capture → judge, up to 5 rounds' }],
}
// args: { repo, url, mockups: {main, focus, history}, maxRounds }
const { repo, url, mockups, maxRounds } = args
const LOOP = `${repo}/.deck-loop`
const PLAN = `
Design plan for the deckstudio chrome (the tool around the deck), decided by the architect:
- Color: paper #FAF9F6 (page), card #FFFFFF, ink #17171A, grey #7A7873, line #E4E1DA, accent #E4572E (only for diffs, selection and primary actions). The deck's own palette is the tool's palette: the slides must look at home, the chrome must never compete with them.
- Type: Archivo for everything in the chrome (500/700 for labels and titles, 400 for text), IBM Plex Mono only for ids, hashes and code. One scale: 12 (meta), 13 (body), 15 (row labels), 20 (screen title). No all-caps labels, no tracked eyebrows, no middle-dot meta strings, no arrows appended to buttons.
- Layout: a workbench. Fixed left gutter (120px) carrying row names (main, lane labels) like the margin of a ledger; the filmstrip and the lane ribbons share one column grid so a lane reads as a strip laid under the slides it touches; the right panel (360px) is the notebook margin for the thread; the version line at the bottom is a thin rail, not a footer. Left aligned everywhere. Cards only where an object is manipulable (a slide, a remark); no cards around text.
- The memorable element: the lane ribbon under main with its accent diff marks (outline for added, dot for changed, dashed slot for removed, hairline connector for moved). Everything else stays quiet.
- Motion: only in answer to an action (a lane appearing, a version added); no entrance animations.
- Copy: sentence case, plain verbs, the same word for the same action everywhere (accept, refuse, discard, propose, run checks, restore).
`
const RENDER = { type: 'object', properties: { targets: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['targets'] }
const CAPTURE = { type: 'object', properties: { files: { type: 'array', items: { type: 'string' } }, notes: { type: 'string' } }, required: ['files'] }
const VERDICT = { type: 'object', properties: { score: { type: 'number' }, tier: { type: 'number' }, landed: { type: 'array', items: { type: 'string' } }, blocking: { type: 'array', items: { type: 'string' } }, directives: { type: 'array', items: { type: 'string' } }, photo_screen: { type: 'string' } }, required: ['score', 'tier', 'blocking', 'directives'] }
const FIX = { type: 'object', properties: { applied: { type: 'array', items: { type: 'string' } }, skipped: { type: 'array', items: { type: 'string' } }, commit: { type: 'string' }, tests_ok: { type: 'boolean' } }, required: ['applied', 'skipped', 'tests_ok'] }

const captureCmd = (round) => `Capture the three screens of the running app at ${url} with agent-browser at viewport 1440x900 into ${LOOP}/round-${round}/: main.png (the / route, with at least one open lane visible: if none is open, ask the co-author in the thread for a small lane on slides 2 to 4 and wait for it), focus.png (open a change of that lane in the focus route), history.png (the /history route with two versions selected). Use: agent-browser set viewport 1440 900; agent-browser open <url>; agent-browser screenshot; copy the file path printed to the target name. Return the three file paths.`

phase('Targets')
const targets = await agent(`Generate the three target renders for the deckstudio tool with ~/.claude/scripts/generate_image.py into ${LOOP}/target/{main,focus,history}.png, 16:9 (--aspect 16:9 --allow-text --quality high), one per mockup. Read each mockup first: ${mockups.main}, ${mockups.focus}, ${mockups.history}. Prompt each as "a flat screenshot of the finished screen of a desktop web app, edge to edge, no device frame" reproducing the mockup's layout and applying this design plan verbatim (palette, type, layout, quiet chrome, one accent):${PLAN}
Do not add illustration, gradients or decoration; the thumbnails inside the screens are tiny composed slides (title + one diagram), never bullet lists. Check each file exists and is 16:9 (sips -g pixelWidth -g pixelHeight). Return the paths.`, { label: 'targets', phase: 'Targets', schema: RENDER, model: 'opus' })
const cap0 = await agent(captureCmd(0), { label: 'capture:0', phase: 'Targets', schema: CAPTURE, model: 'opus' })

phase('Loop')
let prev = null
let best = { score: 0, round: 0 }
const rounds = []
for (let r = 1; r <= (maxRounds ?? 5); r++) {
  const verdict = await agent(`You are a design director judging the deckstudio tool screens against their targets. Open every file: targets ${targets.targets.join(', ')}; current captures ${(prev ? prev.files : cap0.files).join(', ')}${prev && prev.verdict ? `; previous verdict: ${JSON.stringify(prev.verdict)}` : ''}. Design plan the screens must follow:${PLAN}
Score 0-10 on a gated ladder: tier 1 (0-3) every screen shows its function legibly (filmstrip, lane ribbon with diff marks and accept/refuse, focus before/after, history compare), nothing overflows, text ≥ 12px; tier 2 (3-5) one clear reading order per screen, one grid shared by main and lanes, consistent margins, at most two type families; tier 3 (5-7) palette, type and density match the targets, the chrome is quiet and the accent only marks diffs, selection and primary actions, no AI-default chrome (all-caps eyebrows, middle-dot meta strings, arrow-suffixed buttons, identical cards everywhere); tier 4 (7-9) pixel alignment, consistent spacing across screens, copy in sentence case with one verb per action; tier 5 (9-10) better than the targets. If a previous verdict exists, mark each of its directives LANDED / PARTIAL / NOT DONE. Return the score, the tier, blocking items for the next gate, at most four directives each naming the screen, the element and the change with a magnitude, and the screen a user would screenshot.`, { label: `judge:${r}`, phase: 'Loop', schema: VERDICT, model: 'opus' })
  rounds.push({ round: r, score: verdict.score, tier: verdict.tier })
  log(`round ${r}: score ${verdict.score} tier ${verdict.tier}`)
  if (verdict.score > best.score) best = { score: verdict.score, round: r }
  if (verdict.score >= 8) { prev = { verdict, files: prev ? prev.files : cap0.files }; break }
  const fix = await agent(`Apply these design directives to the deckstudio web app at ${repo} (work directly on main; the app source is web/src, tokens in web/src/theme.css). Directives: ${JSON.stringify(verdict.directives)}. Blocking: ${JSON.stringify(verdict.blocking)}. Design plan to respect:${PLAN}
Rules: only web/src files and tests/web; keep pnpm typecheck && pnpm test green; then rebuild and restart the app: cd ${repo} && pnpm build && pkill -f 'bin/deckstudio.js'; sleep 1; (DECKSTUDIO_NO_OPEN=1 node bin/deckstudio.js decks/dss-sf-2026 > /tmp/ds.log 2>&1 &) ; sleep 4; curl -s -o /dev/null -w '%{http_code}' ${url}api/deck must print 200. Commit with git add web tests && git commit -m "M6 round ${r}: <summary>" (plain commit, no Co-Authored-By). Return what you applied, what you skipped and why.`, { label: `fix:${r}`, phase: 'Loop', schema: FIX, model: 'opus' })
  const cap = await agent(captureCmd(r), { label: `capture:${r}`, phase: 'Loop', schema: CAPTURE, model: 'opus' })
  prev = { verdict, files: cap.files, fix }
}
return { rounds, best, last: prev ? prev.verdict : null }
