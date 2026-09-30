import { access } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { ThumbService } from '../../render/thumbs.js';
import type { DeckStore } from '../../store/deckStore.js';
import type { Bus } from '../bus.js';
import { LaneError, type LaneService } from '../laneService.js';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

type Params = { id: string };
type ChangeParams = { id: string; cid: string };

export function laneRoutes(app: FastifyInstance, store: DeckStore, lanes: LaneService, thumbs: ThumbService, bus: Bus): void {
  const inflight = new Set<string>();

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof LaneError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get('/api/lanes', async () => (await store.lanes()).filter((l) => l.status === 'open'));

  app.get<{ Params: Params }>('/api/lanes/:id', async (req, reply) => {
    const lane = await store.lane(req.params.id);
    if (!lane) return reply.code(404).send({ error: `unknown lane ${req.params.id}` });
    return lane;
  });

  app.post<{ Params: ChangeParams }>('/api/lanes/:id/changes/:cid/accept', async (req, reply) => {
    try {
      return await lanes.accept(req.params.id, req.params.cid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: ChangeParams }>('/api/lanes/:id/changes/:cid/refuse', async (req, reply) => {
    try {
      return await lanes.refuse(req.params.id, req.params.cid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: Params }>('/api/lanes/:id', async (req, reply) => {
    try {
      await lanes.closeLane(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Preview slides are not on main, so /api/thumbs/for/:slideId cannot serve them: the response
  // carries the render hash of every changed slide, and renders are enqueued here.
  app.get<{ Params: Params }>('/api/lanes/:id/preview', async (req, reply) => {
    let preview;
    try {
      preview = await lanes.preview(req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
    const thumbStatus: Record<string, { hash: string; ready: boolean }> = {};
    for (const id of preview.changed) {
      const slide = preview.slides[id]!;
      const hash = await thumbs.thumbHash(slide);
      const ready = await exists(thumbs.thumbPath(hash));
      thumbStatus[id] = { hash, ready };
      if (ready || inflight.has(hash)) continue;
      inflight.add(hash);
      thumbs
        .thumb(slide)
        .then(
          () => bus.emit({ type: 'thumb.ready', hash, slideId: id }),
          (err: unknown) => {
            app.log.error({ err, slideId: id, laneId: req.params.id }, 'lane preview thumbnail render failed');
            bus.emit({ type: 'thumb.failed', hash, slideId: id, message: errorMessage(err) });
          },
        )
        .finally(() => inflight.delete(hash));
    }
    return { order: preview.order, slides: preview.slides, skipped: preview.skipped, thumbs: thumbStatus };
  });
}
