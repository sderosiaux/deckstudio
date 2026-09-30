import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { hashSlide } from '../../src/model/ids.js';
import { diffVersions } from '../../src/model/ops.js';
import type { Brief, DiffEntry, Lane, Remark, Slide, Snapshot, Version } from '../../src/model/types.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { buildApp } from '../../src/server/app.js';
import type { BusEvent } from '../../src/server/bus.js';
import { LaneService } from '../../src/server/laneService.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { tmpDir } from '../helpers/tmp.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs' };
const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: '',
  notes: '',
  body: `<p>body ${id}</p>`,
  assets: [],
  kind: 'text',
  ...over,
});
const five: Slide[] = ['s1', 's2', 's3', 's4', 's5'].map((id) => slide(id));
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });
const without = (s: Snapshot, id: string): Snapshot => {
  const { [id]: _gone, ...slides } = s.slides;
  return { order: s.order.filter((x) => x !== id), slides };
};
const contentOf = (s: Snapshot): string[] => s.order.map((id) => `${id}:${hashSlide(s.slides[id]!)}`);

/** Deterministic PRNG (mulberry32) so the randomized cases replay identically. */
const prng = (seed: number): (() => number) => {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};
const shuffle = <T>(xs: readonly T[], rnd: () => number): T[] => {
  const out = [...xs];
  for (let i = out.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [out[i], out[j]] = [out[j]!, out[i]!];
  }
  return out;
};
/** A random deck over the ids p0..p7: random subset, random order, each slide in one of two content variants. */
const randomDeck = (rnd: () => number): Snapshot => {
  const ids = shuffle(['p0', 'p1', 'p2', 'p3', 'p4', 'p5', 'p6', 'p7'], rnd).slice(0, 2 + Math.floor(rnd() * 7));
  return snap(ids.map((id) => (rnd() < 0.5 ? slide(id) : slide(id, { title: `Other ${id}`, kind: 'code' }))));
};

describe('history API', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let store: DeckStore;
  let thumbs: ThumbService;
  let app: FastifyInstance;
  let events: BusEvent[];

  beforeEach(async () => {
    tmp = await tmpDir();
    const deckDir = join(tmp.dir, 'deck');
    store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' }); // v1
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    app = await buildApp({ deckDir, thumbs, checks: null });
    events = [];
    app.bus.on('any', (e) => events.push(e));
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    await tmp?.cleanup();
  });

  const post = (url: string, payload: unknown) => app.inject({ method: 'POST', url, payload: payload as Record<string, unknown> });
  const accept = (l: string, c: string) => app.inject({ method: 'POST', url: `/api/lanes/${l}/changes/${c}/accept` });

  /** v2 removes s3; v3 modifies s2, moves s5 first and adds n1 at the end. */
  const threeVersions = async (): Promise<void> => {
    const v1 = await store.snapshot();
    const v2 = without(v1, 's3');
    await store.commit(v2, { kind: 'accept', laneId: 'manual', changeId: 'c_x' });
    const v3: Snapshot = {
      order: ['s5', 's1', 's2', 's4', 'n1'],
      slides: { ...v2.slides, s2: { ...v2.slides.s2!, title: 'S2 new', body: '<p>changed</p>' }, n1: slide('n1') },
    };
    await store.commit(v3, { kind: 'accept', laneId: 'manual', changeId: 'c_y' });
  };

  it('diffs two versions', async () => {
    await threeVersions();
    const res = await app.inject({ method: 'GET', url: '/api/history/diff?a=1&b=3' });
    expect(res.statusCode).toBe(200);
    const body = res.json() as { a: number; b: number; entries: DiffEntry[] };
    expect(body.a).toBe(1);
    expect(body.b).toBe(3);
    expect(body.entries).toEqual([
      { kind: 'removed', slide: 's3', wasAt: 2 },
      { kind: 'added', slide: 'n1', at: 4 },
      { kind: 'modified', slide: 's2', fields: ['title', 'body'] },
      { kind: 'moved', slide: 's5', from: 4, to: 0 },
    ]);
    expect((await app.inject({ method: 'GET', url: '/api/history/diff?a=1&b=9' })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/history/diff?a=x&b=1' })).statusCode).toBe(400);
  });

  it('restoring a removed slide re-inserts it at its old index as a restore version', async () => {
    await threeVersions();
    const entry: DiffEntry = { kind: 'removed', slide: 's3', wasAt: 2 };
    const res = await post('/api/history/restore', { from: 1, entry });
    expect(res.statusCode).toBe(200);
    const { version } = res.json() as { version: Version };
    expect(version.n).toBe(4);
    expect(version.cause).toEqual({ kind: 'restore', from: 1, entry: JSON.stringify(entry) });
    const main = await store.snapshot();
    expect(main.order).toEqual(['s5', 's1', 's3', 's2', 's4', 'n1']);
    expect(hashSlide(main.slides.s3!)).toBe(hashSlide(five[2]!));
    expect(events).toContainEqual({ type: 'deck.changed', version: 4 });
  });

  it('restoring a removed slide beyond the current length appends it', async () => {
    const v1 = await store.snapshot();
    await store.commit({ order: ['s5'], slides: { s5: v1.slides.s5! } }, { kind: 'accept', laneId: 'manual', changeId: 'c' });
    const res = await post('/api/history/restore', { from: 1, entry: { kind: 'removed', slide: 's4', wasAt: 3 } });
    expect(res.statusCode).toBe(200);
    expect((await store.snapshot()).order).toEqual(['s5', 's4']);
  });

  it('restores added, modified and moved entries', async () => {
    await threeVersions();
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'added', slide: 'n1', at: 4 } })).statusCode).toBe(200);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'modified', slide: 's2', fields: ['title', 'body'] } })).statusCode).toBe(200);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'moved', slide: 's5', from: 4, to: 0 } })).statusCode).toBe(200);
    const main = await store.snapshot();
    expect(main.order).toEqual(['s1', 's2', 's4', 's5']);
    expect(hashSlide(main.slides.s2!)).toBe(hashSlide(five[1]!));
  });

  it('answers 409 when the entry no longer applies', async () => {
    await threeVersions();
    const entry: DiffEntry = { kind: 'removed', slide: 's3', wasAt: 2 };
    expect((await post('/api/history/restore', { from: 1, entry })).statusCode).toBe(200);
    const again = await post('/api/history/restore', { from: 1, entry });
    expect(again.statusCode).toBe(409);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'added', slide: 's1', at: 0 } })).statusCode).toBe(409);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'modified', slide: 's1', fields: ['title'] } })).statusCode).toBe(409);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'moved', slide: 's1', from: 1, to: 0 } })).statusCode).toBe(409);
    expect((await post('/api/history/restore', { from: 9, entry })).statusCode).toBe(400);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'bogus' } })).statusCode).toBe(400);
    expect((await store.state()).version).toBe(4);
  });

  it('open-as-lane builds a lane whose changes, all accepted in order, turn main back into v<n>', async () => {
    await threeVersions();
    const res = await post('/api/history/open-as-lane', { n: 1 });
    expect(res.statusCode).toBe(200);
    const { laneId } = res.json() as { laneId: string };
    const lane = (await store.lane(laneId)) as Lane;
    expect(lane).toMatchObject({ label: 'back to v1', origin: 'user', anchor: { kind: 'arc' }, baseVersion: 3, status: 'open' });
    expect(lane.changes.map((c) => c.kind).sort()).toEqual(['insert', 'modify', 'move', 'remove']);
    expect(lane.changes.every((c) => c.status === 'pending')).toBe(true);
    expect(events).toContainEqual({ type: 'lane.created', laneId });

    const lanes = new LaneService(store, app.bus);
    for (const c of lane.changes) await lanes.accept(laneId, c.id);
    const main = await store.snapshot();
    expect(contentOf(main)).toEqual(contentOf(await store.snapshotAt(1)));
    expect((await store.lane(laneId))!.status).toBe('closed');
    // The version line names the lane as-is: "<what changed> · back to v1", not a bare "· v1".
    const versions = (await app.inject({ method: 'GET', url: '/api/versions' })).json() as Array<{ label: string }>;
    expect(versions[versions.length - 1]!.label).toMatch(/ · back to v1$/);
  });

  it('open-as-lane reproduces an arbitrary reshuffle through the HTTP accept route', async () => {
    const v1 = await store.snapshot();
    const reshuffled: Snapshot = {
      order: ['s4', 'n2', 's1', 'n1', 's5', 's2'],
      slides: { s1: v1.slides.s1!, s2: v1.slides.s2!, s4: { ...v1.slides.s4!, kind: 'code' }, s5: v1.slides.s5!, n1: slide('n1'), n2: slide('n2') },
    };
    await store.commit(reshuffled, { kind: 'accept', laneId: 'manual', changeId: 'c' });
    const target: Snapshot = {
      order: ['s3', 'n1', 's5', 's1', 'n9', 's2', 's4'],
      slides: { ...v1.slides, n1: slide('n1', { title: 'N1 then' }), n9: slide('n9') },
    };
    await store.commit(target, { kind: 'accept', laneId: 'manual', changeId: 'c' }); // v3
    await store.commit(reshuffled, { kind: 'accept', laneId: 'manual', changeId: 'c' }); // v4

    const { laneId } = (await post('/api/history/open-as-lane', { n: 3 })).json() as { laneId: string };
    const lane = (await store.lane(laneId))!;
    for (const c of lane.changes) expect((await accept(laneId, c.id)).statusCode).toBe(200);
    expect(contentOf(await store.snapshot())).toEqual(contentOf(target));
  });

  it('restoring a modified entry copies back only its fields and keeps later edits to other fields', async () => {
    const v1 = await store.snapshot();
    await store.commit({ ...v1, slides: { ...v1.slides, s1: { ...v1.slides.s1!, title: 'NEW' } } }, { kind: 'accept', laneId: 'manual', changeId: 'c' }); // v2
    const v2 = await store.snapshot();
    await store.commit({ ...v2, slides: { ...v2.slides, s1: { ...v2.slides.s1!, notes: 'later' } } }, { kind: 'accept', laneId: 'manual', changeId: 'c' }); // v3
    const { entries } = (await app.inject({ method: 'GET', url: '/api/history/diff?a=1&b=2' })).json() as { entries: DiffEntry[] };
    expect(entries).toEqual([{ kind: 'modified', slide: 's1', fields: ['title'] }]);
    expect((await post('/api/history/restore', { from: 1, entry: entries[0] })).statusCode).toBe(200);
    const s1 = (await store.snapshot()).slides.s1!;
    expect(s1.title).toBe('Title s1');
    expect(s1.notes).toBe('later');
    // Title is back: the entry no longer applies, even though notes still differ from v1.
    expect((await post('/api/history/restore', { from: 1, entry: entries[0] })).statusCode).toBe(409);
  });

  it('restores one entry of an older pair (a < b < latest) onto a main that moved past b', async () => {
    const edit = async (id: string, over: Partial<Slide>) => {
      const m = await store.snapshot();
      await store.commit({ ...m, slides: { ...m.slides, [id]: { ...m.slides[id]!, ...over } } }, { kind: 'accept', laneId: 'manual', changeId: 'c' });
    };
    await edit('s2', { title: 'S2 v2' }); // v2
    await edit('s3', { notes: 'v3 notes' }); // v3
    await edit('s2', { body: '<p>v4 body</p>' }); // v4
    const { entries } = (await app.inject({ method: 'GET', url: '/api/history/diff?a=1&b=2' })).json() as { entries: DiffEntry[] };
    expect(entries).toEqual([{ kind: 'modified', slide: 's2', fields: ['title'] }]);
    const res = await post('/api/history/restore', { from: 1, entry: entries[0] });
    expect(res.statusCode).toBe(200);
    expect((res.json() as { version: Version }).version.n).toBe(5);
    const main = await store.snapshot();
    expect(main.slides.s2).toMatchObject({ title: 'Title s2', body: '<p>v4 body</p>' });
    expect(main.slides.s3!.notes).toBe('v3 notes');
  });

  it('restore rebases open lanes like an accept: orphans, closes and resolves the closed lane remarks', async () => {
    await threeVersions();
    const lane: Lane = {
      id: 'l_n1',
      label: 'tweak n1',
      anchor: { kind: 'slide', slide: 'n1' },
      origin: 'user',
      baseVersion: 3,
      changes: [{ id: 'c_n1', kind: 'modify', slide: 'n1', patch: { title: 'N1!' }, reason: 'r', status: 'pending' }],
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await store.putLane(lane);
    const remark: Remark = {
      id: 'r_n1',
      anchor: { kind: 'slide', slide: 'n1' },
      text: 'n1 is thin',
      origin: 'check:density',
      severity: 'warn',
      status: 'open',
      laneId: null,
      sourceLaneId: 'l_n1',
      createdAt: new Date().toISOString(),
    };
    await store.putRemarks([remark]);
    expect((await post('/api/history/restore', { from: 1, entry: { kind: 'added', slide: 'n1', at: 4 } })).statusCode).toBe(200);
    const after = (await store.lane('l_n1'))!;
    expect(after.status).toBe('closed');
    expect(after.changes[0]!.status).toBe('orphan');
    expect((await store.remarks()).map((r) => r.status)).toEqual(['resolved']);
    expect(events).toEqual([
      { type: 'deck.changed', version: 4 },
      { type: 'lane.updated', laneId: 'l_n1' },
      { type: 'lane.closed', laneId: 'l_n1' },
      { type: 'remarks.changed' },
    ]);
  });

  it('ignores an uncommitted version file left above deck.json', async () => {
    await threeVersions();
    const v3 = (await store.versions()).at(-1)!;
    await writeFile(join(tmp.dir, 'deck', 'versions', 'v99.json'), JSON.stringify({ ...v3, n: 99 }));
    expect((await app.inject({ method: 'GET', url: '/api/history/diff?a=1&b=99' })).statusCode).toBe(400);
    expect((await post('/api/history/open-as-lane', { n: 99 })).statusCode).toBe(400);
    expect((await post('/api/history/restore', { from: 99, entry: { kind: 'removed', slide: 's3', wasAt: 2 } })).statusCode).toBe(400);
  });

  it('open-as-lane, all accepted in order, reproduces v<n> on random decks (seeded)', async () => {
    const lanes = new LaneService(store, app.bus);
    for (let seed = 1; seed <= 40; seed++) {
      const rnd = prng(seed);
      const target = randomDeck(rnd);
      const t = await store.commit(target, { kind: 'accept', laneId: 'manual', changeId: 'c' });
      await store.commit(randomDeck(rnd), { kind: 'accept', laneId: 'manual', changeId: 'c' });
      const res = await post('/api/history/open-as-lane', { n: t.n });
      if (res.statusCode === 409) continue; // main happened to equal the target
      const lane = (await store.lane((res.json() as { laneId: string }).laneId))!;
      for (const c of lane.changes) await lanes.accept(lane.id, c.id);
      expect(contentOf(await store.snapshot()), `seed ${seed}`).toEqual(contentOf(target));
    }
  });

  it('open-as-lane anchors placements on stable slides, so any accept order reproduces v<n> when no two placed slides are adjacent', async () => {
    const lanes = new LaneService(store, app.bus);
    let checked = 0;
    for (let seed = 1; seed <= 200 && checked < 12; seed++) {
      const rnd = prng(seed);
      const target = randomDeck(rnd);
      const main = randomDeck(rnd);
      const placed = new Set(diffVersions(main, target).flatMap((e) => (e.kind === 'added' || e.kind === 'moved' ? [e.slide] : [])));
      if (placed.size === 0 || target.order.some((id, i) => i > 0 && placed.has(id) && placed.has(target.order[i - 1]!))) continue;
      for (const order of ['reverse', 'shuffled'] as const) {
        const t = await store.commit(target, { kind: 'accept', laneId: 'manual', changeId: 'c' });
        await store.commit(main, { kind: 'accept', laneId: 'manual', changeId: 'c' });
        const lane = (await store.lane(((await post('/api/history/open-as-lane', { n: t.n })).json() as { laneId: string }).laneId))!;
        const ids = lane.changes.map((c) => c.id);
        for (const id of order === 'reverse' ? ids.reverse() : shuffle(ids, rnd)) await lanes.accept(lane.id, id);
        expect(contentOf(await store.snapshot()), `seed ${seed} ${order}`).toEqual(contentOf(target));
      }
      checked++;
    }
    expect(checked).toBe(12);
  });

  it('open-as-lane rejects unknown versions and a version equal to main', async () => {
    expect((await post('/api/history/open-as-lane', { n: 7 })).statusCode).toBe(400);
    expect((await post('/api/history/open-as-lane', { n: 1 })).statusCode).toBe(409);
  });
});
