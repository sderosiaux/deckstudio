import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { makeDeckToolHandlers, makeDeckTools, type DeckToolContext } from '../../src/agent/tools.js';
import { contextHeader, SYSTEM_APPEND } from '../../src/agent/prompts.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { Bus, type BusEvent } from '../../src/server/bus.js';
import type { Brief, Lane, Slide, Snapshot } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { assetsDir as fixtureAssets, themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs' };
const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: `story of ${id}`,
  notes: '',
  body: `<p>body ${id}</p>`,
  assets: [],
  kind: 'text',
  ...over,
});
const five = ['s1', 's2', 's3', 's4', 's5'].map((id) => slide(id));
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });
const exists = (p: string) => access(p).then(() => true, () => false);
const newSlide = (over: Partial<Omit<Slide, 'id'>> = {}) => ({ title: 'New claim', story: 'why', notes: '', body: '<div class="cap">x</div>', assets: [], kind: 'text' as const, ...over });

describe('deck tools', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let thumbs: ThumbService;
  let store: DeckStore;
  let bus: Bus;
  let events: BusEvent[];
  let ctx: DeckToolContext;
  let images: [string, string][];
  let checks: string[];

  beforeAll(async () => {
    tmp = await tmpDir();
    thumbs = new ThumbService({ cacheDir: join(tmp.dir, 'thumbcache'), themeCss, assetsDir: fixtureAssets });
    await thumbs.start();
  }, 60_000);
  afterAll(async () => {
    await thumbs?.stop();
    await tmp?.cleanup();
  });

  beforeEach(async () => {
    const dir = join(tmp.dir, `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = await DeckStore.init(dir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    bus = new Bus();
    events = [];
    bus.on('any', (e) => events.push(e));
    images = [];
    checks = [];
    ctx = {
      store,
      thumbs,
      bus,
      imageGen: async (prompt, size) => {
        images.push([prompt, size]);
        return 'assets/gen-1.png';
      },
      runCheck: async (name) => {
        checks.push(name);
      },
    };
  });

  const laneFiles = async () => (await readdir(join(store.dir, 'lanes'))).filter((f) => f.endsWith('.json'));

  it('get_deck lists the outline; get_slide returns a slide or an error', async () => {
    const h = makeDeckToolHandlers(ctx);
    const deck = (await h.get_deck({})) as { version: number; slides: { index: number; id: string; title: string }[] };
    expect(deck.version).toBe(1);
    expect(deck.slides.map((s) => s.id)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(deck.slides[2]).toMatchObject({ index: 3, id: 's3', title: 'Title s3' }); // 1-based, as the creator counts
    expect(await h.get_slide({ id: 's2' })).toEqual(five[1]);
    expect(await h.get_slide({ id: 'nope' })).toMatchObject({ error: expect.stringContaining('nope') });
  });

  it('propose_lane rejects an unknown slide id and persists nothing (Review Focus 4)', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      label: 'tighten',
      anchor: { kind: 'range', from: 's1', to: 's3' },
      changes: [
        { kind: 'modify', slide: 's2', patch: { title: 'Better' }, reason: 'sharper claim' },
        { kind: 'remove', slide: 's_ghost', reason: 'redundant' },
      ],
    })) as { error: string; invalid: { index: number; reason: string }[] };
    expect(res.error).toBeTruthy();
    expect(res.invalid).toEqual([{ index: 1, reason: expect.stringContaining('s_ghost') }]);
    expect(await laneFiles()).toEqual([]);
    expect(events.filter((e) => e.type === 'lane.created')).toEqual([]);
  });

  it('propose_lane rejects an unknown anchor slide', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      label: 'x',
      anchor: { kind: 'slide', slide: 's9' },
      changes: [{ kind: 'modify', slide: 's2', patch: { title: 'T' }, reason: 'r' }],
    })) as { error: string };
    expect(res.error).toContain('s9');
    expect(await laneFiles()).toEqual([]);
  });

  it('propose_lane rejects <ul> in an inserted body, naming the change index', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      label: 'hook',
      anchor: { kind: 'arc' },
      changes: [
        { kind: 'insert', after: 's1', slide: newSlide(), reason: 'hook' },
        { kind: 'insert', after: 's2', slide: newSlide({ body: '<ul><li>a</li></ul>' }), reason: 'list' },
      ],
    })) as { error: string; invalid: { index: number; reason: string }[] };
    expect(res.invalid).toHaveLength(1);
    expect(res.invalid[0]!.index).toBe(1);
    expect(res.invalid[0]!.reason).toContain('<ul>');
    expect(await laneFiles()).toEqual([]);
  });

  it('propose_lane rejects malformed input with a readable error', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({ label: 'x', anchor: { kind: 'arc' }, changes: [] })) as { error: string };
    expect(res.error).toMatch(/changes/);
    expect(await laneFiles()).toEqual([]);
  });

  it('propose_lane persists a valid insert as a pending lane at the current version', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      label: 'hook',
      anchor: { kind: 'range', from: 's1', to: 's3' },
      changes: [{ kind: 'insert', after: null, slide: newSlide(), reason: 'open on the claim' }],
    })) as { laneId: string; changes: { id: string; summary: string }[] };
    expect(res.laneId).toMatch(/^l_/);
    expect(res.changes).toHaveLength(1);
    expect(res.changes[0]!.id).toMatch(/^c_/);
    expect(res.changes[0]!.summary).toContain('New claim');
    const onDisk = JSON.parse(await readFile(join(store.dir, 'lanes', `${res.laneId}.json`), 'utf8')) as Lane;
    expect(onDisk).toMatchObject({ id: res.laneId, label: 'hook', origin: 'user', baseVersion: 1, status: 'open' });
    const c = onDisk.changes[0]!;
    expect(c).toMatchObject({ id: res.changes[0]!.id, kind: 'insert', after: null, status: 'pending', reason: 'open on the claim' });
    if (c.kind !== 'insert') throw new Error('expected insert');
    expect(c.slide.id).toMatch(/^s_/);
    expect(c.slide.title).toBe('New claim');
    expect(events).toContainEqual({ type: 'lane.created', laneId: res.laneId });
  });

  it('propose_lane rejects changes that conflict with each other', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      label: 'x',
      anchor: { kind: 'arc' },
      changes: [
        { kind: 'remove', slide: 's3', reason: 'cut' },
        { kind: 'modify', slide: 's3', patch: { title: 'T' }, reason: 'retitle' },
      ],
    })) as { invalid: { index: number }[] };
    expect(res.invalid.map((i) => i.index)).toEqual([1]);
    expect(await laneFiles()).toEqual([]);
  });

  it('revise_lane replaces pending changes and keeps accepted ones', async () => {
    const h = makeDeckToolHandlers(ctx);
    const { laneId } = (await h.propose_lane({
      label: 'l',
      anchor: { kind: 'arc' },
      changes: [
        { kind: 'modify', slide: 's2', patch: { title: 'A' }, reason: 'a' },
        { kind: 'modify', slide: 's3', patch: { title: 'B' }, reason: 'b' },
      ],
    })) as { laneId: string };
    const lane = (await store.lane(laneId))!;
    const accepted = { ...lane.changes[0]!, status: 'accepted' as const };
    await store.putLane({ ...lane, changes: [accepted, lane.changes[1]!] });

    const bad = (await h.revise_lane({ laneId, replaceChanges: [{ kind: 'remove', slide: 'zz', reason: 'r' }] })) as { invalid: unknown[] };
    expect(bad.invalid).toHaveLength(1);
    expect((await store.lane(laneId))!.changes).toHaveLength(2);

    const res = (await h.revise_lane({
      laneId,
      replaceChanges: [{ kind: 'move', slide: 's5', after: 's1', reason: 'close earlier' }],
    })) as { laneId: string; changes: { id: string }[] };
    expect(res.laneId).toBe(laneId);
    const after = (await store.lane(laneId))!;
    expect(after.changes.map((c) => [c.kind, c.status])).toEqual([
      ['modify', 'accepted'],
      ['move', 'pending'],
    ]);
    expect(after.changes[0]).toEqual(accepted);
    expect(events).toContainEqual({ type: 'lane.updated', laneId });

    expect(await h.revise_lane({ laneId: 'l_missing', replaceChanges: [{ kind: 'remove', slide: 's1', reason: 'r' }] })).toMatchObject({
      error: expect.stringContaining('l_missing'),
    });
  });

  it('add_remark appends an open user remark; link_remark_lane sets its lane', async () => {
    const h = makeDeckToolHandlers(ctx);
    const { remarkId } = (await h.add_remark({ anchor: { kind: 'slide', slide: 's2' }, text: 'weak claim', severity: 'warn' })) as { remarkId: string };
    expect(remarkId).toMatch(/^r_/);
    await h.add_remark({ anchor: { kind: 'arc' }, text: 'second', severity: 'info' });
    const rs = await store.remarks();
    expect(rs).toHaveLength(2);
    expect(rs[0]).toMatchObject({ id: remarkId, origin: 'user', status: 'open', laneId: null, text: 'weak claim', severity: 'warn' });
    expect(events.filter((e) => e.type === 'remarks.changed')).toHaveLength(2);

    const { laneId } = (await h.propose_lane({
      label: 'fix',
      anchor: { kind: 'slide', slide: 's2' },
      changes: [{ kind: 'modify', slide: 's2', patch: { title: 'Sharper' }, reason: 'answers remark' }],
    })) as { laneId: string };
    expect(await h.link_remark_lane({ remarkId, laneId })).toEqual({ remarkId, laneId });
    expect((await store.remarks())[0]!.laneId).toBe(laneId);
    expect(await h.link_remark_lane({ remarkId: 'r_none', laneId })).toMatchObject({ error: expect.any(String) });
  });

  it('generate_image and run_check delegate to the context', async () => {
    const h = makeDeckToolHandlers(ctx);
    expect(await h.generate_image({ prompt: 'a log', size: '1024x1024' })).toEqual({ asset: 'assets/gen-1.png' });
    expect(images).toEqual([['a log', '1024x1024']]);
    expect(await h.run_check({ name: 'arc' })).toEqual({ started: true });
    expect(checks).toEqual(['arc']);
  });

  it('render_slide writes a 1280x720 png under cache/renders and reports body warnings', async () => {
    const h = makeDeckToolHandlers(ctx);
    const ok = (await h.render_slide({ title: 'Claim', body: '<div>fine</div>', kind: 'text' })) as { png_path: string; warnings: string[] };
    expect(ok.warnings).toEqual([]);
    expect(ok.png_path.startsWith(join(store.dir, 'cache', 'renders'))).toBe(true);
    expect(await exists(ok.png_path)).toBe(true);
    const png = await readFile(ok.png_path);
    expect(png.readUInt32BE(16)).toBe(1280);
    expect(png.readUInt32BE(20)).toBe(720);
    const warn = (await h.render_slide({ title: 'Claim', body: '<ul><li>a</li></ul>', kind: 'text' })) as { warnings: string[] };
    expect(warn.warnings.join(' ')).toContain('<ul>');
  }, 30_000);

  it('makeDeckTools exposes an sdk server named deck with every tool', () => {
    const { server, allowedTools } = makeDeckTools(ctx);
    expect(server.type).toBe('sdk');
    expect(server.name).toBe('deck');
    expect(allowedTools).toEqual(['mcp__deck__*']);
  });
});

describe('prompts', () => {
  it('SYSTEM_APPEND states the composition rules', () => {
    for (const s of ['render_slide', 'revise_lane', 'propose_lane', '24px', '1280x720', 'language']) expect(SYSTEM_APPEND).toContain(s);
  });

  it('contextHeader lists brief, outline, range stories, and lane changes', () => {
    const snapshot = snap(five);
    const lane: Lane = {
      id: 'l1',
      label: 'hook',
      anchor: { kind: 'range', from: 's2', to: 's3' },
      origin: 'user',
      baseVersion: 1,
      changes: [{ id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'x' }, reason: 'sharper', status: 'pending' }],
      status: 'open',
      createdAt: '2026-01-01T00:00:00.000Z',
    };
    const h = contextHeader({ thread: 'lane:l1', anchor: lane.anchor, snapshot, lane, brief });
    expect(h).toContain('one log');
    expect(h).toContain('solution-first');
    for (const s of five) expect(h).toContain(`${s.id}`);
    expect(h).toContain('story of s2');
    expect(h).toContain('story of s3');
    expect(h).not.toContain('story of s4');
    expect(h).toMatch(/c1.*modify.*s2.*sharper.*pending/);

    const r = contextHeader({
      thread: 'remark:r1',
      anchor: { kind: 'slide', slide: 's4' },
      snapshot,
      remark: { id: 'r1', anchor: { kind: 'slide', slide: 's4' }, text: 'too dense', origin: 'check:arc', severity: 'warn', status: 'open', laneId: null, createdAt: '' },
      brief,
    });
    expect(r).toContain('too dense');
    expect(r).toContain('story of s4');
  });
});
