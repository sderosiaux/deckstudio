import type { FastifyInstance } from 'fastify';
import { BriefSchema } from '../../model/schema.js';
import type { DeckStore } from '../../store/deckStore.js';

export function briefRoutes(app: FastifyInstance, store: DeckStore): void {
  app.get('/api/brief', async () => store.brief());

  app.put('/api/brief', async (req, reply) => {
    const parsed = BriefSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid brief: ${parsed.error.message}` });
    await store.setBrief(parsed.data);
    return parsed.data;
  });
}
