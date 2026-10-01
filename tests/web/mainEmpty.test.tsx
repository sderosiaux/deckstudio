// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, render, screen, within } from '@testing-library/react';
import type { DeckPayload, LanePreviewPayload } from '../../web/src/api.js';
import type { Lane, Slide, SlideId } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({
  getDeck: vi.fn(),
  getLanes: vi.fn(),
  getLane: vi.fn(),
  getLanePreview: vi.fn(),
  thumbFor: vi.fn(),
}));

vi.mock('../../web/src/api.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../web/src/api.js')>();
  return {
    ...real,
    getDeck: m.getDeck,
    getVersions: async () => [{ n: 0, order: [], slides: {}, cause: { kind: 'import' }, createdAt: '2026-09-30T00:00:00.000Z' }],
    getLanes: m.getLanes,
    openLane: vi.fn(),
    getLane: m.getLane,
    getLanePreview: m.getLanePreview,
    thumbFor: m.thumbFor,
    getRemarks: async () => [],
    openPlayer: vi.fn(),
    remarkApi: { proposeRemark: vi.fn(), resolveRemark: vi.fn() },
    threadApi: { getThread: async () => [], postMessage: vi.fn() },
    laneApi: { acceptChange: vi.fn(), refuseChange: vi.fn(), discardLane: vi.fn() },
    subscribe: () => () => undefined,
  };
});

const { Main } = await import('../../web/src/screens/Main.js');

const EMPTY_HINT = 'Describe the talk to the co-author below: it proposes an outline as a lane you accept slide by slide.';
const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: '', notes: '', body: `<p>${id}</p>`, assets: [], kind: 'text' });
const emptyDeck: DeckPayload = {
  state: { name: 'onboarding', order: [], version: 0, sessionId: null, model: 'm' },
  brief: { title: 'Onboarding engineers in a week', audience: '', message: '', pattern: 'solution-first', abstract: '', design: { rules: '', imageStyle: '' } },
  order: [],
  slides: {},
};
const outline: Lane = {
  id: 'outline',
  label: 'first outline',
  anchor: { kind: 'arc' },
  origin: 'user',
  baseVersion: 0,
  changes: [
    { id: 'c1', kind: 'insert', after: null, slide: slide('n1'), reason: 'opening', status: 'pending' },
    { id: 'c2', kind: 'insert', after: 'n1', slide: slide('n2'), reason: 'middle', status: 'pending' },
    { id: 'c3', kind: 'insert', after: 'n2', slide: slide('n3'), reason: 'close', status: 'pending' },
  ],
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
};
const outlinePreview: LanePreviewPayload = {
  order: ['n1', 'n2', 'n3'],
  slides: { n1: slide('n1'), n2: slide('n2'), n3: slide('n3') },
  skipped: [],
  thumbs: { n1: { hash: 'h1', ready: true }, n2: { hash: 'h2', ready: true }, n3: { hash: 'h3', ready: true } },
};

let lanes: Lane[] = [];
beforeEach(() => {
  sessionStorage.clear();
  lanes = [];
  m.getDeck.mockReset().mockImplementation(async () => emptyDeck);
  m.getLanes.mockReset().mockImplementation(async (status?: string) => (status === undefined ? lanes : []));
  m.getLane.mockReset().mockImplementation(async (id: string) => lanes.find((l) => l.id === id));
  m.getLanePreview.mockReset().mockImplementation(async () => outlinePreview);
  m.thumbFor.mockReset().mockImplementation(async (id: SlideId) => ({ hash: `h_${id}`, ready: true }));
});
afterEach(() => cleanup());

describe('Main on an empty deck', () => {
  it('names the empty strip, says what to do in one line, and puts the caret in the whole-deck composer', async () => {
    // Folded on an earlier deck: an empty deck opens it anyway, the composer is the only way to start.
    sessionStorage.setItem('deckstudio.wholeDeck', 'closed');
    render(<Main />);
    await screen.findByText(EMPTY_HINT);
    const strip = screen.getByTestId('strip-header');
    expect(within(strip).getByText('No slides yet')).toBeTruthy();
    expect(screen.queryAllByTestId('thumb')).toHaveLength(0);
    expect(screen.queryByText(/No open lanes/)).toBeNull();
    const panel = screen.getByTestId('thread-panel');
    await waitFor(() => !!document.activeElement?.matches('input, textarea') && panel.contains(document.activeElement));
    expect(screen.getByText('0 slides')).toBeTruthy();
  });

  it('lays an outline lane of inserts from the first column', async () => {
    lanes = [outline];
    render(<Main />);
    await waitFor(() => screen.queryAllByTestId('lane-cell').length === 3);
    const cells = screen.getAllByTestId('lane-cell');
    expect(cells.map((c) => [c.getAttribute('data-slide'), c.getAttribute('data-col'), c.getAttribute('data-mark')])).toEqual([
      ['n1', '0', 'inserted'],
      ['n2', '1', 'inserted'],
      ['n3', '2', 'inserted'],
    ]);
    expect(cells[0]!.style.gridColumn).toBe('1');
    // The strip row stays named; the hint gives way to the proposal it announced.
    expect(within(screen.getByTestId('strip-header')).getByText('No slides yet')).toBeTruthy();
    expect(screen.queryByText(EMPTY_HINT)).toBeNull();
  });
});
