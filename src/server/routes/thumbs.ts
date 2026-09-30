import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import type { ThumbService } from '../../render/thumbs.js';
import type { DeckStore } from '../../store/deckStore.js';
import type { Bus } from '../bus.js';

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const PNG_NAME = /^([a-f0-9]{64})\.png$/;

/** Public thumb ids are the render hash (assembled HTML + asset bytes), so files serve straight from the cache dir. */
export function thumbRoutes(app: FastifyInstance, store: DeckStore, thumbs: ThumbService, bus: Bus): void {
  const inflight = new Set<string>();

  app.get<{ Params: { slideId: string } }>('/api/thumbs/for/:slideId', async (req, reply) => {
    const slide = await store.slide(req.params.slideId);
    if (!slide) return reply.code(404).send({ error: `unknown slide ${req.params.slideId}` });
    const hash = await thumbs.thumbHash(slide);
    const ready = await exists(thumbs.thumbPath(hash));
    if (!ready && !inflight.has(hash)) {
      inflight.add(hash);
      thumbs
        .thumb(slide)
        .then(
          () => bus.emit({ type: 'thumb.ready', hash, slideId: slide.id }),
          (err: unknown) => {
            app.log.error({ err, slideId: slide.id }, 'thumbnail render failed');
            bus.emit({ type: 'thumb.failed', hash, slideId: slide.id, message: err instanceof Error ? err.message : String(err) });
          },
        )
        .finally(() => inflight.delete(hash));
    }
    return { hash, ready };
  });

  app.get<{ Params: { file: string } }>('/api/thumbs/:file', async (req, reply) => {
    const m = PNG_NAME.exec(req.params.file);
    const path = m?.[1] ? thumbs.thumbPath(m[1]) : undefined;
    if (!path || !(await exists(path))) return reply.code(404).send({ error: 'thumbnail not rendered' });
    return reply.type('image/png').header('cache-control', 'public, max-age=31536000, immutable').send(createReadStream(path));
  });
}
