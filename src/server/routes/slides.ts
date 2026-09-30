import type { FastifyInstance } from 'fastify';
import { applyChange } from '../../model/ops.js';
import { SlidePatchSchema } from '../../model/schema.js';
import type { DeckStore } from '../../store/deckStore.js';
import type { Bus } from '../bus.js';

const MANUAL = 'manual';

export function slideRoutes(app: FastifyInstance, store: DeckStore, bus: Bus): void {
  app.get<{ Params: { id: string } }>('/api/slides/:id', async (req, reply) => {
    const slide = await store.slide(req.params.id);
    if (!slide) return reply.code(404).send({ error: `unknown slide ${req.params.id}` });
    return slide;
  });

  // The creator's direct edit: recorded like an accepted change of a pseudo-lane "manual".
  app.patch<{ Params: { id: string } }>('/api/slides/:id', async (req, reply) => {
    const parsed = SlidePatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid slide patch: ${parsed.error.message}` });
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'empty slide patch: send at least one of title, story, notes, body, assets, kind' });

    const id = req.params.id;
    const outcome = await store.withLock(async () => {
      const snap = await store.snapshot();
      const res = applyChange(snap, { id: MANUAL, kind: 'modify', slide: id, patch, reason: 'direct edit', status: 'accepted' });
      if (!res.ok) return { ok: false as const, error: res.error };
      const version = await store.commit(res.next, { kind: 'accept', laneId: MANUAL, changeId: MANUAL });
      return { ok: true as const, version: version.n, slide: res.next.slides[id]! };
    });
    if (!outcome.ok) return reply.code(404).send({ error: outcome.error });
    bus.emit({ type: 'deck.changed', version: outcome.version });
    return outcome.slide;
  });
}
