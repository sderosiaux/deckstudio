// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { History } from '../../web/src/screens/History.js';
import { VersionLine } from '../../web/src/components/VersionLine.js';
import { bRowCells } from '../../web/src/components/DiffFilmstrips.js';
import type { BusEvent, DeckPayload, HistoryApi } from '../../web/src/api.js';
import { diffVersions } from '../../src/model/ops.js';
import type { Slide, SlideId, Snapshot, Version } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const slide = (id: string, title = `Title ${id}`): Slide => ({ id, title, story: '', notes: '', body: `<p>${id}</p>`, assets: [], kind: 'text' });
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });

// v1: s1..s5. v2: s2 retitled. v3: s4 removed, s6 added, s3 moved before s2.
const snaps: Record<number, Snapshot> = {
  1: snap([slide('s1'), slide('s2'), slide('s3'), slide('s4'), slide('s5')]),
  2: snap([slide('s1'), slide('s2', 'Our Solution'), slide('s3'), slide('s4'), slide('s5')]),
  3: snap([slide('s1'), slide('s3'), slide('s2', 'Our Solution'), slide('s6'), slide('s5')]),
};
const version = (n: number): Version & { label: string } => ({
  n,
  order: snaps[n]!.order,
  slides: {},
  cause: n === 1 ? { kind: 'import' } : { kind: 'accept', laneId: 'l1', changeId: `c${n}` },
  createdAt: '2026-09-30T00:00:00.000Z',
  label: n === 1 ? 'imported' : `change ${n}`,
});
const latest = snaps[3]!;
const deck: DeckPayload = {
  state: { name: 'demo', order: latest.order, version: 3, sessionId: null, model: 'm' },
  brief: { title: 't', audience: 'a', message: 'm', pattern: 'solution-first', abstract: 'x' },
  order: latest.order,
  slides: latest.slides,
};

const stubApi = () => {
  const api = {
    getDeck: vi.fn(async () => deck),
    getVersions: vi.fn(async () => [1, 2, 3].map(version)),
    getVersionSnapshot: vi.fn(async (n: number) => snaps[n]!),
    getHistoryDiff: vi.fn(async (a: number, b: number) => ({ a, b, entries: diffVersions(snaps[a]!, snaps[b]!) })),
    restoreEntry: vi.fn(async () => undefined),
    openVersionAsLane: vi.fn(async (n: number) => ({
      id: 'lv',
      label: `v${n}`,
      anchor: { kind: 'arc' as const },
      origin: 'user' as const,
      baseVersion: 3,
      changes: [],
      status: 'open' as const,
      createdAt: '2026-09-30T00:00:00.000Z',
    })),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h${id}`, ready: true })),
  };
  return api satisfies HistoryApi;
};

const noEvents = (_h: (e: BusEvent) => void) => () => undefined;
const versionButton = (n: number) => within(screen.getAllByTestId('version').find((v) => v.getAttribute('data-version') === String(n))!).getByRole('button');
const kinds = (testId: string) => screen.queryAllByTestId(testId).map((m) => `${m.getAttribute('data-kind')}:${m.getAttribute('data-slide')}`).sort();

afterEach(() => cleanup());

describe('History', () => {
  it('compares the latest version with the one before by default', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('diff-entry').length > 0);
    expect(api.getHistoryDiff).toHaveBeenCalledWith(2, 3);
    const selected = screen.getAllByTestId('version').filter((v) => v.hasAttribute('data-selected'));
    expect(selected.map((v) => `${v.getAttribute('data-version')}${v.getAttribute('data-selected')}`)).toEqual(['2a', '3b']);
  });

  it('selecting v1 and v3 fetches their diff and renders one marker per entry', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    fireEvent.click(versionButton(3), { shiftKey: true });
    await waitFor(() => api.getHistoryDiff.mock.calls.some(([a, b]) => a === 1 && b === 3));
    const entries = diffVersions(snaps[1]!, snaps[3]!);
    expect(entries.map((e) => e.kind).sort()).toEqual(['added', 'modified', 'moved', 'removed']);
    const expected = entries.map((e) => `${e.kind}:${e.slide}`).sort();
    await waitFor(() => kinds('diff-marker').join() === expected.join());
    expect(kinds('diff-entry')).toEqual(expected);
    expect(screen.getByText('v1', { selector: '[data-testid="diff-filmstrips"] *' })).toBeTruthy();

    const panel = screen.getByRole('complementary', { name: 'what changed' });
    expect(within(panel).getByText('added in v3')).toBeTruthy();
    expect(within(panel).getByText('removed in v3')).toBeTruthy();
    expect(within(panel).getByText('title changed')).toBeTruthy();

    // The removed slide shows as a dashed slot in v3's row at its old position (4th column).
    const rowB = screen.getByTestId('row-b');
    const cells = within(rowB).getAllByRole('listitem');
    expect(within(cells[3]!).getByTestId('diff-marker').getAttribute('data-kind')).toBe('removed');
  });

  it('restore posts the entry with from = a, then reloads the versions', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    await waitFor(() => screen.queryAllByTestId('diff-entry').some((e) => e.getAttribute('data-kind') === 'removed'));
    const removed = screen.getAllByTestId('diff-entry').find((e) => e.getAttribute('data-kind') === 'removed')!;
    fireEvent.click(within(removed).getByRole('button', { name: /restore/ }));
    await waitFor(() => api.restoreEntry.mock.calls.length === 1);
    expect(api.restoreEntry).toHaveBeenCalledWith(1, { kind: 'removed', slide: 's4', wasAt: 3 });
    await waitFor(() => api.getVersions.mock.calls.length === 2);
  });

  it('opens version a as a lane, then goes to main', async () => {
    const api = stubApi();
    const navigate = vi.fn();
    render(<History api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'open v1 as a lane' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.openVersionAsLane).toHaveBeenCalledWith(1);
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('shows main thumbnails only for slides whose content matches main', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    await waitFor(() => screen.queryAllByTestId('thumb-image').length > 0);
    const rowA = screen.getByTestId('row-a');
    // s2 was retitled after v1: its v1 card cannot use main's render.
    const s2 = within(rowA).getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === 's2')!;
    expect(within(s2).queryByTestId('thumb-image')).toBeNull();
    const s1 = within(rowA).getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === 's1')!;
    await waitFor(() => within(s1).queryByTestId('thumb-image') !== null);
    expect(api.thumbFor).not.toHaveBeenCalledWith('s4');
  });
});

describe('VersionLine', () => {
  const versions = [1, 2, 3].map(version);

  it('click selects a, shift-click selects b', () => {
    const onSelect = vi.fn();
    render(<VersionLine versions={versions} current={3} selection={{ a: 2, b: 3 }} onSelect={onSelect} />);
    fireEvent.click(versionButton(1));
    fireEvent.click(versionButton(2), { shiftKey: true });
    expect(onSelect.mock.calls).toEqual([[1, 'a'], [2, 'b']]);
  });

  it('links to the history screen when not selectable', () => {
    const navigate = vi.fn();
    render(<VersionLine versions={versions} current={3} navigate={navigate} />);
    const link = screen.getByTestId('history-link');
    expect(link.getAttribute('href')).toBe('/history');
    fireEvent.click(link);
    expect(navigate).toHaveBeenCalledWith('/history');
    expect(screen.queryAllByRole('button')).toHaveLength(0);
  });
});

describe('bRowCells', () => {
  it('puts removed slides at their old index, bounded by the row length', () => {
    const cells = bRowCells(['x', 'y'], [
      { kind: 'removed', slide: 'r0', wasAt: 0 },
      { kind: 'removed', slide: 'r9', wasAt: 9 },
    ]);
    expect(cells.map((c) => c.id)).toEqual(['r0', 'x', 'y', 'r9']);
  });
});
