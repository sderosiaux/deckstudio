import { describe, expect, it } from 'vitest';
import { contextHeader, SYSTEM_APPEND, themeClasses } from '../../src/agent/prompts.js';
import type { Brief, Lane, Remark, Slide, Snapshot } from '../../src/model/types.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
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

describe('contextHeader: slide thread', () => {
  const edited: Snapshot = {
    ...snapshot,
    slides: { ...snapshot.slides, s3: { ...snapshot.slides['s3']!, notes: 'pause after the claim', body: '<div class="flow"><span>log</span></div>' } },
  };

  it('scopes the request on the slide: number, title, story, notes, full body, and the decide-the-scope instruction', () => {
    const h = contextHeader({ thread: 'slide:s3', anchor: null, snapshot: edited, brief });
    expect(h).toContain('Selected: slide s3');
    const scope = h.slice(h.indexOf('Scope:'));
    expect(scope).toContain('the creator is editing slide 3 "Title s3" (s3)');
    expect(scope).toContain('story: story of s3');
    expect(scope).toContain('notes: pause after the claim');
    expect(scope).toContain('<div class="flow"><span>log</span></div>');
    expect(scope).toContain('Decide the scope yourself');
    expect(scope).toContain('call propose_lane once with anchor {"kind":"slide","slide":"s3"}');
    expect(scope).toContain('a single modify change on s3');
    expect(scope).toContain('nothing else');
    expect(scope).toContain('smallest range');
    expect(scope).toContain('the arc');
    expect(scope).toContain('one sentence why the change goes beyond this slide');
    expect(scope).toContain('Never edit main directly');
    expect(scope).toMatch(/never describe pixels/i);
    expect(h).not.toContain('six sentences');
    expect(h).not.toContain('revise_lane on it');
  });

  it('keeps the slide scope when the message carries the slide as context', () => {
    const h = contextHeader({ thread: 'slide:s3', anchor: { kind: 'slide', slide: 's3' }, snapshot: edited, brief });
    expect(h).toContain('the creator is editing slide 3 "Title s3" (s3)');
  });

  it('a slide no longer in the deck: says so and still routes proposals through propose_lane', () => {
    const h = contextHeader({ thread: 'slide:s9', anchor: null, snapshot, brief });
    expect(h).toContain('Slide s9 is no longer in the deck');
    expect(h).toContain('propose_lane');
    expect(h).not.toContain('the creator is editing slide');
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

describe('design rules', () => {
  const rules = 'Archivo for all text.\nNo bullet lists, no sentence under a visual.';
  const designed: Brief = { ...brief, design: { rules, imageStyle: '' } };
  const css = [
    '/* .commented-out{color:red} */',
    ':root{--paper:#FAF9F6}',
    '.slide{padding:72px 96px;line-height:.98}',
    'h2{font-size:82px}',
    '.big,.cap{font-size:32px;box-shadow:0 4px 12px rgba(23,23,26,.10)}',
    '.code .kw{font-weight:700}.code .st{color:var(--accent)}',
    'a[href$=".png"]{border:0}',
    '@media (min-resolution:1.5dppx){.strata.thin{height:60px}}',
  ].join('\n');

  it('themeClasses lists each class selector once, in order, ignoring declarations, comments and strings', () => {
    expect(themeClasses(css)).toEqual(['slide', 'big', 'cap', 'code', 'kw', 'st', 'strata', 'thin']);
  });

  it('adds a Design rules block after the brief line with the rules verbatim and the theme classes', () => {
    const h = contextHeader({ thread: 'global', anchor: null, snapshot, brief: designed, themeCss: css });
    const lines = h.split('\n');
    const at = lines.findIndex((l) => l.startsWith('Design rules'));
    expect(at).toBe(lines.findIndex((l) => l.startsWith('Brief:')) + 1);
    expect(h).toContain(`${lines[at]}\n${rules}\n`);
    // .slide is the stage the renderer draws, not a class for a body.
    expect(h).toContain('Theme classes in theme.css (reuse them instead of inline styles): .big, .cap, .code, .kw, .st, .strata, .thin\n');
    expect(h.indexOf('Design rules')).toBeLessThan(h.indexOf('Deck outline'));
  });

  it('no Design rules block when the brief has no rules', () => {
    const blank = { ...brief, design: { rules: '  \n', imageStyle: 'x' } };
    const h = contextHeader({ thread: 'global', anchor: null, snapshot, brief: blank, themeCss: css });
    expect(h).not.toContain('Design rules');
    expect(h).not.toContain('Theme classes');
  });

  it('lane, remark and slide threads carry the same block', () => {
    const threads = [
      contextHeader({ thread: 'lane:l1', anchor: null, snapshot, lane, brief: designed, themeCss: css }),
      contextHeader({ thread: 'remark:r1', anchor: null, snapshot, remark, brief: designed, themeCss: css }),
      contextHeader({ thread: 'slide:s3', anchor: null, snapshot, brief: designed, themeCss: css }),
    ];
    for (const h of threads) {
      expect(h).toContain(rules);
      expect(h).toContain('.big, .cap');
    }
  });

  it('SYSTEM_APPEND makes every created or modified slide satisfy the design rules, and names conflicts', () => {
    expect(SYSTEM_APPEND).toMatch(/every slide you create or modify must satisfy the design rules of the brief/i);
    expect(SYSTEM_APPEND).toMatch(/conflicts with them, say so in one sentence and propose the closest compliant change/i);
  });
});
