import { createReadStream } from 'node:fs';
import { access } from 'node:fs/promises';
import type { FastifyInstance } from 'fastify';
import { hashSlide } from '../../model/ids.js';
import type { ThumbService } from '../../render/thumbs.js';
import type { DeckStore } from '../../store/deckStore.js';
import type { Bus } from '../bus.js';

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);
const PNG_NAME = /^([a-f0-9]{64})\.png$/;

/**
 * Public thumb ids are slide content hashes (hashSlide). ThumbService names its files by a render
 * hash (HTML + asset bytes) that it only reveals once thumb() resolves, so this route keeps the
 * slide-hash -> rendered-file mapping in memory. After a restart the first /for call re-resolves it
 * (thumb() returns immediately when the file is already cached).
 */
export function thumbRoutes(app: FastifyInstance, store: DeckStore, thumbs: ThumbService, bus: Bus): void {
  const rendered = new Map<string, string>();
  const inflight = new Set<string>();

  app.get<{ Params: { slideId: string } }>('/api/thumbs/for/:slideId', async (req, reply) => {
    const slide = await store.slide(req.params.slideId);
    if (!slide) return reply.code(404).send({ error: `unknown slide ${req.params.slideId}` });
    const hash = hashSlide(slide);
    const known = rendered.get(hash);
    const ready = known !== undefined && (await exists(known));
    // Re-resolve even when ready: an asset file replaced on disk changes the render but not hashSlide.
    if (!inflight.has(hash)) {
      inflight.add(hash);
      thumbs
        .thumb(slide)
        .then(
          (r) => {
            rendered.set(hash, r.path);
            if (!ready || known !== r.path) bus.emit({ type: 'thumb.ready', hash, slideId: slide.id });
          },
          (err: unknown) => app.log.error({ err, slideId: slide.id }, 'thumbnail render failed'),
        )
        .finally(() => inflight.delete(hash));
    }
    return { hash, ready };
  });

  app.get<{ Params: { file: string } }>('/api/thumbs/:file', async (req, reply) => {
    const m = PNG_NAME.exec(req.params.file);
    const path = m?.[1] ? rendered.get(m[1]) : undefined;
    if (!path || !(await exists(path))) return reply.code(404).send({ error: 'thumbnail not rendered' });
    return reply.type('image/png').header('cache-control', 'no-cache').send(createReadStream(path));
  });
}
