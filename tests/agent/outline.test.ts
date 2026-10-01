import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { makeDeckToolHandlers, type DeckToolContext } from '../../src/agent/tools.js';
import type { Brief, Lane } from '../../src/model/types.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { Bus } from '../../src/server/bus.js';
import { LaneService } from '../../src/server/laneService.js';
import { DeckStore } from '../../src/store/deckStore.js';
import { tmpDir } from '../helpers/tmp.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = {
  title: 'Onboarding a new team',
  audience: 'new hires',
  message: 'Ship on day one',
  pattern: 'problem-driven',
  abstract: 'How the first week works.',
  design: { rules: '', imageStyle: '' },
};
const draft = (title: string) => ({
  title,
  story: `why ${title}`,
  notes: `say ${title}`,
  body: `<div class="content"><div class="big">${title}</div></div>`,
  assets: [],
  kind: 'text' as const,
});

type Proposed = { laneId: string; changes: { id: string; summary: string; slideId?: string }[] };

describe('an outline lane on an empty deck', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let store: DeckStore;
  let bus: Bus;
  let ctx: DeckToolContext;

  beforeAll(async () => {
    tmp = await tmpDir();
  });
  afterAll(async () => {
    await tmp?.cleanup();
  });
  beforeEach(async () => {
    store = await DeckStore.init(join(tmp.dir, `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`), 'blank', brief);
    bus = new Bus();
    ctx = {
      store,
      bus,
      thumbs: new ThumbService({ cacheDir: join(store.dir, 'cache'), themeCss, assetsDir: join(store.dir, 'assets') }),
      imageGen: async () => {
        throw new Error('no image in this test');
      },
      runCheck: async () => {},
    };
  });

  const outline = {
    label: 'First outline',
    anchor: { kind: 'arc' },
    changes: [
      { kind: 'insert', ref: 'n1', after: null, slide: draft('Day one is a deploy'), reason: 'opens on the claim' },
      { kind: 'insert', ref: 'n2', after: 'n1', slide: draft('The checklist hides the risk'), reason: 'raises the tension' },
      { kind: 'insert', ref: 'n3', after: 'n2', slide: draft('Pairing beats reading'), reason: 'the answer' },
    ],
  };

  it('propose_lane chains inserts by ref; the preview shows them in order; accept works one slide at a time', async () => {
    expect((await store.snapshot()).order).toEqual([]);
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane(outline)) as Proposed;
    expect(res.laneId).toBeTruthy();
    const ids = res.changes.map((c) => c.slideId!);
    expect(ids.every((id) => /^s_/.test(id))).toBe(true);

    const lane = (await store.lane(res.laneId)) as Lane;
    // Refs are resolved to the inserted slide ids: nothing refers to "n1" any more.
    expect(lane.changes.map((c) => (c.kind === 'insert' ? c.after : 'x'))).toEqual([null, ids[0], ids[1]]);
    expect(JSON.stringify(lane)).not.toContain('"ref"');

    const lanes = new LaneService(store, bus);
    const preview = await lanes.preview(lane.id);
    expect(preview.order).toEqual(ids);
    expect(preview.order.map((id) => preview.slides[id]!.title)).toEqual(['Day one is a deploy', 'The checklist hides the risk', 'Pairing beats reading']);
    expect(preview.skipped).toEqual([]);

    for (const [k, c] of lane.changes.entries()) {
      await lanes.accept(lane.id, c.id);
      expect((await store.snapshot()).order).toEqual(ids.slice(0, k + 1));
    }
    expect((await store.lane(lane.id))!.status).toBe('closed');
  });

  it('propose_lane rejects an insert whose after names an insert listed later', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      ...outline,
      changes: [outline.changes[1], outline.changes[0], outline.changes[2]],
    })) as { error: string; invalid: { index: number; reason: string }[] };
    expect(res.invalid[0]).toEqual({ index: 0, reason: expect.stringMatching(/"n1".*later in this lane/) });
    // The insert after the rejected one cannot land either; the error names it by its ref, never by a generated id.
    expect(res.invalid.slice(1)).toEqual([{ index: 2, reason: expect.stringContaining('"n2"') }]);
    expect(JSON.stringify(res)).not.toMatch(/s_[A-Za-z0-9_-]{10}/);
    expect(await store.lanes()).toEqual([]);
  });

  it('propose_lane rejects a duplicate ref and an unknown after', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane({
      ...outline,
      changes: [outline.changes[0], { ...outline.changes[1], ref: 'n1' }, { ...outline.changes[2], after: 'n9' }],
    })) as { invalid: { index: number; reason: string }[] };
    expect(res.invalid.map((i) => i.index)).toEqual([1, 2]);
    expect(res.invalid[0]!.reason).toMatch(/ref "n1" is already used/);
    expect(res.invalid[1]!.reason).toContain('"n9" does not exist');
  });

  it('revise_lane can extend the outline after a slide the lane inserts, by its returned id or a new ref', async () => {
    const h = makeDeckToolHandlers(ctx);
    const res = (await h.propose_lane(outline)) as Proposed;
    const last = res.changes[2]!.slideId!;
    const rev = (await h.revise_lane({
      laneId: res.laneId,
      changes: [
        { kind: 'insert', ref: 'n4', after: last, slide: draft('Week two is yours'), reason: 'close' },
        { kind: 'insert', after: 'n4', slide: draft('Questions'), reason: 'end' },
      ],
    })) as { added: string[] };
    expect(rev.added).toHaveLength(2);
    const preview = await new LaneService(store, bus).preview(res.laneId);
    expect(preview.order.map((id) => preview.slides[id]!.title)).toEqual([
      'Day one is a deploy',
      'The checklist hides the risk',
      'Pairing beats reading',
      'Week two is yours',
      'Questions',
    ]);
  });
});
