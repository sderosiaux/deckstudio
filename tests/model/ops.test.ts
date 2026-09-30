import { describe, expect, it } from 'vitest';
import { applyChange, diffVersions, rebaseLane, slidesInRange, validateBody, type Snapshot } from '../../src/model/ops.js';
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

  it('Review Focus 1: modify s3 after s3 was removed becomes orphan, others stay pending', () => {
    const afterA = ok(applyChange(fixture(), { id: 'a1', kind: 'remove', slide: 's3', ...base }));
    const b = lane([
      { id: 'b1', kind: 'modify', slide: 's3', patch: { title: 'x' }, ...base },
      { id: 'b2', kind: 'modify', slide: 's2', patch: { title: 'y' }, ...base },
      { id: 'b3', kind: 'insert', after: 's3', slide: slide('n1'), ...base },
      { id: 'b4', kind: 'move', slide: 's4', after: 's3', ...base },
      { id: 'b5', kind: 'remove', slide: 's3', ...base },
      { id: 'b6', kind: 'insert', after: null, slide: slide('n2'), ...base },
    ]);
    const rebased = rebaseLane(b, afterA);
    expect(rebased.changes.map((c) => [c.id, c.status])).toEqual([
      ['b1', 'orphan'],
      ['b2', 'pending'],
      ['b3', 'orphan'],
      ['b4', 'orphan'],
      ['b5', 'orphan'],
      ['b6', 'pending'],
    ]);
    expect(b.changes[0]?.status).toBe('pending');
  });

  it('leaves accepted and refused changes untouched', () => {
    const afterA = ok(applyChange(fixture(), { id: 'a1', kind: 'remove', slide: 's3', ...base }));
    const b = lane([
      { id: 'b1', kind: 'modify', slide: 's3', patch: { title: 'x' }, reason: 'r', status: 'accepted' },
      { id: 'b2', kind: 'remove', slide: 's3', reason: 'r', status: 'refused' },
    ]);
    expect(rebaseLane(b, afterA).changes.map((c) => c.status)).toEqual(['accepted', 'refused']);
  });

  it('references to slides inserted earlier in the same lane are not orphaned', () => {
    const b = lane([
      { id: 'b1', kind: 'insert', after: 's2', slide: slide('n1'), ...base },
      { id: 'b2', kind: 'insert', after: 'n1', slide: slide('n2'), ...base },
    ]);
    expect(rebaseLane(b, fixture()).changes.map((c) => c.status)).toEqual(['pending', 'pending']);
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
    // common ids in a: s1 s2 s4 s5 -> in b: s1 s4 s5 s2; rank changed for s2, s4, s5
    expect(d).toContainEqual({ kind: 'moved', slide: 's2', from: 1, to: 4 });
    expect(d).toContainEqual({ kind: 'moved', slide: 's4', from: 3, to: 2 });
    expect(d).toContainEqual({ kind: 'moved', slide: 's5', from: 4, to: 3 });
    expect(d.filter((e) => e.kind === 'moved' && e.slide === 's1')).toEqual([]);
    expect(d).toHaveLength(6);
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
