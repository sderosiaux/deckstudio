import type { FastifyInstance, FastifyReply } from 'fastify';
import { z } from 'zod';
import type { DiffEntry } from '../../model/types.js';
import { DiffEntrySchema, HistoryError, type HistoryService } from '../historyService.js';

const VersionN = z.number().int().nonnegative();

const RestoreBody = z.object({ from: VersionN, entry: DiffEntrySchema });
const OpenAsLaneBody = z.object({ n: VersionN });

const versionParam = (raw: string | undefined): number | null => (raw !== undefined && /^\d+$/.test(raw) ? Number(raw) : null);

export function historyRoutes(app: FastifyInstance, history: HistoryService): void {
  const fail = (reply: FastifyReply, err: unknown) => {
    if (err instanceof HistoryError) return reply.code(err.status).send({ error: err.message });
    throw err;
  };

  app.get<{ Querystring: { a?: string; b?: string } }>('/api/history/diff', async (req, reply) => {
    const a = versionParam(req.query.a);
    const b = versionParam(req.query.b);
    if (a === null || b === null) return reply.code(400).send({ error: 'query parameters a and b must be version numbers' });
    try {
      return { a, b, entries: await history.diff(a, b) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/history/restore', async (req, reply) => {
    const body = RestoreBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `invalid restore request: ${body.error.message}` });
    try {
      return { version: await history.restore(body.data.from, body.data.entry as DiffEntry) };
    } catch (err) {
      return fail(reply, err);
    }
  });

  app.post('/api/history/open-as-lane', async (req, reply) => {
    const body = OpenAsLaneBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `invalid open-as-lane request: ${body.error.message}` });
    try {
      return { laneId: await history.openAsLane(body.data.n) };
    } catch (err) {
      return fail(reply, err);
    }
  });
}
