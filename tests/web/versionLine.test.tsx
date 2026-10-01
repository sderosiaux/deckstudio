// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { VersionLine } from '../../web/src/components/VersionLine.js';
import type { Version } from '../../src/model/types.js';

const version = (n: number): Version => ({ n, order: ['s1'], slides: { s1: `h${n}` }, cause: n === 0 ? { kind: 'import' } : { kind: 'restore', from: 0, entry: '{}' }, createdAt: '2026-09-30T00:00:00.000Z' });
const shown = (): number[] => screen.getAllByTestId('version').map((v) => Number(v.getAttribute('data-version')));

afterEach(() => {
  cleanup();
  delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
});

describe('VersionLine on main', () => {
  it('shows the six newest versions and collapses the older ones into "… N earlier", a link to the history', () => {
    const navigate = vi.fn();
    render(<VersionLine versions={[0, 1, 2, 3, 4, 5, 6, 7].map(version)} current={7} navigate={navigate} />);
    expect(shown()).toEqual([2, 3, 4, 5, 6, 7]);
    const earlier = screen.getByTestId('versions-earlier');
    expect(earlier.textContent).toBe('… 2 earlier');
    fireEvent.click(earlier);
    expect(navigate).toHaveBeenCalledWith('/history');
  });

  it('six versions or fewer are all shown', () => {
    render(<VersionLine versions={[0, 1, 2, 3, 4, 5].map(version)} current={5} />);
    expect(shown()).toEqual([0, 1, 2, 3, 4, 5]);
    expect(screen.queryByTestId('versions-earlier')).toBeNull();
  });

  it('scrolls the current version into view on mount and again when the current version changes', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const { rerender } = render(<VersionLine versions={[0, 1, 2].map(version)} current={2} />);
    expect((scrolled.mock.contexts.at(-1) as HTMLElement).getAttribute('data-version')).toBe('2');
    scrolled.mockClear();
    rerender(<VersionLine versions={[0, 1, 2, 3].map(version)} current={3} />);
    expect(scrolled).toHaveBeenCalledTimes(1);
    expect((scrolled.mock.contexts[0] as HTMLElement).getAttribute('data-version')).toBe('3');
  });

  it('keeps "compare versions" out of the scrolling rail, so it never covers the current label', () => {
    render(<VersionLine versions={[0, 1, 2].map(version)} current={2} />);
    const rail = screen.getByRole('list');
    expect(within(rail).queryByTestId('history-link')).toBeNull();
    expect(screen.getByTestId('history-link').style.flex).toBe('0 0 auto');
    expect(rail.style.overflowX).toBe('auto');
  });
});

describe('VersionLine when selectable (history)', () => {
  it('shows every version: none of them collapses', () => {
    render(<VersionLine versions={[0, 1, 2, 3, 4, 5, 6, 7].map(version)} current={7} selection={{ a: 0, b: 7 }} onSelect={() => {}} />);
    expect(shown()).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
  });
});
