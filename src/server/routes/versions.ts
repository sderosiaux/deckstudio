import type { FastifyInstance } from 'fastify';
import type { Change, Lane, Version, VersionCause } from '../../model/types.js';
import type { DeckStore } from '../../store/deckStore.js';

function changeSummary(c: Change, slideTitle: (id: string) => string): string {
  switch (c.kind) {
    case 'insert': return `added "${c.slide.title}"`;
    case 'modify': return `changed "${slideTitle(c.slide)}"`;
    case 'remove': return `removed "${slideTitle(c.slide)}"`;
    case 'move': return `moved "${slideTitle(c.slide)}"`;
  }
}

/** A label a person can read on the version line, derived from the cause. */
export function versionLabel(cause: VersionCause, lanes: Map<string, Lane>, slideTitle: (id: string) => string): string {
  switch (cause.kind) {
    case 'import': return 'imported';
    case 'restore': return `restored from v${cause.from}`;
    case 'accept': {
      if (cause.laneId === 'manual') return 'edited by hand';
      const lane = lanes.get(cause.laneId);
      const change = lane?.changes.find((c) => c.id === cause.changeId);
      if (!lane || !change) return 'accepted a change';
      return `${changeSummary(change, slideTitle)} · ${lane.label}`;
    }
  }
}

export function versionRoutes(app: FastifyInstance, store: DeckStore): void {
  app.get('/api/versions', async (): Promise<Array<Version & { label: string }>> => {
    const [versions, lanes, snap] = await Promise.all([store.versions(), store.lanes(), store.snapshot()]);
    const byId = new Map(lanes.map((l) => [l.id, l]));
    const title = (id: string): string => snap.slides[id]?.title ?? id;
    return versions.map((v) => ({ ...v, label: versionLabel(v.cause, byId, title) }));
  });

  app.get<{ Params: { n: string } }>('/api/versions/:n', async (req, reply) => {
    if (!/^\d+$/.test(req.params.n)) return reply.code(400).send({ error: `invalid version "${req.params.n}"` });
    const n = Number(req.params.n);
    const known = (await store.versions()).some((v) => v.n === n);
    if (!known) return reply.code(404).send({ error: `version ${n} does not exist` });
    return store.snapshotAt(n);
  });
}
