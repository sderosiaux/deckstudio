// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Focus, BAR_HEIGHT, excerpt } from '../../web/src/screens/Focus.js';
import type { BusEvent, DeckPayload, FocusApi, LanePreviewPayload } from '../../web/src/api.js';
import type { Change, Lane, Slide, SlideId, Version } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

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
    getThread: vi.fn(async () => []),
    postMessage: vi.fn(async () => undefined),
  };
  return api satisfies FocusApi;
};

const noEvents = (_h: (e: BusEvent) => void) => () => undefined;
const crumb = () => screen.queryByTestId('focus-crumb')?.textContent ?? '';

afterEach(() => {
  cleanup();
  vi.useRealTimers();
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

  it('accept acknowledges in place for 6 s, notes it in the lane thread, then moves to the next pending change', async () => {
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
    expect(screen.getAllByTestId('thread-note').map((n) => n.textContent)).toEqual(['accepted into main as v8']);
    expect(navigate).not.toHaveBeenCalled();

    act(() => vi.advanceTimersByTime(5_900));
    expect(navigate).not.toHaveBeenCalled();
    act(() => vi.advanceTimersByTime(200));
    expect(navigate).toHaveBeenCalledWith('/lane/l1/change/c3');
    expect(navigate).toHaveBeenCalledTimes(1);
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
    fireEvent.click(within(screen.getByTestId('decide-ack')).getByRole('button', { name: 'back to the slide' }));
    expect(navigate).toHaveBeenCalledWith('/slide/s4');
  });

  it('a lane revised in place (the current change id is gone) moves to its first pending change and says so', async () => {
    const api = stubApi();
    const b = bus();
    const navigate = vi.fn();
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={b.subscribe} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    const n1: Change = { ...c1, id: 'n1', reason: 'tighter title, revised' };
    api.getLane.mockResolvedValue(lane([n1, c3]));
    b.emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(navigate).toHaveBeenCalledWith('/lane/l1/change/n1');
    rerender(<Focus laneId="l1" changeId="n1" api={api} subscribe={b.subscribe} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 2'));
    expect(screen.getByTestId('focus-notice').textContent).toBe('the co-author revised this lane');
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

  it('the lane thread sits under the pair inside the scrolling body; no right bar', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryByTestId('thread'));
    expect(document.querySelector('aside')).toBeNull();
    const scroll = screen.getByTestId('focus-scroll');
    const thread = screen.getByTestId('thread');
    expect(scroll.contains(thread)).toBe(true);
    expect(thread.getAttribute('data-layout')).toBe('inline');
    expect(screen.getByTestId('focus-pair').compareDocumentPosition(thread) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
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

  it('previews sit side by side as long as two fit; the sticky decision bar never covers content', async () => {
    render(<Focus laneId="l1" changeId="c1" api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('slide-preview').length === 2);
    const pair = screen.getByTestId('focus-pair');
    expect(pair.className).toBe('focus-pair');
    expect(pair.querySelectorAll('[data-testid="slide-preview"]')).toHaveLength(2);
    expect(document.querySelector('style')!.textContent).toMatch(/\.focus-pair \{[^}]*auto-fit/);
    const scroll = screen.getByTestId('focus-scroll');
    const bar = screen.getByTestId('decide-bar');
    // The bar is the scroll area's last child, sticky at its bottom, with a fixed height the scroll area pads for.
    expect(scroll.lastElementChild).toBe(bar);
    expect(bar.style.position).toBe('sticky');
    expect(bar.style.bottom).toBe('0px');
    expect(bar.style.height).toBe(`${BAR_HEIGHT}px`);
    expect(scroll.style.scrollPaddingBottom).toBe(`${BAR_HEIGHT}px`);
    expect(bar.contains(screen.getByRole('button', { name: 'accept' }))).toBe(true);
  });
});

describe('Focus move changes', () => {
  const move: Change = { id: 'm1', kind: 'move', slide: 's2', after: 's5', reason: 'later', status: 'pending' };
  const moved: LanePreviewPayload = { order: ['s1', 's3', 's4', 's5', 's2'], slides: mainSlides, skipped: [], thumbs: {} };

  it('excerpt keeps 5 slides centred on a position, clamped at the deck ends', () => {
    const o = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h'];
    expect(excerpt(o, 4)).toEqual({ start: 2, ids: ['c', 'd', 'e', 'f', 'g'] });
    expect(excerpt(o, 0)).toEqual({ start: 0, ids: ['a', 'b', 'c', 'd', 'e'] });
    expect(excerpt(o, 7)).toEqual({ start: 3, ids: ['d', 'e', 'f', 'g', 'h'] });
    expect(excerpt(['a', 'b'], 1)).toEqual({ start: 0, ids: ['a', 'b'] });
  });

  it('a move shows two strip excerpts centred on the slide, "was N" on main and "now M" in the lane', async () => {
    const api = stubApi(lane([move]));
    api.getLanePreview.mockResolvedValue(moved);
    render(<Focus laneId="l1" changeId="m1" api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('move-excerpt').length === 2);
    expect(screen.queryAllByTestId('slide-preview')).toHaveLength(0);
    const [main, laneSide] = screen.getAllByTestId('move-excerpt');
    const ids = (el: HTMLElement) => within(el).getAllByTestId('thumb').map((t) => t.getAttribute('data-slide'));
    const sel = (el: HTMLElement) => within(el).getAllByTestId('thumb').find((t) => t.getAttribute('aria-pressed') === 'true')?.getAttribute('data-slide');
    expect(main!.getAttribute('data-side')).toBe('main');
    expect(ids(main!)).toEqual(['s1', 's2', 's3', 's4', 's5']);
    expect(sel(main!)).toBe('s2');
    expect(within(main!).getByTestId('move-caption').textContent).toBe('main, was 2');
    expect(laneSide!.getAttribute('data-side')).toBe('lane');
    expect(ids(laneSide!)).toEqual(['s1', 's3', 's4', 's5', 's2']);
    expect(sel(laneSide!)).toBe('s2');
    expect(within(laneSide!).getByTestId('move-caption').textContent).toBe('this lane, now 5');
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
      await waitFor(() => screen.queryAllByTestId('move-excerpt').length === 2);
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
