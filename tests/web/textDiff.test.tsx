// @vitest-environment jsdom
import { afterEach, describe, expect, it } from 'vitest';
import { cleanup, render, screen } from '@testing-library/react';
import { TextDiff, diffLines, plainText } from '../../web/src/components/TextDiff.js';

afterEach(() => cleanup());

const ops = () => screen.getAllByTestId('diff-line').map((l) => `${l.getAttribute('data-op')}:${l.getAttribute('data-text')}`);

describe('TextDiff', () => {
  it('renders one removed and one added line for a two-line change', () => {
    render(<TextDiff label="body" before={['Kafka is a log', 'Consumers pull']} after={['Kafka is a log', 'Consumers push']} />);
    expect(ops()).toEqual(['same:Kafka is a log', 'del:Consumers pull', 'add:Consumers push']);
    expect(screen.getAllByTestId('diff-line').filter((l) => l.getAttribute('data-op') === 'del')).toHaveLength(1);
    expect(screen.getAllByTestId('diff-line').filter((l) => l.getAttribute('data-op') === 'add')).toHaveLength(1);
  });

  it('says so when nothing changed', () => {
    render(<TextDiff label="title" before={['Same']} after={['Same']} />);
    expect(screen.getByTestId('text-diff').textContent).toContain('no text change');
  });

  it('folds long unchanged runs, keeping context around the edits', () => {
    const before = Array.from({ length: 20 }, (_, i) => `line ${i}`);
    const after = before.map((l, i) => (i === 10 ? 'line ten' : l));
    render(<TextDiff label="body" before={before} after={after} />);
    const shown = ops();
    expect(shown).toContain('del:line 10');
    expect(shown).toContain('add:line ten');
    expect(shown).toContain('same:line 8');
    expect(shown).not.toContain('same:line 0');
    expect(screen.getAllByTestId('diff-fold').map((f) => f.textContent)).toEqual(['8 unchanged lines', '7 unchanged lines']);
  });
});

describe('diffLines', () => {
  it('is an LCS diff: common lines stay, the rest is removed then added', () => {
    expect(diffLines(['a', 'b', 'c', 'd'], ['a', 'x', 'c', 'd', 'e'])).toEqual([
      { op: 'same', text: 'a' },
      { op: 'del', text: 'b' },
      { op: 'add', text: 'x' },
      { op: 'same', text: 'c' },
      { op: 'same', text: 'd' },
      { op: 'add', text: 'e' },
    ]);
    expect(diffLines([], ['a'])).toEqual([{ op: 'add', text: 'a' }]);
    expect(diffLines(['a'], [])).toEqual([{ op: 'del', text: 'a' }]);
  });
});

describe('plainText', () => {
  it('strips tags, one line per block, whitespace collapsed', () => {
    expect(plainText('<h1>Why  <em>lanes</em></h1>\n<ul><li>one</li><li>two &amp; three</li></ul><p>a<br>b</p>')).toEqual([
      'Why lanes',
      'one',
      'two & three',
      'a',
      'b',
    ]);
  });

  it('keeps the lines of a .code body verbatim, its source caption on its own line', () => {
    const html = '<h2>Consumer</h2><pre class="code"><span class="src">Share.java</span><span class="kw">var</span> props = x;\n  try (var r = open()) {\n    r.poll();\n  }</pre>';
    expect(plainText(html)).toEqual(['Consumer', 'Share.java', 'var props = x;', '  try (var r = open()) {', '    r.poll();', '  }']);
  });
});
