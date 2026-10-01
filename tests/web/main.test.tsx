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
  openPlayer: vi.fn(),
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
    openPlayer: m.openPlayer,
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
  brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '', design: { rules: '', imageStyle: '' } },
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
  m.openPlayer.mockReset();
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
const remarkCount = (): string | null => screen.queryByTestId('remark-count')?.textContent ?? null;

const laneCell = (laneId: string, slideId: SlideId): HTMLElement => {
  const row = screen.getAllByTestId('lane-row').find((r) => r.getAttribute('data-lane') === laneId)!;
  return within(row).getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === slideId)!;
};

describe('Main', () => {
  it('the Present button opens the player on the selected slide, plain when nothing is selected', async () => {
    await mounted();
    const present = () => screen.getByText('Present').closest('a')!;
    expect(present().getAttribute('href')).toBe('/api/present');
    const thumb = screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === 's3');
    fireEvent.click(thumb ?? screen.getAllByTestId('thumb')[2]!);
    await waitFor(() => present().getAttribute('href') === '/api/present#3');
  });

  it('double-clicking a main slide opens the player on that slide', async () => {
    await mounted();
    const thumb = screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === 's3')!;
    fireEvent.doubleClick(thumb);
    expect(m.openPlayer.mock.calls).toEqual([['/api/present#3']]);
  });

  describe('opening a slide to edit it', () => {
    const mainThumb = (id: SlideId): HTMLElement => screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === id)!;
    afterEach(() => history.replaceState(null, '', '/'));

    it('Enter or e with one slide selected opens /slide/<id>; nothing selected, a range or a text field does nothing', async () => {
      await mounted();
      fireEvent.keyDown(document.body, { key: 'Enter' });
      expect(location.pathname).toBe('/');
      fireEvent.click(mainThumb('s2'));
      fireEvent.click(mainThumb('s4'), { shiftKey: true });
      fireEvent.keyDown(document.body, { key: 'e' });
      expect(location.pathname).toBe('/');
      fireEvent.click(mainThumb('s2'));
      fireEvent.keyDown(screen.getByLabelText('message'), { key: 'e' });
      expect(location.pathname).toBe('/');
      fireEvent.keyDown(document.body, { key: 'Enter' });
      expect(location.pathname).toBe('/slide/s2');
      history.replaceState(null, '', '/');
      fireEvent.keyDown(document.body, { key: 'e' });
      expect(location.pathname).toBe('/slide/s2');
    });

    it('the selected slide title is a link to its edit screen; the thread chip has an edit link too', async () => {
      await mounted();
      expect(screen.queryByTestId('thumb-title-link')).toBeNull();
      expect(within(screen.getByTestId('context-chip')).queryByRole('link', { name: 'edit' })).toBeNull();
      fireEvent.click(mainThumb('s3'));
      const title = await waitFor(() => screen.queryByTestId('thumb-title-link'));
      expect(title.textContent).toBe('Title s3');
      expect(title.getAttribute('href')).toBe('/slide/s3');
      const edit = within(screen.getByTestId('context-chip')).getByRole('link', { name: 'edit' });
      expect(edit.getAttribute('href')).toBe('/slide/s3');
      fireEvent.click(title);
      expect(location.pathname).toBe('/slide/s3');
      history.replaceState(null, '', '/');
      fireEvent.click(edit);
      expect(location.pathname).toBe('/slide/s3');
      // The double-click still presents.
      fireEvent.doubleClick(mainThumb('s3'));
      expect(m.openPlayer.mock.calls).toEqual([['/api/present#3']]);
    });
  });

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
    // One row of cards: the two overlap (a card is at least three columns wide), so the second waits behind a count.
    await waitFor(() => screen.queryAllByTestId('post-it').length === 1);
    const slot = (id: string) => screen.getAllByTestId('post-it-slot').find((s) => within(s).getByTestId('post-it').getAttribute('data-remark') === id);
    const cols = (id: string) => `${slot(id)!.getAttribute('data-col')}+${slot(id)!.getAttribute('data-span')}`;
    expect(cols('r_slide')).toBe('1+1');
    expect(slot('r_range')).toBeUndefined();
    expect(screen.getByTestId('remarks-more').textContent).toContain('1 more remark');
    expect(remarkCount()).toBe('2 open remarks');
    // Selecting a slide of the range puts its remark first.
    fireEvent.click(screen.getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === 's4')!);
    await waitFor(() => slot('r_range') !== undefined);
    expect(cols('r_range')).toBe('2+3');
    expect(within(slot('r_range')!).getByTestId('post-it').getAttribute('data-selected')).toBe('true');
    expect(slot('r_slide')).toBeUndefined();

    m.getRemarks.mockResolvedValue([remark('r_slide', { anchor: { kind: 'slide', slide: 's2' }, status: 'resolved' })]);
    emit({ type: 'remarks.changed' });
    await waitFor(() => screen.queryByTestId('post-its') === null);
    expect(remarkCount()).toBeNull();
  });

  it('a lane-scoped remark shows under that lane cell, not under main, and does not count in the header', async () => {
    m.getRemarks.mockResolvedValue([remark('r_lane', { anchor: { kind: 'slide', slide: 's3' }, sourceLaneId: 'l1' })]);
    await mounted();
    const laneRemarks = (laneId: string) => {
      const row = screen.getAllByTestId('lane-row').find((r) => r.getAttribute('data-lane') === laneId)!;
      return within(row).queryAllByTestId('post-it-slot');
    };
    await waitFor(() => laneRemarks('l1').length === 1);
    const [slot] = laneRemarks('l1');
    expect(within(slot!).getByTestId('post-it').getAttribute('data-remark')).toBe('r_lane');
    expect(slot!.getAttribute('data-slide')).toBe('s3');
    expect(screen.queryByTestId('post-its')).toBeNull();
    expect(screen.getAllByTestId('post-it')).toHaveLength(1);
    expect(laneRemarks('l2')).toHaveLength(0);
    expect(remarkCount()).toBeNull();

    fireEvent.click(within(slot!).getByRole('button', { name: 'resolve' }));
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

describe('Main QA1', () => {
  const mainThumb = (id: SlideId): HTMLElement => screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === id)!;
  const pressed = (): string[] =>
    screen
      .getAllByTestId('thumb')
      .filter((t) => t.closest('[data-strip="main"]') && t.getAttribute('aria-pressed') === 'true')
      .map((t) => t.getAttribute('data-slide')!);
  const postIt = (id: string): HTMLElement => screen.getAllByTestId('post-it').find((p) => p.getAttribute('data-remark') === id)!;
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('action clicks on a remark card (resolve, propose, its severity tag) leave the selection as it was', async () => {
    m.getRemarks.mockResolvedValue([remark('r_s2', { anchor: { kind: 'slide', slide: 's2' }, severity: 'info' })]);
    await mounted();
    await waitFor(() => screen.queryAllByTestId('post-it').length === 1);
    fireEvent.click(mainThumb('s4'));
    expect(pressed()).toEqual(['s4']);
    fireEvent.click(within(postIt('r_s2')).getByTestId('severity-tag'));
    expect(pressed()).toEqual(['s4']);
    fireEvent.click(within(postIt('r_s2')).getByRole('button', { name: 'propose' }));
    expect(m.proposeRemark).toHaveBeenCalledWith('r_s2');
    expect(pressed()).toEqual(['s4']);
    const resolve = within(postIt('r_s2')).getByRole('button', { name: 'resolve' }) as HTMLButtonElement;
    await waitFor(() => !resolve.disabled);
    fireEvent.click(resolve);
    expect(m.resolveRemark).toHaveBeenCalledWith('r_s2');
    expect(pressed()).toEqual(['s4']);
    // The card body itself still selects what the remark is about.
    fireEvent.click(within(postIt('r_s2')).getByText('text r_s2'));
    expect(pressed()).toEqual(['s2']);
  });

  it('accept, refuse and discard on a lane row leave the selection as it was', async () => {
    await mounted();
    fireEvent.click(mainThumb('s1'));
    const row = screen.getAllByTestId('lane-row')[0]!;
    for (const b of within(row).getAllByRole('button').filter((x) => /^(accept|refuse)/.test(x.getAttribute('aria-label') ?? '') || x.textContent === 'discard lane')) {
      fireEvent.click(b);
    }
    expect(pressed()).toEqual(['s1']);
  });

  it('a shift-click range rings every slide of the range, not only its last one', async () => {
    await mounted();
    fireEvent.click(mainThumb('s2'));
    fireEvent.click(mainThumb('s4'), { shiftKey: true });
    expect(pressed()).toEqual(['s2', 's3', 's4']);
    expect(screen.getByTestId('range-caption').textContent).toBe('slides 2–4');
  });

  it('Escape clears the selection, but not while a message is being written', async () => {
    await mounted();
    fireEvent.click(mainThumb('s3'));
    const input = screen.getByLabelText('message');
    fireEvent.change(input, { target: { value: 'half written' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(pressed()).toEqual(['s3']);
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(pressed()).toEqual([]);
  });

  it('End and Home scroll the canvas to the end and the start of the strip; shift+wheel scrolls it sideways', async () => {
    await mounted();
    const canvas = screen.getByTestId('canvas');
    Object.defineProperty(canvas, 'scrollWidth', { configurable: true, value: 4000 });
    fireEvent.keyDown(document.body, { key: 'End' });
    expect(canvas.scrollLeft).toBe(4000);
    fireEvent.keyDown(document.body, { key: 'Home' });
    expect(canvas.scrollLeft).toBe(0);
    fireEvent.wheel(canvas, { deltaY: 120, deltaX: 0, shiftKey: true });
    expect(canvas.scrollLeft).toBe(120);
    // A plain vertical wheel is left to the browser.
    fireEvent.wheel(canvas, { deltaY: 120, deltaX: 0 });
    expect(canvas.scrollLeft).toBe(120);
  });

  it('the lane rows scroll inside the canvas; the versions rail sits outside it and the canvas keeps a bottom padding of its height', async () => {
    const third = mkLane('l3', 's1', '2026-09-30T00:00:02.000Z');
    const all = [...lanes, third];
    m.getLanes.mockImplementation(async (status?: string) => (status === undefined ? all : []));
    m.getLane.mockImplementation(async (id: string) => all.find((l) => l.id === id));
    m.getLanePreview.mockImplementation(async (id: string) => previewOf(id, id === 'l1' ? 's3' : id === 'l2' ? 's5' : 's1'));
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'versions-rail' ? 96 : 0;
      },
    });
    try {
      render(<Main />);
      await waitFor(() => screen.queryAllByTestId('lane-row').length === 3);
      const canvas = screen.getByTestId('canvas');
      const rail = screen.getByTestId('versions-rail');
      const last = screen.getAllByTestId('lane-row')[2]!;
      expect(canvas.contains(last)).toBe(true);
      expect(canvas.contains(rail)).toBe(false);
      expect(canvas.style.overflow).toBe('auto');
      await waitFor(() => canvas.style.paddingBottom === '96px');
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
    }
  });

  it('lane rows carry their full title and no letter', async () => {
    await mounted();
    expect(screen.getAllByTestId('lane-name').map((n) => n.textContent)).toEqual(['lane l1', 'lane l2']);
  });

  it('a remark whose lane is open on main says "lane opened: <title>" as a link that scrolls to that row', async () => {
    m.getRemarks.mockResolvedValue([remark('r_o', { anchor: { kind: 'slide', slide: 's5' }, laneId: 'l2' })]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await mounted();
    const link = await waitFor(() => screen.queryByTestId('lane-opened'));
    expect(link.textContent).toBe('lane opened: lane l2');
    fireEvent.click(mainThumb('s1'));
    scrolled.mockClear();
    fireEvent.click(link);
    expect((scrolled.mock.contexts[0] as HTMLElement).id).toBe('lane-row-l2');
    expect(pressed()).toEqual(['s1']);
  });

  it('the header counts open remarks with a label; "N more remarks" counts only the cards not shown', async () => {
    m.getRemarks.mockResolvedValue([
      remark('r_a', { anchor: { kind: 'slide', slide: 's1' } }),
      remark('r_b', { anchor: { kind: 'slide', slide: 's2' }, severity: 'info' }),
      remark('r_c', { anchor: { kind: 'slide', slide: 's5' }, severity: 'info' }),
    ]);
    await mounted();
    await waitFor(() => screen.queryAllByTestId('post-it').length > 0);
    expect(screen.getByTestId('remark-count').textContent).toBe('3 open remarks');
    const shown = screen.getAllByTestId('post-it').length;
    expect(screen.getByTestId('remarks-more').textContent).toBe(`${3 - shown} more ${3 - shown === 1 ? 'remark' : 'remarks'}: select a slide`);
  });
});
