import type { FastifyInstance } from 'fastify';
import type { DeckStore } from '../../store/deckStore.js';

export function deckRoutes(app: FastifyInstance, store: DeckStore): void {
  app.get('/api/deck', async () => {
    const [state, brief, { order, slides }] = await Promise.all([store.state(), store.brief(), store.snapshot()]);
    return { state, brief, order, slides };
  });
}
