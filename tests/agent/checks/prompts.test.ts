import { describe, expect, it } from 'vitest';
import { arc } from '../../../src/agent/checks/arc.js';
import { gaps } from '../../../src/agent/checks/gaps.js';
import type { CheckDef, CheckPromptInput } from '../../../src/agent/checks/index.js';
import { order } from '../../../src/agent/checks/order.js';
import { render } from '../../../src/agent/checks/render.js';
import type { Brief, Slide, Snapshot } from '../../../src/model/types.js';

const rules = 'Titles in sentence case.\nNo sentence under a visual.';
const brief = (r: string): Brief => ({ title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: r, imageStyle: '' } });
const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: '', notes: '', body: '<p>x</p>', assets: [], kind: 'text' });
const snap: Snapshot = { order: ['s1', 's2'], slides: { s1: slide('s1'), s2: slide('s2') } };
const input = (r: string): CheckPromptInput => ({ brief: brief(r), snap, deckOrder: snap.order, thumbs: { s1: '/t/s1.png', s2: '/t/s2.png' }, allowLanes: true });

describe('check prompts and the design rules', () => {
  it('render: verifies every rule, a violation is a warn remark naming the rule', () => {
    const p = render.buildPrompt(input(rules));
    expect(p).toContain(`<design-rules>\n${rules}\n</design-rules>`);
    expect(p).toMatch(/a slide that violates one of the design rules above: a "warn" remark that names the rule/i);
    expect(p.indexOf('<design-rules>')).toBeLessThan(p.indexOf('# Output'));
  });

  it('render: no design block and no rule item when the brief has no rules', () => {
    const p = render.buildPrompt(input('   '));
    expect(p).not.toContain('design-rules');
    expect(p).not.toMatch(/violates one of the design rules/i);
  });

  it.each<[string, CheckDef]>([
    ['arc', arc],
    ['order', order],
    ['gaps', gaps],
  ])('%s: receives the rules as context only', (_name, def) => {
    const p = def.buildPrompt(input(rules));
    expect(p).toContain(rules);
    expect(p).toMatch(/context only: another check verifies them; do not report on them/i);
    expect(p).not.toMatch(/violates one of the design rules/i);
    expect(def.buildPrompt(input('')).includes('design-rules')).toBe(false);
  });
});

describe('check prompts judge any deck against its brief', () => {
  const defs: [string, CheckDef][] = [
    ['arc', arc],
    ['order', order],
    ['gaps', gaps],
    ['render', render],
  ];

  it.each(defs)('%s: no kind of event or topic assumed, no example taken from a particular deck', (_name, def) => {
    const text = `${def.system}\n${def.buildPrompt(input(rules))}`;
    expect(text).not.toMatch(/conference|talk\b|technical|kafka|share group|interactive quer|compacted topic|trigger sub-caption/i);
  });

  it.each(defs.slice(0, 3))('%s: says the brief is the only yardstick', (_name, def) => {
    expect(def.system).toMatch(/the brief is your only yardstick/i);
  });

  it('arc: judges opening, progression and landing against the audience, message, abstract and pattern; no fixed slide count', () => {
    const p = arc.buildPrompt(input(''));
    expect(p).toMatch(/against its brief: its audience, its message, its abstract and its pattern/);
    expect(p).toMatch(/Opening:.*this audience/);
    expect(p).toMatch(/Landing:.*message of the brief/);
    expect(p).not.toMatch(/first 3 slides|hook/i);
    expect(p).toMatch(/never report a part as missing because decks of some kind usually have one/i);
  });

  it('order: what this audience can be assumed to know comes from the brief', () => {
    expect(order.buildPrompt(input(''))).toMatch(/the audience in the brief/);
  });

  it('render: judges legibility, and colours, fonts and layout only against the design rules, never a palette of its own', () => {
    const p = render.buildPrompt(input(rules));
    expect(p).toMatch(/colours, fonts and layout only against the design rules above/i);
    expect(p).not.toMatch(/#[0-9A-F]{6}\b/i);
    const bare = render.buildPrompt(input(''));
    expect(bare).toMatch(/no design rules: judge legibility and composition only, never a palette or a style of your own/i);
  });
});
