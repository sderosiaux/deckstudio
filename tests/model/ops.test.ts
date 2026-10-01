import { describe, expect, it } from 'vitest';
import { applyChange, changesNothing, diffVersions, rebaseLane, slidesInRange, validateBody, type Snapshot } from '../../src/model/ops.js';
import { hashSlide, newId } from '../../src/model/ids.js';
import type { Change, Lane, Slide } from '../../src/model/types.js';

const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: `story ${id}`,
  notes: '',
  body: `<div>${id}</div>`,
  assets: [],
  kind: 'text',
  ...over,
});

const fixture = (): Snapshot => {
  const ids = ['s1', 's2', 's3', 's4', 's5'];
  return { order: ids, slides: Object.fromEntries(ids.map((id) => [id, slide(id)])) };
};

const ok = (r: ReturnType<typeof applyChange>): Snapshot => {
  if (!r.ok) throw new Error(r.error);
  return r.next;
};

const base = { reason: 'r', status: 'pending' as const };

describe('ids', () => {
  it('newId has prefix and 10 chars', () => {
    expect(newId('s')).toMatch(/^s_[A-Za-z0-9_-]{10}$/);
    expect(newId('l')).toMatch(/^l_/);
    expect(newId('s')).not.toBe(newId('s'));
  });
  it('hashSlide is stable across key order and ignores id', () => {
    const a = slide('s1');
    const reordered: Slide = { kind: a.kind, assets: a.assets, body: a.body, notes: a.notes, story: a.story, title: a.title, id: 'other' };
    expect(hashSlide(reordered)).toBe(hashSlide(a));
    expect(hashSlide(a)).toMatch(/^[0-9a-f]{64}$/);
  });
  it('hashSlide changes when body changes', () => {
    expect(hashSlide(slide('s1', { body: '<div>x</div>' }))).not.toBe(hashSlide(slide('s1')));
  });
});

describe('applyChange', () => {
  it('insert after null puts the slide first', () => {
    const snap = fixture();
    const next = ok(applyChange(snap, { id: 'c1', kind: 'insert', after: null, slide: slide('n1'), ...base }));
    expect(next.order).toEqual(['n1', 's1', 's2', 's3', 's4', 's5']);
    expect(next.slides.n1?.title).toBe('Title n1');
    expect(snap.order).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(snap.slides.n1).toBeUndefined();
  });
  it('insert after X puts it right after X', () => {
    const next = ok(applyChange(fixture(), { id: 'c1', kind: 'insert', after: 's3', slide: slide('n1'), ...base }));
    expect(next.order).toEqual(['s1', 's2', 's3', 'n1', 's4', 's5']);
  });
  it('insert with an existing id fails', () => {
    const r = applyChange(fixture(), { id: 'c1', kind: 'insert', after: 's3', slide: slide('s1'), ...base });
    expect(r.ok).toBe(false);
  });
  it('modify patches only given fields and does not mutate', () => {
    const snap = fixture();
    const next = ok(applyChange(snap, { id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'New' }, ...base }));
    expect(next.slides.s2).toEqual({ ...slide('s2'), title: 'New' });
    expect(snap.slides.s2?.title).toBe('Title s2');
    expect(next.order).toEqual(snap.order);
  });
  it('remove drops from order and slides', () => {
    const snap = fixture();
    const next = ok(applyChange(snap, { id: 'c1', kind: 'remove', slide: 's3', ...base }));
    expect(next.order).toEqual(['s1', 's2', 's4', 's5']);
    expect(next.slides.s3).toBeUndefined();
    expect(snap.slides.s3).toBeDefined();
  });
  it('move relocates', () => {
    expect(ok(applyChange(fixture(), { id: 'c1', kind: 'move', slide: 's2', after: 's4', ...base })).order).toEqual([
      's1', 's3', 's4', 's2', 's5',
    ]);
    expect(ok(applyChange(fixture(), { id: 'c1', kind: 'move', slide: 's4', after: null, ...base })).order).toEqual([
      's4', 's1', 's2', 's3', 's5',
    ]);
  });
  it('move after itself fails', () => {
    expect(applyChange(fixture(), { id: 'c1', kind: 'move', slide: 's2', after: 's2', ...base }).ok).toBe(false);
  });
  it('unknown slide id returns ok:false', () => {
    const snap = fixture();
    const bad: Change[] = [
      { id: 'c', kind: 'modify', slide: 'nope', patch: { title: 'x' }, ...base },
      { id: 'c', kind: 'remove', slide: 'nope', ...base },
      { id: 'c', kind: 'move', slide: 'nope', after: null, ...base },
      { id: 'c', kind: 'move', slide: 's1', after: 'nope', ...base },
      { id: 'c', kind: 'insert', after: 'nope', slide: slide('n1'), ...base },
    ];
    for (const c of bad) {
      const r = applyChange(snap, c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain('nope');
    }
  });
  it('Review Focus 2: insert after a moved slide follows its new position', () => {
    const moved = ok(applyChange(fixture(), { id: 'c1', kind: 'move', slide: 's2', after: 's5', ...base }));
    expect(moved.order).toEqual(['s1', 's3', 's4', 's5', 's2']);
    const next = ok(applyChange(moved, { id: 'c2', kind: 'insert', after: 's2', slide: slide('n1'), ...base }));
    expect(next.order).toEqual(['s1', 's3', 's4', 's5', 's2', 'n1']);
  });
});

describe('rebaseLane', () => {
  const lane = (changes: Change[]): Lane => ({
    id: 'l_1',
    label: 'lane',
    anchor: { kind: 'range', from: 's2', to: 's4' },
    origin: 'user',
    baseVersion: 1,
    changes,
    status: 'open',
    createdAt: '2026-09-30T00:00:00Z',
  });
  const statuses = (l: Lane) => l.changes.map((c) => [c.id, c.status]);
  const withTitle = (snap: Snapshot, id: string, title: string): Snapshot => ok(applyChange(snap, { id: 'x', kind: 'modify', slide: id, patch: { title }, ...base }));

  it('Review Focus 1: modify s3 after s3 was removed becomes orphan, a remove of s3 is already on main, others stay pending', () => {
    const afterA = ok(applyChange(fixture(), { id: 'a1', kind: 'remove', slide: 's3', ...base }));
    const b = lane([
      { id: 'b1', kind: 'modify', slide: 's3', patch: { title: 'x' }, ...base },
      { id: 'b2', kind: 'modify', slide: 's2', patch: { title: 'y' }, ...base },
      { id: 'b3', kind: 'insert', after: 's3', slide: slide('n1'), ...base },
      { id: 'b4', kind: 'move', slide: 's4', after: 's3', ...base },
      { id: 'b5', kind: 'remove', slide: 's3', ...base },
      { id: 'b6', kind: 'insert', after: null, slide: slide('n2'), ...base },
    ]);
    const { lane: rebased, causes } = rebaseLane(b, afterA, fixture());
    expect(statuses(rebased)).toEqual([
      ['b1', 'orphan'],
      ['b2', 'pending'],
      ['b3', 'orphan'],
      ['b4', 'orphan'],
      ['b5', 'accepted'],
      ['b6', 'pending'],
    ]);
    expect(causes.b5).toBe('already on main');
    expect(causes.b2).toBeUndefined();
    expect(b.changes[0]?.status).toBe('pending');
  });

  it('leaves accepted and refused changes untouched', () => {
    const afterA = ok(applyChange(fixture(), { id: 'a1', kind: 'remove', slide: 's3', ...base }));
    const b = lane([
      { id: 'b1', kind: 'modify', slide: 's3', patch: { title: 'x' }, reason: 'r', status: 'accepted' },
      { id: 'b2', kind: 'remove', slide: 's3', reason: 'r', status: 'refused' },
    ]);
    expect(rebaseLane(b, afterA, fixture()).lane.changes.map((c) => c.status)).toEqual(['accepted', 'refused']);
  });

  it('references to slides inserted earlier in the same lane are not orphaned', () => {
    const b = lane([
      { id: 'b1', kind: 'insert', after: 's2', slide: slide('n1'), ...base },
      { id: 'b2', kind: 'insert', after: 'n1', slide: slide('n2'), ...base },
    ]);
    expect(rebaseLane(b, fixture(), fixture()).lane.changes.map((c) => c.status)).toEqual(['pending', 'pending']);
  });

  it('a move whose slide main put at its target since the lane was proposed is already on main; a real move stays pending', () => {
    // At the lane's base s3 and s1 sat elsewhere; main (fixture order s1 s2 s3 s4 s5) has since put them in place.
    const v1: Snapshot = { ...fixture(), order: ['s2', 's1', 's4', 's3', 's5'] };
    const b = lane([
      { id: 'b1', kind: 'move', slide: 's3', after: 's2', ...base },
      { id: 'b2', kind: 'move', slide: 's1', after: null, ...base },
      { id: 'b3', kind: 'move', slide: 's5', after: 's1', ...base },
      { id: 'b4', kind: 'modify', slide: 's4', patch: { title: 'x' }, ...base },
    ]);
    const r = rebaseLane(b, fixture(), v1);
    expect(statuses(r.lane)).toEqual([
      ['b1', 'accepted'],
      ['b2', 'accepted'],
      ['b3', 'pending'],
      ['b4', 'pending'],
    ]);
    expect(r.causes).toEqual({ b1: 'already on main', b2: 'already on main' });
  });

  it('a move made redundant by an earlier pending change of the lane is orphan, not accepted', () => {
    // After b1 moves s2 to the end, s3 follows s1: "move s3 after s1" is then a no-op, "move s4 after s1" is not.
    const b = lane([
      { id: 'b1', kind: 'move', slide: 's2', after: 's5', ...base },
      { id: 'b2', kind: 'move', slide: 's3', after: 's1', ...base },
      { id: 'b3', kind: 'move', slide: 's4', after: 's1', ...base },
    ]);
    expect(rebaseLane(b, fixture(), fixture()).lane.changes.map((c) => c.status)).toEqual(['pending', 'orphan', 'pending']);
  });

  it('a move in place on main that an earlier pending change of the lane displaces stays pending', () => {
    // b1 puts s4 right after s2; b2 then puts s3 back after s2: in place on main, needed after b1.
    const b = lane([
      { id: 'b1', kind: 'move', slide: 's4', after: 's2', ...base },
      { id: 'b2', kind: 'move', slide: 's3', after: 's2', ...base },
    ]);
    expect(statuses(rebaseLane(b, fixture(), fixture()).lane)).toEqual([
      ['b1', 'pending'],
      ['b2', 'pending'],
    ]);
  });

  describe('QA5 a refusal never makes the next moves "already on main"', () => {
    // The lane pulls the block s4 s5 s6 forward, chained: s4 after s1, then s5 after s4, then s6 after s5.
    // On main s5 already follows s4 and s6 follows s5: those moves only mean something after the first one.
    const v1: Snapshot = { order: ['s1', 's2', 's3', 's4', 's5', 's6', 's7'], slides: Object.fromEntries(['s1', 's2', 's3', 's4', 's5', 's6', 's7'].map((id) => [id, slide(id)])) };
    const chain = (a: Change['status'], b: Change['status'] = 'pending'): Lane =>
      lane([
        { id: 'A', kind: 'move', slide: 's4', after: 's1', reason: 'r', status: a },
        { id: 'B', kind: 'move', slide: 's5', after: 's4', reason: 'r', status: b },
        { id: 'C', kind: 'move', slide: 's6', after: 's5', ...base },
      ]);

    it('all pending: the chained moves stay pending', () => {
      const r = rebaseLane(chain('pending'), v1, v1);
      expect(statuses(r.lane)).toEqual([
        ['A', 'pending'],
        ['B', 'pending'],
        ['C', 'pending'],
      ]);
    });

    it('refuse A: B and C stay pending, with no cause', () => {
      const r = rebaseLane(chain('refused'), v1, v1);
      expect(statuses(r.lane)).toEqual([
        ['A', 'refused'],
        ['B', 'pending'],
        ['C', 'pending'],
      ]);
      expect(r.causes).toEqual({});
    });

    it('refuse A, then accept B (main unchanged by it): C stays pending', () => {
      const r = rebaseLane(chain('refused', 'accepted'), ok(applyChange(v1, chain('refused').changes[1]!)), v1);
      expect(statuses(r.lane)).toEqual([
        ['A', 'refused'],
        ['B', 'accepted'],
        ['C', 'pending'],
      ]);
      expect(r.causes).toEqual({});
    });

    it('accept A, then refuse B: C stays pending (the QA5 focus repro)', () => {
      const main = ok(applyChange(v1, chain('pending').changes[0]!));
      const r = rebaseLane(chain('accepted', 'refused'), main, v1);
      expect(statuses(r.lane).at(-1)).toEqual(['C', 'pending']);
      expect(r.causes).toEqual({});
    });

    it('a chained move main really took meanwhile is still already on main', () => {
      // Another lane moved the whole block: main now holds every move of this lane.
      const main: Snapshot = { ...v1, order: ['s1', 's4', 's5', 's6', 's2', 's3', 's7'] };
      const r = rebaseLane(chain('pending'), main, v1);
      expect(statuses(r.lane)).toEqual([
        ['A', 'accepted'],
        ['B', 'accepted'],
        ['C', 'accepted'],
      ]);
    });
  });

  it('QA3 stale modify: v1 title A, the lane sets B, main changed it to C: orphan with the field and the base version', () => {
    const v1 = withTitle(fixture(), 's2', 'A');
    const main = withTitle(v1, 's2', 'C');
    const b = lane([{ id: 'b1', kind: 'modify', slide: 's2', patch: { title: 'B', notes: 'n' }, ...base }]);
    const r = rebaseLane(b, main, v1);
    expect(statuses(r.lane)).toEqual([['b1', 'orphan']]);
    expect(r.causes).toEqual({ b1: 'title changed on main since v1' });
  });

  it('a modify stays pending when main changed only fields it does not patch', () => {
    const v1 = fixture();
    const main = ok(applyChange(v1, { id: 'x', kind: 'modify', slide: 's2', patch: { notes: 'main notes' }, ...base }));
    const b = lane([{ id: 'b1', kind: 'modify', slide: 's2', patch: { title: 'B' }, ...base }]);
    const r = rebaseLane(b, main, v1);
    expect(statuses(r.lane)).toEqual([['b1', 'pending']]);
    expect(r.causes).toEqual({});
  });

  it('QA3 already on main: a modify whose values main already took is accepted; partly taken stays pending', () => {
    const v1 = withTitle(fixture(), 's2', 'A');
    const main = withTitle(v1, 's2', 'B');
    const b = lane([
      { id: 'b1', kind: 'modify', slide: 's2', patch: { title: 'B' }, ...base },
      { id: 'b2', kind: 'modify', slide: 's2', patch: { title: 'B', notes: 'new notes' }, ...base },
    ]);
    const r = rebaseLane(b, main, v1);
    expect(statuses(r.lane)).toEqual([
      ['b1', 'accepted'],
      ['b2', 'pending'],
    ]);
    expect(r.causes).toEqual({ b1: 'already on main' });
  });

  it('the lane’s own accepted changes do not make its other pending changes stale', () => {
    const v1 = fixture();
    const own: Change = { id: 'b1', kind: 'modify', slide: 's2', patch: { notes: 'N1' }, reason: 'r', status: 'accepted' };
    const main = ok(applyChange(v1, own));
    const b = lane([own, { id: 'b2', kind: 'modify', slide: 's2', patch: { notes: 'N2' }, ...base }]);
    expect(statuses(rebaseLane(b, main, v1).lane)).toEqual([
      ['b1', 'accepted'],
      ['b2', 'pending'],
    ]);
  });

  it('an insert of a slide identical to the one right after the same predecessor on main is already on main', () => {
    const twin = slide('n1', { title: 'Hook' });
    const main = ok(applyChange(fixture(), { id: 'x', kind: 'insert', after: 's2', slide: { ...twin, id: 'm1' }, ...base }));
    const b = lane([
      { id: 'b1', kind: 'insert', after: 's2', slide: twin, ...base },
      { id: 'b2', kind: 'insert', after: 's4', slide: slide('n2', { title: 'Hook' }), ...base },
      { id: 'b3', kind: 'insert', after: 's3', slide: twin, ...base },
    ]);
    const r = rebaseLane(b, main, fixture());
    expect(statuses(r.lane)).toEqual([
      ['b1', 'accepted'],
      ['b2', 'pending'],
      ['b3', 'pending'],
    ]);
    expect(r.causes).toEqual({ b1: 'already on main' });
  });

  it('a later change on a slide the lane inserted, now already on main, is judged on main’s twin', () => {
    const twin = slide('n1', { title: 'Hook' });
    const main = ok(applyChange(fixture(), { id: 'x', kind: 'insert', after: 's2', slide: { ...twin, id: 'm1' }, ...base }));
    const b = lane([
      { id: 'b1', kind: 'insert', after: 's2', slide: twin, ...base },
      { id: 'b2', kind: 'modify', slide: 'n1', patch: { title: 'Hook 2' }, ...base },
    ]);
    // n1 itself never reaches main: a change that needs it can no longer apply.
    expect(statuses(rebaseLane(b, main, fixture()).lane)).toEqual([
      ['b1', 'accepted'],
      ['b2', 'orphan'],
    ]);
  });
});

describe('diffVersions', () => {
  it('reports added, removed, modified fields and moved on a 5-slide fixture', () => {
    const a = fixture();
    // b: remove s3, insert n1 after s1, modify s4 title+assets, move s2 to the end
    const b: Snapshot = {
      order: ['s1', 'n1', 's4', 's5', 's2'],
      slides: {
        s1: slide('s1'),
        n1: slide('n1'),
        s2: slide('s2'),
        s4: slide('s4', { title: 'changed', assets: ['assets/x.png'] }),
        s5: slide('s5'),
      },
    };
    const d = diffVersions(a, b);
    expect(d).toContainEqual({ kind: 'added', slide: 'n1', at: 1 });
    expect(d).toContainEqual({ kind: 'removed', slide: 's3', wasAt: 2 });
    expect(d).toContainEqual({ kind: 'modified', slide: 's4', fields: ['title', 'assets'] });
    // common ids in a: s1 s2 s4 s5 -> in b: s1 s4 s5 s2; only s2 left the longest kept run
    expect(d.filter((e) => e.kind === 'moved')).toEqual([{ kind: 'moved', slide: 's2', from: 1, to: 4 }]);
    expect(d).toHaveLength(4);
  });
  it('insertion and removal alone do not produce moves', () => {
    const a = fixture();
    const b = ok(applyChange(ok(applyChange(a, { id: 'c', kind: 'insert', after: null, slide: slide('n1'), ...base })), {
      id: 'c2', kind: 'remove', slide: 's3', ...base,
    }));
    expect(diffVersions(a, b)).toEqual([
      { kind: 'removed', slide: 's3', wasAt: 2 },
      { kind: 'added', slide: 'n1', at: 0 },
    ]);
  });
  it('moving the last slide to the front reports exactly one move', () => {
    const ids = ['1', '2', '3', '4', '5'];
    const slides = Object.fromEntries(ids.map((id) => [id, slide(id)]));
    const d = diffVersions({ order: ids, slides }, { order: ['5', '1', '2', '3', '4'], slides });
    expect(d).toEqual([{ kind: 'moved', slide: '5', from: 4, to: 0 }]);
  });
  it('swapping two adjacent slides reports at most two moves', () => {
    const ids = ['1', '2', '3', '4', '5'];
    const slides = Object.fromEntries(ids.map((id) => [id, slide(id)]));
    const d = diffVersions({ order: ids, slides }, { order: ['1', '3', '2', '4', '5'], slides });
    expect(d.every((e) => e.kind === 'moved')).toBe(true);
    expect(d.length).toBeGreaterThanOrEqual(1);
    expect(d.length).toBeLessThanOrEqual(2);
    for (const e of d) expect(['2', '3']).toContain(e.slide);
  });
  it('a full reversal keeps one slide in place', () => {
    const ids = ['1', '2', '3', '4', '5'];
    const slides = Object.fromEntries(ids.map((id) => [id, slide(id)]));
    expect(diffVersions({ order: ids, slides }, { order: [...ids].reverse(), slides })).toHaveLength(4);
  });
  it('identical snapshots produce no diff', () => {
    expect(diffVersions(fixture(), fixture())).toEqual([]);
  });
});

describe('validateBody', () => {
  it('rejects <ul>, <ol>, <script> and empty', () => {
    expect(validateBody('<ul><li>a</li></ul>').ok).toBe(false);
    expect(validateBody('<div><OL class="x"><li>a</li></OL></div>').ok).toBe(false);
    expect(validateBody('<div>x</div><script>alert(1)</script>').ok).toBe(false);
    expect(validateBody('').ok).toBe(false);
    expect(validateBody('   \n ').ok).toBe(false);
    const r = validateBody('<ul></ul><script></script>');
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.reasons).toHaveLength(2);
  });
  it('accepts an <img> + <div> fragment and does not confuse <u> with <ul>', () => {
    expect(validateBody('<div class="grid"><img src="assets/a.png" alt=""></div>')).toEqual({ ok: true });
    expect(validateBody('<div><u>under</u><output>o</output></div>')).toEqual({ ok: true });
  });
});

describe('slidesInRange', () => {
  const order = ['s1', 's2', 's3', 's4', 's5'];
  it('slide anchor returns that id', () => {
    expect(slidesInRange(order, { kind: 'slide', slide: 's3' })).toEqual(['s3']);
  });
  it('range is inclusive and swaps reversed bounds', () => {
    expect(slidesInRange(order, { kind: 'range', from: 's2', to: 's4' })).toEqual(['s2', 's3', 's4']);
    expect(slidesInRange(order, { kind: 'range', from: 's4', to: 's2' })).toEqual(['s2', 's3', 's4']);
  });
  it('range with an unknown bound is empty', () => {
    expect(slidesInRange(order, { kind: 'range', from: 's2', to: 'nope' })).toEqual([]);
  });
  it('arc returns all', () => {
    expect(slidesInRange(order, { kind: 'arc' })).toEqual(order);
  });
});

describe('chained inserts on an empty deck (an outline lane)', () => {
  const empty: Snapshot = { order: [], slides: {} };
  const outline: Change[] = [
    { ...base, id: 'c1', kind: 'insert', after: null, slide: slide('n1') },
    { ...base, id: 'c2', kind: 'insert', after: 'n1', slide: slide('n2') },
    { ...base, id: 'c3', kind: 'insert', after: 'n2', slide: slide('n3') },
  ];
  const lane: Lane = { id: 'l1', label: 'Outline', anchor: { kind: 'arc' }, origin: 'user', baseVersion: 0, changes: outline, status: 'open', createdAt: '2026-09-30T00:00:00.000Z' };

  it('applyChange replays each insert after the slide the previous one inserted, in order', () => {
    const preview = outline.reduce((snap, c) => ok(applyChange(snap, c)), empty);
    expect(preview.order).toEqual(['n1', 'n2', 'n3']);
    expect(Object.keys(preview.slides).sort()).toEqual(['n1', 'n2', 'n3']);
  });

  it('an insert after a slide the lane has not inserted yet fails on its own', () => {
    expect(applyChange(empty, outline[1]!)).toEqual({ ok: false, error: 'unknown slide n1 (insert after)' });
  });

  it('rebase keeps the whole chain pending on the empty main, then after the first insert lands on main', () => {
    expect(rebaseLane(lane, empty, empty).lane.changes.map((c) => c.status)).toEqual(['pending', 'pending', 'pending']);
    const main1 = ok(applyChange(empty, outline[0]!));
    const accepted1: Lane = { ...lane, changes: lane.changes.map((c) => (c.id === 'c1' ? { ...c, status: 'accepted' as const } : c)) };
    const r = rebaseLane(accepted1, main1, empty);
    expect(r.lane.changes.map((c) => c.status)).toEqual(['accepted', 'pending', 'pending']);
    expect(r.causes).toEqual({});
    const main2 = ok(applyChange(main1, outline[1]!));
    expect(ok(applyChange(main2, outline[2]!)).order).toEqual(['n1', 'n2', 'n3']);
  });
});

describe('changesNothing (QA5: no-op changes are never proposed)', () => {
  it('a move to where the slide already sits, a modify to the values it holds, an identical insert change nothing', () => {
    const snap = fixture();
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'move', slide: 's3', after: 's2' })).toBe(true);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'move', slide: 's1', after: null })).toBe(true);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'move', slide: 's3', after: 's4' })).toBe(false);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'modify', slide: 's2', patch: { title: 'Title s2' } })).toBe(true);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'modify', slide: 's2', patch: { title: 'Title s2', notes: 'new' } })).toBe(false);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'insert', after: 's1', slide: { ...slide('n1'), title: 'Title s2', story: 'story s2', body: '<div>s2</div>' } })).toBe(true);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'insert', after: 's1', slide: slide('n1') })).toBe(false);
    expect(changesNothing(snap, { ...base, id: 'c', kind: 'remove', slide: 's2' })).toBe(false);
  });
});
