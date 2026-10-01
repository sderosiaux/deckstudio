// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DeckPayload } from '../../web/src/api.js';
import type { Remark, Slide, SlideId, ThreadMessage } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({
  handlers: [] as Array<(e: unknown) => void>,
  getThread: vi.fn(),
  postMessage: vi.fn(),
  getRemarks: vi.fn(),
  proposeRemark: vi.fn(),
  resolveRemark: vi.fn(),
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
    getLanes: async () => [],
    getLane: vi.fn(),
    getLanePreview: vi.fn(),
    thumbFor: async (id: SlideId) => ({ hash: `h_${id}`, ready: true }),
    getRemarks: m.getRemarks,
    openLane: vi.fn(),
    openPlayer: vi.fn(),
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

  it("the selected slide's remark lives in the panel only; the others stay pinned", async () => {
    m.getRemarks.mockResolvedValue([remark('r_s3', { kind: 'slide', slide: 's3' }), remark('r_s6', { kind: 'slide', slide: 's6' })]);
    await mounted();
    await waitFor(() => screen.queryByTestId('remark-count')?.textContent === '2 open remarks');
    fireEvent.click(thumb('s3'));
    const p = await waitFor(() => panel());
    const inPanel = within(p).getAllByTestId('post-it').map((x) => x.getAttribute('data-remark'));
    expect(inPanel).toEqual(['r_s3']);
    const pinned = within(screen.getByTestId('post-its')).getAllByTestId('post-it').map((x) => x.getAttribute('data-remark'));
    expect(pinned).toEqual(['r_s6']);
    expect(screen.getAllByTestId('post-it').filter((x) => x.getAttribute('data-remark') === 'r_s3')).toHaveLength(1);
    fireEvent.click(within(within(p).getByTestId('post-it')).getByRole('button', { name: 'propose' }));
    expect(m.proposeRemark).toHaveBeenCalledWith('r_s3');
    // The propose note shows in the panel while the right bar is a rail.
    await waitFor(() => within(p).queryByTestId('propose-note'));
    expect(pressed()).toEqual(['s3']);
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

  it('a ?select= on load opens the panel without taking the focus', async () => {
    history.replaceState(null, '', '/?select=s2');
    await mounted();
    const p = await waitFor(() => panel());
    expect(p.getAttribute('data-slide')).toBe('s2');
    expect(within(p).getByLabelText('message')).not.toBe(document.activeElement);
  });

  it('with a selection the right bar is a rail; "whole deck" reopens it, the choice kept for the session', async () => {
    await mounted();
    fireEvent.click(thumb('s3'));
    await waitFor(() => panel());
    expect(screen.queryByTestId('thread-panel')).toBeNull();
    const rail = screen.getByTestId('thread-rail');
    fireEvent.click(within(rail).getByRole('button', { name: 'whole deck' }));
    const bar = screen.getByTestId('thread-panel');
    expect(within(bar).getByTestId('thread').getAttribute('data-thread')).toBe('global');
    expect(within(bar).getByTestId('context-chip').getAttribute('data-kind')).toBe('arc');
    expect(panel()).not.toBeNull();

    cleanup();
    await mounted();
    fireEvent.click(thumb('s2'));
    await waitFor(() => panel());
    expect(screen.queryByTestId('thread-panel')).not.toBeNull();
    fireEvent.click(within(screen.getByTestId('thread-panel')).getByRole('button', { name: 'collapse' }));
    expect(screen.queryByTestId('thread-panel')).toBeNull();
    expect(screen.getByTestId('thread-rail')).toBeTruthy();
  });
});
