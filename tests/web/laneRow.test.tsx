// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LaneRow } from '../../web/src/components/LaneRow.js';
import { ContextChip } from '../../web/src/components/ContextChip.js';
import { Thread } from '../../web/src/components/Thread.js';
import type { BusEvent, LaneApi, LanePreviewPayload, ThreadApi } from '../../web/src/api.js';
import type { Change, Lane, Remark, Slide, SlideId, ThreadMessage } from '../../src/model/types.js';
import { act } from '@testing-library/react';
import { waitFor } from '../helpers/waitFor.js';

const slide = (id: string, title = `Title ${id}`): Slide => ({ id, title, story: '', notes: '', body: `<p>${title}</p>`, assets: [], kind: 'text' });
const order: SlideId[] = ['s1', 's2', 's3', 's4', 's5'];
const mainSlides: Record<SlideId, Slide> = Object.fromEntries(order.map((id) => [id, slide(id)]));

const modifyS3: Change = { id: 'c1', kind: 'modify', slide: 's3', patch: { title: 'Sharper s3' }, reason: 'tighter', status: 'pending' };
const insertAfterS2: Change = { id: 'c2', kind: 'insert', after: 's2', slide: slide('n1', 'Hook'), reason: 'hook', status: 'pending' };
const removeS4: Change = { id: 'c3', kind: 'remove', slide: 's4', reason: 'redundant', status: 'pending' };

const lane = (over: Partial<Lane> = {}): Lane => ({
  id: 'l1',
  label: 'add a hook',
  anchor: { kind: 'range', from: 's2', to: 's4' },
  origin: 'user',
  baseVersion: 1,
  changes: [modifyS3, insertAfterS2, removeS4],
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

const preview: LanePreviewPayload = {
  order: ['s1', 's2', 'n1', 's3', 's5'],
  slides: { ...mainSlides, s3: slide('s3', 'Sharper s3'), n1: slide('n1', 'Hook') },
  skipped: [],
  thumbs: { n1: { hash: 'hn1', ready: true }, s3: { hash: 'hs3', ready: false } },
};

const stubApi = (): LaneApi & { [K in keyof LaneApi]: ReturnType<typeof vi.fn> } => ({
  acceptChange: vi.fn(async () => ({})),
  refuseChange: vi.fn(async () => ({})),
  discardLane: vi.fn(async () => undefined),
});

afterEach(() => cleanup());

describe('LaneRow', () => {
  it('spans the anchor columns: s2..s4 in a 5-slide deck starts at column 1 and is 3 columns wide', () => {
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const grid = screen.getByTestId('lane-grid');
    expect(grid.style.gridTemplateColumns).toBe('repeat(5, var(--thumb-w))');
    const region = screen.getByTestId('lane-region');
    expect(region.style.gridColumn).toBe('2 / span 3');
    expect(region.getAttribute('data-col-start')).toBe('1');
    expect(region.getAttribute('data-col-span')).toBe('3');
  });

  it('marks inserted, modified and removed slides, with buttons only under changed ones', () => {
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const cells = screen.getAllByTestId('lane-cell');
    expect(cells.map((c) => `${c.getAttribute('data-slide')}:${c.getAttribute('data-mark')}`)).toEqual(['s2:none', 'n1:inserted', 's3:modified', 's4:removed']);
    expect(within(cells[1]!).getByTestId('insert-badge').textContent).toBe('+');
    expect(within(cells[2]!).getByTestId('modified-dot')).toBeTruthy();
    expect(within(cells[3]!).getByTestId('removed-slot')).toBeTruthy();
    expect(within(cells[0]!).queryByRole('button', { name: /accept/ })).toBeNull();
    // the inserted slide shows its ready preview thumb
    expect((within(cells[1]!).getByTestId('thumb-image') as HTMLImageElement).getAttribute('src')).toBe('/api/thumbs/hn1.png');
  });

  it('clicking ✓ accepts that change id, ✗ refuses it, discard closes the lane', async () => {
    const api = stubApi();
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'accept change c1' }));
    await waitFor(() => api.acceptChange.mock.calls.length === 1);
    expect(api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    await waitFor(() => !(screen.getByRole('button', { name: 'refuse change c2' }) as HTMLButtonElement).disabled);
    fireEvent.click(screen.getByRole('button', { name: 'refuse change c2' }));
    await waitFor(() => api.refuseChange.mock.calls.length === 1);
    expect(api.refuseChange).toHaveBeenCalledWith('l1', 'c2');
    await waitFor(() => !(screen.getByRole('button', { name: 'discard lane' }) as HTMLButtonElement).disabled);
    fireEvent.click(screen.getByRole('button', { name: 'discard lane' }));
    await waitFor(() => api.discardLane.mock.calls.length === 1);
    expect(api.discardLane).toHaveBeenCalledWith('l1');
  });

  it('shows the server error when an accept fails', async () => {
    const api = stubApi();
    api.acceptChange.mockRejectedValueOnce(new Error('POST x failed: 409 change c1 is orphan'));
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'accept change c1' }));
    await waitFor(() => screen.queryByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('orphan');
  });

  it('tags a lane from a check as unsolicited and spans full width for an arc anchor', () => {
    render(<LaneRow lane={lane({ origin: 'check:order', anchor: { kind: 'arc' } })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByText('unsolicited · from check: order')).toBeTruthy();
    const region = screen.getByTestId('lane-region');
    expect(region.style.gridColumn).toBe('1 / span 5');
  });

  it('a single-slide anchor is one column', () => {
    render(<LaneRow lane={lane({ anchor: { kind: 'slide', slide: 's3' }, changes: [modifyS3] })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('lane-region').style.gridColumn).toBe('3 / span 1');
  });

  it('draws a connector from a moved slide to its main column', () => {
    const move: Change = { id: 'c9', kind: 'move', slide: 's4', after: 's1', reason: 'earlier', status: 'pending' };
    const moved: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [move] })} preview={moved} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const cells = screen.getAllByTestId('lane-cell');
    expect(cells.map((c) => c.getAttribute('data-slide'))).toEqual(['s4', 's2', 's3']);
    // s4 now goes after s1, so it sits under main column 0 and was at column 3: three columns right.
    // The region widens to include column 0.
    expect(cells.map((c) => c.getAttribute('data-col'))).toEqual(['0', '1', '2']);
    expect(within(cells[0]!).getByTestId('move-connector').getAttribute('data-delta')).toBe('3');
    expect(screen.getByTestId('lane-region').style.gridColumn).toBe('1 / span 4');
  });

  it('gives buttons to a pending change on a slide outside the anchor range', () => {
    const modifyS5: Change = { id: 'c5', kind: 'modify', slide: 's5', patch: { title: 'New s5' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = { order, slides: { ...mainSlides, s5: slide('s5', 'New s5') }, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [modifyS5] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByRole('button', { name: 'accept change c5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'refuse change c5' })).toBeTruthy();
    const cell = screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === 's5')!;
    expect(cell.getAttribute('data-col')).toBe('4');
  });

  it('places every cell under its own main column, inserts stacked in the column they follow', () => {
    const insertAfterS3: Change = { id: 'c2', kind: 'insert', after: 's3', slide: slide('n1', 'Hook'), reason: 'hook', status: 'pending' };
    const modifyS5: Change = { id: 'c5', kind: 'modify', slide: 's5', patch: { title: 'New s5' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = {
      order: ['s1', 's2', 's3', 'n1', 's4', 's5'],
      slides: { ...mainSlides, n1: slide('n1', 'Hook'), s5: slide('s5', 'New s5') },
      skipped: [],
      thumbs: {},
    };
    render(<LaneRow lane={lane({ changes: [insertAfterS3, modifyS5] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const region = screen.getByTestId('lane-region');
    const start = Number(region.getAttribute('data-col-start'));
    const at = (id: string) => screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === id)!;
    // modify on s5 sits under deck column 5 (0-based 4), both by attribute and by its grid placement in the region
    expect(at('s5').getAttribute('data-col')).toBe('4');
    expect(Number(at('s5').style.gridColumn) + start).toBe(5);
    expect(at('s4').getAttribute('data-col')).toBe('3');
    // the inserted slide sits in s3's column, on the row below s3
    expect(at('n1').getAttribute('data-col')).toBe('2');
    expect(at('s3').style.gridColumn).toBe(at('n1').style.gridColumn);
    expect(at('s3').style.gridRow).toBe('1');
    expect(at('n1').style.gridRow).toBe('2');
    // the thumb numbers follow the main columns
    expect(within(at('s5')).getByTestId('thumb').getAttribute('aria-label')).toBe('Slide 5: New s5');
  });

  it('shows the failed card for a lane thumb whose hash failed, and clicking it retries the preview', () => {
    const onRetry = vi.fn();
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} failedThumbs={new Set(['hs3'])} onRetryThumbs={onRetry} onOpenChange={vi.fn()} />);
    const cell = screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === 's3')!;
    expect(cell.getAttribute('data-thumb-failed')).toBe('true');
    expect((within(cell).getByTestId('thumb-image') as HTMLImageElement).getAttribute('src')).toMatch(/^data:image\/svg\+xml/);
    fireEvent.click(within(cell).getByTestId('thumb'));
    expect(onRetry).toHaveBeenCalledWith('l1');
  });

  it('pins lane-scoped remarks under the cell they anchor to; an arc or off-row remark goes below the cells', () => {
    const r = (id: string, anchor: Remark['anchor']): Remark => ({
      id, anchor, text: `text ${id}`, origin: 'check:render', severity: 'warn', status: 'open', laneId: null, sourceLaneId: 'l1', createdAt: '2026-09-30T00:00:00.000Z',
    });
    const remarkApi = { proposeRemark: vi.fn(async () => undefined), resolveRemark: vi.fn(async () => undefined) };
    render(
      <LaneRow
        lane={lane()}
        preview={preview}
        mainOrder={order}
        mainThumbs={{}}
        api={stubApi()}
        remarks={[r('r_n1', { kind: 'slide', slide: 'n1' }), r('r_range', { kind: 'range', from: 's3', to: 's2' }), r('r_arc', { kind: 'arc' })]}
        remarkApi={remarkApi}
      />,
    );
    const cell = (id: string) => screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === id)!;
    const ids = (el: HTMLElement) => within(el).queryAllByTestId('post-it').map((p) => p.getAttribute('data-remark'));
    expect(ids(cell('n1'))).toEqual(['r_n1']);
    // a range goes under whichever end comes first in the lane: s2 before s3
    expect(ids(cell('s2'))).toEqual(['r_range']);
    expect(ids(cell('s3'))).toEqual([]);
    expect(ids(screen.getByTestId('lane-remarks'))).toEqual(['r_arc']);
    fireEvent.click(within(cell('n1')).getByRole('button', { name: 'propose' }));
    expect(remarkApi.proposeRemark).toHaveBeenCalledWith('r_n1');
  });
});

describe('ContextChip', () => {
  it('describes slide, range and arc contexts', () => {
    const { rerender } = render(<ContextChip context={{ kind: 'slide', slide: 's2' }} order={order} slides={mainSlides} />);
    expect(screen.getByTestId('context-chip').textContent).toContain('slide 2');
    rerender(<ContextChip context={{ kind: 'range', from: 's2', to: 's4' }} order={order} slides={mainSlides} />);
    expect(screen.getByTestId('context-chip').textContent).toContain('slides 2–4');
    rerender(<ContextChip context={{ kind: 'arc' }} order={order} slides={mainSlides} />);
    expect(screen.getByTestId('context-chip').textContent).toContain('whole deck');
  });
});

describe('Thread', () => {
  const setup = () => {
    const handlers = new Set<(e: BusEvent) => void>();
    const emit = (e: BusEvent) => act(() => handlers.forEach((h) => h(e)));
    const stored: ThreadMessage[] = [];
    const api: ThreadApi = {
      getThread: vi.fn(async () => [...stored]),
      postMessage: vi.fn(async () => undefined),
    };
    const subscribe = (h: (e: BusEvent) => void) => {
      handlers.add(h);
      return () => handlers.delete(h);
    };
    return { api, emit, subscribe, stored };
  };

  it('posts { text, context } and streams the reply for its own thread only', async () => {
    const { api, emit, subscribe, stored } = setup();
    render(<Thread threadKey="global" context={{ kind: 'range', from: 's2', to: 's4' }} order={order} slides={mainSlides} api={api} subscribe={subscribe} />);
    await waitFor(() => (api.getThread as ReturnType<typeof vi.fn>).mock.calls.length === 1);

    fireEvent.change(screen.getByLabelText('message'), { target: { value: 'add a hook' } });
    fireEvent.click(screen.getByRole('button', { name: 'Send' }));
    await waitFor(() => (api.postMessage as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    expect(api.postMessage).toHaveBeenCalledWith('global', 'add a hook', { kind: 'range', from: 's2', to: 's4' });

    emit({ type: 'assistant.delta', thread: 'global', text: 'Sure, ' });
    emit({ type: 'assistant.delta', thread: 'lane:other', text: 'IGNORED' });
    emit({ type: 'assistant.delta', thread: 'global', text: 'proposing.' });
    expect(screen.getByTestId('thread-streaming').textContent).toContain('Sure, proposing.');
    expect(screen.getByTestId('thread-streaming').textContent).not.toContain('IGNORED');

    stored.push(
      { id: 'm1', thread: 'global', role: 'user', text: 'add a hook', context: null, at: '2026-09-30T10:00:00.000Z' },
      { id: 'm2', thread: 'global', role: 'assistant', text: 'Sure, proposing.', context: null, at: '2026-09-30T10:00:05.000Z' },
    );
    emit({ type: 'assistant.done', thread: 'global', messageId: 'm2' });
    await waitFor(() => screen.queryByTestId('thread-streaming') === null);
    expect(screen.getAllByTestId('thread-message').map((m) => m.getAttribute('data-role'))).toEqual(['user', 'assistant']);
  });

  it('on hello (socket reopened) drops the partial stream and tool, and reloads the stored thread', async () => {
    const { api, emit, subscribe, stored } = setup();
    render(<Thread threadKey="global" context={{ kind: 'arc' }} order={order} slides={mainSlides} api={api} subscribe={subscribe} />);
    await waitFor(() => (api.getThread as ReturnType<typeof vi.fn>).mock.calls.length === 1);
    emit({ type: 'assistant.delta', thread: 'global', text: 'partial' });
    emit({ type: 'tool.call', thread: 'global', name: 'mcp__deck__get_deck' });
    expect(screen.getByTestId('thread-streaming')).toBeTruthy();
    stored.push({ id: 'm2', thread: 'global', role: 'assistant', text: 'full reply', context: null, at: '2026-09-30T10:00:05.000Z' });
    emit({ type: 'hello', version: null });
    await waitFor(() => screen.queryAllByTestId('thread-message').length === 1);
    expect(screen.queryByTestId('thread-streaming')).toBeNull();
    expect(screen.getByTestId('thread-message').textContent).toContain('full reply');
  });
});

// @vitest-environment jsdom
import { describeTool, renderInline } from '../../web/src/components/Thread.js';
import { describe as d2, expect as e2, it as i2 } from 'vitest';
d2('thread helpers', () => {
  i2('describes deck tools in plain words', () => {
    e2(describeTool('mcp__deck__propose_lane')).toBe('proposing a lane');
    e2(describeTool('mcp__deck__something_new')).toBe('something new');
  });
  i2('renders bold, code and italic inline', () => {
    const nodes = renderInline('a **b** `c` *d*');
    e2(nodes.length).toBe(6);
  });
});
