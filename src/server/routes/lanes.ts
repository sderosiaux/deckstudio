import { access } from 'node:fs/promises';
import type { FastifyInstance, FastifyReply } from 'fastify';
import type { Change, Lane } from '../../model/types.js';
import { deckOf } from '../deckRequest.js';
import type { DeckServices } from '../deckServices.js';
import { LaneError } from '../laneService.js';

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

type Params = { id: string };
type ChangeParams = { id: string; cid: string };
type ListQuery = { status?: string };
const LIST_STATUSES = ['draft', 'open', 'all'] as const;

/** A lane as the routes answer it: each pending modify lists its variants (see withVariants). */
export type LaneView = Omit<Lane, 'changes'> & { changes: (Change & { variantOf?: string[] })[] };

const modifiedFields = (l: Lane): Set<string> =>
  new Set(l.changes.flatMap((c) => (c.kind === 'modify' && c.status === 'pending' ? Object.keys(c.patch).map((f) => `${c.slide}\u0000${f}`) : [])));

/**
 * Adds `variantOf` to each pending modify: the ids of the other open lanes with a pending modify of the same field
 * of the same slide. Computed at read time, never stored: accepting one variant orphans the others on rebase.
 */
export function withVariants(lanes: readonly Lane[], open: readonly Lane[]): LaneView[] {
  const fields = open.map((l) => ({ id: l.id, fields: modifiedFields(l) }));
  return lanes.map((lane) => ({
    ...lane,
    changes: lane.changes.map((c) => {
      if (c.kind !== 'modify' || c.status !== 'pending') return c;
      const keys = Object.keys(c.patch).map((f) => `${c.slide}\u0000${f}`);
      const variantOf = fields.filter((o) => o.id !== lane.id && keys.some((k) => o.fields.has(k))).map((o) => o.id);
      return { ...c, variantOf };
    }),
  }));
}

export function laneRoutes(app: FastifyInstance): void {
  // Preview renders in flight, by hash, per deck.
  const inflightOf = new WeakMap<DeckServices, Set<string>>();
  const inflightFor = (deck: DeckServices): Set<string> => {
    let set = inflightOf.get(deck);
    if (!set) inflightOf.set(deck, (set = new Set()));
    return set;
  };

  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof LaneError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  // Open lanes by default: drafts are check proposals the creator has not opened yet.
  app.get<{ Querystring: ListQuery }>('/api/lanes', async (req, reply) => {
    const status = req.query.status ?? 'open';
    if (!(LIST_STATUSES as readonly string[]).includes(status)) {
      return reply.code(400).send({ error: `invalid status "${status}": expected ${LIST_STATUSES.join(', ')}` });
    }
    const all = await deckOf(req).store.lanes();
    const open = all.filter((l) => l.status === 'open');
    return withVariants(status === 'all' ? all : all.filter((l) => l.status === status), open);
  });

  app.post<{ Params: Params }>('/api/lanes/:id/open', async (req, reply) => {
    try {
      return await deckOf(req).lanes.open(req.params.id);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.get<{ Params: Params }>('/api/lanes/:id', async (req, reply) => {
    const { store } = deckOf(req);
    const lane = await store.lane(req.params.id);
    if (!lane) return reply.code(404).send({ error: `unknown lane ${req.params.id}` });
    const open = (await store.lanes()).filter((l) => l.status === 'open');
    return withVariants([lane], open)[0];
  });

  app.post<{ Params: ChangeParams }>('/api/lanes/:id/changes/:cid/accept', async (req, reply) => {
    try {
      return await deckOf(req).lanes.accept(req.params.id, req.params.cid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post<{ Params: ChangeParams }>('/api/lanes/:id/changes/:cid/refuse', async (req, reply) => {
    try {
      return await deckOf(req).lanes.refuse(req.params.id, req.params.cid);
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.delete<{ Params: Params }>('/api/lanes/:id', async (req, reply) => {
    try {
      await deckOf(req).lanes.closeLane(req.params.id);
      return reply.code(204).send();
    } catch (err) {
      return fail(reply, err);
    }
  });

  // Preview slides are not on main, so /api/thumbs/for/:slideId cannot serve them: the response
  // carries the render hash of every changed slide, and renders are enqueued here.
  app.get<{ Params: Params }>('/api/lanes/:id/preview', async (req, reply) => {
    const deck = deckOf(req);
    const { lanes, thumbs, bus } = deck;
    const inflight = inflightFor(deck);
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
