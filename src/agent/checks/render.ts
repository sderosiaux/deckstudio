import { designRulesBlock, jsonContract, slideName, type CheckDef } from './index.js';

export const render: CheckDef = {
  name: 'render',
  needsThumbs: true,
  system:
    'You review rendered slides (1280x720 screenshots) of a conference deck for legibility, composition, and the design rules of its creator when given. ' +
    'You look at every image you are given before judging. Your final answer is JSON only.',
  buildPrompt({ brief, snap, deckOrder, thumbs, allowLanes }) {
    const rules = designRulesBlock(brief);
    const lines = snap.order.flatMap((id) => {
      const s = snap.slides[id];
      const path = thumbs?.[id];
      if (!s || !path) return [];
      return [`${slideName(deckOrder, id, s.title)} · id=${id} · ${s.kind}\n   image: ${path}`];
    });
    return `${rules ? `${rules}\n\n` : ''}<slides>
${lines.join('\n')}
</slides>

# Task
Read every image path above with the Read tool (several per turn), then judge each slide as it would be seen from the back of a room:
- text smaller than about 24px at 1280x720;
- a bullet or numbered list;
- more than one idea on the slide;
- an empty stage (a title and nothing that carries the idea);
- overflow: content cut at an edge, overlapping, or outside the stage.${
      rules
        ? '\n- a slide that violates one of the design rules above: a "warn" remark that names the rule it breaks (quote it or paraphrase it closely) and what on the slide breaks it. One remark per rule broken.'
        : ''
    }
One remark per problem, anchored on the slide ({ "kind": "slide", "slide": "<id>" }). Use "warn" for overflow, unreadable text, lists${rules ? ', and broken design rules' : ''}; "info" otherwise. Never report the same problem twice on one slide. Say nothing about slides that are fine.

${jsonContract(allowLanes)}`;
  },
};
