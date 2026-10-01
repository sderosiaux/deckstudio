import type { Brief } from './types.js';

/**
 * What a brand-new deck starts with. Generic on purpose: deckstudio serves any presentation,
 * so nothing here names a product, a conference or a technology.
 */
export const STARTER_DESIGN_RULES = `Stage 1280x720 on paper #FAF9F6, ink #17171A, one accent #E4572E, warm light greys; Archivo for text, IBM Plex Mono only for code and identifiers.
One claim per slide: the title states the message in sentence case, large, at the top of the stage; no eyebrow above it, no question as a title.
No bullet lists, no markdown, no paragraph under a visual: a visual stands alone with short large labels; what the speaker says lives in the story and notes fields, not on the stage.
Visuals fill the stage width between the margins (x 96..1184, y 160..640); flat and frontal, no gradients, no stock icons, no emoji.
Code, when shown, uses the .code card, at most 14 lines, never truncated to fit: split into two slides instead.
Never add meta slides (agenda, recap, "what we learned").`;

/** A new deck's brief: the creator fills title, audience and message; the rest has sane defaults. */
export function starterBrief(input: Pick<Brief, 'title' | 'audience' | 'message'> & Partial<Brief>): Brief {
  return {
    title: input.title,
    audience: input.audience,
    message: input.message,
    pattern: input.pattern ?? 'solution-first',
    abstract: input.abstract ?? '',
    design: { rules: input.design?.rules ?? STARTER_DESIGN_RULES, imageStyle: input.design?.imageStyle ?? '' },
  };
}
