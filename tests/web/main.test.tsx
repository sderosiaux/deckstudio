// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { BusEvent, DeckPayload, LanePreviewPayload } from '../../web/src/api.js';
import type { Change, Lane, Slide, SlideId } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({
  handlers: [] as Array<(e: unknown) => void>,
  getDeck: vi.fn(),
  getVersions: vi.fn(),
  getLanes: vi.fn(),
  getLane: vi.fn(),
  getLanePreview: vi.fn(),
  thumbFor: vi.fn(),
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
    getLane: m.getLane,
    getLanePreview: m.getLanePreview,
    thumbFor: m.thumbFor,
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
const hashOf = (id: SlideId): string => `h_${id}_${(deck.slides[id]?.body ?? '').length}`;

const emit = (e: BusEvent) => act(() => m.handlers.forEach((h) => h(e)));
const callsFor = (fn: ReturnType<typeof vi.fn>, arg: string): number => fn.mock.calls.filter((c) => c[0] === arg).length;

beforeEach(() => {
  deck = deckV(3, mainSlides);
  m.handlers = [];
  m.getDeck.mockReset().mockImplementation(async () => deck);
  m.getVersions.mockReset().mockResolvedValue([]);
  m.getLanes.mockReset().mockImplementation(async () => lanes);
  m.getLane.mockReset().mockImplementation(async (id: string) => lanes.find((l) => l.id === id));
  m.getLanePreview.mockReset().mockImplementation(async (id: string) => previewOf(id, id === 'l1' ? 's3' : 's5'));
  m.thumbFor.mockReset().mockImplementation(async (id: SlideId) => ({ hash: hashOf(id), ready: true }));
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
    const lanesBefore = m.getLanes.mock.calls.length;
    emit({ type: 'lane.updated', laneId: 'l1' });
    emit({ type: 'lane.updated', laneId: 'l1' });
    await waitFor(() => callsFor(m.getLanePreview, 'l1') === 2);
    // A later event for l2 flushes after any leftover l1 work would have.
    emit({ type: 'lane.updated', laneId: 'l2' });
    await waitFor(() => callsFor(m.getLanePreview, 'l2') === 2);
    expect(callsFor(m.getLanePreview, 'l1')).toBe(2);
    expect(callsFor(m.getLane, 'l1')).toBe(1);
    expect(m.getLanes.mock.calls.length).toBe(lanesBefore);
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
    expect(m.getLanes.mock.calls.length).toBe(1);

    emit({ type: 'hello', version: null });
    await waitFor(() => m.getDeck.mock.calls.length === 2 && m.getLanes.mock.calls.length === 2);
    await waitFor(() => m.getThread.mock.calls.length === 4);
  });

  it('resyncs when the server hello reports another version than the one shown', async () => {
    await mounted();
    emit({ type: 'hello', version: 9 });
    await waitFor(() => m.getDeck.mock.calls.length === 2 && m.getLanes.mock.calls.length === 2);
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
