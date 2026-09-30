import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import type { Anchor } from '../../model/types.js';
import type { Bus } from '../bus.js';

export const CHECK_NAMES = ['arc', 'order', 'gaps', 'render'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];

/** The slice of the check runner (src/agent/checks/runner.ts) these routes need. */
export interface ChecksRunner {
  run(name: CheckName, scope?: Anchor): Promise<unknown>;
}

declare module 'fastify' {
  interface FastifyInstance {
    /** Wired by whoever builds the runner; absent means checks cannot run in this process. */
    checks?: ChecksRunner;
  }
}

export interface ChecksStatus {
  running: CheckName[];
  lastRun: Record<CheckName, string | null>;
}

const RunBody = z.object({ names: z.array(z.enum(CHECK_NAMES)).optional() }).nullish();

export function checkRoutes(app: FastifyInstance, bus: Bus): void {
  // In memory on purpose: a restart forgets when checks last ran, the remarks they produced stay on disk.
  const running = new Set<CheckName>();
  const lastRun: Record<CheckName, string | null> = { arc: null, order: null, gaps: null, render: null };
  const status = (): ChecksStatus => ({ running: CHECK_NAMES.filter((n) => running.has(n)), lastRun: { ...lastRun } });
  const announce = (): void => bus.emit({ type: 'checks.status', running: status().running });

  app.get('/api/checks/status', async () => status());

  app.post('/api/checks/run', async (req, reply) => {
    const body = RunBody.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `invalid check names: ${body.error.message}` });
    const runner = app.checks;
    if (!runner) return reply.code(503).send({ error: 'checks unavailable' });
    const wanted = [...new Set(body.data?.names ?? CHECK_NAMES)];
    // A check already in flight is not doubled: its result is about to land anyway.
    const started = wanted.filter((n) => !running.has(n));
    for (const name of started) {
      running.add(name);
      void runner
        .run(name)
        .catch((err: unknown) => req.log.error({ err, check: name }, 'check failed'))
        .finally(() => {
          running.delete(name);
          lastRun[name] = new Date().toISOString();
          announce();
        });
    }
    if (started.length) announce();
    return reply.code(202).send({ started });
  });
}
