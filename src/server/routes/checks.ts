import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { CHECK_NAMES, type CheckName, type ChecksStatus } from '../../agent/checks/index.js';

export { CHECK_NAMES, type CheckName, type ChecksStatus };

/** The slice of the check runner (src/agent/checks/runner.ts) these routes need; the runner owns all check status. */
export interface ChecksRunner {
  /** Starts the named checks not already queued or running; returns the ones started. */
  start(names: readonly CheckName[]): CheckName[];
  status(): ChecksStatus;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Wired by whoever builds the runner; absent means checks cannot run in this process. */
    checks?: ChecksRunner;
  }
}

const RunBody = z.object({ names: z.array(z.enum(CHECK_NAMES)).optional() }).nullish();

export function checkRoutes(app: FastifyInstance): void {
  app.get('/api/checks/status', async (_req, reply) => {
    const runner = app.checks;
    if (!runner) return reply.code(503).send({ error: 'checks unavailable' });
    return runner.status();
  });

  app.post('/api/checks/run', async (req, reply) => {
    const body = RunBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `invalid check names: ${body.error.message}` });
    const runner = app.checks;
    if (!runner) return reply.code(503).send({ error: 'checks unavailable' });
    // A check already queued or in flight is not doubled: its result is about to land anyway.
    return reply.code(202).send({ started: runner.start(body.data?.names ?? CHECK_NAMES) });
  });
}
