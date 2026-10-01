import type { FastifyInstance } from 'fastify';
import { nameSlides, type SlideBook } from '../../agent/checks/index.js';
import type { AgentSession } from '../../agent/session.js';
import { newId } from '../../model/ids.js';
import { orderedAnchor } from '../../model/ops.js';
import { AddRemarkInputSchema } from '../../model/schema.js';
import type { Anchor, Remark } from '../../model/types.js';
import type { DeckStore } from '../../store/deckStore.js';
import { deckOf } from '../deckRequest.js';
import { LaneError, type LaneService } from '../laneService.js';

export const PROPOSE_REMARK_TEXT = 'Propose a lane for this remark.';

type IdParams = { id: string };
type ListQuery = { status?: string };

function unknownSlides(order: readonly string[], anchor: Anchor): string[] {
  const ids = anchor.kind === 'slide' ? [anchor.slide] : anchor.kind === 'range' ? [anchor.from, anchor.to] : [];
  return ids.filter((id) => !order.includes(id));
}

/**
 * Remarks as the creator reads them, computed at read time (the store keeps what was written): slide ids in the
 * text become "slide N (title)" in the current order, or in the lane preview's order for a remark found on a lane's
 * preview. A remark anchored on a slide that left main means nothing any more and is left out, unless it describes
 * a lane preview.
 */
export async function presentRemarks(remarks: readonly Remark[], store: DeckStore, lanes: LaneService): Promise<Remark[]> {
  const main = await store.snapshot();
  const books = new Map<string, SlideBook>();
  const bookOf = async (laneId: string | null | undefined): Promise<SlideBook> => {
    if (!laneId) return main;
    let book = books.get(laneId);
    if (!book) {
      const lane = await store.lane(laneId);
      book = lane && lane.status !== 'closed' ? await lanes.preview(laneId).catch(() => main) : main;
      books.set(laneId, book);
    }
    return book;
  };
  const out: Remark[] = [];
  for (const r of remarks) {
    if (!r.sourceLaneId && unknownSlides(main.order, r.anchor).length) continue;
    const text = nameSlides(r.text, await bookOf(r.sourceLaneId));
    out.push(text === r.text ? r : { ...r, text });
  }
  return out;
}

/** Open remarks first; creation order inside each group. */
const openFirst = (rs: Remark[]): Remark[] => [...rs.filter((r) => r.status === 'open'), ...rs.filter((r) => r.status !== 'open')];

export function remarkRoutes(app: FastifyInstance): void {
  app.get<{ Querystring: ListQuery }>('/api/remarks', async (req, reply) => {
    const status = req.query.status;
    if (status !== undefined && status !== 'open' && status !== 'resolved') {
      return reply.code(400).send({ error: `invalid status "${status}": expected open or resolved` });
    }
    const { store, lanes } = deckOf(req);
    // Remarks main no longer matches are resolved by the same rebase that judges the lanes.
    await lanes.syncWithMain();
    const all = openFirst(await presentRemarks(await store.remarks(), store, lanes));
    return status ? all.filter((r) => r.status === status) : all;
  });

  app.post('/api/remarks', async (req, reply) => {
    const parsed = AddRemarkInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid remark: ${parsed.error.message}` });
    const { store, bus } = deckOf(req);
    const { anchor, text, severity } = parsed.data;
    // Same lock as lanes and the agent's add_remark: remarks.json is read-modify-written by all of them.
    const out = await store.withLock(async () => {
      const { order } = await store.state();
      const unknown = unknownSlides(order, anchor as Anchor);
      if (unknown.length) return { error: `anchor references unknown slide id(s): ${unknown.join(', ')}` } as const;
      const remark: Remark = {
        id: newId('r'),
        // In deck order: a range only reads as reversed once a move turned it around (see anchorIsStale).
        anchor: orderedAnchor(order, anchor as Anchor),
        text,
        origin: 'user',
        severity,
        status: 'open',
        laneId: null,
        createdAt: new Date().toISOString(),
      };
      await store.putRemarks([...(await store.remarks()), remark]);
      return { remark } as const;
    });
    if ('error' in out) return reply.code(400).send({ error: out.error });
    bus.emit({ type: 'remarks.changed' });
    return reply.code(201).send(out.remark);
  });

  app.post<{ Params: IdParams }>('/api/remarks/:id/resolve', async (req, reply) => {
    const { store, bus, lanes } = deckOf(req);
    const { id } = req.params;
    const resolved = await store.withLock(async () => {
      const remarks = await store.remarks();
      const target = remarks.find((r) => r.id === id);
      if (!target) return null;
      const next: Remark = { ...target, status: 'resolved' };
      await store.putRemarks(remarks.map((r) => (r.id === id ? next : r)));
      return next;
    });
    if (!resolved) return reply.code(404).send({ error: `remark "${id}" not found` });
    bus.emit({ type: 'remarks.changed' });
    return (await presentRemarks([resolved], store, lanes))[0] ?? resolved;
  });

  app.post<{ Params: IdParams }>('/api/remarks/:id/propose', async (req, reply) => {
    const { store, lanes, agent: session } = deckOf(req);
    const { id } = req.params;
    const remark = (await store.remarks()).find((r) => r.id === id);
    if (!remark) return reply.code(404).send({ error: `remark "${id}" not found` });
    // The check already drafted a lane for this remark: proposing means showing it, not asking for another one.
    const drafted = remark.laneId ? await store.lane(remark.laneId) : null;
    if (drafted?.status === 'draft') {
      try {
        const lane = await lanes.open(drafted.id);
        return reply.code(200).send({ laneId: lane.id, opened: true });
      } catch (err) {
        // Closed meanwhile (e.g. a concurrent accept orphaned it): fall through to the co-author.
        if (!(err instanceof LaneError)) throw err;
      }
    }
    // The reply streams over the bus on thread remark:<id>; the agent links the resulting lane via link_remark_lane.
    session
      .send(`remark:${remark.id}`, PROPOSE_REMARK_TEXT, remark.anchor)
      .catch((err: unknown) => req.log.error({ err, remark: remark.id }, 'agent propose failed'));
    return reply.code(202).send({ accepted: true, thread: `remark:${remark.id}` });
  });
}
