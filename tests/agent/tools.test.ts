import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { access, mkdir, readdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { DIAGRAM_STYLE, makeImageGen } from '../../src/agent/imageGen.js';
import { createLane, GENERATE_IMAGE_DESCRIPTION, makeDeckToolHandlers, makeDeckTools, type DeckToolContext } from '../../src/agent/tools.js';
import { contextHeader, SYSTEM_APPEND } from '../../src/agent/prompts.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { Bus, type BusEvent } from '../../src/server/bus.js';
import type { Brief, Lane, Slide, Snapshot } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { assetsDir as fixtureAssets, themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
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
  let images: [string, string, string][];
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
      imageGen: async (prompt, size, style) => {
        images.push([prompt, size, style]);
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

  it('revise_lane with replace: true drops unmentioned pending changes and keeps decided ones', async () => {
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

    const bad = (await h.revise_lane({ laneId, changes: [{ kind: 'remove', slide: 'zz', reason: 'r' }] })) as { invalid: unknown[] };
    expect(bad.invalid).toHaveLength(1);
    expect((await store.lane(laneId))!.changes).toHaveLength(2);

    const res = (await h.revise_lane({
      laneId,
      replace: true,
      changes: [{ kind: 'move', slide: 's5', after: 's1', reason: 'close earlier' }],
    })) as { laneId: string; added: string[]; kept: string[]; updated: string[]; dropped: string[] };
    expect(res.laneId).toBe(laneId);
    const after = (await store.lane(laneId))!;
    expect(after.changes.map((c) => [c.kind, c.status])).toEqual([
      ['modify', 'accepted'],
      ['move', 'pending'],
    ]);
    expect(after.changes[0]).toEqual(accepted);
    expect(res).toMatchObject({ kept: [], updated: [], added: [after.changes[1]!.id], dropped: [lane.changes[1]!.id] });
    expect(events).toContainEqual({ type: 'lane.updated', laneId });

    expect(await h.revise_lane({ laneId: 'l_missing', changes: [{ kind: 'remove', slide: 's1', reason: 'r' }] })).toMatchObject({
      error: expect.stringContaining('l_missing'),
    });
  });

  it('revise_lane keeps what it is not told to change: one new change keeps the other two with their ids and patches', async () => {
    const h = makeDeckToolHandlers(ctx);
    const { laneId } = (await h.propose_lane({
      label: 'Three edits',
      anchor: { kind: 'arc' },
      changes: [
        { kind: 'modify', slide: 's2', patch: { title: 'A', story: 'sa' }, reason: 'a' },
        { kind: 'modify', slide: 's3', patch: { title: 'B' }, reason: 'b' },
      ],
    })) as { laneId: string };
    const before = (await store.lane(laneId))!;
    const res = (await h.revise_lane({ laneId, changes: [{ kind: 'remove', slide: 's5', reason: 'too long' }] })) as {
      kept: string[];
      updated: string[];
      added: string[];
      dropped: string[];
    };
    const after = (await store.lane(laneId))!;
    expect(after.changes.slice(0, 2)).toEqual(before.changes);
    expect(after.changes[2]).toMatchObject({ kind: 'remove', slide: 's5', status: 'pending' });
    expect(res).toEqual({
      laneId,
      kept: before.changes.map((c) => c.id),
      updated: [],
      added: [after.changes[2]!.id],
      dropped: [],
      changes: after.changes.map((c) => ({ id: c.id, summary: expect.any(String) })),
    });

    // Matched by id: the change keeps its id, its patch merges; matched by (kind, target) without an id too.
    const [a, b] = before.changes;
    const res2 = (await h.revise_lane({
      laneId,
      changes: [
        { id: a!.id, kind: 'modify', slide: 's2', patch: { title: 'A2' }, reason: 'a2' },
        { kind: 'modify', slide: 's3', patch: { body: '<p>b2</p>' }, reason: 'b2' },
      ],
    })) as { kept: string[]; updated: string[]; added: string[] };
    expect(res2).toMatchObject({ kept: [after.changes[2]!.id], updated: [a!.id, b!.id], added: [] });
    const again = (await store.lane(laneId))!;
    expect(again.changes.map((c) => c.id)).toEqual(after.changes.map((c) => c.id));
    expect(again.changes[0]).toMatchObject({ patch: { title: 'A2', story: 'sa' }, reason: 'a2', status: 'pending' });
    expect(again.changes[1]).toMatchObject({ patch: { title: 'B', body: '<p>b2</p>' }, reason: 'b2' });

    // An id that is not a pending change of the lane is rejected, nothing saved.
    expect(await h.revise_lane({ laneId, changes: [{ id: 'c_nope', kind: 'remove', slide: 's4', reason: 'r' }] })).toMatchObject({ invalid: [{ index: 0 }] });
    expect(await store.lane(laneId)).toEqual(again);
  });

  it('QA3 no duplicate lanes: propose_lane with the same anchor and label (case and spaces aside) revises the open lane', async () => {
    const h = makeDeckToolHandlers(ctx);
    const anchor = { kind: 'slide', slide: 's2' } as const;
    const first = (await h.propose_lane({ label: 'Trim the illustrative values', anchor, changes: [{ kind: 'modify', slide: 's2', patch: { body: '<p>a</p>' }, reason: 'r1' }] })) as { laneId: string };
    const again = (await h.propose_lane({
      label: '  trim the   Illustrative values ',
      anchor,
      changes: [{ kind: 'modify', slide: 's2', patch: { body: '<p>b</p>', notes: 'n' }, reason: 'r2' }],
    })) as { laneId: string; revisedExisting: boolean; note: string; updated: string[] };
    expect(again.laneId).toBe(first.laneId);
    expect(again.revisedExisting).toBe(true);
    expect(again.note).toMatch(/revised.*instead of/i);
    expect(again.updated).toHaveLength(1);
    expect(await laneFiles()).toHaveLength(1);
    const lane = (await store.lane(first.laneId))!;
    expect(lane.label).toBe('Trim the illustrative values');
    expect(lane.changes).toMatchObject([{ kind: 'modify', slide: 's2', patch: { body: '<p>b</p>', notes: 'n' }, status: 'pending' }]);
    expect(events.filter((e) => e.type === 'lane.created')).toHaveLength(1);
    expect(events).toContainEqual({ type: 'lane.updated', laneId: first.laneId });

    // Another anchor, or a closed lane, is not a duplicate.
    const other = (await h.propose_lane({ label: 'Trim the illustrative values', anchor: { kind: 'slide', slide: 's3' }, changes: [{ kind: 'remove', slide: 's3', reason: 'r' }] })) as { laneId: string };
    expect(other.laneId).not.toBe(first.laneId);
    await store.putLane({ ...lane, status: 'closed' });
    const fresh = (await h.propose_lane({ label: 'Trim the illustrative values', anchor, changes: [{ kind: 'modify', slide: 's2', patch: { body: '<p>c</p>' }, reason: 'r' }] })) as { laneId: string; revisedExisting?: boolean };
    expect(fresh.laneId).not.toBe(first.laneId);
    expect(fresh.revisedExisting).toBeUndefined();
  });

  it('QA3 no duplicate lanes: a single change on the same slide and field as a recent open lane on that anchor revises it', async () => {
    const h = makeDeckToolHandlers(ctx);
    const anchor = { kind: 'slide', slide: 's2' } as const;
    const first = (await h.propose_lane({ label: 'Four-word hook title', anchor, changes: [{ kind: 'modify', slide: 's2', patch: { title: 'One home exists' }, reason: 'r1' }] })) as { laneId: string };
    const second = (await h.propose_lane({ label: 'Shorter hook title', anchor, changes: [{ kind: 'modify', slide: 's2', patch: { title: 'One home' }, reason: 'r2' }] })) as { laneId: string; revisedExisting: boolean };
    expect(second).toMatchObject({ laneId: first.laneId, revisedExisting: true });
    expect((await store.lane(first.laneId))!.changes).toMatchObject([{ patch: { title: 'One home' } }]);
    expect(await laneFiles()).toHaveLength(1);

    // An explicit alternative is a variant, not a revision.
    const alt = (await h.propose_lane({ label: 'Question title', anchor, alternative: true, changes: [{ kind: 'modify', slide: 's2', patch: { title: 'Where does it live?' }, reason: 'r3' }] })) as { laneId: string };
    expect(alt.laneId).not.toBe(first.laneId);
    // Another field, or a lane older than an hour, is not the same proposal.
    const notes = (await h.propose_lane({ label: 'Notes', anchor, changes: [{ kind: 'modify', slide: 's2', patch: { notes: 'say it slowly' }, reason: 'r' }] })) as { laneId: string };
    expect([first.laneId, alt.laneId]).not.toContain(notes.laneId);
    for (const id of [first.laneId, alt.laneId]) await store.putLane({ ...(await store.lane(id))!, createdAt: new Date(Date.now() - 2 * 3600_000).toISOString() });
    const late = (await h.propose_lane({ label: 'Late title', anchor, changes: [{ kind: 'modify', slide: 's2', patch: { title: 'Late' }, reason: 'r' }] })) as { laneId: string };
    expect([first.laneId, alt.laneId, notes.laneId]).not.toContain(late.laneId);
  });

  it('createLane validates like propose_lane and saves the lane with the given origin and status in one write', async () => {
    const res = (await createLane(ctx, { label: 'Hook first', anchor: { kind: 'arc' }, changes: [{ kind: 'move', slide: 's3', after: null, reason: 'hook' }] }, { origin: 'check:arc', status: 'draft' })) as { laneId: string };
    expect(await store.lane(res.laneId)).toMatchObject({ origin: 'check:arc', status: 'draft', label: 'Hook first' });
    expect(events).toContainEqual({ type: 'lane.created', laneId: res.laneId });
    const bad = await createLane(ctx, { label: 'x', anchor: { kind: 'arc' }, changes: [{ kind: 'remove', slide: 'ghost', reason: 'r' }] }, { origin: 'check:arc', status: 'draft' });
    expect(bad).toMatchObject({ invalid: [{ index: 0 }] });
    // The co-author's propose_lane still opens a user lane.
    const h = makeDeckToolHandlers(ctx);
    const own = (await h.propose_lane({ label: 'y', anchor: { kind: 'arc' }, changes: [{ kind: 'remove', slide: 's4', reason: 'r' }] })) as { laneId: string };
    expect(await store.lane(own.laneId)).toMatchObject({ origin: 'user', status: 'open' });
  });

  it('revise_lane works on a draft lane and keeps it a draft; a closed lane is refused', async () => {
    const h = makeDeckToolHandlers(ctx);
    const { laneId } = (await createLane(ctx, { label: 'd', anchor: { kind: 'arc' }, changes: [{ kind: 'remove', slide: 's4', reason: 'r' }] }, { origin: 'check:gaps', status: 'draft' })) as { laneId: string };
    const res = await h.revise_lane({ laneId, replace: true, changes: [{ kind: 'remove', slide: 's5', reason: 'r2' }] });
    expect(res).toMatchObject({ laneId });
    expect(await store.lane(laneId)).toMatchObject({ status: 'draft', changes: [{ kind: 'remove', slide: 's5' }] });
    await store.putLane({ ...(await store.lane(laneId))!, status: 'closed' });
    expect(await h.revise_lane({ laneId, changes: [{ kind: 'remove', slide: 's5', reason: 'r2' }] })).toMatchObject({ error: expect.stringContaining('closed') });
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
    expect(images).toEqual([['a log', '1024x1024', DIAGRAM_STYLE]]);
    expect(await h.run_check({ name: 'arc' })).toEqual({ started: true });
    expect(checks).toEqual(['arc']);
  });

  it('generate_image applies the image style of the brief, and the built-in style when it is empty', async () => {
    const dir = join(tmp.dir, `img-${Date.now()}`);
    await mkdir(dir, { recursive: true });
    const script = join(dir, 'gen.py');
    await writeFile(script, '');
    const prompts: string[] = [];
    const exec = (async (_cmd: string, args: readonly string[]) => {
      if (args[0] === script) {
        prompts.push(args[1]!);
        await writeFile(args[2]!, 'png');
      }
      return { stdout: '', stderr: '' };
    }) as unknown as NonNullable<Parameters<typeof makeImageGen>[1]>['exec'];
    const h = makeDeckToolHandlers({ ...ctx, imageGen: makeImageGen(join(store.dir, 'assets'), { script, postDir: '/post', exec }) });

    await h.generate_image({ prompt: 'three boxes labeled a, b, c', size: 'wide' });
    await store.setBrief({ ...brief, design: { rules: '', imageStyle: 'Charcoal line art on cream paper.' } });
    await h.generate_image({ prompt: 'one log', size: 'wide' });

    expect(prompts).toEqual([`${DIAGRAM_STYLE.trimEnd()} three boxes labeled a, b, c`, 'Charcoal line art on cream paper. one log']);
  });

  it('generate_image tells the model the style is applied for it', () => {
    expect(GENERATE_IMAGE_DESCRIPTION).toMatch(/image style of the brief is applied automatically/i);
    expect(GENERATE_IMAGE_DESCRIPTION).toMatch(/describe only the content/i);
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

  it('QA3: the co-author marks alternatives and reports a proposal merged into an existing lane', () => {
    expect(SYSTEM_APPEND).toMatch(/alternative, call propose_lane with a new label and alternative: true/);
    expect(SYSTEM_APPEND).toMatch(/revisedExisting/);
    const lane: Lane = { id: 'l1', label: 'L', anchor: { kind: 'slide', slide: 's2' }, origin: 'user', baseVersion: 1, changes: [], status: 'open', createdAt: '' };
    expect(contextHeader({ thread: 'lane:l1', anchor: null, snapshot: snap(five), lane, brief })).toContain('alternative: true');
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
