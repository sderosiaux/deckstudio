import type { FastifyInstance } from 'fastify';
import type { AgentSession } from '../../agent/session.js';
import { newId } from '../../model/ids.js';
import { AddRemarkInputSchema } from '../../model/schema.js';
import type { Anchor, Remark } from '../../model/types.js';
import type { DeckStore } from '../../store/deckStore.js';
import type { Bus } from '../bus.js';

export const PROPOSE_REMARK_TEXT = 'Propose a lane for this remark.';

type IdParams = { id: string };
type ListQuery = { status?: string };

function unknownSlides(order: readonly string[], anchor: Anchor): string[] {
  const ids = anchor.kind === 'slide' ? [anchor.slide] : anchor.kind === 'range' ? [anchor.from, anchor.to] : [];
  return ids.filter((id) => !order.includes(id));
}

/** Open remarks first; creation order inside each group. */
const openFirst = (rs: Remark[]): Remark[] => [...rs.filter((r) => r.status === 'open'), ...rs.filter((r) => r.status !== 'open')];

export function remarkRoutes(app: FastifyInstance, store: DeckStore, session: AgentSession, bus: Bus): void {
  app.get<{ Querystring: ListQuery }>('/api/remarks', async (req, reply) => {
    const status = req.query.status;
    if (status !== undefined && status !== 'open' && status !== 'resolved') {
      return reply.code(400).send({ error: `invalid status "${status}": expected open or resolved` });
    }
    const all = openFirst(await store.remarks());
    return status ? all.filter((r) => r.status === status) : all;
  });

  app.post('/api/remarks', async (req, reply) => {
    const parsed = AddRemarkInputSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: `invalid remark: ${parsed.error.message}` });
    const { anchor, text, severity } = parsed.data;
    // Same lock as lanes and the agent's add_remark: remarks.json is read-modify-written by all of them.
    const out = await store.withLock(async () => {
      const unknown = unknownSlides((await store.state()).order, anchor as Anchor);
      if (unknown.length) return { error: `anchor references unknown slide id(s): ${unknown.join(', ')}` } as const;
      const remark: Remark = {
        id: newId('r'),
        anchor: anchor as Anchor,
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
    return resolved;
  });

  app.post<{ Params: IdParams }>('/api/remarks/:id/propose', async (req, reply) => {
    const { id } = req.params;
    const remark = (await store.remarks()).find((r) => r.id === id);
    if (!remark) return reply.code(404).send({ error: `remark "${id}" not found` });
    // The reply streams over the bus on thread remark:<id>; the agent links the resulting lane via link_remark_lane.
    session
      .send(`remark:${remark.id}`, PROPOSE_REMARK_TEXT, remark.anchor)
      .catch((err: unknown) => req.log.error({ err, remark: remark.id }, 'agent propose failed'));
    return reply.code(202).send({ accepted: true, thread: `remark:${remark.id}` });
  });
}
