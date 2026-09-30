// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { Focus } from '../../web/src/screens/Focus.js';
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
  brief: { title: 'Deck', audience: '', message: '', pattern: 'problem-driven', abstract: '' },
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

afterEach(() => cleanup());

describe('Focus', () => {
  it('next/prev cycle through the pending changes only, wrapping around', async () => {
    const api = stubApi();
    const navigate = vi.fn();
    const { rerender } = render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    expect(crumb()).toContain('lane B');

    fireEvent.click(screen.getByRole('button', { name: /next change/ }));
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c3');
    rerender(<Focus laneId="l1" changeId="c3" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 2 of 3'));

    fireEvent.click(screen.getByRole('button', { name: /next change/ }));
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c5');
    rerender(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 3 of 3'));

    fireEvent.click(screen.getByRole('button', { name: /next change/ }));
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c1');

    fireEvent.click(screen.getByRole('button', { name: /prev change/ }));
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c3');
    // never lands on the accepted or refused ones
    expect(navigate.mock.calls.flat()).not.toContain('/lane/l1/change/c2');
    expect(navigate.mock.calls.flat()).not.toContain('/lane/l1/change/c4');
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

  it('accept calls the api with the current change id, then moves to the next pending change', async () => {
    const after = lane([{ ...c1, status: 'accepted' }, c2, c3, c4, c5]);
    const api = stubApi();
    api.acceptChange.mockResolvedValueOnce({ version: { n: 4, order, slides: {}, cause: { kind: 'accept', laneId: 'l1', changeId: 'c1' }, createdAt: '' }, lane: after });
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c1" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 3'));
    fireEvent.click(screen.getByRole('button', { name: 'accept this change' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    expect(api.refuseChange).not.toHaveBeenCalled();
    expect(navigate).toHaveBeenCalledWith('/lane/l1/change/c3');
  });

  it('refusing the last pending change goes back to main', async () => {
    const only = lane([c2, c5]);
    const api = stubApi(only);
    api.refuseChange.mockResolvedValueOnce(lane([c2, { ...c5, status: 'refused' }]));
    const navigate = vi.fn();
    render(<Focus laneId="l1" changeId="c5" api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => crumb().includes('change 1 of 1'));
    fireEvent.click(screen.getByRole('button', { name: 'refuse' }));
    await waitFor(() => navigate.mock.calls.length === 1);
    expect(api.refuseChange).toHaveBeenCalledWith('l1', 'c5');
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
    expect(screen.getByTestId('thread').getAttribute('data-thread')).toBe('lane:l1');
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
