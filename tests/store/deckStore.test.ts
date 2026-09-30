import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { access, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DeckStore } from '../../src/store/deckStore.js';
import { hashSlide } from '../../src/model/ids.js';
import type { Brief, Lane, Remark, Slide, Snapshot, ThreadMessage, Version } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';

const brief: Brief = { title: 'T', audience: 'devs', message: 'm', pattern: 'problem-driven', abstract: 'a' };
const slide = (id: string, title = id): Slide => ({ id, title, story: '', notes: '', body: `<p>${title}</p>`, assets: [], kind: 'text' });
const snap = (...slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });
const exists = (p: string) => access(p).then(() => true, () => false);

let dir: string;
let cleanup: () => Promise<void>;
beforeEach(async () => {
  ({ dir, cleanup } = await tmpDir());
});
afterEach(async () => {
  await cleanup();
});

describe('DeckStore', () => {
  it('init creates the layout with v0 and default model', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    for (const d of ['slides', 'assets', 'objects', 'versions', 'lanes', 'threads', 'cache/thumbs']) {
      expect(await exists(join(dir, d)), d).toBe(true);
    }
    expect(JSON.parse(await readFile(join(dir, 'brief.json'), 'utf8'))).toEqual(brief);
    expect(await store.state()).toEqual({ name: 'demo', order: [], version: 0, sessionId: null, model: 'claude-opus-5' });
    const vs = await store.versions();
    expect(vs).toHaveLength(1);
    expect(vs[0]).toMatchObject({ n: 0, order: [], slides: {}, cause: { kind: 'import' } });
    expect(await store.remarks()).toEqual([]);
    expect(await store.brief()).toEqual(brief);
    expect(await store.snapshot()).toEqual({ order: [], slides: {} });
  });

  it('init refuses an existing deck; open requires deck.json', async () => {
    await expect(DeckStore.open(dir)).rejects.toThrow();
    await DeckStore.init(dir, 'demo', brief);
    await expect(DeckStore.init(dir, 'again', brief)).rejects.toThrow();
    const reopened = await DeckStore.open(dir);
    expect((await reopened.state()).name).toBe('demo');
  });

  it('commit twice yields v1, v2 and reuses the object of an unchanged slide', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    const a = slide('a');
    const b = slide('b');
    const v1 = await store.commit(snap(a, b), { kind: 'import' });
    expect(v1.n).toBe(1);
    const b2 = { ...b, title: 'B two' };
    const v2 = await store.commit(snap(b2, a), { kind: 'accept', laneId: 'l1', changeId: 'c1' });
    expect(v2.n).toBe(2);
    expect(v2.slides.a).toBe(v1.slides.a);
    expect(v2.slides.a).toBe(hashSlide(a));
    expect(v2.slides.b).not.toBe(v1.slides.b);
    const objects = await readdir(join(dir, 'objects'));
    expect(objects.sort()).toEqual([`${hashSlide(a)}.json`, `${hashSlide(b)}.json`, `${hashSlide(b2)}.json`].sort());
    expect((await store.state()).version).toBe(2);
    expect(await store.snapshot()).toEqual(snap(b2, a));
    expect(await store.slide('b')).toEqual(b2);
    expect((await store.versions()).map((v) => v.n)).toEqual([0, 1, 2]);
  });

  it('commit drops slide files for removed slides and rejects inconsistent snapshots', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    await store.commit(snap(slide('a'), slide('b')), { kind: 'import' });
    await store.commit(snap(slide('a')), { kind: 'accept', laneId: 'l', changeId: 'c' });
    expect(await store.slide('b')).toBeNull();
    expect(await readdir(join(dir, 'slides'))).toEqual(['a.json']);
    await expect(store.commit({ order: ['a', 'zz'], slides: { a: slide('a') } }, { kind: 'import' })).rejects.toThrow(/zz/);
    await expect(store.commit({ order: ['a'], slides: { a: slide('x') } }, { kind: 'import' })).rejects.toThrow();
    await expect(store.commit(snap(slide('../evil')), { kind: 'import' })).rejects.toThrow();
    expect((await store.state()).version).toBe(2);
  });

  it('snapshotAt(1) after two commits returns the older order and content', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    const a = slide('a');
    const b = slide('b');
    await store.commit(snap(a, b), { kind: 'import' });
    await store.commit(snap({ ...b, body: '<p>new</p>' }, a), { kind: 'accept', laneId: 'l', changeId: 'c' });
    expect(await store.snapshotAt(1)).toEqual(snap(a, b));
    expect(await store.snapshotAt(0)).toEqual({ order: [], slides: {} });
    await expect(store.snapshotAt(9)).rejects.toThrow();
  });

  it('two concurrent withLock(commit) produce v1 and v2, never two v1', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    const other = await DeckStore.open(dir); // same folder, different instance: same lock
    const commitNext = (s: DeckStore, title: string) =>
      s.withLock(async () => {
        const cur = await s.snapshot();
        const x = slide(`s${title}`, title);
        return s.commit({ order: [...cur.order, x.id], slides: { ...cur.slides, [x.id]: x } }, { kind: 'accept', laneId: 'l', changeId: title });
      });
    const [v1, v2] = await Promise.all([commitNext(store, 'one'), commitNext(other, 'two')]);
    expect([v1.n, v2.n].sort()).toEqual([1, 2]);
    expect((await store.versions()).map((v) => v.n)).toEqual([0, 1, 2]);
    expect((await store.snapshot()).order).toEqual(['sone', 'stwo']);
  });

  it('withLock releases after a rejection', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    await expect(store.withLock(async () => { throw new Error('boom'); })).rejects.toThrow('boom');
    expect(await store.withLock(async () => 42)).toBe(42);
  });

  it('thread append/read round-trips; lane:abc maps to threads/lane_abc.jsonl', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    expect(await store.thread('lane:abc')).toEqual([]);
    const m1: ThreadMessage = { id: 'm1', thread: 'lane:abc', role: 'user', text: 'hi\nthere', context: { kind: 'slide', slide: 'a' }, at: '2026-09-30T00:00:00Z' };
    const m2: ThreadMessage = { id: 'm2', thread: 'lane:abc', role: 'assistant', text: 'ok', context: null, at: '2026-09-30T00:00:01Z' };
    await store.appendMessage(m1);
    await store.appendMessage(m2);
    expect(await store.thread('lane:abc')).toEqual([m1, m2]);
    expect(await exists(join(dir, 'threads', 'lane_abc.jsonl'))).toBe(true);
    expect((await readFile(join(dir, 'threads', 'lane_abc.jsonl'), 'utf8')).trim().split('\n')).toHaveLength(2);
    expect(await store.thread('global')).toEqual([]);
  });

  it('lanes, remarks, brief and sessionId persist', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    const lane: Lane = { id: 'L1', label: 'tighten', anchor: { kind: 'arc' }, origin: 'user', baseVersion: 0, changes: [], status: 'open', createdAt: '2026-09-30T00:00:00Z' };
    await store.putLane(lane);
    await store.putLane({ ...lane, id: 'L2', createdAt: '2026-09-30T00:00:01Z' });
    await store.putLane({ ...lane, label: 'tighter' });
    expect(await store.lane('L1')).toEqual({ ...lane, label: 'tighter' });
    expect(await store.lane('nope')).toBeNull();
    expect((await store.lanes()).map((l) => l.id)).toEqual(['L1', 'L2']);
    const remark: Remark = { id: 'r1', anchor: { kind: 'arc' }, text: 'x', origin: 'check:arc', severity: 'warn', status: 'open', laneId: null, createdAt: '2026-09-30T00:00:00Z' };
    await store.putRemarks([remark]);
    expect(await store.remarks()).toEqual([remark]);
    await store.setBrief({ ...brief, title: 'T2' });
    expect((await store.brief()).title).toBe('T2');
    await store.setSessionId('sess-1');
    const reopened = await DeckStore.open(dir);
    expect((await reopened.state()).sessionId).toBe('sess-1');
    await reopened.setSessionId(null);
    expect((await store.state()).sessionId).toBeNull();
  });

  it('snapshotAt gives each slide its version key as id even when two slides share an object', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    const a = slide('a', 'same');
    const b = { ...a, id: 'b' };
    expect(hashSlide(a)).toBe(hashSlide(b));
    await store.commit(snap(a, b), { kind: 'import' });
    await store.commit(snap(slide('c')), { kind: 'accept', laneId: 'l', changeId: 'c' });
    const at1 = await store.snapshotAt(1);
    expect(at1).toEqual(snap(a, b));
    const v3 = await store.commit(at1, { kind: 'restore', from: 1, entry: 'x' });
    expect(v3.n).toBe(3);
    expect(await store.snapshot()).toEqual(snap(a, b));
  });

  it('recovers from a crash that left an orphan version file above deck.json', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    await store.commit(snap(slide('a')), { kind: 'import' });
    const orphan: Version = { n: 2, order: ['zz'], slides: { zz: hashSlide(slide('zz')) }, cause: { kind: 'import' }, createdAt: '2026-09-30T00:00:00Z' };
    await writeFile(join(dir, 'versions', 'v2.json'), JSON.stringify(orphan));
    const v2 = await store.commit(snap(slide('a'), slide('b')), { kind: 'accept', laneId: 'l', changeId: 'c' });
    expect(v2.n).toBe(2);
    const state = await store.state();
    expect(state).toMatchObject({ version: 2, order: ['a', 'b'] });
    const onDisk = (await store.versions()).find((v) => v.n === 2);
    expect(onDisk).toEqual(v2);
    expect(onDisk?.order).toEqual(state.order);
    expect(await store.snapshotAt(2)).toEqual(await store.snapshot());
  });

  it('versions() lists only committed versions, never an orphan file above deck.json', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    await store.commit(snap(slide('a')), { kind: 'import' });
    const orphan: Version = { n: 99, order: ['zz'], slides: { zz: hashSlide(slide('zz')) }, cause: { kind: 'import' }, createdAt: '2026-09-30T00:00:00Z' };
    await writeFile(join(dir, 'versions', 'v99.json'), JSON.stringify(orphan));
    expect((await store.versions()).map((v) => v.n)).toEqual([0, 1]);
  });

  it('setSessionId racing a commit loses neither update', async () => {
    const store = await DeckStore.init(dir, 'demo', brief);
    await Promise.all([store.commit(snap(slide('a')), { kind: 'import' }), store.setSessionId('s')]);
    expect(await store.state()).toMatchObject({ version: 1, order: ['a'], sessionId: 's' });
  });
});
