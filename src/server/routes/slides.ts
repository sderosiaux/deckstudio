import type { FastifyInstance } from 'fastify';
import { applyChange, validateBody } from '../../model/ops.js';
import { SlidePatchSchema } from '../../model/schema.js';
import { deckOf } from '../deckRequest.js';

const MANUAL = 'manual';
// A slide asset is a single file of the deck's assets folder: a bare name or `assets/<name>`, never a path.
const ASSET_NAME = /^(?:assets\/)?[A-Za-z0-9._-]+$/;

function badAssetNames(assets: readonly string[]): string[] {
  return assets.filter((a) => {
    if (!ASSET_NAME.test(a)) return true;
    const name = a.replace(/^assets\//, '');
    return name === '.' || name === '..';
  });
}

export function slideRoutes(app: FastifyInstance): void {
  app.get<{ Params: { id: string } }>('/api/slides/:id', async (req, reply) => {
    const slide = await deckOf(req).store.slide(req.params.id);
    if (!slide) return reply.code(404).send({ error: `unknown slide ${req.params.id}` });
    return slide;
  });

  // The creator's direct edit: recorded like an accepted change of a pseudo-lane "manual".
  app.patch<{ Params: { id: string } }>('/api/slides/:id', async (req, reply) => {
    const parsed = SlidePatchSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid slide patch: ${parsed.error.message}` });
    const patch = Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined));
    if (Object.keys(patch).length === 0) return reply.code(400).send({ error: 'empty slide patch: send at least one of title, story, notes, body, assets, kind' });

    const { body, assets } = parsed.data;
    if (body !== undefined) {
      const check = validateBody(body);
      if (!check.ok) return reply.code(400).send({ error: 'invalid slide body', reasons: check.reasons });
    }
    if (assets !== undefined) {
      const bad = badAssetNames(assets);
      if (bad.length > 0) {
        return reply.code(400).send({ error: 'invalid asset names: use a file name of the assets folder (name or assets/<name>)', reasons: bad });
      }
    }

    const { store, bus } = deckOf(req);
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
