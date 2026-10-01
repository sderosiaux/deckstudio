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
const { laneApi } = await import('../../web/src/api.js');

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
  sessionStorage.clear();
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

const mainThumb = (id: SlideId): HTMLElement => screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === id)!;
const laneRow = (laneId: string): HTMLElement => screen.getAllByTestId('lane-row').find((r) => r.getAttribute('data-lane') === laneId)!;
const laneOrder = (): string[] => screen.getAllByTestId('lane-row').map((r) => r.getAttribute('data-lane')!);

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
      fireEvent.keyDown(within(screen.getByTestId('selection-panel')).getByLabelText('message'), { key: 'e' });
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
      const edit = within(within(screen.getByTestId('selection-panel')).getByTestId('context-chip')).getByRole('link', { name: 'edit' });
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
  it('open remarks are dots on their slides, not cards on the canvas; resolved ones are gone after remarks.changed', async () => {
    m.getRemarks.mockResolvedValue([
      remark('r_slide', { anchor: { kind: 'slide', slide: 's2' } }),
      remark('r_range', { anchor: { kind: 'range', from: 's3', to: 's5' }, severity: 'info' }),
      remark('r_done', { anchor: { kind: 'slide', slide: 's1' }, status: 'resolved' }),
    ]);
    await mounted();
    await waitFor(() => remarkCount() === '2 open remarks');
    const dot = (id: SlideId) => within(mainThumb(id)).queryByTestId('remark-dot');
    expect(dot('s2')!.textContent).toBe('1');
    expect(['s3', 's4', 's5'].map((id) => dot(id)?.getAttribute('data-severity'))).toEqual(['info', 'info', 'info']);
    expect(dot('s1')).toBeNull();
    expect(screen.queryAllByTestId('post-it')).toHaveLength(0);
    expect(screen.queryByTestId('remarks-more')).toBeNull();

    m.getRemarks.mockResolvedValue([remark('r_slide', { anchor: { kind: 'slide', slide: 's2' }, status: 'resolved' })]);
    emit({ type: 'remarks.changed' });
    await waitFor(() => screen.queryAllByTestId('remark-dot').length === 0);
    expect(remarkCount()).toBeNull();
  });

  it('a lane-scoped remark is counted in its lane gutter and listed there on demand, not under main nor in the header', async () => {
    m.getRemarks.mockResolvedValue([remark('r_lane', { anchor: { kind: 'slide', slide: 's3' }, sourceLaneId: 'l1' })]);
    await mounted();
    const toggle = await waitFor(() => within(laneRow('l1')).queryByRole('button', { name: '1 check remark' }));
    expect(screen.queryAllByTestId('post-it')).toHaveLength(0);
    expect(within(laneRow('l2')).queryByRole('button', { name: /check remark/ })).toBeNull();
    expect(screen.queryAllByTestId('remark-dot')).toHaveLength(0);
    expect(remarkCount()).toBeNull();
    fireEvent.click(toggle);
    fireEvent.click(within(laneRow('l1')).getByRole('button', { name: 'resolve' }));
    expect(m.resolveRemark).toHaveBeenCalledWith('r_lane');
  });
});

describe('Main draft lanes', () => {
  const draft: Lane = { ...mkLane('l3', 's4', '2026-09-30T00:00:02.000Z'), status: 'draft', origin: 'check:render' };

  it('draft lanes are not rendered; the remark in the panel offers "open lane", and the lane row appears first, flashed', async () => {
    drafts = [draft];
    m.getRemarks.mockResolvedValue([remark('r_d', { anchor: { kind: 'slide', slide: 's4' }, laneId: 'l3' })]);
    m.getLane.mockImplementation(async (id: string) => (id === 'l3' ? draft : lanes.find((l) => l.id === id)));
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      await mounted();
      expect(m.getLanes).toHaveBeenCalledWith('draft');
      fireEvent.click(mainThumb('s4'));
      const postIt = await waitFor(() => screen.queryAllByTestId('post-it').find((p) => within(p).queryByTestId('draft-ready')));
      expect(within(postIt).getByTestId('draft-ready').textContent).toBe('draft ready');
      expect(within(postIt).queryByRole('button', { name: 'propose' })).toBeNull();
      expect(laneOrder()).toEqual(['l2', 'l1']);

      // A draft announced live stays off main too.
      emit({ type: 'lane.updated', laneId: 'l3' });
      await waitFor(() => callsFor(m.getLane, 'l3') === 1);
      expect(screen.getAllByTestId('lane-row')).toHaveLength(2);

      fireEvent.click(within(screen.getAllByTestId('post-it')[0]!).getByRole('button', { name: 'open lane' }));
      expect(m.openLane).toHaveBeenCalledWith('l3');
      m.getLane.mockImplementation(async (id: string) => (id === 'l3' ? { ...draft, status: 'open' } : lanes.find((l) => l.id === id)));
      emit({ type: 'lane.updated', laneId: 'l3' });
      await waitFor(() => screen.getAllByTestId('lane-row').length === 3);
      expect(laneOrder()).toEqual(['l3', 'l2', 'l1']);
      await waitFor(() => laneRow('l3').getAttribute('data-flash') === 'true');
      // The panel stays where the creator works; the remark card links to the row ("lane opened").
      expect(scrolled.mock.contexts.some((el) => (el as HTMLElement).id === 'lane-row-l3')).toBe(false);
      await waitFor(() => screen.queryAllByTestId('draft-ready').length === 0);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });
});

describe('Main one proposal, one place', () => {
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('lane rows list the newest first', async () => {
    await mounted();
    expect(laneOrder()).toEqual(['l2', 'l1']);
  });

  it('a lane revised by a request from the panel moves first and flashes, without scrolling the canvas away from the panel; a rebase afterwards does not', async () => {
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await mounted();
    fireEvent.click(mainThumb('s3'));
    const p = within(screen.getByTestId('selection-panel'));
    const input = p.getByLabelText('message');
    fireEvent.change(input, { target: { value: 'shorter title' } });
    fireEvent.click(p.getByRole('button', { name: 'Send' }));
    expect(m.postMessage).toHaveBeenCalledWith('slide:s3', 'shorter title', { kind: 'slide', slide: 's3' });
    emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => laneOrder()[0] === 'l1');
    await waitFor(() => laneRow('l1').getAttribute('data-flash') === 'true');
    // The answer lands in the panel: the lane row below is a mirror and does not steal the scroll.
    expect(scrolled.mock.contexts.some((el) => (el as HTMLElement).id === 'lane-row-l1')).toBe(false);
    expect(laneRow('l2').getAttribute('data-flash')).toBeNull();
    // The flash ends with its animation.
    fireEvent(laneRow('l1'), new Event('animationend'));
    await waitFor(() => laneRow('l1').getAttribute('data-flash') === null);

    emit({ type: 'assistant.done', thread: 'slide:s3', messageId: 'm1' });
    emit({ type: 'lane.updated', laneId: 'l2' });
    await waitFor(() => callsFor(m.getLanePreview, 'l2') === 2);
    expect(laneOrder()).toEqual(['l1', 'l2']);
    expect(laneRow('l2').getAttribute('data-flash')).toBeNull();
  });
});

describe('Main propose feedback', () => {
  const note = () => screen.queryByTestId('propose-note');

  it('propose leaves a line in the selection panel that turns into a link once a lane linked to the remark arrives', async () => {
    m.getRemarks.mockResolvedValue([remark('r_p', { anchor: { kind: 'slide', slide: 's2' } })]);
    sessionStorage.setItem('deckstudio.wholeDeck', 'open');
    await mounted();
    fireEvent.click(mainThumb('s2'));
    const postIt = await waitFor(() => screen.queryByTestId('post-it'));
    fireEvent.click(within(postIt).getByRole('button', { name: 'propose' }));
    expect(m.proposeRemark).toHaveBeenCalledWith('r_p');
    await waitFor(() => note());
    expect(note()!.textContent).toBe('asked the co-author for a lane on slide 2…');
    // Where the creator asked: in the panel, not in the whole-deck bar (open beside it).
    expect(within(screen.getByTestId('selection-panel')).getByTestId('propose-note')).toBe(note());
    expect(within(screen.getByTestId('thread-panel')).queryByTestId('propose-note')).toBeNull();
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
  const pressed = (): string[] =>
    screen
      .getAllByTestId('thumb')
      .filter((t) => t.closest('[data-strip="main"]') && t.getAttribute('aria-pressed') === 'true')
      .map((t) => t.getAttribute('data-slide')!);
  const postIt = (id: string): HTMLElement => screen.getAllByTestId('post-it').find((p) => p.getAttribute('data-remark') === id)!;
  afterEach(() => {
    delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
  });

  it('action clicks on a remark card in the panel (resolve, propose, its severity label, its text) leave the selection as it was', async () => {
    m.getRemarks.mockResolvedValue([remark('r_s2', { anchor: { kind: 'range', from: 's2', to: 's4' }, severity: 'info' })]);
    await mounted();
    fireEvent.click(mainThumb('s4'));
    await waitFor(() => screen.queryAllByTestId('post-it').length === 1);
    expect(pressed()).toEqual(['s4']);
    const tag = within(postIt('r_s2')).getByTestId('severity-tag');
    expect(tag.className).not.toContain('tag');
    fireEvent.click(tag);
    fireEvent.click(within(postIt('r_s2')).getByTestId('remark-text'));
    expect(pressed()).toEqual(['s4']);
    fireEvent.click(within(postIt('r_s2')).getByRole('button', { name: 'propose' }));
    expect(m.proposeRemark).toHaveBeenCalledWith('r_s2');
    expect(pressed()).toEqual(['s4']);
    const resolve = within(postIt('r_s2')).getByRole('button', { name: 'resolve' }) as HTMLButtonElement;
    await waitFor(() => !resolve.disabled);
    fireEvent.click(resolve);
    expect(m.resolveRemark).toHaveBeenCalledWith('r_s2');
    expect(pressed()).toEqual(['s4']);
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
    const input = within(screen.getByTestId('selection-panel')).getByLabelText('message');
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
    expect(screen.getAllByTestId('lane-name').map((n) => n.textContent)).toEqual(['lane l2', 'lane l1']);
  });

  it('a remark whose lane is open on main says "lane opened: <title>" as a link that scrolls to that row', async () => {
    m.getRemarks.mockResolvedValue([remark('r_o', { anchor: { kind: 'slide', slide: 's5' }, laneId: 'l2' })]);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    await mounted();
    fireEvent.click(mainThumb('s5'));
    const link = await waitFor(() => screen.queryByTestId('lane-opened'));
    expect(link.textContent).toBe('lane opened: lane l2');
    scrolled.mockClear();
    fireEvent.click(link);
    expect((scrolled.mock.contexts[0] as HTMLElement).id).toBe('lane-row-l2');
    expect(pressed()).toEqual(['s5']);
  });

  it('the header counts open main remarks with a label', async () => {
    m.getRemarks.mockResolvedValue([
      remark('r_a', { anchor: { kind: 'slide', slide: 's1' } }),
      remark('r_b', { anchor: { kind: 'slide', slide: 's2' }, severity: 'info' }),
      remark('r_c', { anchor: { kind: 'slide', slide: 's5' }, severity: 'info' }),
    ]);
    await mounted();
    await waitFor(() => screen.queryByTestId('remark-count'));
    expect(screen.getByTestId('remark-count').textContent).toBe('3 open remarks');
  });
});

describe('Main variants', () => {
  const titleTo = (id: string, title: string, variantOf: string[]) => ({ id, kind: 'modify' as const, slide: 's2', patch: { title }, reason: `title ${title}`, status: 'pending' as const, variantOf });
  const lA = { ...mkLane('lA', 's2', '2026-09-30T21:41:00.000Z'), label: 'Four-word hook title', changes: [titleTo('cA', 'One home already exists', ['lB'])] };
  const lB = { ...mkLane('lB', 's2', '2026-09-30T21:52:00.000Z'), label: 'Shorter hook title', changes: [titleTo('cB', 'One answer already exists', ['lA'])] };
  const time = (iso: string) => new Date(iso).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });

  it('lanes competing on one slide field share one row, "slide 2, title: 2 variants", each with its text, time, accept and refuse; after an accept the others go', async () => {
    let all: Lane[] = [...lanes, lA, lB];
    m.getLanes.mockImplementation(async (status?: string) => (status === undefined ? all : []));
    m.getLane.mockImplementation(async (id: string) => all.find((l) => l.id === id));
    m.getLanePreview.mockImplementation(async (id: string) => previewOf(id, id === 'l1' ? 's3' : id === 'l2' ? 's5' : 's2'));
    render(<Main />);
    const row = await waitFor(() => screen.queryByTestId('variant-row'));
    expect(within(row).getByTestId('variant-label').textContent).toBe('slide 2, title: 2 variants');
    // The competing lanes have no rows of their own.
    expect(laneOrder()).toEqual(['l2', 'l1']);
    const cells = await waitFor(() => (within(row).queryAllByTestId('variant-cell').length === 2 ? within(row).getAllByTestId('variant-cell') : null));
    expect(cells.map((c) => c.getAttribute('data-lane'))).toEqual(['lA', 'lB']);
    expect(cells.map((c) => c.getAttribute('data-col'))).toEqual(['1', '1']);
    expect(within(cells[0]!).getByTestId('variant-text').textContent).toBe('One home already exists');
    expect(within(cells[1]!).getByTestId('variant-text').textContent).toBe('One answer already exists');
    expect(within(cells[0]!).getByTestId('variant-time').textContent).toBe(time(lA.createdAt));
    expect(within(cells[0]!).getByText('Four-word hook title')).toBeTruthy();
    fireEvent.click(within(cells[0]!).getByRole('button', { name: /^accept: / }));
    expect(laneApi.acceptChange).toHaveBeenCalledWith('lA', 'cA');
    within(cells[1]!).getByRole('button', { name: /^refuse: / });

    // The server takes A into main and orphans B: both leave main.
    all = [...lanes];
    m.getLane.mockImplementation(async (id: string) => (id === 'lB' ? { ...lB, changes: [{ ...lB.changes[0]!, status: 'orphan', variantOf: [] }] } : all.find((l) => l.id === id)));
    emit({ type: 'lane.closed', laneId: 'lA' });
    emit({ type: 'lane.updated', laneId: 'lB' });
    await waitFor(() => screen.queryByTestId('variant-row') === null);
    expect(laneOrder()).toEqual(['l2', 'l1']);
  });
});
