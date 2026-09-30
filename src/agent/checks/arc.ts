import { briefBlock, deckOutline, jsonContract, type CheckDef } from './index.js';

const PATTERNS = {
  'solution-first': 'solution-first: state the answer early, then decompose it into its parts, each slide opening one part of the answer.',
  'problem-driven': 'problem-driven: build up the tension first, then arrive at the answer as the resolution, each slide raising the stakes or removing an alternative.',
} as const;

export const arc: CheckDef = {
  name: 'arc',
  needsThumbs: false,
  system:
    'You review the narrative arc of a conference talk deck. You judge structure, not wording. ' +
    'You are terse and concrete: every remark names the slide it is about and what is wrong. You answer with JSON only.',
  buildPrompt({ brief, snap, allowLanes }) {
    return `${briefBlock(brief)}

${deckOutline(snap, { bodies: false })}

# Task
Judge the arc of this deck against its pattern, ${PATTERNS[brief.pattern]}
1. Hook: is there a hook (a question or a tension the audience wants resolved) within the first 3 slides? If not, say where one should go.
2. Progression: does the deck ${brief.pattern === 'solution-first' ? 'decompose the answer' : 'build up to the answer'} slide after slide, or does it stall, repeat, or jump?
3. Close: does the closing return to the opening (its question, image, or claim)?
Report at most 4 remarks, the most important first. Anchor each on the slide or range it is about; use { "kind": "arc" } only for a remark about the whole deck. Use "warn" for a structural problem and "info" for a suggestion.

${jsonContract(allowLanes)}`;
  },
};
