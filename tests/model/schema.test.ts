import { describe, expect, it } from 'vitest';
import {
  AddRemarkInputSchema,
  AnchorSchema,
  ChangeSchema,
  LaneSchema,
  ProposeLaneInputSchema,
  ReviseLaneInputSchema,
  SlidePatchSchema,
  SlideSchema,
  VersionSchema,
} from '../../src/model/schema.js';

const slide = { id: 's_abcdefghij', title: 't', story: 's', notes: '', body: '<div>x</div>', assets: [], kind: 'text' };

describe('schemas', () => {
  it('SlideSchema accepts a slide and rejects an unknown kind', () => {
    expect(SlideSchema.parse(slide)).toEqual(slide);
    expect(SlideSchema.safeParse({ ...slide, kind: 'bullet' }).success).toBe(false);
  });
  it('SlidePatchSchema accepts partial patches and strips id', () => {
    expect(SlidePatchSchema.parse({ title: 'x' })).toEqual({ title: 'x' });
    expect(SlidePatchSchema.parse({ id: 'z', body: 'b' })).toEqual({ body: 'b' });
  });
  it('AnchorSchema discriminates on kind', () => {
    expect(AnchorSchema.safeParse({ kind: 'arc' }).success).toBe(true);
    expect(AnchorSchema.safeParse({ kind: 'range', from: 'a', to: 'b' }).success).toBe(true);
    expect(AnchorSchema.safeParse({ kind: 'range', from: 'a' }).success).toBe(false);
    expect(AnchorSchema.safeParse({ kind: 'deck' }).success).toBe(false);
  });
  it('ChangeSchema discriminates on kind', () => {
    expect(ChangeSchema.safeParse({ id: 'c', kind: 'insert', after: null, slide, reason: 'r', status: 'pending' }).success).toBe(true);
    expect(ChangeSchema.safeParse({ id: 'c', kind: 'modify', slide: 's1', patch: { title: 'x' }, reason: 'r', status: 'orphan' }).success).toBe(true);
    expect(ChangeSchema.safeParse({ id: 'c', kind: 'remove', slide: 's1', reason: 'r', status: 'weird' }).success).toBe(false);
    expect(ChangeSchema.safeParse({ id: 'c', kind: 'move', slide: 's1', reason: 'r', status: 'pending' }).success).toBe(false);
  });
  it('LaneSchema validates origin', () => {
    const lane = { id: 'l', label: 'x', anchor: { kind: 'arc' }, origin: 'check:arc', baseVersion: 0, changes: [], status: 'open', createdAt: 'now' };
    expect(LaneSchema.safeParse(lane).success).toBe(true);
    expect(LaneSchema.safeParse({ ...lane, origin: 'bot' }).success).toBe(false);
  });
  it('VersionSchema validates', () => {
    expect(VersionSchema.safeParse({ n: 1, order: ['a'], slides: { a: 'h' }, cause: { kind: 'import' }, createdAt: 'now' }).success).toBe(true);
    expect(VersionSchema.safeParse({ n: -1, order: [], slides: {}, cause: { kind: 'import' }, createdAt: 'now' }).success).toBe(false);
  });
  it('ProposeLaneInput: insert slide has no id, changes non-empty, reason required', () => {
    const { id: _id, ...newSlide } = slide;
    const parsed = ProposeLaneInputSchema.parse({
      label: 'tighten',
      anchor: { kind: 'slide', slide: 's1' },
      changes: [{ kind: 'insert', after: 's1', slide: { ...newSlide, id: 'ignored' }, reason: 'why' }],
    });
    const c = parsed.changes[0];
    expect(c?.kind).toBe('insert');
    if (c?.kind === 'insert') expect('id' in c.slide).toBe(false);
    expect(ProposeLaneInputSchema.safeParse({ label: 'x', anchor: { kind: 'arc' }, changes: [] }).success).toBe(false);
    expect(
      ProposeLaneInputSchema.safeParse({ label: 'x', anchor: { kind: 'arc' }, changes: [{ kind: 'remove', slide: 's1', reason: '' }] }).success,
    ).toBe(false);
  });
  it('ReviseLaneInput and AddRemarkInput validate', () => {
    expect(ReviseLaneInputSchema.safeParse({ laneId: 'l', replaceChanges: [{ kind: 'remove', slide: 's1', reason: 'r' }] }).success).toBe(true);
    expect(AddRemarkInputSchema.safeParse({ anchor: { kind: 'arc' }, text: 'x', severity: 'warn' }).success).toBe(true);
    expect(AddRemarkInputSchema.safeParse({ anchor: { kind: 'arc' }, text: 'x', severity: 'error' }).success).toBe(false);
  });
});
