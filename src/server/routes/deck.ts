import type { FastifyInstance } from 'fastify';
import { deckOf } from '../deckRequest.js';

export function deckRoutes(app: FastifyInstance): void {
  app.get('/api/deck', async (req) => {
    const { store } = deckOf(req);
    const [state, brief, { order, slides }] = await Promise.all([store.state(), store.brief(), store.snapshot()]);
    return { state, brief, order, slides };
  });
}
