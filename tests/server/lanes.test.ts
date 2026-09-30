import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import type { BusEvent } from '../../src/server/bus.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { ThumbService } from '../../src/render/thumbs.js';
import type { Brief, Change, Lane, Slide, Snapshot, Version } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs' };
const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: '',
  notes: '',
  body: `<p class="cap">body ${id}</p>`,
  assets: [],
  kind: 'text',
  ...over,
});
const five: Slide[] = ['s1', 's2', 's3', 's4', 's5'].map((id) => slide(id));
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });

const modify = (id: string, target: string, title: string): Change => ({ id, kind: 'modify', slide: target, patch: { title }, reason: 'r', status: 'pending' });
const remove = (id: string, target: string): Change => ({ id, kind: 'remove', slide: target, reason: 'r', status: 'pending' });
const insert = (id: string, after: string | null, s: Slide): Change => ({ id, kind: 'insert', after, slide: s, reason: 'r', status: 'pending' });
const lane = (id: string, changes: Change[], createdAt = '2026-09-30T00:00:00.000Z'): Lane => ({
  id,
  label: `lane ${id}`,
  anchor: { kind: 'range', from: 's1', to: 's5' },
  origin: 'user',
  baseVersion: 1,
  changes,
  status: 'open',
  createdAt,
});

describe('lanes API', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let thumbs: ThumbService;
  let store: DeckStore;
  let app: FastifyInstance;
  let events: BusEvent[];

  beforeAll(async () => {
    tmp = await tmpDir();
  });
  afterAll(async () => {
    await tmp?.cleanup();
  });

  beforeEach(async () => {
    const deckDir = join(tmp.dir, `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    await writeFile(join(deckDir, 'theme.css'), themeCss);
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    await thumbs.start();
    app = await buildApp({ deckDir, thumbs, checks: null });
    events = [];
    app.bus.on('any', (e) => events.push(e));
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    await thumbs?.stop();
  });

  const accept = (l: string, c: string) => app.inject({ method: 'POST', url: `/api/lanes/${l}/changes/${c}/accept` });
  const refuse = (l: string, c: string) => app.inject({ method: 'POST', url: `/api/lanes/${l}/changes/${c}/refuse` });
  const getLane = async (l: string): Promise<Lane> => (await app.inject({ method: 'GET', url: `/api/lanes/${l}` })).json();
  const deck = async () => (await app.inject({ method: 'GET', url: '/api/deck' })).json();
  const versions = async (): Promise<Version[]> => (await app.inject({ method: 'GET', url: '/api/versions' })).json();

  it('accepting one of two changes commits v2, keeps the other pending, and the preview shows it on top of v2', async () => {
    const n1 = slide('n1', { title: 'Hook' });
    await store.putLane(lane('l_a', [modify('c_1', 's2', 'S2 new'), insert('c_2', 's2', n1)]));

    const res = await accept('l_a', 'c_1');
    expect(res.statusCode).toBe(200);
    const body = res.json();
    expect(body.version.n).toBe(2);
    expect(body.version.cause).toEqual({ kind: 'accept', laneId: 'l_a', changeId: 'c_1' });
    expect(body.lane.changes.map((c: Change) => c.status)).toEqual(['accepted', 'pending']);
    expect(body.lane.status).toBe('open');

    const l = await getLane('l_a');
    expect(l.changes.map((c) => c.status)).toEqual(['accepted', 'pending']);
    expect((await deck()).slides.s2.title).toBe('S2 new');
    expect(events).toContainEqual({ type: 'deck.changed', version: 2 });
    expect(events).toContainEqual({ type: 'lane.updated', laneId: 'l_a' });

    const preview = await app.inject({ method: 'GET', url: '/api/lanes/l_a/preview' });
    expect(preview.statusCode).toBe(200);
    const p = preview.json();
    expect(p.order).toEqual(['s1', 's2', 'n1', 's3', 's4', 's5']);
    expect(p.slides.s2.title).toBe('S2 new');
    expect(p.slides.n1).toEqual(n1);
    expect(p.skipped).toEqual([]);
    // Only the slide that differs from main gets a thumbnail enqueued.
    const hash = await thumbs.thumbHash(n1);
    expect(p.thumbs).toEqual({ n1: { hash, ready: false } });
    await waitFor(() => events.some((e) => e.type === 'thumb.ready' && e.hash === hash && e.slideId === 'n1'), { timeout: 20_000 });
    expect((await app.inject({ method: 'GET', url: `/api/thumbs/${hash}.png` })).statusCode).toBe(200);
    // Main is untouched by a preview.
    expect((await deck()).order).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('two concurrent accepts on different lanes produce v2 and v3, both applied on top of each other', async () => {
    await store.putLane(lane('l_a', [modify('c_a', 's1', 'A')]));
    await store.putLane(lane('l_b', [modify('c_b', 's2', 'B')]));

    const [a, b] = await Promise.all([accept('l_a', 'c_a'), accept('l_b', 'c_b')]);
    expect([a.statusCode, b.statusCode]).toEqual([200, 200]);
    expect([a.json().version.n, b.json().version.n].sort()).toEqual([2, 3]);

    const vs = await versions();
    expect(vs.map((v) => v.n)).toEqual([0, 1, 2, 3]);
    expect(vs.slice(2).map((v) => v.cause).sort((x, y) => JSON.stringify(x).localeCompare(JSON.stringify(y)))).toEqual([
      { kind: 'accept', laneId: 'l_a', changeId: 'c_a' },
      { kind: 'accept', laneId: 'l_b', changeId: 'c_b' },
    ]);
    const d = await deck();
    expect(d.state.version).toBe(3);
    expect(d.slides.s1.title).toBe('A');
    expect(d.slides.s2.title).toBe('B');
    // v3 carries both changes: the second accept applied on top of the first.
    const v3 = (await app.inject({ method: 'GET', url: '/api/versions/3' })).json();
    expect([v3.slides.s1.title, v3.slides.s2.title]).toEqual(['A', 'B']);
    // Both single-change lanes are now closed.
    expect((await app.inject({ method: 'GET', url: '/api/lanes' })).json()).toEqual([]);
  });

  it('accepting a change that removes s3 orphans another lane’s modify s3 and closes the accepted lane', async () => {
    await store.putLane(lane('l_a', [remove('c_rm', 's3')], '2026-09-30T00:00:00.000Z'));
    await store.putLane(lane('l_b', [modify('c_m3', 's3', 'x'), modify('c_m4', 's4', 'y')], '2026-09-30T00:00:01.000Z'));

    const res = await accept('l_a', 'c_rm');
    expect(res.statusCode).toBe(200);
    expect(res.json().lane.status).toBe('closed');
    expect((await deck()).order).toEqual(['s1', 's2', 's4', 's5']);

    const b = await getLane('l_b');
    expect(b.changes.map((c) => [c.id, c.status])).toEqual([
      ['c_m3', 'orphan'],
      ['c_m4', 'pending'],
    ]);
    expect(b.status).toBe('open');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_a' });
    expect(events).toContainEqual({ type: 'lane.updated', laneId: 'l_b' });

    const open: Lane[] = (await app.inject({ method: 'GET', url: '/api/lanes' })).json();
    expect(open.map((l) => l.id)).toEqual(['l_b']);
    // An orphan can no longer be accepted.
    expect((await accept('l_b', 'c_m3')).statusCode).toBe(409);
  });

  it('a lane whose last pending change is orphaned by another lane gets closed', async () => {
    await store.putLane(lane('l_a', [remove('c_rm', 's3')]));
    await store.putLane(lane('l_b', [modify('c_m3', 's3', 'x')]));
    expect((await accept('l_a', 'c_rm')).statusCode).toBe(200);
    expect((await getLane('l_b')).status).toBe('closed');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_b' });
  });

  it('refuse marks the change refused without committing, and closes the lane once nothing is pending', async () => {
    await store.putLane(lane('l_a', [modify('c_1', 's1', 'x'), modify('c_2', 's2', 'y')]));

    const r1 = await refuse('l_a', 'c_1');
    expect(r1.statusCode).toBe(200);
    expect(r1.json().changes.map((c: Change) => c.status)).toEqual(['refused', 'pending']);
    expect(r1.json().status).toBe('open');
    expect(events).toContainEqual({ type: 'lane.updated', laneId: 'l_a' });
    expect((await accept('l_a', 'c_1')).statusCode).toBe(409);
    expect((await refuse('l_a', 'c_1')).statusCode).toBe(409);

    const r2 = await refuse('l_a', 'c_2');
    expect(r2.json().status).toBe('closed');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_a' });
    expect((await versions()).map((v) => v.n)).toEqual([0, 1]);
    expect(events.some((e) => e.type === 'deck.changed')).toBe(false);
  });

  it('accept returns 409 when the change no longer applies and 404 for unknown lane or change', async () => {
    await store.putLane(lane('l_a', [modify('c_bad', 'zz', 'x')]));
    const res = await accept('l_a', 'c_bad');
    expect(res.statusCode).toBe(409);
    expect(res.json().error).toMatch(/zz/);
    expect((await getLane('l_a')).changes[0]!.status).toBe('pending');
    expect((await versions()).map((v) => v.n)).toEqual([0, 1]);

    expect((await accept('l_nope', 'c_bad')).statusCode).toBe(404);
    expect((await accept('l_a', 'c_nope')).statusCode).toBe(404);
    expect((await refuse('l_a', 'c_nope')).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/lanes/l_nope' })).statusCode).toBe(404);
    expect((await app.inject({ method: 'GET', url: '/api/lanes/l_nope/preview' })).statusCode).toBe(404);
  });

  it('DELETE closes a lane: it leaves the open list and refuses further accepts', async () => {
    await store.putLane(lane('l_a', [modify('c_1', 's1', 'x')]));
    const del = await app.inject({ method: 'DELETE', url: '/api/lanes/l_a' });
    expect(del.statusCode).toBe(204);
    expect((await getLane('l_a')).status).toBe('closed');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_a' });
    expect((await app.inject({ method: 'GET', url: '/api/lanes' })).json()).toEqual([]);
    expect((await accept('l_a', 'c_1')).statusCode).toBe(409);
    expect((await app.inject({ method: 'DELETE', url: '/api/lanes/l_nope' })).statusCode).toBe(404);
  });

  it('preview skips pending changes that fail to apply and reports them', async () => {
    await store.putLane(lane('l_a', [modify('c_bad', 'zz', 'x'), modify('c_ok', 's2', 'S2 preview')]));
    const p = (await app.inject({ method: 'GET', url: '/api/lanes/l_a/preview' })).json();
    expect(p.skipped).toEqual(['c_bad']);
    expect(p.order).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(p.slides.s2.title).toBe('S2 preview');
    expect(Object.keys(p.thumbs)).toEqual(['s2']);
    await waitFor(() => events.some((e) => e.type === 'thumb.ready' && e.hash === p.thumbs.s2.hash), { timeout: 20_000 });
  });
});
