// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import type { DeckPayload, LanePreviewPayload } from '../../web/src/api.js';
import type { Change, Lane, Slide, SlideId, ThreadMessage } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const m = vi.hoisted(() => ({
  getDeck: vi.fn(),
  getLanes: vi.fn(),
  getLane: vi.fn(),
  getLanePreview: vi.fn(),
  thumbFor: vi.fn(),
  getThread: vi.fn(),
  acceptChange: vi.fn(),
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
    threadApi: {
      getThread: (key: string) => m.getThread(key),
      postMessage: vi.fn(),
      getLane: (id: string) => m.getLane(id),
      getLanePreview: (id: string) => m.getLanePreview(id),
      thumbFor: (id: SlideId) => m.thumbFor(id),
      acceptChange: (laneId: string, changeId: string) => m.acceptChange(laneId, changeId),
      refuseChange: vi.fn(),
    },
    laneApi: { acceptChange: vi.fn(), refuseChange: vi.fn(), discardLane: vi.fn() },
    subscribe: () => () => undefined,
  };
});

const { Main } = await import('../../web/src/screens/Main.js');

const EMPTY_HINT = 'Describe the talk to the co-author on the right: it proposes an outline as a lane you accept slide by slide.';
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
  m.getThread.mockReset().mockImplementation(async () => []);
  m.acceptChange.mockReset();
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

describe('QA5: the empty deck header, plurals, the outline receipt on main', () => {
  it('Present and Brief and checks are muted, not links, titled "no slides yet"', async () => {
    render(<Main />);
    await screen.findByText(EMPTY_HINT);
    for (const id of ['header-present', 'header-brief']) {
      const el = screen.getByTestId(id);
      expect(el.getAttribute('aria-disabled')).toBe('true');
      expect(el.getAttribute('title')).toBe('no slides yet');
      expect(el.hasAttribute('href')).toBe(false);
    }
    expect(screen.getByTestId('header-present').textContent).toBe('Present');
    // "No slides yet" sits right of the empty gutter, on the title column, not in the gutter.
    const label = screen.getByTestId('no-slides');
    expect(label.closest('.gutter')).toBeNull();
    expect(label.closest('[data-strip="main"]')!.previousElementSibling!.className).toBe('gutter');
  });

  it('"1 slide", "2 slides" next to the version; with slides Present is a link again', async () => {
    m.getDeck.mockImplementation(async () => ({ ...emptyDeck, order: ['n1'], slides: { n1: slide('n1') } }));
    render(<Main />);
    await waitFor(() => screen.queryByTestId('slide-count')?.textContent === '1 slide');
    expect(screen.getByTestId('header-present').getAttribute('href')).toBeTruthy();
    expect(screen.getByTestId('header-present').hasAttribute('aria-disabled')).toBe(false);
    cleanup();
    m.getDeck.mockImplementation(async () => ({ ...emptyDeck, order: ['n1', 'n2'], slides: { n1: slide('n1'), n2: slide('n2') } }));
    render(<Main />);
    await waitFor(() => screen.queryByTestId('slide-count')?.textContent === '2 slides');
  });

  it('a 10-insert outline answered in the whole-deck thread is one receipt; "open on the strip" scrolls to its row and flashes it', async () => {
    const inserts: Change[] = Array.from({ length: 10 }, (_, i) => ({
      id: `c${i + 1}`, kind: 'insert', after: i === 0 ? null : `n${i}`, slide: slide(`n${i + 1}`), reason: `slide ${i + 1}`, status: 'pending',
    }));
    const ten: Lane = { ...outline, changes: inserts, createdAt: '2026-09-30T10:00:02.000Z' };
    lanes = [ten];
    m.getLanePreview.mockImplementation(async () => ({ order: inserts.map((c) => (c.kind === 'insert' ? c.slide.id : '')), slides: {}, skipped: [], thumbs: {} }));
    const stored: ThreadMessage[] = [
      { id: 'u1', thread: 'global', role: 'user', text: 'Draft the outline: 10 slides', context: { kind: 'arc' }, at: '2026-09-30T10:00:00.000Z' },
      { id: 'a1', thread: 'global', role: 'assistant', text: 'Here it is.', context: null, at: '2026-09-30T10:05:00.000Z' },
    ];
    m.getThread.mockImplementation(async () => stored);
    const scrolled = vi.fn();
    Element.prototype.scrollIntoView = scrolled;
    render(<Main />);
    const head = await waitFor(() => screen.queryByTestId('receipt-head'));
    expect(head.textContent).toBe('lane: first outline, 10 inserts');
    expect(screen.getAllByTestId('receipt-line')).toHaveLength(10);
    expect(screen.queryAllByTestId('proposal-change')).toHaveLength(0);
    await waitFor(() => screen.queryByTestId('lane-row'));
    scrolled.mockClear();
    fireEvent.click(screen.getByRole('button', { name: 'open on the strip' }));
    const row = screen.getByTestId('lane-row');
    expect(scrolled.mock.contexts).toContain(row);
    await waitFor(() => row.getAttribute('data-flash') === 'true');
  });
});
