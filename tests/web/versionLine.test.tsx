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

describe('VersionLine QA2', () => {
  const withLabel = (n: number, label: string, cause: Version['cause']): Version & { label: string } => ({ ...version(n), cause, label });
  const item = (n: number) => screen.getAllByTestId('version').find((v) => v.getAttribute('data-version') === String(n))!;

  it('shows the server label of a restore whole, on up to two wrapping lines, with the hash kept under it', () => {
    const long = 'slide 3 "The log has three jobs" reverted to v1 · story, notes';
    render(<VersionLine versions={[version(0), withLabel(1, long, { kind: 'restore', from: 0, entry: '{}' })]} current={1} selection={{ a: 0, b: 1 }} onSelect={() => {}} />);
    const cause = within(item(1)).getByTestId('version-cause');
    expect(cause.textContent).toBe(long);
    expect(cause.style.whiteSpace).not.toBe('nowrap');
    expect(cause.style.webkitLineClamp ?? cause.style.getPropertyValue('-webkit-line-clamp')).toBe('2');
    expect(within(item(1)).getByTestId('version-hash').textContent).toMatch(/^[0-9a-f]{7}$/);
    // On the history, wide enough that two lines hold a slide title and what was reverted.
    expect(Number.parseInt(item(1).style.minWidth, 10)).toBeGreaterThanOrEqual(144);
    cleanup();
    // Main keeps its six narrow columns beside the lanes.
    render(<VersionLine versions={[version(0), withLabel(1, long, { kind: 'restore', from: 0, entry: '{}' })]} current={1} />);
    expect(item(1).style.minWidth).toBe('112px');
    expect(within(item(1)).getByTestId('version-cause').textContent).toBe(long);
  });

  it('an accepted change keeps the change part on the rail; the lane name stays in the tooltip', () => {
    render(<VersionLine versions={[version(0), withLabel(1, 'changed "Hook" · Shorter labels', { kind: 'accept', laneId: 'l1', changeId: 'c1' })]} current={1} />);
    expect(within(item(1)).getByTestId('version-cause').textContent).toBe('changed "Hook"');
    expect(item(1).title).toContain('Shorter labels');
  });

  it('scrolls the selected pair into view, the earlier then the later one, whenever the selection changes', () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    const versions = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].map(version);
    const { rerender } = render(<VersionLine versions={versions} current={9} selection={{ a: 1, b: 9 }} onSelect={() => {}} />);
    const targets = () => scrolled.mock.contexts.map((el) => (el as HTMLElement).getAttribute('data-version'));
    expect(targets().slice(-2)).toEqual(['1', '9']);
    scrolled.mockClear();
    rerender(<VersionLine versions={versions} current={9} selection={{ a: 7, b: 2 }} onSelect={() => {}} />);
    expect(targets()).toEqual(['2', '7']);
  });

  it('the "from" and "to" tags follow the selection and stay on the rail', () => {
    const versions = [1, 2, 3, 4].map(version);
    const tags = () => screen.getAllByTestId('version').map((v) => within(v).queryByTestId('version-pick')?.textContent ?? null);
    const { rerender } = render(<VersionLine versions={versions} current={4} selection={{ a: 1, b: 4 }} onSelect={() => {}} />);
    expect(tags()).toEqual(['from', null, null, 'to']);
    rerender(<VersionLine versions={versions} current={4} selection={{ a: 2, b: 3 }} onSelect={() => {}} />);
    expect(tags()).toEqual([null, 'from', 'to', null]);
    // The tag line may wrap but never clips its tag away.
    for (const v of screen.getAllByTestId('version-pick')) expect(v.parentElement!.style.overflow).not.toBe('hidden');
  });
});
