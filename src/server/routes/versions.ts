import type { FastifyInstance } from 'fastify';
import type { Change, Lane, Snapshot, Version, VersionCause } from '../../model/types.js';
import { deckOf } from '../deckRequest.js';
import { describeRestore, storedEntry } from '../historyService.js';

function changeSummary(c: Change, slideTitle: (id: string) => string): string {
  switch (c.kind) {
    case 'insert': return `added "${c.slide.title}"`;
    case 'modify': return `changed "${slideTitle(c.slide)}"`;
    case 'remove': return `removed "${slideTitle(c.slide)}"`;
    case 'move': return `moved "${slideTitle(c.slide)}"`;
  }
}

/** Main just before a restore version and the restore version itself: what a restore label reads from. */
export interface RestoreSides {
  before: Snapshot;
  after: Snapshot;
}

/** A label a person can read on the version line, derived from the cause. */
export function versionLabel(cause: VersionCause, lanes: Map<string, Lane>, slideTitle: (id: string) => string, sides?: RestoreSides): string {
  switch (cause.kind) {
    case 'import': return 'imported';
    case 'restore': {
      const entry = storedEntry(cause.entry);
      return entry && sides ? describeRestore(cause.from, entry, sides.before, sides.after) : `restored from v${cause.from}`;
    }
    case 'accept': {
      if (cause.laneId === 'manual') return 'edited by hand';
      const lane = lanes.get(cause.laneId);
      const change = lane?.changes.find((c) => c.id === cause.changeId);
      if (!lane || !change) return 'accepted a change';
      return `${changeSummary(change, slideTitle)} · ${lane.label}`;
    }
  }
}

export function versionRoutes(app: FastifyInstance): void {
  app.get('/api/versions', async (req): Promise<Array<Version & { label: string }>> => {
    const { store } = deckOf(req);
    const [versions, lanes, snap] = await Promise.all([store.versions(), store.lanes(), store.snapshot()]);
    const byId = new Map(lanes.map((l) => [l.id, l]));
    const title = (id: string): string => snap.slides[id]?.title ?? id;
    // A restore label numbers its slide in the versions around it, not on today's main.
    const sides = await Promise.all(
      versions.map(async (v, i): Promise<RestoreSides | undefined> => {
        const prev = versions[i - 1];
        if (v.cause.kind !== 'restore' || !prev) return undefined;
        const [before, after] = await Promise.all([store.snapshotAt(prev.n), store.snapshotAt(v.n)]);
        return { before, after };
      }),
    );
    return versions.map((v, i) => ({ ...v, label: versionLabel(v.cause, byId, title, sides[i]) }));
  });

  app.get<{ Params: { n: string } }>('/api/versions/:n', async (req, reply) => {
    if (!/^\d+$/.test(req.params.n)) return reply.code(400).send({ error: `invalid version "${req.params.n}"` });
    const n = Number(req.params.n);
    const { store } = deckOf(req);
    const known = (await store.versions()).some((v) => v.n === n);
    if (!known) return reply.code(404).send({ error: `version ${n} does not exist` });
    return store.snapshotAt(n);
  });
}
