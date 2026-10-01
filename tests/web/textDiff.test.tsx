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

  it('marks only the changed words of an edited line: struck in the removed line, accent in the added one', () => {
    render(<TextDiff label="story" before={['Consumers pull from the log']} after={['Consumers push from the log']} />);
    const [del, add] = screen.getAllByTestId('diff-line');
    const marked = (el: HTMLElement) => Array.from(el.querySelectorAll('span[style]')).filter((s) => (s as HTMLElement).style.textDecoration === 'line-through' || (s as HTMLElement).style.color === 'var(--accent)').map((s) => s.textContent);
    expect(marked(del!)).toEqual(['pull']);
    expect(marked(add!)).toEqual(['push']);
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

  it('keeps every text node in document order: footers, figcaptions, labels and .cap/.big each on a line, images as their alt', () => {
    const html =
      '<h2>Two topics</h2><div class="cols"><figure><img src="assets/a.png" alt="event flow"><figcaption>events fan out</figcaption></figure>' +
      '<div><span class="big">1 owner</span><span class="cap">per command</span><label>queue</label></div></div>' +
      '<footer>something happened · any number of readers</footer><footer>something should happen · one owner</footer>';
    expect(plainText(html)).toEqual([
      'Two topics',
      '[image: event flow]',
      'events fan out',
      '1 owner',
      'per command',
      'queue',
      'something happened · any number of readers',
      'something should happen · one owner',
    ]);
  });

  it('names an image without alt text by its file, so swapping the asset is a visible line change', () => {
    expect(plainText('<img src="assets/t07.png" alt style="left:0">')).toEqual(['[image: t07.png]']);
  });

  it('reads the labels of an inline svg, one per text element', () => {
    expect(plainText('<svg viewBox="0 0 10 10"><text x="0" y="1">producer</text><text x="0" y="5">consumer</text></svg>')).toEqual(['producer', 'consumer']);
  });

  it('shows a footer-only body change as a removed and an added line, never "no text change"', () => {
    const before = '<h2>Events and commands</h2><footer>something happened · any number of readers</footer>';
    const after = '<h2>Events and commands</h2><footer><b>happened · many readers</b></footer>';
    render(<TextDiff label="body" before={plainText(before)} after={plainText(after)} />);
    expect(screen.getByTestId('text-diff').textContent).not.toContain('no text change');
    expect(ops()).toEqual(['same:Events and commands', 'del:something happened · any number of readers', 'add:happened · many readers']);
  });
});
