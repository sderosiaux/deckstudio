// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Focus, BAR_HEIGHT } from '../../web/src/screens/Focus.js';
import type { BusEvent, DeckPayload, FocusApi, LanePreviewPayload } from '../../web/src/api.js';
import type { Change, Lane, Slide, SlideId, ThreadMessage, Version } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

/** The window narrower than the two-column breakpoint: matchMedia answers false. */
const narrow = () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
};
const themeCss = (): string => readFileSync(join(process.cwd(), 'web/src/theme.css'), 'utf8');

const slide = (id: string, title = `Title ${id}`): Slide => ({ id, title, story: '', notes: '', body: `<p>${title}</p>`, assets: [], kind: 'text' });
const order: SlideId[] = ['s1', 's2', 's3', 's4', 's5'];
const mainSlides: Record<SlideId, Slide> = Object.fromEntries(order.map((id) => [id, slide(id)]));

const c1: Change = { id: 'c1', kind: 'modify', slide: 's3', patch: { title: 'Sharper s3' }, reason: 'tighter title', status: 'pending' };
const c2: Change = { id: 'c2', kind: 'modify', slide: 's2', patch: { title: 'x' }, reason: 'done already', status: 'accepted' };
const c3: Change = { id: 'c3', kind: 'insert', after: 's2', slide: slide('n1', 'Hook'), reason: 'needs a hook', status: 'pending' };
const c4: Change = { id: 'c4', kind: 'modify', slide: 's5', patch: { title: 'y' }, reason: 'nope', status: 'refused' };
const c5: Change = { id: 'c5', kind: 'remove', slide: 's4', reason: 'redundant', status: 'pending' };

const lane = (changes: Change[] = [c1, c2, c3, c4, c5]): Lane => ({
  id: 'l1',
  label: 'lane B',
  anchor: { kind: 'range', from: 's2', to: 's4' },
  origin: 'user',
  baseVersion: 1,
  changes,
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
});

const deck: DeckPayload = {
  state: { name: 'd', order, version: 3, sessionId: null, model: 'm' },
  brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '', design: { rules: '', imageStyle: '' } },
  order,
  slides: mainSlides,
};

const preview: LanePreviewPayload = {
  order: ['s1', 's2', 'n1', 's3', 's5'],
  slides: { ...mainSlides, s3: slide('s3', 'Sharper s3'), n1: slide('n1', 'Hook') },
  skipped: [],
  thumbs: { n1: { hash: 'hn1', ready: true }, s3: { hash: 'hs3new', ready: true } },
};

const stubApi = (l: Lane = lane()) => {
  const api = {
    getDeck: vi.fn(async () => deck),
    getLane: vi.fn(async () => l),
    getLanePreview: vi.fn(async () => preview),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h${id}`, ready: true })),
    acceptChange: vi.fn(async (): Promise<{ version: Version; lane: Lane }> => ({ version: { n: 4, order, slides: {}, cause: { kind: 'import' }, createdAt: '' }, lane: l })),
    refuseChange: vi.fn(async () => l),
    getThread: vi.fn(async (_key: string): Promise<ThreadMessage[]> => []),
    postMessage: vi.fn(async () => undefined),
  };
  return api satisfies FocusApi;
};

const noEvents = (_h: (e: BusEvent) => void) => () => undefined;
const crumb = () => screen.queryByTestId('focus-crumb')?.textContent ?? '';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
  vi.unstubAllGlobals();
});

/** A subscribe the test can push events through. */
const bus = () => {
  const handlers = new Set<(e: BusEvent) => void>();
  return {
    subscribe: (h: (e: BusEvent) => void) => {
      handlers.add(h);
      return () => {
        handlers.delete(h);
      };
    },
    emit: (e: BusEvent) => act(() => handlers.forEach((h) => h(e))),
  };
};

describe('Focus', () => {
  it('next/previous step through the pending changes only and stop at the ends', async () => {
    const api = stubApi();
    const navigate = vi.fn();
    const prevBtn = () => screen.getByRole('button', { name: 'previous change' }) as HTMLButtonElement;
    const nextBtn = () => screen.getByRole('button', { name: 'next change' }) as HTMLButtonElement;
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    expect(prevBtn().disabled).toBe(true);
    fireEvent.click(nextBtn());
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c3');

    rerender(<Focus laneId="l1" changeId="c3" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 2 of 3'));
    expect(prevBtn().disabled).toBe(false);
    expect(nextBtn().disabled).toBe(false);
    fireEvent.click(nextBtn());
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c5');

    rerender(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 3 of 3'));
    expect(nextBtn().disabled).toBe(true);
    navigate.mockClear();
    fireEvent.click(nextBtn());
    expect(navigate).not.toHaveBeenCalled();
    fireEvent.click(prevBtn());
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c3');
    // never lands on the accepted or refused ones
    expect(navigate.mock.calls.flat()).not.toContain('/lane/l1/change/c2');
    expect(navigate.mock.calls.flat()).not.toContain('/lane/l1/change/c4');
  });

  it('the header shows the full lane title and where the lane comes from', async () => {
    const long = { ...lane(), label: 'Pull the decision-layer detour out of the opening run' };
    render(<Focus laneId="l1" changeId="c1" api={stubApi(long)} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    const title = screen.getByTestId('focus-title');
    expect(title.textContent).toBe('Pull the decision-layer detour out of the opening run');
    expect(title.style.whiteSpace).toBe('normal');
    expect(screen.getByTestId('focus-origin').textContent).toBe('from your request on slides 2–4');

    cleanup();
    render(<Focus laneId="l1" changeId="c1" api={stubApi({ ...long, origin: 'check:arc' })} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-origin'));
    expect(screen.getByTestId('focus-origin').textContent).toBe('unsolicited, from check: arc, on slides 2–4');
  });

  it('shows main vs lane for a modify, with the reason', async () => {
    const api = stubApi();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    const [left, right] = screen.getAllByTestId('slide-preview');
    expect(left!.getAttribute('data-variant')).toBe('main');
    expect(left!.querySelector('img')!.getAttribute('src')).toBe('/api/thumbs/hs3.png');
    expect(right!.getAttribute('data-variant')).toBe('lane');
    expect(right!.querySelector('img')!.getAttribute('src')).toBe('/api/thumbs/hs3new.png');
    expect(screen.getByTestId('focus-reason').textContent).toContain('tighter title');
    expect(api.thumbFor).toHaveBeenCalledWith('s3');
  });

  it('an insert shows a dashed "not in main" card on the left, a remove a "removed" card on the right', async () => {
    const api = stubApi();
    const { rerender } = render(<Focus laneId="l1" changeId="c3" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    let [left, right] = screen.getAllByTestId('slide-preview');
    expect(left!.getAttribute('data-variant')).toBe('missing');
    expect(left!.textContent).toContain('not in main');
    expect(right!.querySelector('img')!.getAttribute('src')).toBe('/api/thumbs/hn1.png');

    rerender(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 3 of 3'));
    [left, right] = screen.getAllByTestId('slide-preview');
    expect(left!.getAttribute('data-variant')).toBe('main');
    expect(right!.getAttribute('data-variant')).toBe('missing');
    expect(right!.textContent).toContain('removed');
  });

  it('accept acknowledges in place and stays put: no timed move, "next change" is the way on', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const after = lane([{ ...c1, status: 'accepted' }, c2, c3, c4, c5]);
    const api = stubApi();
    api.acceptChange.mockResolvedValueOnce({ version: { n: 8, order, slides: {}, cause: { kind: 'accept', laneId: 'l1', changeId: 'c1' }, createdAt: '' }, lane: after });
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={navigate} />);
    await vi.waitFor(() => expect(crumb()).toContain('change 1 of 3'));
    fireEvent.click(screen.getByRole('button', { name: 'accept' }));
    await vi.waitFor(() => expect(screen.queryByTestId('decide-ack')).not.toBeNull());
    expect(api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    expect(api.refuseChange).not.toHaveBeenCalled();
    const ack = screen.getByTestId('decide-ack');
    expect(ack.textContent).toContain('accepted into main as v8');
    expect(screen.queryByTestId('decide-bar')).toBeNull();
    expect(within(ack).getByRole('button', { name: 'next change' }).className).toBe('btn-primary');
    expect(crumb()).toBe('accepted (v8)');
    expect(screen.getAllByTestId('thread-note').map((n) => n.textContent)).toEqual(['accepted into main as v8']);
    // The decided pair stays, named for what it now is.
    const [left, right] = screen.getAllByTestId('slide-preview');
    expect(left!.getAttribute('aria-label')).toBe('before, slide 3');
    expect(right!.getAttribute('aria-label')).toBe('now in main as v8');
    expect(right!.getAttribute('data-variant')).toBe('main');

    act(() => vi.advanceTimersByTime(60_000));
    expect(navigate).not.toHaveBeenCalled();
    expect(screen.getByTestId('decide-ack')).toBeTruthy();
    fireEvent.click(within(screen.getByTestId('decide-ack')).getByRole('button', { name: 'next change' }));
    expect(navigate).toHaveBeenCalledWith('/lane/l1/change/c3');
    expect(navigate).toHaveBeenCalledTimes(1);
  });

  it('refuse acknowledges in place too, and never moves by itself', async () => {
    vi.useFakeTimers({ toFake: ['setTimeout', 'clearTimeout'] });
    const only = lane([c2, c5]);
    const api = stubApi(only);
    api.refuseChange.mockResolvedValueOnce(lane([c2, { ...c5, status: 'refused' }]));
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={navigate} />);
    await vi.waitFor(() => expect(crumb()).toContain('change 1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'refuse' }));
    await vi.waitFor(() => expect(screen.queryByTestId('decide-ack')).not.toBeNull());
    expect(crumb()).toBe('refused');
    act(() => vi.advanceTimersByTime(60_000));
    expect(navigate).not.toHaveBeenCalled();
  });

  it('"next change" on the acknowledgement moves at once', async () => {
    const after = lane([{ ...c1, status: 'refused' }, c2, c3, c4, c5]);
    const api = stubApi();
    api.refuseChange.mockResolvedValueOnce(after);
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    fireEvent.click(screen.getByRole('button', { name: 'refuse' }));
    await waitFor(() => screen.queryByTestId('decide-ack'));
    expect(screen.getByTestId('decide-ack').textContent).toContain('refused');
    fireEvent.click(within(screen.getByTestId('decide-ack')).getByRole('button', { name: 'next change' }));
    expect(navigate).toHaveBeenCalledWith('/lane/l1/change/c3');
  });

  it('refusing the last pending change goes back to that slide', async () => {
    const only = lane([c2, c5]);
    const api = stubApi(only);
    api.refuseChange.mockResolvedValueOnce(lane([c2, { ...c5, status: 'refused' }]));
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'refuse' }));
    await waitFor(() => screen.queryByTestId('decide-ack'));
    expect(api.refuseChange).toHaveBeenCalledWith('l1', 'c5');
    fireEvent.click(within(screen.getByTestId('decide-ack')).getByRole('button', { name: 'back to slide 4' }));
    expect(navigate).toHaveBeenCalledWith('/slide/s4');
  });

  it('a lane revised in place (the current change id is gone) moves to its first pending change, marked revised hh:mm', async () => {
    const api = stubApi();
    const b = bus();
    const navigate = vi.fn();
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={b.subscribe} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    expect(screen.queryByTestId('focus-revised')).toBeNull();
    const n1: Change = { ...c1, id: 'n1', reason: 'tighter title, revised' };
    api.getLane.mockResolvedValue(lane([n1, c3]));
    b.emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(navigate).toHaveBeenCalledWith('/lane/l1/change/n1');
    rerender(<Focus laneId="l1" changeId="n1" api={api} subscribe={b.subscribe} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 2'));
    expect(screen.getByTestId('focus-revised').textContent).toMatch(/^revised \d\d:\d\d$/);
  });

  it('a change revised under the same id gets the revised badge on the header; a decision alone does not', async () => {
    const api = stubApi();
    const b = bus();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={b.subscribe} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    // Another change of the lane decided elsewhere: not a revision of this one.
    api.getLane.mockResolvedValue(lane([c1, c2, { ...c3, status: 'refused' }, c4, c5]));
    b.emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => crumb().includes('change 1 of 2'));
    expect(screen.queryByTestId('focus-revised')).toBeNull();
    api.getLane.mockResolvedValue(lane([{ ...c1, reason: 'tighter title, and the story too', patch: { title: 'Sharper s3', story: 'Kafka Streams' } }, c2, { ...c3, status: 'refused' }, c4, c5]));
    b.emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => screen.queryByTestId('focus-revised'));
    const badge = screen.getByTestId('focus-revised');
    expect(badge.textContent).toMatch(/^revised \d\d:\d\d$/);
    expect(screen.getByTestId('focus-reason').textContent).toContain('and the story too');
  });

  it('labels each card on its own line above an inset slide frame, and keeps the header gutter empty', async () => {
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    for (const card of screen.getAllByTestId('slide-preview')) {
      const frame = within(card).getByTestId('slide-frame');
      expect(frame.contains(card.querySelector('figcaption'))).toBe(false);
    }
    expect(document.querySelector('.screen-header > .gutter')!.textContent).toBe('');
    fireEvent.click(screen.getByTestId('header-main'));
    expect(navigate).toHaveBeenCalledWith('/');
  });

  it('underlines the anchor range in both filmstrips and opens the lane thread', async () => {
    const api = stubApi();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-strip'));
    fireEvent.click(screen.getByTestId('focus-strip'));
    await waitFor(() => screen.queryAllByTestId('range-underline').length === 2);
    const [mainLine, laneLine] = screen.getAllByTestId('range-underline');
    // main: s2..s4 = columns 2..4
    expect(mainLine!.style.gridColumn).toBe('2 / span 3');
    // lane preview: s2, n1, s3 (s4 removed) = columns 2..4
    expect(laneLine!.style.gridColumn).toBe('2 / span 3');
    // Each underline says what it marks, at its left end.
    expect(screen.getAllByTestId('range-label').map((l) => l.textContent)).toEqual(["this lane's slides on main", 'changed in this lane']);
    expect(screen.getByTestId('thread').getAttribute('data-thread')).toBe('lane:l1');
  });

  it('the lane thread is a full-height right column beside the renders, its composer at the bottom, never under the decision bar', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('thread') && screen.queryByTestId('decide-bar'));
    expect(screen.getByTestId('focus-layout').getAttribute('data-columns')).toBe('2');
    const side = screen.getByTestId('focus-side');
    const thread = screen.getByTestId('thread');
    expect(side.contains(thread)).toBe(true);
    expect(thread.getAttribute('data-layout')).toBe('panel');
    expect(thread.lastElementChild!.tagName).toBe('FORM');
    expect(screen.getByTestId('focus-scroll').contains(thread)).toBe(false);
    expect(side.contains(screen.getByTestId('decide-bar'))).toBe(false);
    expect(side.contains(document.querySelector('footer'))).toBe(false);
    // Beside the renders: the side column follows the work column.
    expect(screen.getByTestId('focus-work').compareDocumentPosition(side) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(themeCss()).toMatch(/\.focus-layout\[data-columns='2'\] \{[^}]*grid-template-columns: minmax\(0, 1fr\) 320px/);
    // The thread column starts at the top of the screen: the header belongs to the work column only.
    expect(screen.getByTestId('focus-work').contains(document.querySelector('.screen-header'))).toBe(true);
    expect(side.contains(document.querySelector('.screen-header'))).toBe(false);
  });

  it('below the breakpoint the thread follows the renders in the scrolling body; the bar sits outside it, under', async () => {
    narrow();
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('thread') && screen.queryByTestId('decide-bar'));
    expect(screen.getByTestId('focus-layout').getAttribute('data-columns')).toBe('1');
    expect(screen.queryByTestId('focus-side')).toBeNull();
    const scroll = screen.getByTestId('focus-scroll');
    const thread = screen.getByTestId('thread');
    expect(scroll.contains(thread)).toBe(true);
    expect(screen.getByTestId('focus-pair').compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const bar = screen.getByTestId('decide-bar');
    expect(scroll.contains(bar)).toBe(false);
    expect(scroll.compareDocumentPosition(bar) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('a lane anchored on a slide opens its thread with the last exchange of that slide conversation, read-only', async () => {
    const api = stubApi({ ...lane([c1]), anchor: { kind: 'slide', slide: 's3' } });
    const slideThread: ThreadMessage[] = [
      { id: 'u0', thread: 'slide:s3', role: 'user', text: 'older ask', context: { kind: 'slide', slide: 's3' }, at: '2026-09-30T09:00:00.000Z' },
      { id: 'a0', thread: 'slide:s3', role: 'assistant', text: 'older reply', context: null, at: '2026-09-30T09:00:05.000Z' },
      { id: 'u1', thread: 'slide:s3', role: 'user', text: 'make the title sharper', context: { kind: 'slide', slide: 's3' }, at: '2026-09-30T10:00:00.000Z' },
      { id: 'a1', thread: 'slide:s3', role: 'assistant', text: 'Opened lane B.', context: null, at: '2026-09-30T10:00:05.000Z' },
    ];
    const own: ThreadMessage = { id: 'l1m', thread: 'lane:l1', role: 'user', text: 'also the story', context: null, at: '2026-09-30T11:00:00.000Z' };
    api.getThread.mockImplementation(async (key: string) => (key === 'slide:s3' ? slideThread : key === 'lane:l1' ? [own] : []));
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('thread-seed') && screen.queryAllByTestId('thread-message').length === 1);
    expect(api.getThread).toHaveBeenCalledWith('slide:s3');
    const seed = screen.getByTestId('thread-seed');
    expect(seed.textContent).toContain('from the slide conversation');
    expect(within(seed).getAllByTestId('seed-message').map((m) => m.textContent)).toEqual([expect.stringContaining('make the title sharper'), expect.stringContaining('Opened lane B.')]);
    expect(seed.compareDocumentPosition(screen.getByTestId('thread-message')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it('below the breakpoint the bar offers a way to the conversation: it puts the caret in the composer', async () => {
    narrow();
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('decide-bar'));
    fireEvent.click(within(screen.getByTestId('decide-bar')).getByRole('button', { name: 'write to the co-author' }));
    expect(document.activeElement).toBe(screen.getByLabelText('message'));
    expect(scrolled).toHaveBeenCalled();
  });

  it('the reason names slides by number and title, never by id', async () => {
    const api = stubApi(lane([{ ...c1, reason: 's2 already makes the point' }]));
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-reason'));
    expect(screen.getByTestId('focus-reason').textContent).toContain('slide 2, Title s2 already makes the point');
  });

  it('a lane on a range has no seed', async () => {
    const api = stubApi();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => api.getThread.mock.calls.length > 0);
    expect(api.getThread.mock.calls.map((c) => c[0])).toEqual(['lane:l1']);
    expect(screen.queryByTestId('thread-seed')).toBeNull();
  });

  it('a proposal in the lane thread shows its pair only: no accept, refuse or link to this same screen', async () => {
    const api = stubApi(lane([c1]));
    const b = bus();
    const stored: ThreadMessage[] = [];
    api.getThread.mockImplementation(async () => [...stored]);
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={b.subscribe} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByLabelText('message'));
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'also the story' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => api.postMessage.mock.calls.length === 1);
    b.emit({ type: 'lane.updated', laneId: 'l1' });
    stored.push({ id: 'a1', thread: 'lane:l1', role: 'assistant', text: 'Revised.', context: null, at: '2026-09-30T10:00:05.000Z' });
    b.emit({ type: 'assistant.done', thread: 'lane:l1', messageId: 'a1' });
    await waitFor(() => screen.queryAllByTestId('proposal-change').length === 1);
    const card = screen.getByTestId('thread-proposal');
    expect(within(card).queryAllByRole('button')).toHaveLength(0);
    expect(within(card).queryAllByRole('link')).toHaveLength(0);
  });

  it('no style element inside the screen: its rules live in the theme', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    expect(document.querySelector('style')).toBeNull();
    expect(themeCss()).toMatch(/\.focus-pair \{[^}]*auto-fit/);
  });
});

describe('Focus text diff and layout', () => {
  const lines = (field: string) =>
    Array.from(screen.getAllByTestId('text-diff').find((d) => d.getAttribute('data-field') === field)!.querySelectorAll('[data-testid="diff-line"]')).map(
      (l) => `${l.getAttribute('data-op')}:${l.getAttribute('data-text')}`,
    );

  it('a modify shows a text diff of each changed text field under the previews', async () => {
    const body: Change = {
      id: 'c1',
      kind: 'modify',
      slide: 's3',
      patch: { title: 'Sharper s3', body: '<p>Title s3</p><p>second line</p>', story: 'why now' },
      reason: 'tighter title',
      status: 'pending',
    };
    const api = stubApi(lane([body, c3]));
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('text-diff').length === 3);
    expect(screen.getAllByTestId('text-diff').map((d) => d.getAttribute('data-field'))).toEqual(['title', 'body', 'story']);
    expect(lines('title')).toEqual(['del:Title s3', 'add:Sharper s3']);
    expect(lines('body')).toEqual(['same:Title s3', 'add:second line']);
    expect(lines('story')).toEqual(['add:why now']);
  });

  it('a modify that touches no rendered field says the slide looks the same, above the pair', async () => {
    const story: Change = { id: 'c1', kind: 'modify', slide: 's3', patch: { story: 'why now' }, reason: 'r', status: 'pending' };
    const notes: Change = { id: 'c6', kind: 'modify', slide: 's2', patch: { notes: 'say it slower' }, reason: 'r', status: 'pending' };
    const both: Change = { id: 'c7', kind: 'modify', slide: 's5', patch: { story: 'a', notes: 'b' }, reason: 'r', status: 'pending' };
    const api = stubApi(lane([story, notes, both, c3]));
    const same = () => screen.queryByTestId('focus-same-render');
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => same());
    expect(same()!.textContent).toBe('only the story changes; the slide looks the same');
    expect(same()!.nextElementSibling).toBe(screen.getByTestId('focus-pair'));
    rerender(<Focus laneId="l1" changeId="c6" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 2 of 4'));
    expect(same()!.textContent).toBe('only the notes change; the slide looks the same');
    rerender(<Focus laneId="l1" changeId="c7" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 3 of 4'));
    expect(same()!.textContent).toBe('only the story and notes change; the slide looks the same');
    // an insert, or a modify that touches the title, changes what the slide looks like
    rerender(<Focus laneId="l1" changeId="c3" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 4 of 4'));
    expect(same()).toBeNull();
  });

  it('no text diff for an insert, a remove, or a modify that only touches assets', async () => {
    const assetsOnly: Change = { id: 'c1', kind: 'modify', slide: 's3', patch: { assets: [] }, reason: 'r', status: 'pending' };
    const api = stubApi(lane([assetsOnly, c3, c5]));
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    expect(screen.queryAllByTestId('text-diff')).toHaveLength(0);
    rerender(<Focus laneId="l1" changeId="c3" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 2 of 3'));
    expect(screen.queryAllByTestId('text-diff')).toHaveLength(0);
  });

  it('previews sit side by side as long as two fit; the decision bar sits under the scrolling body, never over it', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    const pair = screen.getByTestId('focus-pair');
    expect(pair.className).toBe('focus-pair');
    expect(pair.querySelectorAll('[data-testid="slide-preview"]')).toHaveLength(2);
    const scroll = screen.getByTestId('focus-scroll');
    const bar = screen.getByTestId('decide-bar');
    // The bar follows the diff pane (the scroll area and its fade), a fixed-height block of its own: nothing scrolls under it.
    expect(scroll.parentElement!.className).toBe('focus-pane');
    expect(scroll.parentElement!.nextElementSibling).toBe(bar);
    expect(bar.style.position).not.toBe('sticky');
    expect(bar.style.height).toBe(`${BAR_HEIGHT}px`);
    expect(bar.contains(screen.getByRole('button', { name: 'accept' }))).toBe(true);
  });
});

describe('Focus fills the body', () => {
  it('the pair spans the body: the lane side larger, a side missing slims to a narrow column', async () => {
    const api = stubApi();
    const shape = () => screen.getByTestId('focus-pair').getAttribute('data-shape');
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    expect(shape()).toBe('both');
    // an insert has no main side, a remove no lane side
    rerender(<Focus laneId="l1" changeId="c3" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 2 of 3'));
    expect(shape()).toBe('after');
    rerender(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 3 of 3'));
    expect(shape()).toBe('before');
    const css = themeCss();
    expect(css).not.toMatch(/\.focus-pair \{[^}]*max-width/);
    expect(css).toMatch(/\.focus-pair\[data-shape='both'\] \{[^}]*5fr\) minmax\(0, 7fr/);
    // No empty 120px gutter on this screen: the body starts at the screen edge padding.
    expect(css).not.toMatch(/\.focus-scroll \{[^}]*var\(--gutter\)/);
  });

  it('text diffs sit in columns across the body, each under 80 characters wide', async () => {
    const body: Change = { id: 'c1', kind: 'modify', slide: 's3', patch: { title: 'Sharper s3', story: 'why now' }, reason: 'tighter title', status: 'pending' };
    render(<Focus laneId="l1" changeId="c1" api={stubApi(lane([body, c3]))} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('text-diff').length === 2);
    const diffs = screen.getByTestId('focus-diffs');
    expect(diffs.className).toBe('focus-diffs');
    for (const d of screen.getAllByTestId('text-diff')) {
      expect(diffs.contains(d)).toBe(true);
      expect(d.style.maxWidth).toBe('80ch');
    }
    expect(screen.getByTestId('focus-reason').style.maxWidth).toBe('80ch');
    expect(themeCss()).toMatch(/\.focus-diffs \{[^}]*grid-template-columns/);
  });
});

describe('Focus move changes', () => {
  const move: Change = { id: 'm1', kind: 'move', slide: 's2', after: 's5', reason: 'later', status: 'pending' };
  const moved: LanePreviewPayload = { order: ['s1', 's3', 's4', 's5', 's2'], slides: mainSlides, skipped: [], thumbs: {} };

  it('a move shows both whole strips, the moved slide twice its neighbours and ringed, "was N" on main and "now M" in the lane', async () => {
    const api = stubApi(lane([move]));
    api.getLanePreview.mockResolvedValue(moved);
    render(<Focus laneId="l1" changeId="m1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('move-strip').length === 2);
    expect(screen.queryAllByTestId('slide-preview')).toHaveLength(0);
    expect(screen.queryAllByTestId('move-excerpt')).toHaveLength(0);
    const [main, laneSide] = screen.getAllByTestId('move-strip');
    const ids = (el: HTMLElement) => within(el).getAllByTestId('thumb').map((t) => t.getAttribute('data-slide'));
    const sel = (el: HTMLElement) => within(el).getAllByTestId('thumb').filter((t) => t.getAttribute('aria-pressed') === 'true').map((t) => t.getAttribute('data-slide'));
    const scale = (el: HTMLElement) => within(el).getAllByRole('listitem').map((li) => li.style.getPropertyValue('--move-k'));
    expect(main!.getAttribute('data-side')).toBe('main');
    expect(ids(main!)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(sel(main!)).toEqual(['s2']);
    expect(scale(main!)).toEqual(['1', '2', '1', '1', '1']);
    expect(within(main!).getByTestId('move-caption').textContent).toBe('main, was 2');
    expect(laneSide!.getAttribute('data-side')).toBe('lane');
    expect(ids(laneSide!)).toEqual(['s1', 's3', 's4', 's5', 's2']);
    expect(sel(laneSide!)).toEqual(['s2']);
    expect(scale(laneSide!)).toEqual(['1', '1', '1', '1', '2']);
    expect(within(laneSide!).getByTestId('move-caption').textContent).toBe('this lane, now 5');
    // The thumbs size from the viewport-filling unit in the theme, the lane side larger than main's.
    expect(themeCss()).toMatch(/\.move-strip-item \{[^}]*--move-k/);
    expect(themeCss()).toMatch(/\.focus-move \{[^}]*--move-u:[^;]*cqh/);
  });

  it('each move strip scrolls so the moved slide sits in its middle', async () => {
    const many: SlideId[] = Array.from({ length: 30 }, (_, i) => `s${i + 1}`);
    const slidesMany = Object.fromEntries(many.map((id) => [id, slide(id)]));
    const far: Change = { id: 'm2', kind: 'move', slide: 's2', after: 's28', reason: 'later', status: 'pending' };
    const after = [...many.filter((x) => x !== 's2').slice(0, 27), 's2', ...many.filter((x) => x !== 's2').slice(27)];
    const api = stubApi({ ...lane([far]), anchor: { kind: 'slide', slide: 's2' } });
    api.getDeck.mockResolvedValue({ ...deck, order: many, slides: slidesMany, state: { ...deck.state, order: many } });
    api.getLanePreview.mockResolvedValue({ order: after, slides: slidesMany, skipped: [], thumbs: {} });
    // Items 100px apart in an 800px wide strip; the moved one is 200px wide.
    const proto = HTMLElement.prototype;
    const saved = ['offsetLeft', 'offsetWidth', 'clientWidth'].map((k) => [k, Object.getOwnPropertyDescriptor(proto, k)] as const);
    const item = (el: HTMLElement) => (el.getAttribute('role') === 'listitem' ? el : null);
    Object.defineProperty(proto, 'offsetLeft', { configurable: true, get(this: HTMLElement) { const li = item(this); return li ? Array.from(li.parentElement!.children).indexOf(li) * 100 : 0; } });
    Object.defineProperty(proto, 'offsetWidth', { configurable: true, get(this: HTMLElement) { const li = item(this); return li ? (li.getAttribute('data-moved') ? 200 : 96) : 0; } });
    Object.defineProperty(proto, 'clientWidth', { configurable: true, get(this: HTMLElement) { return this.getAttribute('role') === 'list' ? 800 : 0; } });
    try {
      render(<Focus laneId="l1" changeId="m2" api={api} subscribe={noEvents} navigate={vi.fn()} />);
      await waitFor(() => screen.queryAllByTestId('move-strip').length === 2);
      const [main, laneSide] = screen.getAllByTestId('move-strip').map((s) => within(s).getByRole('list'));
      // main: s2 at index 1 -> centre 200 is left of the middle, no scroll; lane: s2 at index 27 -> 2700 + 100 - 400.
      await waitFor(() => laneSide!.scrollLeft > 0);
      expect(main!.scrollLeft).toBe(0);
      expect(laneSide!.scrollLeft).toBe(2700 + 100 - 400);
    } finally {
      for (const [k, d] of saved) if (d) Object.defineProperty(proto, k, d);
    }
  });

  it('the bottom strips scroll so the destination column is visible', async () => {
    const many: SlideId[] = Array.from({ length: 30 }, (_, i) => `s${i + 1}`);
    const slidesMany = Object.fromEntries(many.map((id) => [id, slide(id)]));
    const far: Change = { id: 'm2', kind: 'move', slide: 's2', after: 's28', reason: 'later', status: 'pending' };
    const after = [...many.filter((x) => x !== 's2').slice(0, 27), 's2', ...many.filter((x) => x !== 's2').slice(27)];
    const api = stubApi({ ...lane([far]), anchor: { kind: 'slide', slide: 's2' } });
    api.getDeck.mockResolvedValue({ ...deck, order: many, slides: slidesMany, state: { ...deck.state, order: many } });
    api.getLanePreview.mockResolvedValue({ order: after, slides: slidesMany, skipped: [], thumbs: {} });
    // Columns 100px apart from x = 144 in a 1000px wide strip area.
    const rect = vi.spyOn(Element.prototype, 'getBoundingClientRect').mockImplementation(function (this: Element) {
      const el = this as HTMLElement;
      if (el.tagName === 'FOOTER') return { left: 0, right: 1000, width: 1000, top: 0, bottom: 200, height: 200, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
      const item = el.closest('[role="listitem"]');
      if (item && el.getAttribute('data-testid') === 'thumb') {
        const i = Array.from(item.parentElement!.children).indexOf(item);
        const left = 144 + i * 100 - (el.closest('footer')?.scrollLeft ?? 0);
        return { left, right: left + 96, width: 96, top: 0, bottom: 54, height: 54, x: left, y: 0, toJSON: () => ({}) } as DOMRect;
      }
      return { left: 0, right: 0, width: 0, top: 0, bottom: 0, height: 0, x: 0, y: 0, toJSON: () => ({}) } as DOMRect;
    });
    try {
      render(<Focus laneId="l1" changeId="m2" api={api} subscribe={noEvents} navigate={vi.fn()} />);
      await waitFor(() => screen.queryAllByTestId('move-strip').length === 2);
      fireEvent.click(screen.getByTestId('focus-strip'));
      const footer = document.querySelector('footer')!;
      // s2 lands at column 28 (index 27): x = 144 + 2700, centred in the strip area.
      await waitFor(() => footer.scrollLeft > 0);
      expect(footer.scrollLeft).toBe(144 + 27 * 100 + 48 - 500);
    } finally {
      rect.mockRestore();
    }
  });
});

describe('Focus reload', () => {
  it('reloads without content change request no thumb again; a changed slide is the only one re-requested', async () => {
    const api = stubApi();
    let push: (e: BusEvent) => void = () => undefined;
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={(h) => ((push = h), () => undefined)} navigate={vi.fn()} />);
    await waitFor(() => api.thumbFor.mock.calls.length === order.length);
    const perSlide = () => order.map((id) => api.thumbFor.mock.calls.filter((c) => c[0] === id).length);

    push({ type: 'deck.changed', version: 3 });
    await waitFor(() => api.getDeck.mock.calls.length === 2);
    push({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => api.getLanePreview.mock.calls.length === 3);
    // The lane's own events are the marker the reloads ran to their end; a changed slide proves the loop runs.
    const changed: DeckPayload = { ...deck, state: { ...deck.state, version: 4 }, slides: { ...mainSlides, s4: slide('s4', 'Edited s4') } };
    api.getDeck.mockResolvedValue(changed);
    push({ type: 'deck.changed', version: 4 });
    await waitFor(() => api.thumbFor.mock.calls.length === order.length + 1);
    expect(perSlide()).toEqual([1, 1, 1, 2, 1]);
    expect(api.thumbFor.mock.calls.at(-1)).toEqual(['s4']);
  });
});

describe('LaneRow links to the focus screen', () => {
  it('clicking a changed thumb opens its change, an unchanged one does nothing', async () => {
    const { LaneRow } = await import('../../web/src/components/LaneRow.js');
    const open = vi.fn();
    const laneApi = { acceptChange: vi.fn(), refuseChange: vi.fn(), discardLane: vi.fn() };
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={laneApi} onOpenChange={open} />);
    const thumb = (id: string) => screen.getAllByTestId('thumb').find((t) => t.getAttribute('data-slide') === id)!;
    fireEvent.click(thumb('s2'));
    expect(open).not.toHaveBeenCalled();
    fireEvent.click(thumb('n1'));
    expect(open).toHaveBeenLastCalledWith('l1', 'c3');
    fireEvent.click(thumb('s3'));
    expect(open).toHaveBeenLastCalledWith('l1', 'c1');
    const removed = screen.getByTestId('removed-slot');
    expect(removed.getAttribute('href')).toBe('/lane/l1/change/c5');
    fireEvent.click(removed);
    expect(open).toHaveBeenLastCalledWith('l1', 'c5');
  });
});

describe('Focus strip and diff pane', () => {
  it('one 48px strip of slide numbers: changed filled, refused struck, the current one ringed; a click expands the full strips', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('strip-cell').length > 0);
    // Collapsed: no filmstrip, no underline.
    expect(document.querySelector('footer')).toBeNull();
    expect(screen.queryAllByTestId('range-underline')).toHaveLength(0);
    const strip = screen.getByTestId('focus-strip');
    expect(strip.getAttribute('aria-expanded')).toBe('false');
    const cells = screen.getAllByTestId('strip-cell');
    expect(cells.map((c) => c.textContent)).toEqual(['1', '2', 'new', '3', '4', '5']);
    expect(cells.map((c) => c.getAttribute('data-state'))).toEqual(['same', 'changed', 'changed', 'changed', 'changed', 'refused']);
    expect(cells.filter((c) => c.getAttribute('aria-current') === 'true').map((c) => c.getAttribute('data-slide'))).toEqual(['s3']);
    const css = themeCss();
    expect(css).toMatch(/\.focus-strip \{[^}]*height: 48px/);
    expect(css).toMatch(/\.strip-cell\[data-state='changed'\] \{[^}]*background: var\(--accent\)/);
    expect(css).toMatch(/\.strip-cell\[data-state='refused'\] \{[^}]*text-decoration: line-through/);

    fireEvent.click(strip);
    expect(strip.getAttribute('aria-expanded')).toBe('true');
    await waitFor(() => screen.queryAllByTestId('range-underline').length === 2);
    expect(document.querySelector('footer')).not.toBeNull();
    fireEvent.click(strip);
    expect(document.querySelector('footer')).toBeNull();
  });

  it('the diff pane takes the remaining height; a bottom fade shows while it runs on below', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-pair'));
    const pane = screen.getByTestId('focus-scroll');
    expect(screen.queryByTestId('focus-fade')).toBeNull();
    Object.defineProperty(pane, 'scrollHeight', { value: 900, configurable: true });
    Object.defineProperty(pane, 'clientHeight', { value: 400, configurable: true });
    fireEvent.scroll(pane);
    await waitFor(() => screen.queryByTestId('focus-fade'));
    pane.scrollTop = 500;
    fireEvent.scroll(pane);
    await waitFor(() => screen.queryByTestId('focus-fade') === null);
    expect(themeCss()).toMatch(/\.focus-scroll \{[^}]*flex: 1/);
  });
});

describe('Focus decided and settled changes', () => {
  /** A lane payload with the server's reasons for the changes it settled itself. */
  const withCauses = (l: Lane, causes: Record<string, string>): Lane => ({ ...l, causes }) as Lane;

  it('a lane with nothing pending says "all changes decided", lists each outcome and goes back to the slide', async () => {
    const decided = withCauses(
      {
        ...lane([{ ...c1, status: 'accepted' }, c2, { ...c3, status: 'refused' }, { ...c5, status: 'orphan' }]),
        status: 'closed',
      },
      { c2: 'already on main', c5: 'a slide it needs is no longer on main' },
    );
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c1" api={stubApi(decided)} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => screen.queryByTestId('focus-outcomes'));
    expect(crumb()).toBe('all changes decided');
    expect(document.body.textContent).not.toContain('of 0');
    const items = within(screen.getByTestId('focus-outcomes')).getAllByRole('listitem');
    expect(items.map((i) => i.getAttribute('data-outcome'))).toEqual(['accepted', 'already on main', 'refused', 'stale']);
    expect(items[0]!.textContent).toContain('slide 3, Title s3');
    expect(items[2]!.textContent).toContain('Hook');
    expect(items[3]!.textContent).toContain('a slide it needs is no longer on main');
    expect(screen.queryByTestId('decide-bar')).toBeNull();
    const back = screen.getByRole('link', { name: 'back to slide 3' });
    expect(back.className).toBe('btn-primary');
    fireEvent.click(back);
    expect(navigate).toHaveBeenCalledWith('/slide/s3');
  });

  it('a discarded lane says its pending changes were discarded', async () => {
    const gone: Lane = { ...lane([c1]), status: 'closed' };
    render(<Focus laneId="l1" changeId="c1" api={stubApi(gone)} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-outcomes'));
    expect(within(screen.getByTestId('focus-outcomes')).getAllByRole('listitem').map((i) => i.getAttribute('data-outcome'))).toEqual(['discarded']);
  });

  it('while the co-author revises this lane, accept and refuse wait for it', async () => {
    const api = stubApi();
    const b = bus();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={b.subscribe} navigate={vi.fn()} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    const accept = () => screen.getByRole('button', { name: 'accept' }) as HTMLButtonElement;
    const refuse = () => screen.getByRole('button', { name: 'refuse' }) as HTMLButtonElement;
    expect(accept().disabled).toBe(false);
    // Another thread's turn changes nothing.
    b.emit({ type: 'tool.call', name: 'mcp__deck__get_deck', thread: 'slide:s3' });
    expect(accept().disabled).toBe(false);
    b.emit({ type: 'tool.call', name: 'mcp__deck__revise_lane', thread: 'lane:l1' });
    expect(accept().disabled).toBe(true);
    expect(refuse().disabled).toBe(true);
    expect(accept().title).toBe('the co-author is revising this lane');
    b.emit({ type: 'assistant.done', thread: 'lane:l1', messageId: 'a1' });
    expect(accept().disabled).toBe(false);
    expect(accept().title).toBe('');
    // A message sent from this screen starts the turn at once.
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'shorter' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => api.postMessage.mock.calls.length === 1);
    expect(accept().disabled).toBe(true);
    b.emit({ type: 'agent.error', thread: 'lane:l1', message: 'boom' });
    expect(accept().disabled).toBe(false);
  });

  it('a stale change shows the server\'s reason in the header instead of accept and refuse', async () => {
    const l = withCauses(lane([c1, { ...c5, status: 'orphan' }]), { c5: 'title changed on main since v1' });
    render(<Focus laneId="l1" changeId="c5" api={stubApi(l)} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-settled'));
    expect(screen.getByTestId('focus-settled').textContent).toBe('stale: title changed on main since v1');
    expect(crumb()).toBe('stale');
    expect(screen.queryByRole('button', { name: 'accept' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'refuse' })).toBeNull();
    expect(screen.getByRole('link', { name: 'Review the first pending change' }).getAttribute('href')).toBe('/lane/l1/change/c1');
  });

  it('a change main already holds says so in the header', async () => {
    const l = withCauses(lane([c1, { ...c3, status: 'accepted' }]), { c3: 'already on main' });
    render(<Focus laneId="l1" changeId="c3" api={stubApi(l)} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('focus-settled'));
    expect(screen.getByTestId('focus-settled').textContent).toBe('already on main');
    expect(crumb()).toBe('already on main');
    expect(screen.queryByRole('button', { name: 'accept' })).toBeNull();
  });
});
