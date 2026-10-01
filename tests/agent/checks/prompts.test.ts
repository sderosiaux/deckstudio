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
