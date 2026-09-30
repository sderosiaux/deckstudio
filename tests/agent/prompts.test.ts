import { describe, expect, it } from 'vitest';
import { contextHeader, SYSTEM_APPEND } from '../../src/agent/prompts.js';
import type { Brief, Lane, Remark, Slide, Snapshot } from '../../src/model/types.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs' };
const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: `story of ${id}`, notes: '', body: `<p>${id}</p>`, assets: [], kind: 'text' });
const five = ['s1', 's2', 's3', 's4', 's5'].map(slide);
const snapshot: Snapshot = { order: five.map((s) => s.id), slides: Object.fromEntries(five.map((s) => [s.id, s])) };

const lane: Lane = {
  id: 'l1',
  label: 'Tighter opening',
  anchor: { kind: 'range', from: 's2', to: 's3' },
  origin: 'user',
  baseVersion: 1,
  changes: [
    { id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'Shorter' }, reason: 'the claim is buried', status: 'pending' },
    { id: 'c2', kind: 'insert', after: 's3', slide: { ...slide('n1'), title: 'Why logs win' }, reason: 'needs a bridge', status: 'accepted' },
    { id: 'c3', kind: 'remove', slide: 's9', reason: 'gone already', status: 'orphan' },
  ],
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
};

const remark: Remark = {
  id: 'r1',
  anchor: { kind: 'slide', slide: 's4' },
  text: 'the concept of offsets is used before it is introduced',
  origin: 'check:order',
  severity: 'warn',
  status: 'open',
  laneId: null,
  createdAt: '2026-09-30T00:00:00.000Z',
};

describe('contextHeader', () => {
  it('lane thread: label, anchor titles, one line per change, revise-or-fork instruction', () => {
    const h = contextHeader({ thread: 'lane:l1', anchor: null, snapshot, lane, brief });
    expect(h).toContain('Tighter opening');
    expect(h).toContain('Anchor slides: "Title s2" (s2), "Title s3" (s3)');
    expect(h).toContain('c1 · modify · "Title s2" (s2) · the claim is buried · pending');
    expect(h).toContain('c2 · insert · "Why logs win" (n1) after s3 · needs a bridge · accepted');
    expect(h).toContain('c3 · remove · (no longer in the deck) (s9) · gone already · orphan');
    expect(h).toContain('call revise_lane on it (laneId "l1")');
    expect(h).toContain('call propose_lane with a new label');
    expect(h).toContain('mention both lanes');
    expect(h).toContain('Never edit main directly');
    expect(h).not.toContain('link_remark_lane');
    expect(h).not.toContain('six sentences');
  });

  it('remark thread: text, anchor titles, severity, propose-then-link instruction', () => {
    const h = contextHeader({ thread: 'remark:r1', anchor: null, snapshot, remark, brief });
    expect(h).toContain(remark.text);
    expect(h).toContain('Severity: warn');
    expect(h).toContain('Anchor slides: "Title s4" (s4)');
    expect(h).toContain('call propose_lane with anchor {"kind":"slide","slide":"s4"}');
    expect(h).toContain('link_remark_lane({"remarkId":"r1","laneId":<the new lane id>})');
    expect(h).toContain('mention the lane id');
    expect(h).not.toContain('revise_lane on it');
  });

  it('remark already linked to a lane: names it', () => {
    const h = contextHeader({ thread: 'remark:r1', anchor: null, snapshot, remark: { ...remark, laneId: 'l7' }, brief });
    expect(h).toContain('already linked to lane l7');
  });

  it('global thread: brief, outline, selection, propose_lane and six-sentence instruction', () => {
    const h = contextHeader({ thread: 'global', anchor: { kind: 'slide', slide: 's3' }, snapshot, brief });
    expect(h).toContain('one log');
    for (const s of five) expect(h).toContain(`${s.id}: ${s.title}`);
    expect(h).toContain('Selected: slide s3');
    expect(h).toContain('story of s3');
    expect(h).toContain('always go through propose_lane');
    expect(h).toContain('under six sentences');
    expect(h).not.toContain('revise_lane on it');
  });
});

describe('reply rules', () => {
  it('tell the co-author to answer in the creator language and without layout jargon', async () => {
    const { SYSTEM_APPEND } = await import('../../src/agent/prompts.js');
    expect(SYSTEM_APPEND).toMatch(/language the creator writes in/);
    expect(SYSTEM_APPEND).toMatch(/Never mention pixel sizes/);
  });
});

describe('SYSTEM_APPEND', () => {
  it('forbids truncating content to fit, offers a split or a remark instead, and never claims a render check passed', () => {
    expect(SYSTEM_APPEND).toMatch(/Never truncate code or text to make it fit/);
    expect(SYSTEM_APPEND).toMatch(/split it into two slides/);
    expect(SYSTEM_APPEND).toMatch(/add_remark/);
    expect(SYSTEM_APPEND).toMatch(/render_slide only validates structure/);
    expect(SYSTEM_APPEND).toMatch(/Never claim .*render check passed/);
  });
});
