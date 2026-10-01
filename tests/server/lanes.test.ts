import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { buildApp } from '../../src/server/app.js';
import type { BusEvent } from '../../src/server/bus.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { ThumbService, type ThumbResult } from '../../src/render/thumbs.js';
import type { Brief, Change, Lane, Remark, Slide, Snapshot, Version } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
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

  it('after an accept, a move that became a no-op is already on main; its lane stays open while it has other pending changes', async () => {
    const move = (id: string, target: string, after: string | null): Change => ({ id, kind: 'move', slide: target, after, reason: 'r', status: 'pending' });
    await store.putLane(lane('l_a', [move('c_a', 's4', 's1')]));
    await store.putLane(lane('l_b', [move('c_b', 's4', 's1'), modify('c_m5', 's5', 'y')]));
    await store.putLane(lane('l_c', [move('c_c', 's4', 's1')]));
    expect((await accept('l_a', 'c_a')).statusCode).toBe(200);
    expect((await deck()).order).toEqual(['s1', 's4', 's2', 's3', 's5']);
    const b = await getLane('l_b');
    expect(b.changes.map((c) => [c.id, c.status])).toEqual([
      ['c_b', 'accepted'],
      ['c_m5', 'pending'],
    ]);
    expect(b.status).toBe('open');
    expect((await getLane('l_c')).status).toBe('closed');
  });

  it('QA5 refusing the first of chained moves leaves the next ones pending; accepting the second leaves the third pending', async () => {
    const move = (id: string, target: string, after: string | null): Change => ({ id, kind: 'move', slide: target, after, reason: 'r', status: 'pending' });
    // Pull the block s3 s4 s5 right after s1: on main s4 already follows s3 and s5 follows s4.
    await store.putLane(lane('l_m', [move('c_a', 's3', 's1'), move('c_b', 's4', 's3'), move('c_c', 's5', 's4')]));
    const r1 = await refuse('l_m', 'c_a');
    expect(r1.statusCode).toBe(200);
    const statuses = (l: Lane) => l.changes.map((c) => [c.id, c.status]);
    expect(statuses(r1.json())).toEqual([
      ['c_a', 'refused'],
      ['c_b', 'pending'],
      ['c_c', 'pending'],
    ]);
    expect(statuses(await getLane('l_m'))).toEqual(statuses(r1.json()));
    expect(await store.thread('lane:l_m')).toEqual([]);
    expect((await accept('l_m', 'c_b')).statusCode).toBe(200);
    const after = await getLane('l_m');
    expect(statuses(after)).toEqual([
      ['c_a', 'refused'],
      ['c_b', 'accepted'],
      ['c_c', 'pending'],
    ]);
    expect(after.status).toBe('open');
    expect((await deck()).order).toEqual(['s1', 's2', 's3', 's4', 's5']);
  });

  it('QA5 lane labels and change reasons are served with slides named in the current order, never ids; the store keeps the ids', async () => {
    const move = (id: string, target: string, after: string | null, reason: string): Change => ({ id, kind: 'move', slide: target, after, reason, status: 'pending' });
    const n1 = slide('s_newSlide01', { title: 'Hook' });
    await store.putLane({
      ...lane('l_n', [
        move('c_1', 's4', 's1', 'keeps s4 attached to the read-pattern of s1'),
        { ...insert('c_2', 's4', n1), reason: 'opens the answer before slide s_newSlide01 lands; Slide s5 follows' },
        move('c_3', 's2', 's5', 'pushes s_gone000000 out'),
      ]),
      label: 'Move s4 next to s1',
    });
    const one = await getLane('l_n');
    expect(one.label).toBe('Move slide 4 next to slide 1');
    expect(one.changes.map((c) => c.reason)).toEqual([
      'keeps slide 4 (Title s4) attached to the read-pattern of slide 1 (Title s1)',
      'opens the answer before the new slide "Hook" lands; Slide 5 (Title s5) follows',
      'pushes a removed slide out',
    ]);
    const listed: Lane[] = (await app.inject({ method: 'GET', url: '/api/lanes' })).json();
    expect(listed.find((l) => l.id === 'l_n')).toEqual(one);
    // Numbers follow main: after an accept moves s4 to second place, the reason says slide 2.
    await store.putLane(lane('l_mv', [move('c_x', 's4', 's1', 'r')]));
    expect((await accept('l_mv', 'c_x')).statusCode).toBe(200);
    expect((await getLane('l_n')).changes[0]!.reason).toBe('keeps slide 2 (Title s4) attached to the read-pattern of slide 1 (Title s1)');
    const stored = (await store.lane('l_n'))!;
    expect(stored.label).toBe('Move s4 next to s1');
    expect(stored.changes[0]!.reason).toBe('keeps s4 attached to the read-pattern of s1');
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
    // The failed accept wrote nothing (a read would rebase the lane: its change can never apply).
    expect((await store.lane('l_a'))!.changes[0]!.status).toBe('pending');
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

  it('closing a lane (DELETE, last accept, last refuse) resolves the open remarks found on its preview', async () => {
    const rem = (id: string, sourceLaneId: string | null, status: Remark['status'] = 'open'): Remark => ({
      id,
      anchor: { kind: 'slide', slide: 's1' },
      text: `remark ${id}`,
      origin: 'check:render',
      severity: 'warn',
      status,
      laneId: null,
      ...(sourceLaneId ? { sourceLaneId } : {}),
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    await store.putLane(lane('l_a', [modify('c_1', 's1', 'x')]));
    await store.putLane(lane('l_b', [modify('c_2', 's2', 'y')]));
    await store.putLane(lane('l_c', [modify('c_3', 's3', 'z')]));
    await store.putRemarks([rem('r_a', 'l_a'), rem('r_b', 'l_b'), rem('r_c', 'l_c'), rem('r_deck', null)]);
    const statuses = async () => Object.fromEntries((await store.remarks()).map((r) => [r.id, r.status]));

    expect((await app.inject({ method: 'DELETE', url: '/api/lanes/l_a' })).statusCode).toBe(204);
    expect(await statuses()).toEqual({ r_a: 'resolved', r_b: 'open', r_c: 'open', r_deck: 'open' });
    expect(events).toContainEqual({ type: 'remarks.changed' });

    expect((await accept('l_b', 'c_2')).statusCode).toBe(200);
    expect(await statuses()).toEqual({ r_a: 'resolved', r_b: 'resolved', r_c: 'open', r_deck: 'open' });

    expect((await refuse('l_c', 'c_3')).statusCode).toBe(200);
    expect(await statuses()).toEqual({ r_a: 'resolved', r_b: 'resolved', r_c: 'resolved', r_deck: 'open' });
  });

  it('GET /api/lanes lists open lanes by default and filters by ?status=draft|open|all', async () => {
    await store.putLane(lane('l_open', [modify('c_1', 's1', 'x')]));
    await store.putLane({ ...lane('l_draft', [modify('c_2', 's2', 'y')]), status: 'draft', origin: 'check:arc' });
    await store.putLane({ ...lane('l_closed', [modify('c_3', 's3', 'z')]), status: 'closed' });
    const ids = async (url: string) => ((await app.inject({ method: 'GET', url })).json() as Lane[]).map((l) => l.id).sort();
    expect(await ids('/api/lanes')).toEqual(['l_open']);
    expect(await ids('/api/lanes?status=open')).toEqual(['l_open']);
    expect(await ids('/api/lanes?status=draft')).toEqual(['l_draft']);
    expect(await ids('/api/lanes?status=all')).toEqual(['l_closed', 'l_draft', 'l_open']);
    const bad = await app.inject({ method: 'GET', url: '/api/lanes?status=nope' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toMatch(/nope/);
  });

  it('POST /api/lanes/:id/open turns a draft into an open lane and emits lane.updated; 404 unknown, 409 closed', async () => {
    await store.putLane({ ...lane('l_draft', [modify('c_1', 's1', 'x')]), status: 'draft', origin: 'check:arc' });
    const res = await app.inject({ method: 'POST', url: '/api/lanes/l_draft/open' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: 'l_draft', status: 'open', origin: 'check:arc' });
    expect((await getLane('l_draft')).status).toBe('open');
    expect(events).toContainEqual({ type: 'lane.updated', laneId: 'l_draft' });
    expect(events).toContainEqual({ type: 'lane.opened', laneId: 'l_draft' });
    // Opening an open lane is a no-op that answers the lane.
    events.length = 0;
    const again = await app.inject({ method: 'POST', url: '/api/lanes/l_draft/open' });
    expect(again.statusCode).toBe(200);
    expect(again.json().status).toBe('open');
    expect(events).toEqual([]);

    expect((await app.inject({ method: 'POST', url: '/api/lanes/l_nope/open' })).statusCode).toBe(404);
    await store.putLane({ ...lane('l_closed', [modify('c_2', 's2', 'y')]), status: 'closed' });
    expect((await app.inject({ method: 'POST', url: '/api/lanes/l_closed/open' })).statusCode).toBe(409);
  });

  it('accept and refuse work on a draft lane and open it implicitly', async () => {
    await store.putLane({ ...lane('l_a', [modify('c_1', 's1', 'A'), modify('c_2', 's2', 'B')]), status: 'draft', origin: 'check:arc' });
    const a = await accept('l_a', 'c_1');
    expect(a.statusCode).toBe(200);
    expect(a.json().lane.status).toBe('open');
    expect((await deck()).slides.s1.title).toBe('A');

    await store.putLane({ ...lane('l_b', [modify('c_3', 's3', 'C'), modify('c_4', 's4', 'D')]), status: 'draft', origin: 'check:order' });
    const r = await refuse('l_b', 'c_3');
    expect(r.statusCode).toBe(200);
    expect(r.json().status).toBe('open');
    expect((await getLane('l_b')).status).toBe('open');
    expect(events).toContainEqual({ type: 'lane.updated', laneId: 'l_b' });
  });

  it('an accept rebases draft lanes like open ones: a draft whose only change is orphaned is closed', async () => {
    await store.putLane(lane('l_a', [remove('c_rm', 's3')]));
    await store.putLane({ ...lane('l_d', [modify('c_m3', 's3', 'x')]), status: 'draft', origin: 'check:render' });
    await store.putLane({ ...lane('l_e', [modify('c_m3b', 's3', 'x'), modify('c_m4', 's4', 'y')]), status: 'draft', origin: 'check:render' });
    expect((await accept('l_a', 'c_rm')).statusCode).toBe(200);
    expect((await getLane('l_d')).status).toBe('closed');
    const e = await getLane('l_e');
    // Still a draft: rebasing is not the creator acting on it.
    expect(e.status).toBe('draft');
    expect(e.changes.map((c) => c.status)).toEqual(['orphan', 'pending']);
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_d' });
  });

  const laneThread = async (l: string): Promise<string[]> => ((await app.inject({ method: 'GET', url: `/api/threads/lane:${l}` })).json() as { text: string }[]).map((m) => m.text);
  const setTitle = async (id: string, title: string): Promise<void> => {
    const main = await store.snapshot();
    await store.commit({ ...main, slides: { ...main.slides, [id]: { ...main.slides[id]!, title } } }, { kind: 'restore', from: 1, entry: '{}' });
  };

  it('QA3 stale modify: a lane on v1 setting a title main changed since is orphaned with the reason, and closed', async () => {
    // v1: s2 titled "Title s2" (A). l_old proposes B; l_new proposes C and is accepted.
    await store.putLane(lane('l_old', [modify('c_old', 's2', 'B')]));
    await store.putLane(lane('l_new', [modify('c_new', 's2', 'C')]));
    expect((await accept('l_new', 'c_new')).statusCode).toBe(200);
    const old = await getLane('l_old');
    expect(old.changes.map((c) => c.status)).toEqual(['orphan']);
    expect(old.status).toBe('closed');
    expect((await laneThread('l_old')).join('\n')).toMatch(/title changed on main since v1/);
    expect(((await app.inject({ method: 'GET', url: '/api/lanes' })).json() as Lane[]).map((l) => l.id)).toEqual([]);
  });

  it('QA3 already on main: after main takes the same title, the lane closes as accepted and leaves the list', async () => {
    await store.putLane(lane('l_a', [modify('c_a', 's2', 'Same')]));
    await store.putLane(lane('l_b', [modify('c_b', 's2', 'Same'), modify('c_b2', 's3', 'Other')]));
    expect((await accept('l_a', 'c_a')).statusCode).toBe(200);
    const b = await getLane('l_b');
    expect(b.changes.map((c) => [c.id, c.status])).toEqual([
      ['c_b', 'accepted'],
      ['c_b2', 'pending'],
    ]);
    expect(b.status).toBe('open');
    expect(await laneThread('l_b')).toEqual(['The title of slide 2 (Same): already on main, nothing to decide.']);

    await store.putLane(lane('l_c', [modify('c_c', 's4', 'Four')]));
    await setTitle('s4', 'Four');
    // Any later accept rebases every open lane on main.
    expect((await accept('l_b', 'c_b2')).statusCode).toBe(200);
    expect((await getLane('l_c')).status).toBe('closed');
    expect((await getLane('l_c')).changes[0]!.status).toBe('accepted');
    expect(((await app.inject({ method: 'GET', url: '/api/lanes' })).json() as Lane[]).map((l) => l.id)).toEqual([]);
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_c' });
  });

  it('refuse and open rebase the lane on main: stale changes are orphaned, a lane left with nothing pending closes', async () => {
    await store.putLane(lane('l_a', [modify('c_1', 's1', 'x'), modify('c_2', 's2', 'y')]));
    await setTitle('s2', 'Changed on main');
    const r = await refuse('l_a', 'c_1');
    expect(r.statusCode).toBe(200);
    expect(r.json().changes.map((c: Change) => c.status)).toEqual(['refused', 'orphan']);
    expect(r.json().status).toBe('closed');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_a' });

    await store.putLane({ ...lane('l_d', [modify('c_3', 's3', 'z')]), status: 'draft', origin: 'check:render' });
    await setTitle('s3', 'z');
    const o = await app.inject({ method: 'POST', url: '/api/lanes/l_d/open' });
    expect(o.statusCode).toBe(200);
    expect(o.json().status).toBe('closed');
    expect(o.json().changes[0].status).toBe('accepted');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_d' });
  });

  it('QA3 variants: pending modifies list the other open lanes on the same slide and field; accepting one orphans the others', async () => {
    await store.putLane(lane('l_a', [modify('c_a', 's2', 'A title'), modify('c_a3', 's3', 'x')]));
    await store.putLane(lane('l_b', [modify('c_b', 's2', 'B title')]));
    await store.putLane({ ...lane('l_n', [{ id: 'c_n', kind: 'modify', slide: 's2', patch: { notes: 'n' }, reason: 'r', status: 'pending' }]) });
    await store.putLane({ ...lane('l_closed', [modify('c_x', 's2', 'X')]), status: 'closed' });
    type Listed = Omit<Lane, 'changes'> & { changes: (Change & { variantOf?: string[] })[] };
    const list: Listed[] = (await app.inject({ method: 'GET', url: '/api/lanes' })).json();
    const variants = (l: string, c: string) => list.find((x) => x.id === l)!.changes.find((x) => x.id === c)!.variantOf;
    expect(variants('l_a', 'c_a')).toEqual(['l_b']);
    expect(variants('l_a', 'c_a3')).toEqual([]);
    expect(variants('l_b', 'c_b')).toEqual(['l_a']);
    expect(variants('l_n', 'c_n')).toEqual([]);
    const one: Listed = (await app.inject({ method: 'GET', url: '/api/lanes/l_b' })).json();
    expect(one.changes[0]!.variantOf).toEqual(['l_a']);
    // Not stored: the lane on disk has no such field.
    expect('variantOf' in (await store.lane('l_b'))!.changes[0]!).toBe(false);

    expect((await accept('l_b', 'c_b')).statusCode).toBe(200);
    const a = await getLane('l_a');
    expect(a.changes.map((c) => [c.id, c.status])).toEqual([
      ['c_a', 'orphan'],
      ['c_a3', 'pending'],
    ]);
    expect((a.changes[1] as Change & { variantOf?: string[] }).variantOf).toEqual([]);
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

  const listLanes = async (q = ''): Promise<Lane[]> => (await app.inject({ method: 'GET', url: `/api/lanes${q}` })).json();
  const move = (id: string, target: string, after: string | null): Change => ({ id, kind: 'move', slide: target, after, reason: 'r', status: 'pending' });
  const openRemarks = async (): Promise<string[]> => ((await app.inject({ method: 'GET', url: '/api/remarks?status=open' })).json() as Remark[]).map((r) => r.id);
  const remarkBase = { origin: 'check:arc' as const, severity: 'warn' as const, status: 'open' as const, laneId: null, createdAt: '2026-09-30T00:00:00.000Z' };

  it('QA4 a lane on v7 whose field main changes at v8 through a restore is served orphan with its cause, without any accept', async () => {
    for (let k = 2; k <= 7; k++) await setTitle('s5', `five v${k}`);
    expect((await store.state()).version).toBe(7);
    await store.putLane({ ...lane('l_a', [modify('c_a', 's2', 'New title')]), baseVersion: 7 });
    expect((await listLanes()).map((l) => l.id)).toEqual(['l_a']);

    // v8 written behind the server's back: no event, only the next read can notice it.
    await setTitle('s2', 'Restored title');
    const served = await getLane('l_a');
    expect(served.changes.map((c) => c.status)).toEqual(['orphan']);
    expect(served.status).toBe('closed');
    expect((await laneThread('l_a')).join('\n')).toMatch(/title changed on main since v7/);
    expect((await listLanes()).map((l) => l.id)).toEqual([]);
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_a' });
    expect(events.filter((e) => e.type === 'deck.changed')).toEqual([]);
  });

  it('QA4 any deck.changed (a direct slide edit) rebases open and draft lanes once, with no read and no accept', async () => {
    await store.putLane(lane('l_a', [modify('c_a', 's2', 'Lane title')]));
    await store.putLane({ ...lane('l_d', [modify('c_d', 's2', 'Draft title'), modify('c_d4', 's4', 'Four')]), status: 'draft', origin: 'check:order' });
    const patch = await app.inject({ method: 'PATCH', url: '/api/slides/s2', payload: { title: 'Edited by hand' } });
    expect(patch.statusCode).toBe(200);
    await waitFor(() => events.some((e) => e.type === 'lane.closed' && e.laneId === 'l_a'));
    const a = (await store.lane('l_a'))!;
    expect(a.changes[0]!.status).toBe('orphan');
    const d = (await store.lane('l_d'))!;
    expect(d.status).toBe('draft');
    expect(d.changes.map((c) => c.status)).toEqual(['orphan', 'pending']);
    // Each lane's rebase is told once in its thread.
    expect(await laneThread('l_a')).toHaveLength(1);
    expect(await laneThread('l_d')).toHaveLength(1);
  });

  it('QA4 a move that reverses a range remark resolves it; a slide remark and a lane-preview remark stay open', async () => {
    await store.putLane({ ...lane('l_preview', [modify('c_p', 's5', 'P'), modify('c_p1', 's1', 'P1')]) });
    await store.putRemarks([
      { ...remarkBase, id: 'r_range', anchor: { kind: 'range', from: 's2', to: 's4' }, text: 'too long between s2 and s4' },
      { ...remarkBase, id: 'r_slide', anchor: { kind: 'slide', slide: 's4' }, text: 'dense' },
      { ...remarkBase, id: 'r_preview', anchor: { kind: 'range', from: 's5', to: 's1' }, text: 'on the preview', origin: 'check:render', sourceLaneId: 'l_preview' },
    ]);
    await store.putLane(lane('l_m', [move('c_m', 's4', 's1')]));
    expect((await accept('l_m', 'c_m')).statusCode).toBe(200);
    expect((await store.state()).order).toEqual(['s1', 's4', 's2', 's3', 's5']);
    expect(await openRemarks()).toEqual(['r_slide', 'r_preview']);
    expect((await store.remarks()).find((r) => r.id === 'r_range')!.status).toBe('resolved');
    expect(events).toContainEqual({ type: 'remarks.changed' });
  });

  it('QA4 a reorder written behind the server resolves reversed range remarks on the next lane read', async () => {
    await store.putRemarks([{ ...remarkBase, id: 'r_range', anchor: { kind: 'range', from: 's1', to: 's3' }, text: 'opening' }]);
    expect(await openRemarks()).toEqual(['r_range']);
    const main = await store.snapshot();
    await store.commit({ ...main, order: ['s3', 's1', 's2', 's4', 's5'] }, { kind: 'restore', from: 1, entry: '{}' });
    await listLanes();
    expect(await openRemarks()).toEqual([]);
  });
});

class FailingThumbs extends ThumbService {
  override async thumb(_slide: Slide): Promise<ThumbResult> {
    throw new Error('browser crashed');
  }
}

describe('lane preview thumbnails that fail', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let app: FastifyInstance;

  beforeAll(async () => {
    tmp = await tmpDir();
  });
  afterAll(async () => {
    await app?.close();
    await tmp?.cleanup();
  });

  it('emit thumb.failed with the hash and slide, not an agent error', async () => {
    const deckDir = join(tmp.dir, 'deck');
    const store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    // Never started: thumb() fails before any browser is needed.
    const thumbs = new FailingThumbs({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    app = await buildApp({ deckDir, thumbs });
    const events: BusEvent[] = [];
    app.bus.on('any', (e) => events.push(e));
    await app.ready();
    await store.putLane(lane('l_a', [modify('c_1', 's2', 'S2 preview')]));

    const p = (await app.inject({ method: 'GET', url: '/api/lanes/l_a/preview' })).json();
    const hash = p.thumbs.s2.hash as string;
    await waitFor(() => events.some((e) => e.type === 'thumb.failed'));
    expect(events.filter((e) => e.type === 'thumb.failed' || e.type === 'agent.error')).toEqual([
      { type: 'thumb.failed', hash, slideId: 's2', message: 'browser crashed' },
    ]);
  });
});
