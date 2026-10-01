// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { DeckPayload } from '../../web/src/api.js';
import type { Lane, Remark, Slide, SlideId, ThreadMessage } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({
  handlers: [] as Array<(e: unknown) => void>,
  getThread: vi.fn(),
  postMessage: vi.fn(),
  getRemarks: vi.fn(),
  proposeRemark: vi.fn(),
  resolveRemark: vi.fn(),
  getLanes: vi.fn(),
  getLane: vi.fn(),
  getLanePreview: vi.fn(),
  acceptChange: vi.fn(),
  refuseChange: vi.fn(),
}));

const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: '', notes: '', body: `<p>${id}</p>`, assets: [], kind: 'text' });
const order: SlideId[] = ['s1', 's2', 's3', 's4', 's5', 's6'];
const deck: DeckPayload = {
  state: { name: 'd', order, version: 3, sessionId: null, model: 'm' },
  brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '', design: { rules: '', imageStyle: '' } },
  order,
  slides: Object.fromEntries(order.map((id) => [id, slide(id)])),
};

vi.mock('../../web/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/api.js')>();
  return {
    ...real,
    getDeck: async () => deck,
    getVersions: async () => [],
    getLanes: m.getLanes,
    getLane: m.getLane,
    getLanePreview: m.getLanePreview,
    thumbFor: async (id: SlideId) => ({ hash: `h_${id}`, ready: true }),
    getRemarks: m.getRemarks,
    openLane: vi.fn(),
    openPlayer: vi.fn(),
    remarkApi: { proposeRemark: m.proposeRemark, resolveRemark: m.resolveRemark },
    threadApi: {
      getThread: m.getThread,
      postMessage: m.postMessage,
      getLane: m.getLane,
      getLanePreview: m.getLanePreview,
      thumbFor: async (id: SlideId) => ({ hash: `h_${id}`, ready: true }),
      acceptChange: m.acceptChange,
      refuseChange: m.refuseChange,
    },
    laneApi: { acceptChange: vi.fn(), refuseChange: vi.fn(), discardLane: vi.fn() },
    subscribe: (h: (e: unknown) => void) => {
      m.handlers.push(h);
      return () => {
        m.handlers = m.handlers.filter((x) => x !== h);
      };
    },
  };
});

const { Main, deckTurns, panelSpan, revealColumn, StripPager } = await import('../../web/src/screens/Main.js');
const { placeCards } = await import('../../web/src/components/RemarkRow.js');

const remark = (id: string, anchor: Remark['anchor']): Remark => ({
  id, anchor, text: `text ${id}`, origin: 'check:render', severity: 'warn', status: 'open', laneId: null, createdAt: '2026-09-30T00:00:00.000Z',
});
const msg = (id: string, role: 'user' | 'assistant', context: ThreadMessage['context'], at: string): ThreadMessage => ({ id, thread: 'global', role, text: `text ${id}`, context, at });

const thumb = (id: SlideId): HTMLElement => screen.getAllByTestId('thumb').find((t) => t.closest('[data-strip="main"]') && t.getAttribute('data-slide') === id)!;
const panel = (): HTMLElement | null => screen.queryByTestId('selection-panel');
const pressed = (): string[] => screen.getAllByTestId('thumb').filter((t) => t.getAttribute('aria-pressed') === 'true').map((t) => t.getAttribute('data-slide')!);
const mounted = async () => {
  render(<Main />);
  await waitFor(() => screen.queryAllByTestId('thumb').length === order.length);
};

beforeEach(() => {
  m.handlers = [];
  sessionStorage.clear();
  m.getThread.mockReset().mockResolvedValue([]);
  m.postMessage.mockReset().mockResolvedValue(undefined);
  m.getRemarks.mockReset().mockResolvedValue([]);
  m.proposeRemark.mockReset().mockResolvedValue(undefined);
  m.resolveRemark.mockReset().mockResolvedValue(undefined);
  m.getLanes.mockReset().mockResolvedValue([]);
  m.getLane.mockReset();
  m.getLanePreview.mockReset();
  m.acceptChange.mockReset();
  m.refuseChange.mockReset();
});
afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

describe('Main selection panel', () => {
  it('nothing selected: no panel, the whole-deck conversation in the right bar', async () => {
    await mounted();
    expect(panel()).toBeNull();
    const bar = screen.getByTestId('thread-panel');
    expect(within(bar).getByTestId('thread').getAttribute('data-thread')).toBe('global');
    expect(within(bar).getByRole('heading', { name: 'whole deck' })).toBeTruthy();
    expect(within(bar).getByTestId('context-chip').getAttribute('data-kind')).toBe('arc');
  });

  it('a selected slide opens the panel under its column, on the slide:<id> thread, above the lane rows', async () => {
    await mounted();
    fireEvent.click(thumb('s3'));
    const p = await waitFor(() => panel());
    expect(p.getAttribute('data-slide')).toBe('s3');
    expect(p.closest('[data-testid="selection-slot"]')!.getAttribute('data-col')).toBe('2');
    expect(within(p).getByTestId('thread').getAttribute('data-thread')).toBe('slide:s3');
    await waitFor(() => m.getThread.mock.calls.some((c) => c[0] === 'slide:s3'));
    // Sent from the panel: on the slide thread, about that slide.
    fireEvent.change(within(p).getByLabelText('message'), { target: { value: 'shorter title' } });
    fireEvent.click(within(p).getByRole('button', { name: 'Send' }));
    expect(m.postMessage).toHaveBeenCalledWith('slide:s3', 'shorter title', { kind: 'slide', slide: 's3' });
    // It sits under the strip, before the lanes empty state.
    const strip = document.querySelector('[data-strip="main"]')!;
    expect(strip.compareDocumentPosition(p) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(p.compareDocumentPosition(screen.getByText(/^No open lanes/)) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });

  it("remarks leave the canvas: a count dot per thumb, and the selected slide's remarks first in its panel, expandable", async () => {
    m.getRemarks.mockResolvedValue([
      remark('r_s3', { kind: 'slide', slide: 's3' }),
      { ...remark('r_info', { kind: 'slide', slide: 's3' }), severity: 'info' },
      remark('r_range', { kind: 'range', from: 's2', to: 's4' }),
      remark('r_s6', { kind: 'slide', slide: 's6' }),
    ]);
    await mounted();
    await waitFor(() => screen.queryByTestId('remark-count')?.textContent === '4 open remarks');
    // No post-it row on the canvas.
    expect(screen.queryByTestId('post-its')).toBeNull();
    expect(screen.queryAllByTestId('post-it')).toHaveLength(0);
    const dot = (id: SlideId) => within(thumb(id)).queryByTestId('remark-dot');
    expect(dot('s3')!.textContent).toBe('3');
    expect(dot('s3')!.getAttribute('data-severity')).toBe('warn');
    expect(dot('s2')!.textContent).toBe('1');
    expect(dot('s6')!.textContent).toBe('1');
    expect(dot('s1')).toBeNull();
    fireEvent.click(thumb('s3'));
    const p = await waitFor(() => panel());
    const cards = within(p).getAllByTestId('post-it');
    // Warnings first, then the rest; the range remark covers s3 too.
    expect(cards.map((x) => x.getAttribute('data-remark'))).toEqual(['r_s3', 'r_range', 'r_info']);
    // The remarks come before the conversation.
    expect(within(p).getByTestId('panel-remarks').compareDocumentPosition(within(p).getByRole('log')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    const text = within(cards[0]!).getByTestId('remark-text');
    expect(text.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(text);
    expect(text.getAttribute('aria-expanded')).toBe('true');
    expect(text.textContent).toBe('text r_s3');
    expect(pressed()).toEqual(['s3']);
    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'propose' }));
    expect(m.proposeRemark).toHaveBeenCalledWith('r_s3');
    fireEvent.click(within(cards[1]!).getByRole('button', { name: 'resolve' }));
    expect(m.resolveRemark).toHaveBeenCalledWith('r_range');
    // The propose note shows in the panel, where the creator asked.
    await waitFor(() => within(p).queryByTestId('propose-note'));
    expect(pressed()).toEqual(['s3']);
  });

  it('the whole-deck bar keeps only whole-deck turns: slide and range requests belong to their panel', async () => {
    m.getThread.mockImplementation(async (key: string) =>
      key === 'global'
        ? [
            msg('u_slide', 'user', { kind: 'slide', slide: 's2' }, '2026-09-30T00:00:01.000Z'),
            msg('a_slide', 'assistant', null, '2026-09-30T00:00:02.000Z'),
            msg('u_range', 'user', { kind: 'range', from: 's2', to: 's4' }, '2026-09-30T00:00:03.000Z'),
            msg('a_range', 'assistant', null, '2026-09-30T00:00:04.000Z'),
            msg('u_deck', 'user', { kind: 'arc' }, '2026-09-30T00:00:05.000Z'),
            msg('a_deck', 'assistant', null, '2026-09-30T00:00:06.000Z'),
            msg('u_old', 'user', null, '2026-09-30T00:00:07.000Z'),
          ]
        : [],
    );
    await mounted();
    const bar = screen.getByTestId('thread-panel');
    await waitFor(() => within(bar).queryAllByTestId('thread-message').length === 3);
    expect(within(bar).getAllByTestId('thread-message').map((x) => x.textContent)).toEqual([
      expect.stringContaining('text u_deck'),
      expect.stringContaining('text a_deck'),
      expect.stringContaining('text u_old'),
    ]);
    expect(deckTurns([msg('x', 'assistant', null, '2026-09-30T00:00:00.000Z')]).map((x) => x.id)).toEqual(['x']);
  });

  it('the panel is 5 to 9 columns wide from its column, and keeps that left edge with the canvas scrolled away', () => {
    expect(panelSpan(3, undefined)).toBe(9);
    expect(panelSpan(3, { first: 0, end: 9 })).toBe(6);
    expect(panelSpan(7, { first: 0, end: 9 })).toBe(5);
    expect(panelSpan(3, { first: 0, end: 20 })).toBe(9);
    // Slides 4-6 selected, the canvas at its end (columns 21..29 in view): the panel is out of view, so placed
    // without a view, at its own column and nine columns wide, never stretched over the columns in sight.
    const [placed] = placeCards([{ id: 'p', col: 3, span: panelSpan(3, undefined), selected: true }], 30, 1);
    expect(placed).toMatchObject({ start: 3, width: 9 });
  });

  it("the panel's height stops above the versions rail: the canvas height less the strip, the log scrolls inside", async () => {
    const desc = Object.getOwnPropertyDescriptor(HTMLElement.prototype, 'offsetHeight')!;
    const cdesc = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!;
    Object.defineProperty(HTMLElement.prototype, 'offsetHeight', {
      configurable: true,
      get(this: HTMLElement) {
        return this.getAttribute('data-testid') === 'strip-header' ? 160 : 0;
      },
    });
    Object.defineProperty(Element.prototype, 'clientHeight', {
      configurable: true,
      get(this: Element) {
        return this.getAttribute('data-testid') === 'canvas' ? 700 : 0;
      },
    });
    try {
      await mounted();
      fireEvent.click(thumb('s3'));
      const p = await waitFor(() => panel());
      // 700 less the strip (160), what sits above the panel (28: canvas padding, pin row) and 16 of clearance.
      await waitFor(() => p.style.getPropertyValue('--panel-max-h') === '496px');
      expect(p.className).toContain('selection-panel');
    } finally {
      Object.defineProperty(HTMLElement.prototype, 'offsetHeight', desc);
      Object.defineProperty(Element.prototype, 'clientHeight', cdesc);
    }
  });

  it('the strip stays on top: the filmstrip and its range caption sit in a sticky header, the panel scrolls below it', async () => {
    await mounted();
    fireEvent.click(thumb('s2'));
    fireEvent.click(thumb('s4'), { shiftKey: true });
    const p = await waitFor(() => panel());
    const header = screen.getByTestId('strip-header');
    expect(header.className).toContain('strip-sticky');
    expect(header.contains(document.querySelector('[data-strip="main"]'))).toBe(true);
    expect(header.contains(screen.getByTestId('range-caption'))).toBe(true);
    expect(header.contains(p)).toBe(false);
    // No hover title competes with the range caption.
    expect(header.querySelectorAll('.thumb-title')).toHaveLength(0);
  });

  it('"+N" on both ends pages the strip; revealColumn brings a column to the left edge', () => {
    const page = vi.fn();
    render(<StripPager visible={{ first: 9, end: 18, hidden: 12, rows: [{ hidden: 12, top: 60 }], cut: 900 }} onPage={page} />);
    const prev = screen.getByRole('button', { name: 'show the previous slides (9 more)' });
    const next = screen.getByRole('button', { name: 'show the next slides (12 more)' });
    expect(prev.textContent).toBe('+9');
    fireEvent.click(prev);
    fireEvent.click(next);
    expect(page.mock.calls).toEqual([[-1], [1]]);
    cleanup();
    render(<StripPager visible={{ first: 0, end: 9, hidden: 0, rows: [{ hidden: 0, top: 60 }], cut: 900 }} onPage={page} />);
    expect(screen.queryAllByRole('button')).toHaveLength(0);

    const canvas = document.createElement('div');
    canvas.innerHTML = '<div class="gutter"></div><div data-strip="main"><button data-testid="thumb"></button><button data-testid="thumb"></button><button data-testid="thumb"></button></div>';
    const rect = (left: number) => ({ left, right: left + 100, top: 0, bottom: 0, width: 100, height: 0, x: left, y: 0, toJSON: () => ({}) });
    canvas.querySelector('.gutter')!.getBoundingClientRect = () => rect(44);
    canvas.querySelectorAll('[data-testid="thumb"]').forEach((t, i) => {
      t.getBoundingClientRect = () => rect(150 + i * 108);
    });
    canvas.scrollLeft = 0;
    revealColumn(canvas, 2);
    // The gutter ends at 144, its row starts 6px further: column 2 at 366 needs 216px.
    expect(canvas.scrollLeft).toBe(216);
  });

  it('a range opens the panel at its first column on the global thread, showing only the turns about that range', async () => {
    m.getRemarks.mockResolvedValue([remark('r_in', { kind: 'slide', slide: 's3' }), remark('r_out', { kind: 'slide', slide: 's6' })]);
    m.getThread.mockImplementation(async (key: string) =>
      key === 'global'
        ? [
            msg('u_range', 'user', { kind: 'range', from: 's2', to: 's4' }, '2026-09-30T00:00:01.000Z'),
            msg('a_range', 'assistant', null, '2026-09-30T00:00:02.000Z'),
            msg('u_deck', 'user', { kind: 'arc' }, '2026-09-30T00:00:03.000Z'),
          ]
        : [],
    );
    await mounted();
    fireEvent.click(thumb('s2'));
    fireEvent.click(thumb('s4'), { shiftKey: true });
    const p = await waitFor(() => (panel()?.getAttribute('data-kind') === 'range' ? panel() : null));
    expect(p.getAttribute('data-slide')).toBe('s2');
    expect(p.closest('[data-testid="selection-slot"]')!.getAttribute('data-col')).toBe('1');
    expect(within(p).getByTestId('thread').getAttribute('data-thread')).toBe('global');
    await waitFor(() => within(p).queryAllByTestId('thread-message').length === 2);
    expect(within(p).getAllByTestId('thread-message').map((x) => x.textContent)).toEqual([expect.stringContaining('text u_range'), expect.stringContaining('text a_range')]);
    expect(within(p).getAllByTestId('post-it').map((x) => x.getAttribute('data-remark'))).toEqual(['r_in']);
    fireEvent.change(within(p).getByLabelText('message'), { target: { value: 'merge them' } });
    fireEvent.click(within(p).getByRole('button', { name: 'Send' }));
    expect(m.postMessage).toHaveBeenCalledWith('global', 'merge them', { kind: 'range', from: 's2', to: 's4' });
  });

  it('Escape, an empty composer Escape and a click on empty canvas close it; a click inside it does not', async () => {
    await mounted();
    fireEvent.click(thumb('s3'));
    let p = await waitFor(() => panel());
    fireEvent.click(within(p).getByRole('log'));
    expect(panel()).not.toBeNull();
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(panel()).toBeNull();

    fireEvent.click(thumb('s3'));
    p = await waitFor(() => panel());
    const input = within(p).getByLabelText('message');
    fireEvent.change(input, { target: { value: 'half written' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(panel()).not.toBeNull();
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(panel()).toBeNull();

    fireEvent.click(thumb('s3'));
    await waitFor(() => panel());
    fireEvent.click(screen.getByTestId('canvas'));
    expect(panel()).toBeNull();
    expect(pressed()).toEqual([]);
  });

  it('a pointer selection puts the caret in the panel composer; Enter on the body still opens the slide', async () => {
    await mounted();
    fireEvent.click(thumb('s4'), { detail: 1 });
    const p = await waitFor(() => panel());
    expect(document.activeElement).toBe(within(p).getByLabelText('message'));
    fireEvent.keyDown(document.body, { key: 'Enter' });
    expect(location.pathname).toBe('/slide/s4');
  });

  it('Enter in the empty composer opens the slide; with a message written it sends it', async () => {
    await mounted();
    fireEvent.click(thumb('s4'), { detail: 1 });
    const p = await waitFor(() => panel());
    const input = within(p).getByLabelText('message');
    fireEvent.change(input, { target: { value: 'tighter' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(location.pathname).toBe('/');
    fireEvent.change(input, { target: { value: '' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(location.pathname).toBe('/slide/s4');
  });

  it('a ?select= on load opens the panel without taking the focus', async () => {
    history.replaceState(null, '', '/?select=s2');
    await mounted();
    const p = await waitFor(() => panel());
    expect(p.getAttribute('data-slide')).toBe('s2');
    expect(within(p).getByLabelText('message')).not.toBe(document.activeElement);
  });

  it('frozen layout: the whole-deck bar keeps its width whatever the selection, and only its own toggle collapses it', async () => {
    await mounted();
    const bar = () => screen.queryByTestId('thread-panel');
    const rail = () => screen.queryByTestId('thread-rail');
    expect(bar()!.style.width).toBe('360px');
    expect(bar()!.style.flex).toBe('0 0 360px');
    fireEvent.click(thumb('s3'));
    await waitFor(() => panel());
    // Selecting never resizes the strip: the bar stays, at the same width.
    expect(bar()!.style.width).toBe('360px');
    expect(rail()).toBeNull();
    const hide = within(bar()!).getByRole('button', { name: 'hide the whole-deck conversation' });
    expect(hide.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(hide);
    expect(bar()).toBeNull();
    expect(rail()!.style.width).toBe('40px');
    // Clearing the selection does not reopen it either.
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(panel()).toBeNull();
    expect(bar()).toBeNull();
    const show = within(rail()!).getByRole('button', { name: 'whole deck' });
    expect(show.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(show);
    expect(bar()!.style.width).toBe('360px');

    // The choice is kept for the session.
    fireEvent.click(within(bar()!).getByRole('button', { name: 'hide the whole-deck conversation' }));
    cleanup();
    await mounted();
    expect(bar()).toBeNull();
    expect(rail()).not.toBeNull();
  });

  it('frozen layout: lane and strip columns keep their x when a slide is selected', async () => {
    // jsdom lays nothing out: what places the columns is the canvas box, its rows and the strip's own styles, and the
    // bar beside the canvas. None of them may change on a selection.
    const xs = (): string => {
      const canvas = screen.getByTestId('canvas');
      return [canvas, canvas.firstElementChild as HTMLElement, document.querySelector<HTMLElement>('[data-strip="main"]')!, canvas.parentElement!, document.querySelector<HTMLElement>('aside')!]
        .map((el) => `${el.getAttribute('style')}|${el.className}`)
        .join(';');
    };
    await mounted();
    const before = { xs: xs(), bar: screen.getByTestId('thread-panel').getAttribute('style') };
    fireEvent.click(thumb('s4'));
    await waitFor(() => panel());
    expect(screen.getByTestId('thread-panel').getAttribute('style')).toBe(before.bar);
    expect(xs()).toBe(before.xs);
  });
});

describe('Main panel QA3', () => {
  const themeCss = (): string => readFileSync(join(process.cwd(), 'web/src/theme.css'), 'utf8');
  const emit = (e: unknown) => act(() => m.handlers.forEach((h) => h(e)));

  it('a reply that opens a lane for the selected slide carries its proposal card in the panel; the lane row mirrors it, flashed, without stealing the scroll', async () => {
    const lane: Lane = {
      id: 'l_new', label: 'One home', anchor: { kind: 'slide', slide: 's3' }, origin: 'user', baseVersion: 3, status: 'open', createdAt: '2026-09-30T10:00:02.000Z',
      changes: [{ id: 'c1', kind: 'modify', slide: 's3', patch: { title: 'One home already exists' }, reason: 'one idea', status: 'pending' }],
    };
    const preview = { order, slides: { ...deck.slides, s3: { ...deck.slides.s3!, title: 'One home already exists' } }, skipped: [], thumbs: { s3: { hash: 'lane_s3', ready: true } } };
    m.getLane.mockResolvedValue(lane);
    m.getLanePreview.mockResolvedValue(preview);
    const stored: ThreadMessage[] = [];
    m.getThread.mockImplementation(async (key: string) => (key === 'slide:s3' ? [...stored] : []));
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    try {
      await mounted();
      fireEvent.click(thumb('s3'));
      const p = await waitFor(() => panel());
      fireEvent.change(within(p).getByLabelText('message'), { target: { value: 'one idea' } });
      fireEvent.click(within(p).getByRole('button', { name: 'Send' }));
      await waitFor(() => m.postMessage.mock.calls.length === 1);
      m.getLanes.mockResolvedValue([lane]);
      emit({ type: 'lane.created', laneId: 'l_new' });
      stored.push(
        { id: 'u1', thread: 'slide:s3', role: 'user', text: 'one idea', context: { kind: 'slide', slide: 's3' }, at: '2026-09-30T10:00:00.000Z' },
        { id: 'a1', thread: 'slide:s3', role: 'assistant', text: 'Opened a lane.', context: null, at: '2026-09-30T10:00:05.000Z' },
      );
      emit({ type: 'assistant.done', thread: 'slide:s3', messageId: 'a1' });
      const card = await waitFor(() => within(p).queryByTestId('thread-proposal'));
      const reply = within(p).getAllByTestId('thread-message').find((x) => x.getAttribute('data-role') === 'assistant')!;
      expect(reply.contains(card)).toBe(true);
      const line = await waitFor(() => within(card).queryByTestId('field-diff'));
      expect(line.textContent).toBe('title: Title s3 → One home already exists');
      expect(within(card).getByRole('button', { name: 'accept' })).toBeTruthy();
      expect(within(card).getByRole('button', { name: 'refuse' })).toBeTruthy();
      expect(within(card).getByRole('link', { name: 'open in focus' })).toBeTruthy();
      // The lane row is a mirror: there, flashed, and the canvas did not jump to it.
      const row = await waitFor(() => document.getElementById('lane-row-l_new'));
      expect(row.getAttribute('data-flash')).toBe('true');
      expect(scrolled.mock.contexts.some((el) => (el as HTMLElement).id === 'lane-row-l_new')).toBe(false);
      // "lane: <label>" brings the mirror into view on demand.
      fireEvent.click(within(card).getByRole('button', { name: 'lane: One home' }));
      expect(scrolled.mock.contexts.some((el) => (el as HTMLElement).id === 'lane-row-l_new')).toBe(true);
    } finally {
      delete (Element.prototype as { scrollIntoView?: unknown }).scrollIntoView;
    }
  });

  it('the panel lists 3 remarks, then "N more remarks" grows the list in place; no inner scroll box clips a card', async () => {
    m.getRemarks.mockResolvedValue(['a', 'b', 'c', 'd', 'e'].map((x) => remark(`r_${x}`, { kind: 'slide', slide: 's3' })));
    await mounted();
    fireEvent.click(thumb('s3'));
    const p = await waitFor(() => panel());
    await waitFor(() => within(p).queryAllByTestId('post-it').length === 3);
    const more = within(p).getByRole('button', { name: '2 more remarks' });
    expect(more.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(more);
    expect(within(p).getAllByTestId('post-it')).toHaveLength(5);
    fireEvent.click(within(p).getByRole('button', { name: 'show fewer' }));
    expect(within(p).getAllByTestId('post-it')).toHaveLength(3);
    // The list itself never scrolls (a hidden overflow cut cards); the panel as a whole scrolls past its max height.
    const css = themeCss();
    expect(css).not.toMatch(/\.panel-remarks \{[^}]*(max-height|overflow)/);
    expect(css).toMatch(/\.selection-panel \{[^}]*overflow-y: auto/);
  });

  it('a panel taller than its max height shows a bottom fade until scrolled to its end', async () => {
    const sh = Object.getOwnPropertyDescriptor(Element.prototype, 'scrollHeight')!;
    const ch = Object.getOwnPropertyDescriptor(Element.prototype, 'clientHeight')!;
    const isPanel = (el: Element) => el.getAttribute('data-testid') === 'selection-panel';
    Object.defineProperty(Element.prototype, 'scrollHeight', { configurable: true, get(this: Element) { return isPanel(this) ? 900 : 0; } });
    Object.defineProperty(Element.prototype, 'clientHeight', { configurable: true, get(this: Element) { return isPanel(this) ? 500 : 0; } });
    try {
      await mounted();
      fireEvent.click(thumb('s3'));
      const p = await waitFor(() => panel());
      await waitFor(() => within(p).queryByTestId('panel-fade'));
      p.scrollTop = 400;
      fireEvent.scroll(p);
      await waitFor(() => within(p).queryByTestId('panel-fade') === null);
    } finally {
      Object.defineProperty(Element.prototype, 'scrollHeight', sh);
      Object.defineProperty(Element.prototype, 'clientHeight', ch);
    }
  });

  it('a panel whose slide pages out of view folds to a one-line bar at the strip\'s left edge; "show" brings the column back', async () => {
    const rect = (left: number, width: number) => ({ left, right: left + width, top: 0, bottom: 50, width, height: 50, x: left, y: 0, toJSON: () => ({}) });
    const gbcr = Element.prototype.getBoundingClientRect;
    const cw = Object.getOwnPropertyDescriptor(Element.prototype, 'clientWidth')!;
    // Columns 0-2 sit under the gutter (the strip paged on): slides 4-6 are in view.
    Element.prototype.getBoundingClientRect = function (this: Element) {
      if (this.getAttribute('data-testid') === 'canvas') return rect(0, 1000);
      if (this.classList.contains('gutter')) return rect(24, 120);
      if (this.getAttribute('data-testid') === 'thumb' && this.closest('[data-strip="main"]')) {
        const i = order.indexOf(this.getAttribute('data-slide')!);
        return rect(150 + (i - 3) * 108, 100);
      }
      return rect(0, 0);
    };
    Object.defineProperty(Element.prototype, 'clientWidth', { configurable: true, get(this: Element) { return this.getAttribute('data-testid') === 'canvas' ? 1000 : 0; } });
    try {
      await mounted();
      const canvas = screen.getByTestId('canvas');
      canvas.scrollLeft = 400;
      fireEvent.click(thumb('s1'));
      const bar = await waitFor(() => screen.queryByTestId('panel-bar'));
      // No panel holding its height off-screen.
      expect(panel()).toBeNull();
      expect(bar.textContent).toContain('conversation about slide 1');
      fireEvent.click(within(bar).getByRole('button', { name: 'show' }));
      // revealColumn(0): slide 1 at -174 comes to the row start (150): 324px back.
      expect(canvas.scrollLeft).toBe(76);
      expect(pressed()).toEqual(['s1']);
    } finally {
      Element.prototype.getBoundingClientRect = gbcr;
      Object.defineProperty(Element.prototype, 'clientWidth', cw);
    }
  });

  it('severity words are plain muted text with a tooltip, never a control; a click on the text toggles it whole', async () => {
    m.getRemarks.mockResolvedValue([{ ...remark('r_i', { kind: 'slide', slide: 's3' }), severity: 'info' }, remark('r_w', { kind: 'slide', slide: 's3' })]);
    await mounted();
    fireEvent.click(thumb('s3'));
    const p = await waitFor(() => panel());
    await waitFor(() => within(p).queryAllByTestId('post-it').length === 2);
    for (const tag of within(p).getAllByTestId('severity-tag')) {
      expect(tag.tagName).toBe('SPAN');
      expect(tag.getAttribute('role')).toBeNull();
      expect(tag.getAttribute('tabindex')).toBeNull();
      expect(tag.closest('button')).toBeNull();
      expect(tag.className).toContain('meta');
      expect(tag.style.color).toBe('');
      expect(tag.getAttribute('title')).toMatch(/\w/);
    }
    expect(within(p).queryByRole('button', { name: /^(info|warn)$/ })).toBeNull();
    const text = within(within(p).getAllByTestId('post-it')[0]!).getByTestId('remark-text');
    fireEvent.click(text);
    expect(text.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(text);
    expect(text.getAttribute('aria-expanded')).toBe('false');
  });
});
