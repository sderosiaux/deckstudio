import type { FastifyRequest } from 'fastify';
import type { DeckServices } from './deckServices.js';

declare module 'fastify' {
  interface FastifyRequest {
    /** The deck this request is about, set by deckPlugin's onRequest hook before any handler runs. */
    deck: DeckServices | null;
    /** URL path the deck is mounted under: '' for a single-deck app, '/d/<id>' in the studio. */
    deckBase: string;
  }
}

/** The resolved deck of a request handled inside deckPlugin. */
export function deckOf(req: FastifyRequest): DeckServices {
  if (!req.deck) throw new Error(`no deck resolved for ${req.method} ${req.url}: route registered outside deckPlugin`);
  return req.deck;
}
