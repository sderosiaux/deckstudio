// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { RESTORE_DONE_MS } from '../../web/src/screens/History.js';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { History } from '../../web/src/screens/History.js';
import { VersionLine } from '../../web/src/components/VersionLine.js';
import { DiffFilmstrips, aRowCells, bRowCells } from '../../web/src/components/DiffFilmstrips.js';
import { ApiError, openVersionAsLane, type BusEvent, type DeckPayload, type HistoryApi } from '../../web/src/api.js';
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
  brief: { title: 't', audience: 'a', message: 'm', pattern: 'solution-first', abstract: 'x', design: { rules: '', imageStyle: '' } },
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
    openVersionAsLane: vi.fn(async (_n: number) => ({ laneId: 'lv' })),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h${id}`, ready: true })),
  };
  return api satisfies HistoryApi;
};

const noEvents = (_h: (e: BusEvent) => void) => () => undefined;

/** A bus the test drives: emit() reaches every subscribed handler. */
const fakeBus = () => {
  const handlers = new Set<(e: BusEvent) => void>();
  return {
    subscribe: (h: (e: BusEvent) => void) => {
      handlers.add(h);
      return () => void handlers.delete(h);
    },
    emit: (e: BusEvent) => {
      for (const h of handlers) h(e);
    },
  };
};

const deferred = <T,>() => {
  let resolve!: (v: T) => void;
  const promise = new Promise<T>((r) => (resolve = r));
  return { promise, resolve };
};
const versionButton = (n: number) => within(screen.getAllByTestId('version').find((v) => v.getAttribute('data-version') === String(n))!).getByRole('button');
const kinds = (testId: string) => screen.queryAllByTestId(testId).map((m) => `${m.getAttribute('data-kind')}:${m.getAttribute('data-slide')}`).sort();

afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

describe('History', () => {
  it('compares the latest version with the one before by default', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('diff-entry').length > 0);
    expect(api.getHistoryDiff).toHaveBeenCalledWith(2, 3);
    const selected = screen.getAllByTestId('version').filter((v) => v.hasAttribute('data-selected'));
    expect(selected.map((v) => `${v.getAttribute('data-version')}${v.getAttribute('data-selected')}`)).toEqual(['2a', '3b']);
  });

  it('wraps an entry\'s slide title (two lines at most) instead of cutting it to one, under an empty header gutter', async () => {
    render(<History api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('diff-entry').length > 0);
    const title = screen.getAllByTestId('diff-entry-title')[0]!;
    expect(title.style.whiteSpace).not.toBe('nowrap');
    expect(title.style.webkitLineClamp).toBe('2');
    expect(document.querySelector('.screen-header > .gutter')!.textContent).toBe('');
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

  it('restore posts the entry with from = a, then reloads once, on the server deck.changed', async () => {
    const api = stubApi();
    const bus = fakeBus();
    // The server announces the new main version on the bus; the restore itself triggers no client reload.
    api.restoreEntry.mockImplementation(async () => {
      bus.emit({ type: 'deck.changed', version: 4 });
    });
    render(<History api={api} subscribe={bus.subscribe} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    await waitFor(() => screen.queryAllByTestId('diff-entry').some((e) => e.getAttribute('data-kind') === 'removed'));
    const removed = screen.getAllByTestId('diff-entry').find((e) => e.getAttribute('data-kind') === 'removed')!;
    fireEvent.click(within(removed).getByRole('button', { name: /bring back/ }));
    fireEvent.click(within(removed).getByRole('button', { name: 'confirm' }));
    await waitFor(() => api.restoreEntry.mock.calls.length === 1);
    expect(api.restoreEntry).toHaveBeenCalledWith(1, { kind: 'removed', slide: 's4', wasAt: 3 });
    await waitFor(() => api.getVersions.mock.calls.length >= 2);
    // Restore settled (button back to idle): any client-side reload would have started by now.
    await waitFor(() => screen.queryByText('restoring…') === null);
    expect(api.getVersions).toHaveBeenCalledTimes(2);
  });

  it('drops a stale refresh answer that lands after a newer one', async () => {
    const api = stubApi();
    const bus = fakeBus();
    const first = deferred<DeckPayload>();
    const v4 = snap([slide('s1'), slide('s3'), slide('s2', 'Our Solution'), slide('s6')]);
    const deck4: DeckPayload = { ...deck, state: { ...deck.state, version: 4, order: v4.order }, order: v4.order, slides: v4.slides };
    api.getDeck.mockImplementationOnce(() => first.promise).mockImplementation(async () => deck4);
    render(<History api={api} subscribe={bus.subscribe} navigate={vi.fn()} />);
    bus.emit({ type: 'deck.changed', version: 4 });
    const shownVersion = () => screen.queryByTestId('history-version')?.textContent;
    await waitFor(() => shownVersion() === 'v4');
    // The mount-time refresh answers last, with the older main: it must not overwrite v4.
    await act(async () => {
      first.resolve(deck);
      await first.promise;
    });
    expect(shownVersion()).toBe('v4');
    expect(screen.getByTestId('history-deck').textContent).toBe('demo');
  });

  it('on deck.changed, re-requests only the thumbs of slides whose content changed', async () => {
    const api = stubApi();
    const bus = fakeBus();
    render(<History api={api} subscribe={bus.subscribe} navigate={vi.fn()} />);
    // Default pair v2..v3: every slide of v3 matches main, so all get main's thumb.
    await waitFor(() => screen.queryAllByTestId('thumb-image').length > 0 && api.thumbFor.mock.calls.length === 5);
    const s1Before = within(screen.getByTestId('row-b')).getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === 's1')!;
    const s1Src = within(s1Before).getByTestId('thumb-image').getAttribute('src');

    // v4: s5 edited on main. Only s5 must be re-requested.
    const s5b = { ...slide('s5'), body: '<p>s5 edited</p>' };
    const v4 = snap([slide('s1'), slide('s3'), slide('s2', 'Our Solution'), slide('s6'), s5b]);
    snaps[4] = v4;
    const deck4: DeckPayload = { ...deck, state: { ...deck.state, version: 4 }, slides: v4.slides };
    api.getDeck.mockImplementation(async () => deck4);
    api.getVersions.mockImplementation(async () => [1, 2, 3, 4].map(version));
    api.thumbFor.mockClear();
    api.thumbFor.mockImplementation(async (id: SlideId) => ({ hash: id === 's5' ? 'hs5b' : `h${id}`, ready: true }));
    try {
      bus.emit({ type: 'deck.changed', version: 4 });
      await waitFor(() => api.getHistoryDiff.mock.calls.some(([a, b]) => a === 2 && b === 4));
      await waitFor(() => api.thumbFor.mock.calls.length > 0);
      await waitFor(() => {
        const s5 = within(screen.getByTestId('row-b')).getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === 's5');
        return s5 ? within(s5).queryByTestId('thumb-image')?.getAttribute('src') === '/api/thumbs/hs5b.png' : false;
      });
      expect(api.thumbFor.mock.calls).toEqual([['s5']]);
      const s1 = within(screen.getByTestId('row-b')).getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === 's1')!;
      expect(within(s1).getByTestId('thumb-image').getAttribute('src')).toBe(s1Src);
    } finally {
      delete snaps[4];
    }
  });

  it('opens version a as a lane, then goes to main with that lane in the hash', async () => {
    const api = stubApi();
    const navigate = vi.fn();
    render(<History api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    fireEvent.click(await screen.findByRole('button', { name: 'Open v1 as a lane' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.openVersionAsLane).toHaveBeenCalledWith(1);
    expect(navigate).toHaveBeenCalledWith('/#lane=lv');
  });

  it('api.openVersionAsLane resolves to the server answer { laneId }', async () => {
    const fetchMock = vi.fn(async (_url: string, _init?: RequestInit) => new Response(JSON.stringify({ laneId: 'lane-7' }), { status: 200, headers: { 'content-type': 'application/json' } }));
    vi.stubGlobal('fetch', fetchMock);
    try {
      const res: { laneId: string } = await openVersionAsLane(2);
      expect(res).toEqual({ laneId: 'lane-7' });
      expect(fetchMock.mock.calls[0]![0]).toBe('/api/history/open-as-lane');
      expect(JSON.parse(String(fetchMock.mock.calls[0]![1]!.body))).toEqual({ n: 2 });
    } finally {
      vi.unstubAllGlobals();
    }
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

  it('every row says "restore"; its label names what it does to main', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    await waitFor(() => screen.queryAllByTestId('diff-entry').length === 4);
    const button = (kind: string) => within(screen.getAllByTestId('diff-entry').find((e) => e.getAttribute('data-kind') === kind)!).getByRole('button');
    for (const kind of ['added', 'removed', 'modified', 'moved']) expect(button(kind).textContent).toBe('restore');
    expect(button('added').getAttribute('aria-label')).toMatch(/^restore \(remove from main\)/);
    expect(button('removed').getAttribute('aria-label')).toMatch(/^restore \(bring back\)/);
    expect(button('modified').getAttribute('aria-label')).toMatch(/^restore \(revert content\)/);
    expect(button('moved').getAttribute('aria-label')).toMatch(/^restore \(move back\)/);
    // The verb is visible in the row, not only in the tooltip (M5 persona friction 2).
    const does = (kind: string) => within(screen.getAllByTestId('diff-entry').find((e) => e.getAttribute('data-kind') === kind)!).getByTestId('diff-entry-does').textContent;
    expect(does('added')).toBe('restore: remove from main');
    expect(does('removed')).toBe('restore: bring back');
    const panel = screen.getByRole('complementary', { name: 'what changed' });
    expect(within(panel).getByText('added in v3')).toBeTruthy();
    expect(within(panel).getAllByText(/^slide \d+$/)).toHaveLength(4);
  });

  it('comparing from an empty version shows one warning line and no restore buttons', async () => {
    const api = stubApi();
    snaps[0] = snap([]);
    try {
      api.getVersions.mockImplementation(async () => [0, 1, 2, 3].map(version));
      render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
      await waitFor(() => screen.queryAllByTestId('version').length === 4);
      fireEvent.click(versionButton(0));
      const panel = screen.getByRole('complementary', { name: 'what changed' });
      await waitFor(() => within(panel).queryByText('v0 is empty: restoring would remove every slide'));
      expect(within(panel).queryAllByRole('button')).toHaveLength(0);
      expect(within(panel).queryAllByTestId('diff-entry')).toHaveLength(0);
    } finally {
      delete snaps[0];
    }
  });

  it('"open vA as a lane" is disabled when main already has vA\'s slides (b is main: reuses the loaded diff)', async () => {
    const api = stubApi();
    api.getHistoryDiff.mockImplementation(async (a: number, b: number) => ({ a, b, entries: [] }));
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByText('v2 and v3 have the same slides in the same order.'));
    const open = screen.getByRole('button', { name: 'Open v2 as a lane' }) as HTMLButtonElement;
    expect(open.disabled).toBe(true);
    expect(open.title).toBe("main already has v2's slides");
    expect(api.getHistoryDiff.mock.calls).toEqual([[2, 3]]);
  });

  it('"open vA as a lane" asks diff(current, a) once when b is not main, and disables on an empty diff', async () => {
    const api = stubApi();
    api.getHistoryDiff.mockImplementation(async (a: number, b: number) => ({ a, b, entries: a === 3 && b === 1 ? [] : diffVersions(snaps[a]!, snaps[b]!) }));
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    fireEvent.click(versionButton(2), { shiftKey: true });
    await waitFor(() => (screen.getByRole('button', { name: 'Open v1 as a lane' }) as HTMLButtonElement).disabled);
    expect(api.getHistoryDiff.mock.calls.filter(([a, b]) => a === 3 && b === 1)).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Open v1 as a lane' }).title).toBe("main already has v1's slides");
  });

  it('a 409 from open-as-lane never shows the raw HTTP error in the header', async () => {
    const api = stubApi();
    api.openVersionAsLane.mockRejectedValue(new ApiError('POST', '/api/history/open-as-lane', 409, 'main already equals v1'));
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    const open = await screen.findByRole('button', { name: 'Open v1 as a lane' });
    await waitFor(() => !(open as HTMLButtonElement).disabled);
    fireEvent.click(open);
    const alert = await screen.findByRole('alert');
    expect(alert.textContent).not.toMatch(/POST|failed: 409/);
    expect(alert.textContent).toBe("main already has v1's slides");
  });

  it('reads the compared pair from ?a=&b=', async () => {
    history.replaceState(null, '', '/history?a=1&b=3');
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('diff-entry').length === 4);
    expect(api.getHistoryDiff.mock.calls[0]).toEqual([1, 3]);
    expect(api.getHistoryDiff).not.toHaveBeenCalledWith(2, 3);
  });
});

describe('DiffFilmstrips', () => {
  const a = snap([slide('s1'), slide('s2')]);
  const b = snap([slide('s1'), slide('s3'), slide('s2')]);
  const side = (n: number, s: Snapshot) => ({ n, snapshot: s, thumbs: {} });

  it('forward compare: an added slide leaves a dashed slot in row a at its position', () => {
    render(<DiffFilmstrips a={side(1, a)} b={side(2, b)} entries={diffVersions(a, b)} onFocus={vi.fn()} />);
    const cells = within(screen.getByTestId('row-a')).getAllByRole('listitem');
    expect(cells).toHaveLength(3);
    expect(within(cells[1]!).getByTestId('ghost-s3')).toBeTruthy();
    // The ghost is not a second marker for the entry.
    expect(within(screen.getByTestId('row-a')).queryAllByTestId('diff-marker')).toHaveLength(0);
  });

  it('the selected thumbnail uses an ink ring whose class differs from the "changed" marker', () => {
    render(<DiffFilmstrips a={side(1, a)} b={side(2, b)} entries={diffVersions(a, b)} focused="s3" onFocus={vi.fn()} />);
    const rowB = screen.getByTestId('row-b');
    const cell = within(rowB).getAllByRole('listitem')[1]!;
    const marker = within(cell).getByTestId('diff-marker');
    const selected = cell.querySelector('.thumb-selected') as HTMLElement;
    expect(selected).not.toBeNull();
    expect(marker.className).toBe('diff-changed');
    expect(selected.className).not.toBe(marker.className);
    expect(selected.style.boxShadow).toContain('var(--ink)');
    expect(selected.style.boxShadow).not.toContain('var(--accent)');
  });
});

describe('aRowCells', () => {
  it('puts added slides at their new index, bounded by the row length', () => {
    const cells = aRowCells(['x', 'y'], [
      { kind: 'added', slide: 'n0', at: 0 },
      { kind: 'added', slide: 'n9', at: 9 },
    ]);
    expect(cells.map((c) => c.id)).toEqual(['n0', 'x', 'y', 'n9']);
  });
});

describe('VersionLine', () => {
  const versions = [1, 2, 3].map(version);

  it('on main, clicking a version opens the history comparing it with the current one', () => {
    const navigate = vi.fn();
    render(<VersionLine versions={versions} current={3} navigate={navigate} />);
    const chip = within(screen.getAllByTestId('version').find((v) => v.getAttribute('data-version') === '1')!).getByRole('link');
    expect(chip.getAttribute('href')).toBe('/history?a=1&b=3');
    fireEvent.click(chip);
    expect(navigate).toHaveBeenCalledWith('/history?a=1&b=3');
  });

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

describe('History QA1', () => {
  const entryOf = (kind: string) => screen.getAllByTestId('diff-entry').find((e) => e.getAttribute('data-kind') === kind)!;
  const selectedPair = () => screen.getAllByTestId('version').filter((v) => v.hasAttribute('data-selected')).map((v) => `${v.getAttribute('data-version')}${v.getAttribute('data-selected')}`);

  it('restore is a two-step inline confirm: the first click asks, cancel backs out, confirm restores', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    await waitFor(() => screen.queryAllByTestId('diff-entry').length === 4);
    fireEvent.click(within(entryOf('added')).getByRole('button', { name: /^restore/ }));
    expect(api.restoreEntry).not.toHaveBeenCalled();
    expect(within(entryOf('added')).getByTestId('restore-confirm').textContent).toContain('remove from main?');
    fireEvent.click(within(entryOf('added')).getByRole('button', { name: 'cancel' }));
    expect(within(entryOf('added')).queryByTestId('restore-confirm')).toBeNull();
    expect(api.restoreEntry).not.toHaveBeenCalled();
    fireEvent.click(within(entryOf('added')).getByRole('button', { name: /^restore/ }));
    fireEvent.click(within(entryOf('added')).getByRole('button', { name: 'confirm' }));
    await waitFor(() => api.restoreEntry.mock.calls.length === 1);
    expect(api.restoreEntry).toHaveBeenCalledWith(1, { kind: 'added', slide: 's6', at: 3 });
  });

  it('after a restore the row says "done: vN, undo" for a few seconds; undo restores the inverse entry', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const api = stubApi();
    // Restoring "removed s4" from v1 brings s4 back on main: v4.
    snaps[4] = snap([slide('s1'), slide('s3'), slide('s2', 'Our Solution'), slide('s4'), slide('s6'), slide('s5')]);
    const deck4: DeckPayload = { ...deck, state: { ...deck.state, version: 4, order: snaps[4].order }, order: snaps[4].order, slides: snaps[4].slides };
    api.restoreEntry.mockImplementationOnce(async () => {
      api.getDeck.mockImplementation(async () => deck4);
      api.getVersions.mockImplementation(async () => [1, 2, 3, 4].map(version));
    });
    try {
      render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
      await waitFor(() => screen.queryAllByTestId('version').length === 3);
      fireEvent.click(versionButton(1));
      await waitFor(() => screen.queryAllByTestId('diff-entry').length === 4);
      fireEvent.click(within(entryOf('removed')).getByRole('button', { name: /^restore/ }));
      fireEvent.click(within(entryOf('removed')).getByRole('button', { name: 'confirm' }));
      const done = await waitFor(() => screen.queryByTestId('restore-done'));
      expect(done.textContent).toBe('done: v4, undo');
      fireEvent.click(within(done).getByRole('button', { name: 'undo' }));
      await waitFor(() => api.restoreEntry.mock.calls.length === 2);
      const inverse = diffVersions(snaps[3]!, snaps[4]!).find((e) => e.slide === 's4')!;
      expect(api.restoreEntry.mock.calls[1]).toEqual([3, inverse]);
      await waitFor(() => screen.queryByTestId('restore-done') === null);

      // A second restore: the line goes away on its own after RESTORE_DONE_MS.
      api.restoreEntry.mockImplementation(async () => undefined);
      await waitFor(() => screen.queryAllByTestId('diff-entry').length > 0);
      const first = screen.getAllByTestId('diff-entry')[0]!;
      fireEvent.click(within(first).getByRole('button', { name: /^restore/ }));
      fireEvent.click(within(first).getByRole('button', { name: 'confirm' }));
      await waitFor(() => screen.queryByTestId('restore-done'));
      act(() => {
        vi.advanceTimersByTime(RESTORE_DONE_MS + 10);
      });
      expect(screen.queryByTestId('restore-done')).toBeNull();
    } finally {
      vi.useRealTimers();
      delete snaps[4];
    }
  });

  it('clicking the current "to" does nothing; swap exchanges from and to', async () => {
    const api = stubApi();
    render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('diff-entry').length > 0);
    expect(selectedPair()).toEqual(['2a', '3b']);
    fireEvent.click(versionButton(3));
    expect(selectedPair()).toEqual(['2a', '3b']);
    expect(api.getHistoryDiff).not.toHaveBeenCalledWith(3, 3);
    fireEvent.click(screen.getByRole('button', { name: 'swap' }));
    expect(selectedPair()).toEqual(['2b', '3a']);
    await waitFor(() => api.getHistoryDiff.mock.calls.some(([a, b]) => a === 3 && b === 2));
  });

  it('an empty version reads "empty (before import)" and cannot be opened as a lane', async () => {
    const api = stubApi();
    snaps[0] = snap([]);
    try {
      api.getVersions.mockImplementation(async () => [0, 1, 2, 3].map((n) => (n === 0 ? { ...version(0), order: [], label: 'imported' } : version(n))));
      render(<History api={api} subscribe={noEvents} navigate={vi.fn()} />);
      await waitFor(() => screen.queryAllByTestId('version').length === 4);
      const v0 = screen.getAllByTestId('version').find((v) => v.getAttribute('data-version') === '0')!;
      expect(within(v0).getByTestId('version-cause').textContent).toBe('empty (before import)');
      fireEvent.click(versionButton(0));
      const open = (await screen.findByRole('button', { name: 'Open v0 as a lane' })) as HTMLButtonElement;
      expect(open.disabled).toBe(true);
      expect(open.title).toBe('v0 is empty (before import)');
    } finally {
      delete snaps[0];
    }
  });

  it('a past version whose slide differs from main shows a title card, never a blank thumb', async () => {
    render(<History api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('version').length === 3);
    fireEvent.click(versionButton(1));
    await waitFor(() => screen.queryAllByTestId('diff-entry').length === 4);
    const rowA = screen.getByTestId('row-a');
    const s2 = within(rowA).getAllByRole('listitem').find((c) => c.querySelector('[data-slide="s2"]'))!;
    expect(within(s2).getByTestId('thumb-title-card').textContent).toBe('Title s2');
  });
});

describe('DiffFilmstrips QA1', () => {
  const many = (n: number) => snap(Array.from({ length: n }, (_, i) => slide(`m${i + 1}`)));
  const side = (n: number, s: Snapshot) => ({ n, snapshot: s, thumbs: {} });

  it('each changed thumb carries a text tag: added, removed, modified, moved from N', () => {
    render(<DiffFilmstrips a={side(1, snaps[1]!)} b={side(3, snaps[3]!)} entries={diffVersions(snaps[1]!, snaps[3]!)} onFocus={vi.fn()} />);
    const tags = screen.getAllByTestId('diff-tag').map((t) => `${t.getAttribute('data-slide')}:${t.textContent}`).sort();
    // s3 was the 3rd slide of v1 and is the 2nd of v3.
    expect(tags).toEqual(['s3:moved from 3', 's2:modified', 's4:removed', 's6:added'].sort());
    for (const t of screen.getAllByTestId('diff-tag')) expect(t.style.fontSize).toBe('12px');
  });

  it('both strips live in one scroller: the wheel and shift+wheel scroll them together sideways', () => {
    render(<DiffFilmstrips a={side(1, many(30))} b={side(2, many(30))} entries={[]} onFocus={vi.fn()} />);
    const scroller = screen.getByTestId('diff-filmstrips');
    expect(screen.getByTestId('row-a').closest('[data-testid="diff-filmstrips"]')).toBe(scroller);
    expect(screen.getByTestId('row-b').closest('[data-testid="diff-filmstrips"]')).toBe(scroller);
    let left = 0;
    Object.defineProperty(scroller, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => void (left = v) });
    Object.defineProperty(scroller, 'scrollWidth', { configurable: true, value: 6000 });
    Object.defineProperty(scroller, 'clientWidth', { configurable: true, value: 900 });
    const wheel = fireEvent.wheel(scroller, { deltaY: 120 });
    expect(wheel).toBe(false); // default prevented: the page does not try to scroll vertically
    expect(left).toBe(120);
    fireEvent.wheel(scroller, { deltaY: 80, shiftKey: true });
    expect(left).toBe(200);
    // A sideways gesture is the browser's own.
    expect(fireEvent.wheel(scroller, { deltaX: 50, deltaY: 2 })).toBe(true);
    expect(left).toBe(200);
  });

  it('the "+N" slot is a button that scrolls the strips on by a page', () => {
    const rect = (left: number, width: number, top = 0, height = 99): DOMRect => ({ left, width, top, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const spyRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-edge-item')) {
        const i = [...this.parentElement!.children].indexOf(this);
        return rect(126 + i * 184, 176);
      }
      if (this.classList.contains('gutter')) return rect(0, 120);
      return rect(0, 900, 0, 300);
    });
    const spyWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    try {
      render(<DiffFilmstrips a={side(1, many(30))} b={side(2, many(30))} entries={[]} onFocus={vi.fn()} />);
      const scroller = screen.getByTestId('diff-filmstrips');
      let left = 0;
      Object.defineProperty(scroller, 'scrollLeft', { configurable: true, get: () => left, set: (v: number) => void (left = v) });
      const more = screen.getAllByRole('button', { name: /^show the next slides/ });
      expect(more).toHaveLength(2);
      fireEvent.click(more[0]!);
      expect(left).toBeGreaterThanOrEqual(184);
      expect(left % 184).toBe(0);
    } finally {
      spyRect.mockRestore();
      spyWidth.mockRestore();
    }
  });
});

describe('VersionLine QA1', () => {
  it('the compared versions carry "from" and "to" tags', () => {
    render(<VersionLine versions={[1, 2, 3].map(version)} current={3} selection={{ a: 1, b: 3 }} onSelect={vi.fn()} />);
    const tag = (n: number) => within(screen.getAllByTestId('version').find((v) => v.getAttribute('data-version') === String(n))!).queryByTestId('version-pick')?.textContent;
    expect([tag(1), tag(2), tag(3)]).toEqual(['from', undefined, 'to']);
  });
});
