// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Slide as SlideScreen } from '../../web/src/screens/Slide.js';
import type { BusEvent, DeckPayload, LanePreviewPayload, SlideApi } from '../../web/src/api.js';
import type { Change, Lane, Slide, SlideId, Version } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: `story of ${id}`,
  notes: `notes of ${id}`,
  body: `<p>${id}</p>`,
  assets: [],
  kind: 'text',
  ...over,
});
const order: SlideId[] = ['s1', 's2', 's3', 's4', 's5'];
const slides: Record<SlideId, Slide> = Object.fromEntries(order.map((id) => [id, slide(id)]));
const deckOf = (s: Record<SlideId, Slide> = slides, version = 3): DeckPayload => ({
  state: { name: 'd', order, version, sessionId: null, model: 'm' },
  brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '', design: { rules: '', imageStyle: '' } },
  order,
  slides: s,
});

const change = (id: string, s: SlideId, over: Partial<Change> = {}): Change =>
  ({ id, kind: 'modify', slide: s, patch: { title: `New ${s}` }, reason: `sharper claim on ${s}`, status: 'pending', ...over }) as Change;
const mkLane = (id: string, label: string, anchor: Lane['anchor'], changes: Change[]): Lane => ({
  id,
  label,
  anchor,
  origin: 'user',
  baseVersion: 3,
  changes,
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
});

const onS3 = mkLane('l1', 'Sharper claim', { kind: 'slide', slide: 's3' }, [change('c1', 's3')]);
const rangeTouchingS3 = mkLane('l2', 'Tighter middle', { kind: 'range', from: 's2', to: 's4' }, [
  change('c2', 's2'),
  { id: 'c3', kind: 'move', slide: 's3', after: 's4', reason: 'the payoff comes later', status: 'pending' },
]);
const elsewhere = mkLane('l3', 'Closing', { kind: 'slide', slide: 's5' }, [change('c4', 's5')]);
const decidedOnS3 = mkLane('l4', 'Old take', { kind: 'slide', slide: 's3' }, [change('c5', 's3', { status: 'accepted' })]);

/** The lane's preview: s3 rendered under its own hash when the lane modifies it. */
const previewOf = (lane: Lane): LanePreviewPayload => ({
  order,
  slides: { ...slides, s3: slide('s3', { title: `${lane.label} s3` }) },
  skipped: [],
  thumbs: { s3: { hash: `${lane.id}_s3`, ready: true } },
});

function setup(opts: { lanes?: Lane[]; deck?: DeckPayload } = {}) {
  let lanes = opts.lanes ?? [onS3, rangeTouchingS3, elsewhere, decidedOnS3];
  let deck = opts.deck ?? deckOf();
  const handlers = new Set<(e: BusEvent) => void>();
  const api = {
    getDeck: vi.fn(async () => deck),
    getLanes: vi.fn(async () => lanes),
    getLane: vi.fn(async (id: string) => lanes.find((l) => l.id === id)!),
    getLanePreview: vi.fn(async (id: string) => previewOf(lanes.find((l) => l.id === id)!)),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h_${id}`, ready: true })),
    acceptChange: vi.fn(async (): Promise<{ version: Version; lane: Lane }> => ({ version: { n: 4, order, slides: {}, cause: { kind: 'import' }, createdAt: '' }, lane: onS3 })),
    refuseChange: vi.fn(async (): Promise<Lane> => onS3),
    discardLane: vi.fn(async () => undefined),
    getThread: vi.fn(async () => []),
    postMessage: vi.fn(async () => undefined),
  } satisfies SlideApi;
  const subscribe = (h: (e: BusEvent) => void) => {
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  };
  const emit = (e: BusEvent) => act(() => handlers.forEach((h) => h(e)));
  const navigate = vi.fn();
  return {
    api,
    subscribe,
    emit,
    navigate,
    setLanes: (l: Lane[]) => {
      lanes = l;
    },
    setDeck: (d: DeckPayload) => {
      deck = d;
    },
  };
}

const crumb = (): string => screen.queryByTestId('slide-crumb')?.textContent ?? '';
const laneRows = (): HTMLElement[] => screen.queryAllByTestId('slide-lane');
const stage = (): HTMLElement | null => screen.queryByTestId('slide-stage')?.querySelector('[data-testid="slide-preview"]') ?? null;
const pressed = (): string | undefined =>
  within(screen.getByTestId('slide-toggle'))
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent ?? undefined;

afterEach(() => cleanup());

describe('Slide screen', () => {
  it('loads the slide large, its story and notes, and every open lane with a live change on it', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb() === 'slide 3 of 5, Title s3');
    await waitFor(() => stage()?.querySelector('img'));
    expect(stage()!.querySelector('img')!.getAttribute('src')).toBe('/api/thumbs/h_s3.png');
    expect(t.api.thumbFor).toHaveBeenCalledWith('s3');
    expect(screen.getByTestId('slide-story').textContent).toContain('story of s3');
    expect(screen.getByTestId('slide-notes').textContent).toContain('notes of s3');

    await waitFor(() => laneRows().length === 2);
    expect(laneRows().map((r) => r.getAttribute('data-lane'))).toEqual(['l1', 'l2']);
    const [first, second] = laneRows();
    expect(first!.textContent).toContain('Sharper claim');
    expect(first!.textContent).toContain('modify');
    expect(first!.textContent).toContain('sharper claim on s3');
    // Only the change on this slide: the range lane's change on s2 is not listed here.
    expect(within(second!).getAllByTestId('change-buttons').map((b) => b.getAttribute('data-change'))).toEqual(['c3']);
    expect(second!.textContent).toContain('move');
    expect(second!.textContent).toContain('the payoff comes later');
  });

  it('says so when no open lane touches the slide', async () => {
    const t = setup({ lanes: [elsewhere] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-lanes-empty'));
    expect(laneRows()).toHaveLength(0);
  });

  it('posts to the slide:<id> thread with the slide as fixed context, no clear button', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('thread'));
    expect(screen.getByTestId('thread').getAttribute('data-thread')).toBe('slide:s3');
    expect(screen.getByTestId('thread').getAttribute('data-layout')).toBe('inline');
    expect(screen.queryByLabelText('clear context')).toBeNull();
    await waitFor(() => t.api.getThread.mock.calls.length > 0);
    expect(t.api.getThread).toHaveBeenCalledWith('slide:s3');

    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'make the claim sharper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => t.api.postMessage.mock.calls.length === 1);
    expect(t.api.postMessage).toHaveBeenCalledWith('slide:s3', 'make the claim sharper', { kind: 'slide', slide: 's3' });
  });

  it('ArrowRight and ArrowLeft go to the next and previous slide, not while typing', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb().startsWith('slide 3'));
    fireEvent.keyDown(document.body, { key: 'ArrowRight' });
    expect(t.navigate).toHaveBeenLastCalledWith('/slide/s4');
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(t.navigate).toHaveBeenLastCalledWith('/slide/s2');
    t.navigate.mockClear();
    fireEvent.keyDown(screen.getByLabelText('message'), { key: 'ArrowRight' });
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it('the header links step through the deck; none before the first slide', async () => {
    const t = setup();
    render(<SlideScreen slideId="s1" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb().startsWith('slide 1'));
    expect(screen.queryByRole('link', { name: 'previous slide' })).toBeNull();
    fireEvent.click(screen.getByRole('link', { name: 'next slide' }));
    expect(t.navigate).toHaveBeenLastCalledWith('/slide/s2');
    fireEvent.keyDown(document.body, { key: 'ArrowLeft' });
    expect(t.navigate).toHaveBeenCalledTimes(1);
  });

  it('Escape goes back to main with this slide selected', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb().startsWith('slide 3'));
    fireEvent.keyDown(document.body, { key: 'Escape' });
    expect(t.navigate).toHaveBeenLastCalledWith('/?select=s3');
  });

  it('accept and refuse on a lane row decide that change; open in focus opens it', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2);
    fireEvent.click(screen.getByLabelText('accept change c1'));
    await waitFor(() => t.api.acceptChange.mock.calls.length === 1);
    expect(t.api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    await waitFor(() => !(screen.getByLabelText('refuse change c3') as HTMLButtonElement).disabled);
    fireEvent.click(screen.getByLabelText('refuse change c3'));
    await waitFor(() => t.api.refuseChange.mock.calls.length === 1);
    expect(t.api.refuseChange).toHaveBeenCalledWith('l2', 'c3');
    fireEvent.click(within(laneRows()[0]!).getByRole('link', { name: 'open in focus' }));
    expect(t.navigate).toHaveBeenLastCalledWith('/lane/l1/change/c1');
  });

  it('lane.created for a lane on this slide reloads the list and switches the stage to its proposal', async () => {
    const t = setup({ lanes: [] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-lanes-empty'));
    expect(screen.queryByTestId('slide-toggle')).toBeNull();
    // A lane elsewhere reloads the list but changes nothing here.
    t.setLanes([elsewhere]);
    t.emit({ type: 'lane.created', laneId: 'l3' });
    await waitFor(() => t.api.getLanes.mock.calls.length === 2);
    expect(screen.queryByTestId('slide-toggle')).toBeNull();

    t.setLanes([elsewhere, onS3]);
    t.emit({ type: 'lane.created', laneId: 'l1' });
    await waitFor(() => stage()?.getAttribute('data-variant') === 'lane');
    expect(pressed()).toBe('proposed in Sharper claim');
    expect(laneRows().map((r) => r.getAttribute('data-lane'))).toEqual(['l1']);
  });

  it('lane.closed drops the row; deck.changed reloads the slide', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2);
    t.setLanes([rangeTouchingS3]);
    t.emit({ type: 'lane.closed', laneId: 'l1' });
    await waitFor(() => laneRows().length === 1);

    t.setDeck(deckOf({ ...slides, s3: slide('s3', { title: 'The log is the database', story: 'a new story' }) }, 4));
    t.emit({ type: 'deck.changed', version: 4 });
    await waitFor(() => crumb() === 'slide 3 of 5, The log is the database');
    expect(screen.getByTestId('slide-story').textContent).toContain('a new story');
    await waitFor(() => t.api.thumbFor.mock.calls.length === 2);
  });

  it('a slide no longer on main says so and links back', async () => {
    const t = setup();
    render(<SlideScreen slideId="s9" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByText(/no longer on main/));
    fireEvent.click(screen.getByRole('link', { name: 'back to main' }));
    expect(t.navigate).toHaveBeenLastCalledWith('/');
  });
  it('lays out the body column: the slide, its conversation with the composer, then story, notes and lanes on this slide; no right bar', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2);
    expect(document.querySelector('aside')).toBeNull();
    const body = screen.getByTestId('slide-body');
    const order = ['slide-stage', 'thread', 'slide-story', 'slide-notes', 'slide-lanes'].map((id) => screen.getByTestId(id));
    for (const el of order) expect(body.contains(el)).toBe(true);
    for (let i = 1; i < order.length; i++) expect(order[i - 1]!.compareDocumentPosition(order[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // the composer closes the conversation block
    const thread = screen.getByTestId('thread');
    expect(thread.lastElementChild!.tagName).toBe('FORM');
    expect(thread.contains(screen.getByLabelText('message'))).toBe(true);
  });

  it('a main | proposed toggle above the slide names each lane that changes it and swaps the render for its preview', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-toggle'));
    const toggle = screen.getByTestId('slide-toggle');
    expect(toggle.compareDocumentPosition(screen.getByTestId('slide-stage')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(within(toggle).getAllByRole('button').map((b) => b.textContent)).toEqual(['main', 'proposed in Sharper claim', 'proposed in Tighter middle']);
    expect(pressed()).toBe('main');
    await waitFor(() => stage()?.querySelector('img'));
    expect(stage()!.getAttribute('data-variant')).toBe('main');

    fireEvent.click(within(toggle).getByRole('button', { name: 'proposed in Sharper claim' }));
    await waitFor(() => stage()?.querySelector('img')?.getAttribute('src') === '/api/thumbs/l1_s3.png');
    expect(stage()!.getAttribute('data-variant')).toBe('lane');
    expect(t.api.getLanePreview).toHaveBeenCalledWith('l1');
    fireEvent.click(within(toggle).getByRole('button', { name: 'main' }));
    await waitFor(() => stage()?.querySelector('img')?.getAttribute('src') === '/api/thumbs/h_s3.png');
  });

  it('no toggle when no lane changes this slide', async () => {
    const t = setup({ lanes: [elsewhere] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-lanes-empty'));
    expect(screen.queryByTestId('slide-toggle')).toBeNull();
  });
});
