import type { FastifyInstance } from 'fastify';
import type { DeckStore } from '../../store/deckStore.js';

export function versionRoutes(app: FastifyInstance, store: DeckStore): void {
  app.get('/api/versions', async () => store.versions());

  app.get<{ Params: { n: string } }>('/api/versions/:n', async (req, reply) => {
    if (!/^\d+$/.test(req.params.n)) return reply.code(400).send({ error: `invalid version "${req.params.n}"` });
    const n = Number(req.params.n);
    const known = (await store.versions()).some((v) => v.n === n);
    if (!known) return reply.code(404).send({ error: `version ${n} does not exist` });
    return store.snapshotAt(n);
  });
}
