export const meta = {
  name: 'deckstudio-review',
  description: 'Milestone review: seven reviewers over the milestone diff, dedup, adversarial verification of each finding',
  phases: [{ title: 'Review', detail: 'seven lenses' }, { title: 'Verify', detail: 'reproduce or reject each finding' }],
}
// args: { repo, base, head, milestone, specPath, planPath }
const { repo, base, head, milestone, specPath, planPath } = args
const LENSES = [
  ['correctness', 'logic errors, off-by-one, wrong state transitions, unhandled null/undefined, async races, wrong immutability (mutated inputs)'],
  ['security', 'path traversal in file routes, HTML injection in assembled slides (script/on* stripping), unsafe file writes, unbounded inputs'],
  ['tests', 'tests that do not test what they claim, missing edge cases named in the plan Review Focus, fixed sleeps, mocked units under test, flaky ordering'],
  ['maintainability', 'duplicated logic, contracts drifted between modules (types vs schema vs implementation), naming inconsistent with the plan interfaces, dead code'],
  ['performance', 'unbounded loops over the deck on every request, re-rendering thumbnails needlessly, synchronous fs on hot paths, memory leaks in the browser/page lifecycle'],
  ['operations', 'crash paths without a clear error, missing cleanup (browser, sockets, temp dirs), startup order, CLI usability, logs that lie'],
  ['spec-contract', 'behaviour that contradicts the spec or the plan Interfaces blocks: storage layout, tool contracts, anchors, version semantics, light theme, no bullet lists'],
]
const FINDINGS = { type: 'object', properties: { findings: { type: 'array', items: { type: 'object', properties: {
  file: { type: 'string' }, line: { type: 'number' }, severity: { type: 'string', enum: ['high', 'medium', 'low'] },
  claim: { type: 'string' }, repro: { type: 'string' } }, required: ['file', 'line', 'severity', 'claim', 'repro'] } } }, required: ['findings'] }
const VERDICT = { type: 'object', properties: { verdict: { type: 'string', enum: ['CONFIRMED', 'REJECTED'] }, evidence: { type: 'string' }, fix_hint: { type: 'string' } }, required: ['verdict', 'evidence'] }
phase('Review')
const reviews = await parallel(LENSES.map(([name, focus]) => () => agent(`You review milestone "${milestone}" of the deckstudio repo at ${repo}. Diff to review: run cd ${repo} && git diff ${base}..${head} --stat then read the changed files in full (git diff ${base}..${head} -- <file>). Spec: ${specPath}. Plan (Interfaces and Review Focus sections): ${planPath}.
Lens: ${name} — ${focus}. Report only findings you can point to with file and line and a concrete reproduction (a command, a test, or an input). No style nits. Severity: high = wrong behaviour or data loss reachable in normal use; medium = wrong in an edge case named by the plan or spec; low = the rest. Return at most 8 findings.`, { label: `review:${name}`, phase: 'Review', schema: FINDINGS, model: 'opus' })))
const all = reviews.filter(Boolean).flatMap(r => r.findings)
const seen = new Set()
const deduped = all.filter(f => { const k = `${f.file}:${f.line}:${f.claim.slice(0, 40)}`; if (seen.has(k)) return false; seen.add(k); return true })
const toVerify = deduped.filter(f => f.severity !== 'low')
log(`${all.length} findings, ${deduped.length} unique, ${toVerify.length} to verify (low severity skipped: ${deduped.length - toVerify.length})`)
phase('Verify')
const verified = await parallel(toVerify.map(f => () => agent(`Repo ${repo} at ${head}. A reviewer claims: "${f.claim}" at ${f.file}:${f.line}, reproduction: "${f.repro}". Try to reproduce it for real (write and run a throwaway vitest test under /tmp or run the command; do not commit anything, do not modify tracked files). Default to REJECTED if you cannot reproduce. Return evidence (the command and its output) and, if CONFIRMED, a one-line fix hint.`, { label: `verify:${f.file.split('/').pop()}:${f.line}`, phase: 'Verify', schema: VERDICT, model: 'opus' }).then(v => ({ ...f, ...v }))))
return { confirmed: verified.filter(Boolean).filter(v => v.verdict === 'CONFIRMED'), rejected: verified.filter(Boolean).filter(v => v.verdict === 'REJECTED'), low: deduped.filter(f => f.severity === 'low') }
