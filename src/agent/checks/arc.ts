import { briefBlock, deckOutline, jsonContract, type CheckDef } from './index.js';

const PATTERNS = {
  'solution-first': 'solution-first: state the answer early, then decompose it into its parts, each slide opening one part of the answer.',
  'problem-driven': 'problem-driven: build up the tension first, then arrive at the answer as the resolution, each slide raising the stakes or removing an alternative.',
} as const;

export const arc: CheckDef = {
  name: 'arc',
  needsThumbs: false,
  system:
    'You review the narrative arc of a slide deck against its brief: who it is for, what it must leave them with, and the pattern it follows. ' +
    'You judge structure, not wording, and the brief is your only yardstick: you never hold the deck to a template of what some kind of deck should contain. ' +
    'You are terse and concrete: every remark names the slide it is about, as "slide N (title)", and what is wrong. You answer with JSON only.',
  buildPrompt({ brief, snap, deckOrder, allowLanes }) {
    return `${briefBlock(brief)}

${deckOutline(snap, deckOrder, { bodies: false })}

# Task
Judge the arc of this deck against its brief: its audience, its message, its abstract and its pattern, ${PATTERNS[brief.pattern]}
1. Opening: do the first slides give this audience a reason to follow, the way the pattern asks (${brief.pattern === 'solution-first' ? 'the answer, stated early' : 'a tension this audience feels'})? If not, say where it belongs.
2. Progression: does the deck ${brief.pattern === 'solution-first' ? 'decompose the answer' : 'build up to the answer'} slide after slide, toward the message, or does it stall, repeat, or jump?
3. Landing: do the last slides land the message of the brief?
Never report a part as missing because decks of some kind usually have one: only what the brief calls for counts.
Report at most 4 remarks, the most important first. Anchor each on the slide or range it is about; use { "kind": "arc" } only for a remark about the whole deck. Use "warn" for a structural problem and "info" for a suggestion.

${jsonContract(allowLanes)}`;
  },
};
