// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BusEvent, DeckPayload, LanePreviewPayload } from '../../web/src/api.js';
import type { Change, Lane, Remark, Slide, SlideId } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({
  handlers: [] as Array<(e: unknown) => void>,
  getDeck: vi.fn(),
  getVersions: vi.fn(),
  getLanes: vi.fn(),
  openLane: vi.fn(),
  getLane: vi.fn(),
  getLanePreview: vi.fn(),
  thumbFor: vi.fn(),
  getRemarks: vi.fn(),
  proposeRemark: vi.fn(),
  resolveRemark: vi.fn(),
  getThread: vi.fn(),
  postMessage: vi.fn(),
}));

vi.mock('../../web/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/api.js')>();
  return {
    ...real,
    getDeck: m.getDeck,
    getVersions: m.getVersions,
    getLanes: m.getLanes,
    openLane: m.openLane,
    getLane: m.getLane,
    getLanePreview: m.getLanePreview,
    thumbFor: m.thumbFor,
    getRemarks: m.getRemarks,
    remarkApi: { proposeRemark: m.proposeRemark, resolveRemark: m.resolveRemark },
    threadApi: { getThread: m.getThread, postMessage: m.postMessage },
    laneApi: { acceptChange: vi.fn(), refuseChange: vi.fn(), discardLane: vi.fn() },
    subscribe: (h: (e: unknown) => void) => {
      m.handlers.push(h);
      return () => {
        m.handlers = m.handlers.filter((x) => x !== h);
      };
    },
  };
});

const { Main } = await import('../../web/src/screens/Main.js');

const slide = (id: string, title = `Title ${id}`): Slide => ({ id, title, story: '', notes: '', body: `<p>${title}</p>`, assets: [], kind: 'text' });
const order: SlideId[] = ['s1', 's2', 's3', 's4', 's5'];
const deckV = (version: number, slides: Record<SlideId, Slide>): DeckPayload => ({
  state: { name: 'd', order, version, sessionId: null, model: 'm' },
  brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '' },
  order,
  slides,
});
const mainSlides: Record<SlideId, Slide> = Object.fromEntries(order.map((id) => [id, slide(id)]));

const modify = (id: string, s: SlideId): Change => ({ id, kind: 'modify', slide: s, patch: { title: `New ${s}` }, reason: 'r', status: 'pending' });
const mkLane = (id: string, s: SlideId, createdAt: string): Lane => ({
  id,
  label: `lane ${id}`,
  anchor: { kind: 'slide', slide: s },
  origin: 'user',
  baseVersion: 3,
  changes: [modify(`c_${id}`, s)],
  status: 'open',
  createdAt,
});
const lanes = [mkLane('l1', 's3', '2026-09-30T00:00:00.000Z'), mkLane('l2', 's5', '2026-09-30T00:00:01.000Z')];
const previewOf = (laneId: string, s: SlideId): LanePreviewPayload => ({
  order,
  slides: { ...mainSlides, [s]: slide(s, `New ${s}`) },
  skipped: [],
  thumbs: { [s]: { hash: `h_${laneId}_${s}`, ready: false } },
});

let deck: DeckPayload;
let drafts: Lane[] = [];
/** Calls for the open lanes (the default list), not the draft lookups. */
const openListCalls = (): number => m.getLanes.mock.calls.filter((c) => c[0] === undefined).length;
const hashOf = (id: SlideId): string => `h_${id}_${(deck.slides[id]?.body ?? '').length}`;

const emit = (e: BusEvent) => act(() => m.handlers.forEach((h) => h(e)));
const callsFor = (fn: ReturnType<typeof vi.fn>, arg: string): number => fn.mock.calls.filter((c) => c[0] === arg).length;

beforeEach(() => {
  deck = deckV(3, mainSlides);
  m.handlers = [];
  m.getDeck.mockReset().mockImplementation(async () => deck);
  m.getVersions.mockReset().mockResolvedValue([]);
  drafts = [];
  m.getLanes.mockReset().mockImplementation(async (status?: string) => (status === 'draft' ? drafts : status === undefined ? lanes : []));
  m.openLane.mockReset().mockResolvedValue(undefined);
  m.getLane.mockReset().mockImplementation(async (id: string) => lanes.find((l) => l.id === id));
  m.getLanePreview.mockReset().mockImplementation(async (id: string) => previewOf(id, id === 'l1' ? 's3' : 's5'));
  m.thumbFor.mockReset().mockImplementation(async (id: SlideId) => ({ hash: hashOf(id), ready: true }));
  m.getRemarks.mockReset().mockResolvedValue([]);
  m.proposeRemark.mockReset().mockResolvedValue(undefined);
  m.resolveRemark.mockReset().mockResolvedValue(undefined);
  m.getThread.mockReset().mockResolvedValue([]);
  m.postMessage.mockReset().mockResolvedValue(undefined);
});
afterEach(() => cleanup());

const mounted = async () => {
  render(<Main />);
  await waitFor(() => m.thumbFor.mock.calls.length === order.length);
  await waitFor(() => callsFor(m.getLanePreview, 'l1') === 1 && callsFor(m.getLanePreview, 'l2') === 1);
  await waitFor(() => screen.getAllByTestId('lane-row').length === 2);
};

const remark = (id: string, over: Partial<Remark>): Remark => ({
  id,
  anchor: { kind: 'arc' },
  text: `text ${id}`,
  origin: 'check:render',
  severity: 'warn',
  status: 'open',
  laneId: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  ...over,
});
const warnBadge = (): string | null => screen.queryByTestId('warn-badge')?.textContent ?? null;

const laneCell = (laneId: string, slideId: SlideId): HTMLElement => {
  const row = screen.getAllByTestId('lane-row').find((r) => r.getAttribute('data-lane') === laneId)!;
  return within(row).getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === slideId)!;
};

describe('Main', () => {
  it('after a deck.changed that modifies one slide, re-requests only that slide thumb; the others keep their URL', async () => {
    await mounted();
    m.thumbFor.mockClear();
    deck = deckV(4, { ...mainSlides, s3: slide('s3', 'A much longer title for s3') });
    emit({ type: 'deck.changed', version: 4 });
    await waitFor(() => document.querySelector(`img[src="/api/thumbs/${hashOf('s3')}.png"]`));
    expect(m.thumbFor.mock.calls).toEqual([['s3']]);
    expect(document.querySelector(`img[src="/api/thumbs/${hashOf('s1')}.png"]`)).not.toBeNull();
  });

  it('a lane.updated burst fetches that lane once (lane + preview) and nothing for the others', async () => {
    await mounted();
    const lanesBefore = openListCalls();
    emit({ type: 'lane.updated', laneId: 'l1' });
    emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => callsFor(m.getLanePreview, 'l1') === 2);
    // A later event for l2 flushes after any leftover l1 work would have.
    emit({ type: 'lane.updated', laneId: 'l2' });
    await waitFor(() => callsFor(m.getLanePreview, 'l2') === 2);
    expect(callsFor(m.getLanePreview, 'l1')).toBe(2);
    expect(callsFor(m.getLane, 'l1')).toBe(1);
    expect(openListCalls()).toBe(lanesBefore);
  });

  it('lane.closed drops the lane without refetching anything', async () => {
    await mounted();
    const previewsBefore = m.getLanePreview.mock.calls.length;
    emit({ type: 'lane.closed', laneId: 'l1' });
    await waitFor(() => screen.getAllByTestId('lane-row').length === 1);
    expect(screen.getByTestId('lane-row').getAttribute('data-lane')).toBe('l2');
    expect(m.getLanePreview.mock.calls.length).toBe(previewsBefore);
  });

  it('resyncs deck, lanes and thread when the socket opens a second time, not on the first open', async () => {
    await mounted();
    await waitFor(() => m.getThread.mock.calls.length >= 1);
    emit({ type: 'hello', version: null });
    // The thread reloads on any hello; wait for that as the marker the first hello was processed.
    await waitFor(() => m.getThread.mock.calls.length === 2);
    emit({ type: 'hello', version: 3 });
    emit({ type: 'lane.updated', laneId: 'l2' });
    await waitFor(() => callsFor(m.getLanePreview, 'l2') === 2);
    expect(m.getDeck.mock.calls.length).toBe(1);
    expect(openListCalls()).toBe(1);

    emit({ type: 'hello', version: null });
    await waitFor(() => m.getDeck.mock.calls.length === 2 && openListCalls() === 2);
    await waitFor(() => m.getThread.mock.calls.length === 4);
  });

  it('resyncs when the server hello reports another version than the one shown', async () => {
    await mounted();
    emit({ type: 'hello', version: 9 });
    await waitFor(() => m.getDeck.mock.calls.length === 2 && openListCalls() === 2);
  });

  it('thumb.failed with a lane preview hash marks that lane cell, not the main slide, and a click retries the preview', async () => {
    await mounted();
    emit({ type: 'thumb.failed', hash: 'h_l1_s3', slideId: 's3', message: 'boom' });
    await waitFor(() => laneCell('l1', 's3').getAttribute('data-thumb-failed') === 'true');
    expect(laneCell('l2', 's5').getAttribute('data-thumb-failed')).toBeNull();
    // main s3 keeps its thumbnail
    expect(document.querySelector(`img[src="/api/thumbs/${hashOf('s3')}.png"]`)).not.toBeNull();
    fireEvent.click(within(laneCell('l1', 's3')).getByTestId('thumb'));
    await waitFor(() => callsFor(m.getLanePreview, 'l1') === 2);
    await waitFor(() => laneCell('l1', 's3').getAttribute('data-thumb-failed') === null);
  });
});

describe('Main load failures', () => {
  const EMPTY = /No open lanes/;

  it('a failed lanes fetch shows an error line instead of the empty state, and Retry fetches the lanes again', async () => {
    m.getLanes.mockImplementation(async (status?: string) => {
      if (status === undefined) throw new Error('GET /api/lanes failed: 500 boom');
      return [];
    });
    render(<Main />);
    const line = await waitFor(() => screen.queryByText(/Lanes: GET \/api\/lanes failed: 500 boom/));
    expect(screen.queryByText(EMPTY)).toBeNull();
    const before = openListCalls();
    m.getLanes.mockImplementation(async (status?: string) => (status === undefined ? lanes : []));
    fireEvent.click(within(line.parentElement!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => screen.queryAllByTestId('lane-row').length === 2);
    expect(openListCalls()).toBe(before + 1);
    expect(screen.queryByText(/Lanes:/)).toBeNull();
  });

  it('a failed remarks fetch shows its error line with a Retry that reloads deck, lanes and remarks', async () => {
    m.getRemarks.mockRejectedValue(new Error('GET /api/remarks failed: 500 nope'));
    render(<Main />);
    const line = await waitFor(() => screen.queryByText(/Remarks: GET \/api\/remarks failed: 500 nope/));
    const calls = { deck: m.getDeck.mock.calls.length, lanes: openListCalls(), remarks: m.getRemarks.mock.calls.length };
    m.getRemarks.mockResolvedValue([]);
    fireEvent.click(within(line.parentElement!).getByRole('button', { name: 'Retry' }));
    await waitFor(() => screen.queryByText(/Remarks:/) === null);
    expect(m.getDeck.mock.calls.length).toBe(calls.deck + 1);
    expect(openListCalls()).toBe(calls.lanes + 1);
    expect(m.getRemarks.mock.calls.length).toBe(calls.remarks + 1);
  });

  it('Retry after a failed deck load reloads deck, lanes and remarks', async () => {
    m.getDeck.mockRejectedValueOnce(new Error('Failed to fetch'));
    render(<Main />);
    await waitFor(() => screen.queryByText('Could not load the deck.'));
    const lanesBefore = openListCalls();
    const remarksBefore = m.getRemarks.mock.calls.length;
    fireEvent.click(screen.getByRole('button', { name: 'Retry' }));
    await waitFor(() => screen.queryAllByTestId('lane-row').length === 2);
    expect(m.getDeck.mock.calls.length).toBe(2);
    expect(openListCalls()).toBe(lanesBefore + 1);
    expect(m.getRemarks.mock.calls.length).toBe(remarksBefore + 1);
  });
});

describe('Main lane from history', () => {
  afterEach(() => {
    history.replaceState(null, '', '/');
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('with #lane=<id>, scrolls that lane row into view once it is shown, then drops the hash', async () => {
    history.replaceState(null, '', '/#lane=l2');
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<Main />);
    await waitFor(() => screen.queryAllByTestId('lane-row').length === 2);
    await waitFor(() => scrolled.mock.calls.length > 0);
    const target = scrolled.mock.contexts.find((el) => el instanceof HTMLElement && el.getAttribute('data-testid') === 'lane-row') as HTMLElement;
    expect(target.getAttribute('data-lane')).toBe('l2');
    expect(target.id).toBe('lane-row-l2');
    expect(location.hash).toBe('');
  });
});

describe('Main remarks', () => {
  it('an open slide remark sits under its column, a range remark spans its columns; resolved ones are gone after remarks.changed', async () => {
    m.getRemarks.mockResolvedValue([
      remark('r_slide', { anchor: { kind: 'slide', slide: 's2' } }),
      remark('r_range', { anchor: { kind: 'range', from: 's3', to: 's5' }, severity: 'info' }),
      remark('r_done', { anchor: { kind: 'slide', slide: 's1' }, status: 'resolved' }),
    ]);
    await mounted();
    await waitFor(() => screen.queryAllByTestId('post-it').length === 2);
    const slot = (id: string) => screen.getAllByTestId('post-it-slot').find((s) => within(s).getByTestId('post-it').getAttribute('data-remark') === id)!;
    expect(slot('r_slide').style.gridColumn).toBe('2');
    expect(slot('r_range').style.gridColumn).toBe('3 / span 3');
    expect(warnBadge()).toBe(' · 1');

    m.getRemarks.mockResolvedValue([remark('r_slide', { anchor: { kind: 'slide', slide: 's2' }, status: 'resolved' })]);
    emit({ type: 'remarks.changed' });
    await waitFor(() => screen.queryByTestId('post-its') === null);
    expect(warnBadge()).toBeNull();
  });

  it('a lane-scoped remark shows under that lane cell, not under main, and does not count in the warn badge', async () => {
    m.getRemarks.mockResolvedValue([remark('r_lane', { anchor: { kind: 'slide', slide: 's3' }, sourceLaneId: 'l1' })]);
    await mounted();
    await waitFor(() => within(laneCell('l1', 's3')).queryAllByTestId('post-it').length === 1);
    expect(within(laneCell('l1', 's3')).getByTestId('post-it').getAttribute('data-remark')).toBe('r_lane');
    expect(screen.queryByTestId('post-its')).toBeNull();
    expect(screen.getAllByTestId('post-it')).toHaveLength(1);
    expect(within(laneCell('l2', 's5')).queryAllByTestId('post-it')).toHaveLength(0);
    expect(warnBadge()).toBeNull();

    fireEvent.click(within(laneCell('l1', 's3')).getByRole('button', { name: 'resolve' }));
    expect(m.resolveRemark).toHaveBeenCalledWith('r_lane');
  });
});

describe('Main draft lanes', () => {
  const draft: Lane = { ...mkLane('l3', 's4', '2026-09-30T00:00:02.000Z'), status: 'draft', origin: 'check:render' };

  it('draft lanes are not rendered; a post-it linked to one offers "open lane", and the lane row appears after lane.updated', async () => {
    drafts = [draft];
    m.getRemarks.mockResolvedValue([remark('r_d', { anchor: { kind: 'slide', slide: 's4' }, laneId: 'l3' })]);
    m.getLane.mockImplementation(async (id: string) => (id === 'l3' ? draft : lanes.find((l) => l.id === id)));
    await mounted();
    expect(m.getLanes).toHaveBeenCalledWith('draft');
    const postIt = await waitFor(() => screen.queryAllByTestId('post-it').find((p) => within(p).queryByTestId('draft-ready')));
    expect(within(postIt).getByTestId('draft-ready').textContent).toBe('draft ready');
    expect(within(postIt).queryByRole('button', { name: 'propose' })).toBeNull();
    expect(screen.getAllByTestId('lane-row').map((r) => r.getAttribute('data-lane'))).toEqual(['l1', 'l2']);

    // A draft announced live stays off main too.
    emit({ type: 'lane.updated', laneId: 'l3' });
    await waitFor(() => callsFor(m.getLane, 'l3') === 1);
    await waitFor(() => screen.queryAllByTestId('post-it').some((p) => within(p).queryByRole('button', { name: 'open lane' })));
    expect(screen.getAllByTestId('lane-row')).toHaveLength(2);

    fireEvent.click(within(screen.getAllByTestId('post-it')[0]!).getByRole('button', { name: 'open lane' }));
    expect(m.openLane).toHaveBeenCalledWith('l3');
    m.getLane.mockImplementation(async (id: string) => (id === 'l3' ? { ...draft, status: 'open' } : lanes.find((l) => l.id === id)));
    emit({ type: 'lane.updated', laneId: 'l3' });
    await waitFor(() => screen.getAllByTestId('lane-row').length === 3);
    expect(screen.getAllByTestId('lane-row').map((r) => r.getAttribute('data-lane'))).toEqual(['l1', 'l2', 'l3']);
    await waitFor(() => screen.queryAllByTestId('draft-ready').length === 0);
  });
});

describe('Main propose feedback', () => {
  const note = () => screen.queryByTestId('propose-note');

  it('propose leaves a line in the thread panel that turns into a link once a lane linked to the remark arrives', async () => {
    m.getRemarks.mockResolvedValue([remark('r_p', { anchor: { kind: 'slide', slide: 's2' } })]);
    await mounted();
    const postIt = await waitFor(() => screen.queryByTestId('post-it'));
    fireEvent.click(within(postIt).getByRole('button', { name: 'propose' }));
    expect(m.proposeRemark).toHaveBeenCalledWith('r_p');
    await waitFor(() => note());
    expect(note()!.textContent).toBe('asked the co-author for a lane on slide 2…');
    expect(within(screen.getByTestId('thread-panel')).getByTestId('propose-note')).toBe(note());
    expect(note()!.querySelector('a')).toBeNull();

    // An unrelated lane event: still waiting.
    emit({ type: 'lane.updated', laneId: 'l2' });
    await waitFor(() => callsFor(m.getLanePreview, 'l2') === 2);
    expect(note()!.querySelector('a')).toBeNull();

    const proposed: Lane = { ...mkLane('l4', 's2', '2026-09-30T00:00:03.000Z'), changes: [{ ...modify('c_first', 's2'), status: 'refused' }, modify('c_l4', 's2')] };
    m.getLane.mockImplementation(async (id: string) => (id === 'l4' ? proposed : lanes.find((l) => l.id === id)));
    m.getRemarks.mockResolvedValue([remark('r_p', { anchor: { kind: 'slide', slide: 's2' }, laneId: 'l4' })]);
    emit({ type: 'lane.created', laneId: 'l4' });
    const link = await waitFor(() => note()?.querySelector('a'));
    expect(link.getAttribute('href')).toBe('/lane/l4/change/c_l4');
  });
});

describe('subscribe', () => {
  class FakeWs {
    static all: FakeWs[] = [];
    onopen: (() => void) | null = null;
    onclose: (() => void) | null = null;
    onmessage: ((m: MessageEvent) => void) | null = null;
    onerror: (() => void) | null = null;
    constructor(public url: string) {
      FakeWs.all.push(this);
    }
    close(): void {
      this.onclose?.();
    }
  }

  it('delivers a synthetic hello on every (re)open', async () => {
    const real = await vi.importActual<typeof import('../../web/src/api.js')>('../../web/src/api.js');
    vi.stubGlobal('WebSocket', FakeWs);
    try {
      const seen: BusEvent[] = [];
      const off = real.subscribe((e) => seen.push(e));
      FakeWs.all[0]!.onopen?.();
      expect(seen).toEqual([{ type: 'hello', version: null }]);
      FakeWs.all[0]!.onclose?.();
      await waitFor(() => FakeWs.all.length === 2);
      FakeWs.all[1]!.onopen?.();
      expect(seen).toEqual([{ type: 'hello', version: null }, { type: 'hello', version: null }]);
      off();
    } finally {
      vi.unstubAllGlobals();
    }
  });
});
