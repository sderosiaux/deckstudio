import { briefBlock, deckOutline, jsonContract, type CheckDef } from './index.js';

export const order: CheckDef = {
  name: 'order',
  needsThumbs: false,
  system:
    'You check the order of introduction of concepts in a technical conference deck, as a first-time viewer would experience it. ' +
    'You are precise and name slides as "slide N (title)". You answer with JSON only.',
  buildPrompt({ brief, snap, deckOrder, allowLanes }) {
    return `${briefBlock(brief)}

${deckOutline(snap, deckOrder, { bodies: true })}

# Task
A concept is a noun phrase a slide relies on for the viewer to follow it, e.g. "share group", "Interactive Queries", "compacted topic". A concept is introduced on the slide that first explains or defines it.
List every concept that a slide uses before the slide that introduces it, and every concept used but never introduced anywhere (unless the audience in the brief can be assumed to know it).
One remark per concept: anchor it on the slide where the concept is first used ({ "kind": "slide", "slide": "<id>" }), and in the text name the concept and the slide where it is defined, as "slide N (title)" (or say it is never defined). Use "warn" when the slide cannot be followed without it, "info" otherwise.
A fitting lane moves the defining slide earlier or adds a short definition where the concept is first used.

${jsonContract(allowLanes)}`;
  },
};
