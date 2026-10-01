// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Slide as SlideScreen, nameSlides } from '../../web/src/screens/Slide.js';
import type { BusEvent, DeckPayload, LanePreviewPayload } from '../../web/src/api.js';
import type { SlideScreenApi } from '../../web/src/screens/Slide.js';
import type { Change, Lane, Remark, Slide, SlideId, ThreadMessage, Version } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

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

const remark = (id: string, anchor: Remark['anchor'], over: Partial<Remark> = {}): Remark => ({
  id,
  anchor,
  text: `remark ${id}`,
  origin: 'check:gaps',
  severity: 'warn',
  status: 'open',
  laneId: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

function setup(opts: { lanes?: Lane[]; deck?: DeckPayload; remarks?: Remark[]; drafts?: Lane[] } = {}) {
  let lanes = opts.lanes ?? [onS3, rangeTouchingS3, elsewhere, decidedOnS3];
  let deck = opts.deck ?? deckOf();
  let remarks = opts.remarks ?? [];
  const drafts = opts.drafts ?? [];
  const stored: ThreadMessage[] = [];
  const handlers = new Set<(e: BusEvent) => void>();
  const api = {
    getDeck: vi.fn(async () => deck),
    getLanes: vi.fn(async (status?: string) => (status === 'draft' ? drafts : lanes)),
    getLane: vi.fn(async (id: string) => lanes.find((l) => l.id === id)!),
    getLanePreview: vi.fn(async (id: string) => previewOf(lanes.find((l) => l.id === id)!)),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h_${id}`, ready: true })),
    acceptChange: vi.fn(async (): Promise<{ version: Version; lane: Lane }> => ({ version: { n: 4, order, slides: {}, cause: { kind: 'import' }, createdAt: '' }, lane: onS3 })),
    refuseChange: vi.fn(async (): Promise<Lane> => onS3),
    discardLane: vi.fn(async () => undefined),
    getThread: vi.fn(async () => [...stored]),
    postMessage: vi.fn(async () => undefined),
    getRemarks: vi.fn(async () => remarks),
    proposeRemark: vi.fn(async () => undefined),
    resolveRemark: vi.fn(async () => undefined),
    openLane: vi.fn(async () => undefined),
  } satisfies SlideScreenApi;
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
    setRemarks: (r: Remark[]) => {
      remarks = r;
    },
    stored,
  };
}

const crumb = (): string => screen.queryByTestId('slide-crumb')?.textContent ?? '';
const laneRows = (): HTMLElement[] => screen.queryAllByTestId('slide-lane');
const stage = (): HTMLElement | null => screen.queryByTestId('slide-stage')?.querySelector('[data-testid="slide-preview"]') ?? null;
const pressed = (): string | undefined =>
  within(screen.getByTestId('slide-toggle'))
    .getAllByRole('button')
    .find((b) => b.getAttribute('aria-pressed') === 'true')?.textContent ?? undefined;

/** Lane list reloads: the calls without a status filter (drafts are asked for with `draft`). */
const laneLoads = (api: ReturnType<typeof setup>['api']): number => api.getLanes.mock.calls.filter((c) => c[0] === undefined).length;

/** The window narrower than the two-column breakpoint: matchMedia answers false. */
const themeCss = (): string => readFileSync(join(process.cwd(), 'web/src/theme.css'), 'utf8');
const narrow = () => {
  vi.stubGlobal('matchMedia', (query: string) => ({ matches: false, media: query, addEventListener: () => undefined, removeEventListener: () => undefined }));
};

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

describe('nameSlides', () => {
  it('replaces whole slide ids by "slide N, Title"; a slide off main by its title; other words stay', () => {
    const all = { ...slides, s_gone: slide('s_gone', { title: 'Old one' }) };
    expect(nameSlides('s3 already makes it; see s_gone, not s33 or as3', order, all)).toBe('slide 3, Title s3 already makes it; see Old one, not s33 or as3');
    expect(nameSlides('nothing here', order, all)).toBe('nothing here');
  });
});

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
    // Slide ids in a reason read as the slide's number and title.
    expect(first!.textContent).toContain('sharper claim on slide 3, Title s3');
    expect(first!.textContent).not.toContain('on s3');
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
    fireEvent.click(screen.getByLabelText('accept: modify slide 3, Sharper claim s3'));
    await waitFor(() => t.api.acceptChange.mock.calls.length === 1);
    expect(t.api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    const refuseMove = () => screen.getByLabelText('refuse: move slide 3, Tighter middle s3, to 3') as HTMLButtonElement;
    await waitFor(() => !refuseMove().disabled);
    fireEvent.click(refuseMove());
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
    await waitFor(() => laneLoads(t.api) === 2);
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
  it('two columns: the render, the conversation under it, then story and notes on the left; only lanes and remarks on the right', async () => {
    const t = setup({ remarks: [remark('r1', { kind: 'slide', slide: 's3' })] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2 && screen.queryAllByTestId('post-it').length === 1);
    expect(screen.getByTestId('slide-layout').getAttribute('data-columns')).toBe('2');
    // The screen's rules live in the theme: no style element inside the content.
    expect(document.querySelector('style')).toBeNull();
    const left = screen.getByTestId('slide-body');
    const right = screen.getByTestId('slide-side');
    const seq = ['slide-toggle', 'slide-stage', 'thread', 'slide-story', 'slide-notes'].map((id) => screen.getByTestId(id));
    for (const el of seq) expect(left.contains(el)).toBe(true);
    for (let i = 1; i < seq.length; i++) expect(seq[i - 1]!.compareDocumentPosition(seq[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The conversation grows in the work column with the same composer as main's panel; never in the side column.
    const thread = screen.getByTestId('thread');
    expect(thread.getAttribute('data-layout')).toBe('inline');
    expect(thread.lastElementChild!.tagName).toBe('FORM');
    expect(right.contains(thread)).toBe(false);
    expect(right.querySelector('[aria-label="conversation about this slide"]')).toBeNull();
    for (const id of ['slide-lanes', 'slide-remarks']) expect(right.contains(screen.getByTestId(id))).toBe(true);
    expect(screen.getByTestId('slide-lanes').compareDocumentPosition(screen.getByTestId('slide-remarks')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The side column is one scroll area at full height.
    expect(right.contains(screen.getByTestId('slide-side-scroll'))).toBe(true);
    expect(themeCss()).not.toMatch(/\.slide-side-talk/);
    expect(themeCss()).not.toMatch(/\.slide-side-scroll \{[^}]*max-height/);
  });

  it('below the breakpoint, one column: render, conversation, story, notes, then lanes and remarks', async () => {
    narrow();
    const t = setup({ remarks: [remark('r1', { kind: 'slide', slide: 's3' })] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2 && screen.queryAllByTestId('post-it').length === 1);
    expect(screen.getByTestId('slide-layout').getAttribute('data-columns')).toBe('1');
    expect(screen.queryByTestId('slide-side')).toBeNull();
    const body = screen.getByTestId('slide-body');
    const seq = ['slide-stage', 'thread', 'slide-story', 'slide-notes', 'slide-lanes', 'slide-remarks'].map((id) => screen.getByTestId(id));
    for (const el of seq) expect(body.contains(el)).toBe(true);
    for (let i = 1; i < seq.length; i++) expect(seq[i - 1]!.compareDocumentPosition(seq[i]!) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(screen.getByTestId('thread').getAttribute('data-layout')).toBe('inline');
  });

  it('clicking a lane row shows its proposal on the render; the selected row is marked', async () => {
    const t = setup();
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2);
    expect(pressed()).toBe('main');
    fireEvent.click(laneRows()[1]!);
    expect(pressed()).toBe('proposed in Tighter middle');
    expect(laneRows()[1]!.getAttribute('aria-current')).toBe('true');
    expect(laneRows()[0]!.getAttribute('aria-current')).toBeNull();
    fireEvent.click(within(laneRows()[0]!).getByRole('button', { name: 'Sharper claim' }));
    expect(pressed()).toBe('proposed in Sharper claim');
    await waitFor(() => stage()?.querySelector('img')?.getAttribute('src') === '/api/thumbs/l1_s3.png');
    // Deciding on a row is that decision only: it does not switch the render.
    fireEvent.click(screen.getByLabelText(/^accept: move slide 3/));
    expect(pressed()).toBe('proposed in Sharper claim');
  });

  it('a lane that removes this slide draws a dashed "removed in lane" overlay on the main render', async () => {
    const drop = mkLane('l5', 'Drop the wire format', { kind: 'slide', slide: 's3' }, [{ id: 'c9', kind: 'remove', slide: 's3', reason: 'redundant', status: 'pending' }]);
    const t = setup({ lanes: [drop, onS3] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('removed-overlay'));
    expect(stage()!.getAttribute('data-variant')).toBe('main');
    const overlay = screen.getByTestId('removed-overlay');
    expect(screen.getByTestId('slide-stage').contains(overlay)).toBe(true);
    expect(overlay.textContent).toBe('removed in lane Drop the wire format');
    expect(overlay.style.border).toContain('dashed');
    // Not on a lane's own render.
    fireEvent.click(within(screen.getByTestId('slide-toggle')).getByRole('button', { name: 'proposed in Sharper claim' }));
    expect(screen.queryByTestId('removed-overlay')).toBeNull();
  });

  it('lists the open remarks on this slide with propose and resolve; remarks.changed reloads them', async () => {
    const mine = remark('r1', { kind: 'slide', slide: 's3' }, { text: 'the claim is buried' });
    const range = remark('r2', { kind: 'range', from: 's2', to: 's4' }, { text: 'slides 2 to 4 detour', severity: 'info' });
    const others = [
      remark('r3', { kind: 'slide', slide: 's5' }),
      remark('r4', { kind: 'arc' }),
      remark('r5', { kind: 'slide', slide: 's3' }, { status: 'resolved' }),
      remark('r6', { kind: 'slide', slide: 's3' }, { sourceLaneId: 'l1' }),
    ];
    const t = setup({ remarks: [mine, range, ...others] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryAllByTestId('post-it').length === 2);
    const cards = () => within(screen.getByTestId('slide-remarks')).getAllByTestId('post-it');
    expect(cards().map((c) => c.getAttribute('data-remark'))).toEqual(['r1', 'r2']);
    fireEvent.click(within(cards()[0]!).getByRole('button', { name: 'propose' }));
    await waitFor(() => t.api.proposeRemark.mock.calls.length === 1);
    expect(t.api.proposeRemark).toHaveBeenCalledWith('r1');
    fireEvent.click(within(cards()[1]!).getByRole('button', { name: 'resolve' }));
    await waitFor(() => t.api.resolveRemark.mock.calls.length === 1);
    expect(t.api.resolveRemark).toHaveBeenCalledWith('r2');
    t.setRemarks([mine]);
    t.emit({ type: 'remarks.changed' });
    await waitFor(() => cards().length === 1);
  });

  it('a remark whose lane is a draft offers to open it', async () => {
    const draft = { ...mkLane('l7', 'Draft fix', { kind: 'slide', slide: 's3' }, [change('c7', 's3')]), status: 'draft' as const };
    const t = setup({ lanes: [], drafts: [draft], remarks: [remark('r1', { kind: 'slide', slide: 's3' }, { laneId: 'l7' })] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByRole('button', { name: 'open lane' }));
    fireEvent.click(screen.getByRole('button', { name: 'open lane' }));
    await waitFor(() => t.api.openLane.mock.calls.length === 1);
    expect(t.api.openLane).toHaveBeenCalledWith('l7');
  });

  it('no remark on this slide: the section says so', async () => {
    const t = setup({ remarks: [remark('r3', { kind: 'slide', slide: 's5' })] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-remarks-empty'));
    expect(screen.queryAllByTestId('post-it')).toHaveLength(0);
  });

  /** Sends a message on s3, then lands the co-author's reply that created `lane`. */
  async function replyWith(t: ReturnType<typeof setup>, lane: Lane): Promise<void> {
    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'sharper' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => t.api.postMessage.mock.calls.length === 1);
    t.setLanes([lane]);
    t.emit({ type: 'lane.created', laneId: lane.id });
    t.stored.push(
      { id: 'u1', thread: 'slide:s3', role: 'user', text: 'sharper', context: { kind: 'slide', slide: 's3' }, at: '2026-09-30T10:00:00.000Z' },
      { id: 'a1', thread: 'slide:s3', role: 'assistant', text: 'Proposed.', context: null, at: '2026-09-30T10:00:05.000Z' },
    );
    t.emit({ type: 'assistant.done', thread: 'slide:s3', messageId: 'a1' });
  }

  it('the reply carries its proposal card, as on main: the pair with accept, refuse and open in focus, in place', async () => {
    const t = setup({ lanes: [] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-lanes-empty'));
    await replyWith(t, onS3);
    await waitFor(() => screen.queryAllByTestId('proposal-change').length === 1 && laneRows().length === 1);
    const card = screen.getByTestId('thread-proposal');
    // The card sits under the render, in the work column.
    expect(screen.getByTestId('slide-body').contains(card)).toBe(true);
    await waitFor(() => card.querySelectorAll('img').length === 2);
    fireEvent.click(within(card).getByRole('button', { name: 'accept' }));
    await waitFor(() => t.api.acceptChange.mock.calls.length === 1);
    expect(t.api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    await waitFor(() => within(card).queryByText('accepted into main as v4'));
    expect(within(card).getByRole('link', { name: 'open in focus' }).getAttribute('href')).toBe('/lane/l1/change/c1');
  });

  it('clicking a proposal card in the conversation switches the render to that lane', async () => {
    const t = setup({ lanes: [] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => screen.queryByTestId('slide-lanes-empty'));
    await replyWith(t, onS3);
    await waitFor(() => screen.queryByTestId('thread-proposal') && laneRows().length === 1);
    fireEvent.click(within(screen.getByTestId('slide-toggle')).getByRole('button', { name: 'main' }));
    expect(pressed()).toBe('main');
    fireEvent.click(within(screen.getByTestId('thread-proposal')).getAllByTestId('slide-preview')[0]!);
    expect(pressed()).toBe('proposed in Sharper claim');
    expect(laneRows()[0]!.getAttribute('aria-current')).toBe('true');
  });

  it('story and notes follow the tab: a lane shows its own text, with a word diff against main where it differs', async () => {
    const storyLane = mkLane('l8', 'Say it plainly', { kind: 'slide', slide: 's3' }, [change('c8', 's3', { patch: { story: 'the claim told plainly' } } as Partial<Change>)]);
    const t = setup({ lanes: [storyLane] });
    t.api.getLanePreview.mockImplementation(async () => ({
      order,
      slides: { ...slides, s3: slide('s3', { story: 'the claim told plainly' }) },
      skipped: [],
      thumbs: { s3: { hash: 'l8_s3', ready: true } },
    }));
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 1);
    const story = () => screen.getByTestId('slide-story');
    const notes = () => screen.getByTestId('slide-notes');
    expect(story().textContent).toContain('story of s3');
    expect(within(story()).queryByTestId('text-diff')).toBeNull();
    expect(within(story()).getByTestId('field-source').textContent).toBe('on main');

    fireEvent.click(within(screen.getByTestId('slide-toggle')).getByRole('button', { name: 'proposed in Say it plainly' }));
    await waitFor(() => within(story()).queryByTestId('text-diff'));
    expect(within(story()).getByTestId('field-source').textContent).toBe('in Say it plainly, changed');
    const lines = within(story()).getAllByTestId('diff-line');
    expect(lines.map((l) => l.getAttribute('data-op'))).toEqual(['del', 'add']);
    expect(lines[1]!.getAttribute('data-text')).toBe('the claim told plainly');
    // The same notes in the lane: plain text, said to be unchanged.
    expect(within(notes()).queryByTestId('text-diff')).toBeNull();
    expect(notes().textContent).toContain('notes of s3');
    expect(within(notes()).getByTestId('field-source').textContent).toBe('in Say it plainly, unchanged');

    fireEvent.click(within(screen.getByTestId('slide-toggle')).getByRole('button', { name: 'main' }));
    expect(within(story()).queryByTestId('text-diff')).toBeNull();
    expect(story().textContent).toContain('story of s3');
  });

  it('a stale change, or one main already holds, shows the server\'s reason in the lane list instead of accept and refuse', async () => {
    const mixed = {
      ...mkLane('l9', 'Two takes', { kind: 'slide', slide: 's3' }, [
        change('c10', 's3', { status: 'orphan' }),
        change('c11', 's3', { status: 'accepted', patch: { notes: 'n' } } as Partial<Change>),
        change('c12', 's3', { patch: { story: 'live' } } as Partial<Change>),
      ]),
      causes: { c10: 'title changed on main since v1', c11: 'already on main' },
    } as Lane;
    const t = setup({ lanes: [mixed] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 1);
    const row = laneRows()[0]!;
    expect(within(row).getAllByTestId('change-settled').map((n) => n.textContent)).toEqual(['stale: title changed on main since v1', 'already on main']);
    // Only the live change can be decided.
    expect(within(row).getAllByTestId('change-buttons').map((b) => b.getAttribute('data-change'))).toEqual(['c12']);
  });

  it('a lane whose changes on this slide are all settled is listed, with no render tab', async () => {
    const stale = { ...mkLane('l9', 'Old title', { kind: 'slide', slide: 's3' }, [change('c10', 's3', { status: 'orphan' })]), causes: { c10: 'title changed on main since v1' } } as Lane;
    const t = setup({ lanes: [stale] });
    render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 1);
    expect(within(laneRows()[0]!).getByTestId('change-settled').textContent).toBe('stale: title changed on main since v1');
    expect(within(laneRows()[0]!).queryByTestId('change-buttons')).toBeNull();
    expect(screen.queryByTestId('slide-toggle')).toBeNull();
  });

  it('moving to another slide brings both columns back to the top', async () => {
    const t = setup();
    const { rerender } = render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => laneRows().length === 2);
    const body = screen.getByTestId('slide-body');
    const side = screen.getByTestId('slide-side-scroll');
    body.scrollTop = 192;
    side.scrollTop = 80;
    rerender(<SlideScreen slideId="s4" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb().startsWith('slide 4'));
    expect(screen.getByTestId('slide-body').scrollTop).toBe(0);
    expect(screen.getByTestId('slide-side-scroll').scrollTop).toBe(0);
  });

  it('below the breakpoint too, moving to another slide scrolls the column to the top', async () => {
    narrow();
    const t = setup();
    const { rerender } = render(<SlideScreen slideId="s3" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb().startsWith('slide 3'));
    screen.getByTestId('slide-body').scrollTop = 192;
    rerender(<SlideScreen slideId="s2" api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await waitFor(() => crumb().startsWith('slide 2'));
    expect(screen.getByTestId('slide-body').scrollTop).toBe(0);
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
