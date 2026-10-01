import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { Slide } from '../../model/types.js';
import { deckOf } from '../deckRequest.js';
import type { DeckServices } from '../deckServices.js';

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const PNG_NAME = /^([a-f0-9]{64})\.png$/;

/** Public thumb ids are the render hash (assembled HTML + asset bytes), so files serve straight from the cache dir. */
export function thumbRoutes(app: FastifyInstance): void {
  // Renders in flight, by hash, per deck: two decks may share a hash but not a cache dir.
  const inflightOf = new WeakMap<DeckServices, Set<string>>();

  /**
   * The slide's hash and whether its PNG exists; enqueues the render when it does not. `slideId` goes on the bus
   * events: null for a past version's slide, which clients must not take for main's slide of that id.
   */
  const status = async (deck: DeckServices, slide: Slide, slideId: string | null): Promise<{ hash: string; ready: boolean }> => {
    const { thumbs, bus } = deck;
    let inflight = inflightOf.get(deck);
    if (!inflight) inflightOf.set(deck, (inflight = new Set()));
    const flying = inflight;
    const hash = await thumbs.thumbHash(slide);
    const ready = await exists(thumbs.thumbPath(hash));
    if (!ready && !flying.has(hash)) {
      flying.add(hash);
      thumbs
        .thumb(slide)
        .then(
          () => bus.emit({ type: 'thumb.ready', hash, slideId }),
          (err: unknown) => {
            app.log.error({ err, slideId: slide.id }, 'thumbnail render failed');
            bus.emit({ type: 'thumb.failed', hash, slideId, message: err instanceof Error ? err.message : String(err) });
          },
        )
        .finally(() => flying.delete(hash));
    }
    return { hash, ready };
  };

  app.get<{ Params: { slideId: string } }>('/api/thumbs/for/:slideId', async (req, reply) => {
    const deck = deckOf(req);
    const slide = await deck.store.slide(req.params.slideId);
    if (!slide) return reply.code(404).send({ error: `unknown slide ${req.params.slideId}` });
    return status(deck, slide, slide.id);
  });

  // A slide as it was in version n: the history shows past versions as renders, not as title cards.
  app.get<{ Params: { n: string; slideId: string } }>('/api/thumbs/version/:n/:slideId', async (req, reply) => {
    if (!/^\d+$/.test(req.params.n)) return reply.code(400).send({ error: `invalid version "${req.params.n}"` });
    const n = Number(req.params.n);
    const deck = deckOf(req);
    const { store } = deck;
    if (!(await store.versions()).some((v) => v.n === n)) return reply.code(404).send({ error: `version ${n} does not exist` });
    const slide = (await store.snapshotAt(n)).slides[req.params.slideId];
    if (!slide) return reply.code(404).send({ error: `slide ${req.params.slideId} is not in v${n}` });
    return status(deck, slide, null);
  });

  app.get<{ Params: { file: string } }>('/api/thumbs/:file', async (req, reply) => {
    const m = PNG_NAME.exec(req.params.file);
    const path = m?.[1] ? deckOf(req).thumbs.thumbPath(m[1]) : undefined;
    if (!path || !(await exists(path))) return reply.code(404).send({ error: 'thumbnail not rendered' });
    return reply.type('image/png').header('cache-control', 'public, max-age=31536000, immutable').send(createReadStream(path));
  });
}
