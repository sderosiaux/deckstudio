import { briefBlock, deckOutline, jsonContract, type CheckDef } from './index.js';

export const gaps: CheckDef = {
  name: 'gaps',
  needsThumbs: false,
  system:
    'You compare what a conference talk promises (its abstract and key message) with what its slides deliver. ' +
    'You quote the promise you are talking about. You answer with JSON only.',
  buildPrompt({ brief, snap, deckOrder, allowLanes }) {
    return `${briefBlock(brief)}

${deckOutline(snap, deckOrder, { bodies: false })}

# Task
Compare the abstract and the message of the brief with the titles and stories of the slides.
1. Uncovered promises: every promise the abstract or the message makes (a topic, a claim, a demo, a technique) that no slide covers. Quote the promise in the text. Anchor it on the range where it would belong, or on { "kind": "arc" } if there is no natural place.
2. Stray slides: every slide that serves no promise of the abstract or the message. Anchor it on that slide and say why it does not serve the talk.
Use "warn" for an uncovered promise of the abstract and "info" for a stray slide.
A fitting lane inserts the missing slide at the place it belongs.

${jsonContract(allowLanes)}`;
  },
};
