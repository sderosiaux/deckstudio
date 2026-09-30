import { jsonContract, type CheckDef } from './index.js';

export const render: CheckDef = {
  name: 'render',
  needsThumbs: true,
  system:
    'You review rendered slides (1280x720 screenshots) of a conference deck for legibility and composition. ' +
    'You look at every image you are given before judging. Your final answer is JSON only.',
  buildPrompt({ snap, thumbs, allowLanes }) {
    const lines = snap.order.flatMap((id, i) => {
      const s = snap.slides[id];
      const path = thumbs?.[id];
      if (!s || !path) return [];
      return [`${i + 1}. id=${id} (${s.kind}) title: ${s.title}\n   image: ${path}`];
    });
    return `<slides>
${lines.join('\n')}
</slides>

# Task
Read every image path above with the Read tool (several per turn), then judge each slide as it would be seen from the back of a room:
- text smaller than about 24px at 1280x720;
- a bullet or numbered list;
- more than one idea on the slide;
- an empty stage (a title and nothing that carries the idea);
- overflow: content cut at an edge, overlapping, or outside the stage.
One remark per problem, anchored on the slide ({ "kind": "slide", "slide": "<id>" }). Use "warn" for overflow, unreadable text, and lists; "info" otherwise. Say nothing about slides that are fine.

${jsonContract(allowLanes)}`;
  },
};
