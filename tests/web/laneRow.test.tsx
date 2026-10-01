// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LaneRow, VariantRow, variantGroups } from '../../web/src/components/LaneRow.js';
import { placeCards } from '../../web/src/components/RemarkRow.js';
import { ContextChip } from '../../web/src/components/ContextChip.js';
import { Thread } from '../../web/src/components/Thread.js';
import { focusPath, type BusEvent, type LaneApi, type LanePreviewPayload, type ThreadApi } from '../../web/src/api.js';
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
  it('spans the anchor columns, widened to the inserted slide: s2..s4 plus n1 starts at column 1 and is 4 columns wide', () => {
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const grid = screen.getByTestId('lane-grid');
    expect(grid.style.gridTemplateColumns).toBe('repeat(5, var(--thumb-w))');
    const region = screen.getByTestId('lane-region');
    expect(region.style.gridColumn).toBe('2 / span 4');
    expect(region.getAttribute('data-col-start')).toBe('1');
    expect(region.getAttribute('data-col-span')).toBe('4');
  });

  it('lays every cell in one row, marks inserted, modified and removed slides, with buttons under every changed one', () => {
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const cells = screen.getAllByTestId('lane-cell');
    // n1 would go right after s2, but s3 (modified) and the removed s4 hold their columns: it takes the next free one.
    // s2, unchanged, has no cell: main's row shows it.
    expect(cells.map((c) => `${c.getAttribute('data-slide')}:${c.getAttribute('data-mark')}:${c.getAttribute('data-col')}`)).toEqual([
      's3:modified:2',
      's4:removed:3',
      'n1:inserted:4',
    ]);
    expect(cells.every((c) => c.style.gridRow === '1 / span 2')).toBe(true);
    expect(within(cells[2]!).getByTestId('insert-badge').textContent).toBe('+');
    expect(within(cells[0]!).getByTestId('modified-dot')).toBeTruthy();
    expect(within(cells[1]!).getByTestId('removed-slot')).toBeTruthy();
    // the removed slot carries its own accept / refuse pair
    expect(within(cells[1]!).getByRole('button', { name: 'accept: remove slide 4, Title s4' })).toBeTruthy();
    expect(within(cells[1]!).getByRole('button', { name: 'refuse: remove slide 4, Title s4' })).toBeTruthy();
    // the inserted slide shows its ready preview thumb
    expect((within(cells[2]!).getByTestId('thumb-image') as HTMLImageElement).getAttribute('src')).toBe('/api/thumbs/hn1.png');
  });

  it('clicking ✓ accepts that change id, ✗ refuses it, discard closes the lane', async () => {
    const api = stubApi();
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'accept: modify slide 3, Sharper s3' }));
    await waitFor(() => api.acceptChange.mock.calls.length === 1);
    expect(api.acceptChange).toHaveBeenCalledWith('l1', 'c1');
    await waitFor(() => !(screen.getByRole('button', { name: 'refuse: insert slide 3, Hook' }) as HTMLButtonElement).disabled);
    fireEvent.click(screen.getByRole('button', { name: 'refuse: insert slide 3, Hook' }));
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
    fireEvent.click(screen.getByRole('button', { name: 'accept: modify slide 3, Sharper s3' }));
    await waitFor(() => screen.queryByRole('alert'));
    expect(screen.getByRole('alert').textContent).toContain('orphan');
  });

  it('says where a check lane comes from; an arc lane starts at the first slide it touches', () => {
    render(<LaneRow lane={lane({ origin: 'check:order', anchor: { kind: 'arc' } })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('lane-origin').textContent).toBe('from check: order');
    // s3 modified (column 2), s4 removed (column 3), n1 inserted in the next free column (4): untouched s1 and s2 stay on main.
    const region = screen.getByTestId('lane-region');
    expect(region.style.gridColumn).toBe('3 / span 3');
    expect(screen.getAllByTestId('lane-cell').map((c) => c.getAttribute('data-slide'))).toEqual(['s3', 's4', 'n1']);
  });

  it('names the lane in the gutter with its full title, no letter, and its origin under it', () => {
    const long = 'Pull the decision-layer detour out of the opening run';
    const { rerender } = render(<LaneRow lane={lane({ label: long, anchor: { kind: 'slide', slide: 's2' } })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('lane-name').textContent).toBe(long);
    expect(screen.getByTestId('lane-origin').textContent).toBe('from your request on slide 2');
    rerender(<LaneRow lane={lane({ anchor: { kind: 'range', from: 's2', to: 's4' } })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('lane-origin').textContent).toBe('from your request on slides 2–4');
    rerender(<LaneRow lane={lane({ label: 'back to v4', anchor: { kind: 'arc' } })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('lane-origin').textContent).toBe('from history v4');
  });

  it('names accept and refuse after the change they decide, never by id', () => {
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const names = screen.getAllByRole('button').map((b) => b.getAttribute('aria-label') ?? b.textContent ?? '').filter((n) => /^(accept|refuse)/.test(n));
    expect(new Set(names)).toEqual(
      new Set([
        'accept: insert slide 3, Hook',
        'refuse: insert slide 3, Hook',
        'accept: modify slide 3, Sharper s3',
        'refuse: modify slide 3, Sharper s3',
        'accept: remove slide 4, Title s4',
        'refuse: remove slide 4, Title s4',
      ]),
    );
    expect(names.join(' ')).not.toMatch(/\bc[123]\b/);
    expect(names).toHaveLength(6);
  });

  it('a single-slide anchor is one column', () => {
    render(<LaneRow lane={lane({ anchor: { kind: 'slide', slide: 's3' }, changes: [modifyS3] })} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('lane-region').style.gridColumn).toBe('3 / span 1');
  });

  it('leaves an unoutlined slot with its buttons at a moved slide\'s own column: the hairline end, where it goes and what moves', () => {
    const move: Change = { id: 'c9', kind: 'move', slide: 's4', after: 's1', reason: 'earlier', status: 'pending' };
    const moved: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [move] })} preview={moved} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const cells = screen.getAllByTestId('lane-cell');
    expect(cells.map((c) => `${c.getAttribute('data-slide')}:${c.getAttribute('data-col')}`)).toEqual(['s4:3']);
    const slot = within(cells[0]!).getByTestId('moved-slot');
    expect(slot.style.border).toBe('');
    expect(slot.textContent).toContain('moved to 2');
    expect(within(slot).getByTestId('moved-title').textContent).toBe(mainSlides.s4!.title);
    expect(within(slot).getByTestId('move-connector')).toBeTruthy();
    expect(within(cells[0]!).getByRole('button', { name: 'accept: move slide 4, Title s4, to 2' })).toBeTruthy();
    expect(screen.getByTestId('lane-region').style.gridColumn).toBe('2 / span 3');
  });

  it('shows a moved slide\'s thumbnail in its slot, main\'s render since the content is unchanged, the title held to two lines', () => {
    const move: Change = { id: 'c9', kind: 'move', slide: 's4', after: 's1', reason: 'earlier', status: 'pending' };
    const moved: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    const open = vi.fn();
    render(<LaneRow lane={lane({ changes: [move] })} preview={moved} mainOrder={order} mainThumbs={{ s4: '/api/thumbs/main-s4.png' }} api={stubApi()} onOpenChange={open} />);
    const slot = screen.getByTestId('moved-slot');
    const thumb = within(slot).getByRole('link');
    expect((within(slot).getByTestId('thumb-image') as HTMLImageElement).getAttribute('src')).toBe('/api/thumbs/main-s4.png');
    // the slot names what moves once, under the thumb: no hover title on top of it
    expect(slot.querySelector('.thumb-title')).toBeNull();
    const title = within(slot).getByTestId('moved-title');
    expect(title.style.webkitLineClamp).toBe('2');
    expect(title.getAttribute('title')).toBe(mainSlides.s4!.title);
    fireEvent.click(thumb);
    expect(open).toHaveBeenCalledWith('l1', 'c9');
  });

  it('a modify that only rewrites the story or the notes says so on its cell, next to the dot', () => {
    const storyOnly: Change = { id: 'c1', kind: 'modify', slide: 's3', patch: { story: 'why now' }, reason: 'r', status: 'pending' };
    const both: Change = { id: 'c6', kind: 'modify', slide: 's2', patch: { story: 'a', notes: 'b' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = { order, slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [storyOnly, both, { ...modifyS3, id: 'c7', slide: 's4' }] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const at = (id: string) => screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === id)!;
    expect(within(at('s3')).getByTestId('modified-tag').textContent).toBe('story');
    expect(within(at('s3')).getByTestId('modified-dot')).toBeTruthy();
    expect(within(at('s2')).getByTestId('modified-tag').textContent).toBe('story, notes');
    // a modify that touches the title changes the render: the plain dot only
    expect(within(at('s4')).queryByTestId('modified-tag')).toBeNull();
    expect(within(at('s4')).getByTestId('modified-dot')).toBeTruthy();
  });

  it('names the new position of a slide moved further on', () => {
    const move: Change = { id: 'c9', kind: 'move', slide: 's2', after: 's3', reason: 'swap', status: 'pending' };
    const moved: LanePreviewPayload = { order: ['s1', 's3', 's2', 's4', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [move] })} preview={moved} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const cell = screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === 's2')!;
    expect(cell.getAttribute('data-col')).toBe('1');
    expect(within(cell).getByTestId('moved-slot').textContent).toContain('moved to 3');
  });

  it('gives buttons to a pending change on a slide outside the anchor range', () => {
    const modifyS5: Change = { id: 'c5', kind: 'modify', slide: 's5', patch: { title: 'New s5' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = { order, slides: { ...mainSlides, s5: slide('s5', 'New s5') }, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [modifyS5] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByRole('button', { name: 'accept: modify slide 5, New s5' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'refuse: modify slide 5, New s5' })).toBeTruthy();
    const cell = screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === 's5')!;
    expect(cell.getAttribute('data-col')).toBe('4');
  });

  it('places every cell under its own main column, an insert right after the slide it follows, in the same row', () => {
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
    // the inserted slide takes the column after s3; s4, unchanged, yields it (main already shows s4)
    expect(at('n1').getAttribute('data-col')).toBe('3');
    expect(screen.getAllByTestId('lane-cell').some((c) => c.getAttribute('data-slide') === 's4')).toBe(false);
    expect(screen.getAllByTestId('lane-cell').every((c) => c.style.gridRow === '1 / span 2')).toBe(true);
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

  it('keeps lane-scoped remarks out of the row until asked: a count in the gutter opens them, full text and propose', () => {
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
        remarks={[r('r_n1', { kind: 'slide', slide: 'n1' }), r('r_arc', { kind: 'arc' })]}
        remarkApi={remarkApi}
      />,
    );
    expect(screen.queryByTestId('lane-remarks')).toBeNull();
    expect(screen.queryAllByTestId('post-it')).toHaveLength(0);
    const toggle = screen.getByRole('button', { name: '2 check remarks' });
    expect(toggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(toggle);
    const list = screen.getByTestId('lane-remarks');
    expect(within(list).getAllByTestId('post-it').map((p) => p.getAttribute('data-remark'))).toEqual(['r_n1', 'r_arc']);
    fireEvent.click(within(list).getAllByRole('button', { name: 'propose' })[0]!);
    expect(remarkApi.proposeRemark).toHaveBeenCalledWith('r_n1');
  });

  it('names a removed slide by its title from main when the preview no longer has it, never by id', () => {
    const p: LanePreviewPayload = { order: ['s1', 's2', 's3', 's5'], slides: Object.fromEntries(Object.entries(mainSlides).filter(([id]) => id !== 's4')), skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [removeS4] })} preview={p} mainOrder={order} mainSlides={{ ...mainSlides, s4: slide('s4', 'Typed in') }} mainThumbs={{}} api={stubApi()} />);
    const slot = screen.getByTestId('removed-slot');
    expect(slot.getAttribute('aria-label')).toBe('removed: Typed in');
    expect(screen.getByRole('button', { name: 'accept: remove slide 4, Typed in' })).toBeTruthy();
    expect(screen.getByRole('button', { name: 'refuse: remove slide 4, Typed in' })).toBeTruthy();
    expect([...document.querySelectorAll('[aria-label]')].map((el) => el.getAttribute('aria-label')).filter((n) => /\bs4\b/.test(n ?? ''))).toEqual([]);
  });

  it('puts the "story, notes" tag under the card next to accept and refuse, never over the thumbnail', () => {
    const both: Change = { id: 'c6', kind: 'modify', slide: 's2', patch: { story: 'a', notes: 'b' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = { order, slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [both] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const cell = screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === 's2')!;
    const tag = within(cell).getByTestId('modified-tag');
    const buttons = within(cell).getByTestId('change-buttons');
    // Same line as the buttons, not an overlay on the card.
    expect(tag.closest('[data-testid="change-line"]')).toBe(buttons.closest('[data-testid="change-line"]'));
    expect(tag.closest('[data-testid="change-line"]')).not.toBeNull();
    expect(getComputedStyle(tag.parentElement!).position).not.toBe('absolute');
  });

  it('spills its name into the empty columns in view before its first cell, like a ledger line, instead of wrapping it in the gutter', () => {
    const modifyS5: Change = { id: 'c5', kind: 'modify', slide: 's5', patch: { title: 'New s5' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = { order, slides: { ...mainSlides, s5: slide('s5', 'New s5') }, skipped: [], thumbs: {} };
    const long = 'Open the memory answer before the coordination block';
    const one = lane({ label: long, anchor: { kind: 'slide', slide: 's5' }, changes: [modifyS5] });
    const open = vi.fn();
    const { rerender } = render(<LaneRow lane={one} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} view={{ first: 0, end: 5 }} onOpenChange={open} />);
    const spill = screen.getByTestId('lane-spill');
    // Columns 1 to 4 are empty in this row: the name, its origin and its actions run from the gutter over them.
    expect(spill.closest('.gutter')).not.toBeNull();
    expect(spill.getAttribute('data-columns')).toBe('4');
    expect(spill.style.width).toContain('4 * (var(--thumb-w) + var(--col-gap))');
    expect(within(spill).getByTestId('lane-name').textContent).toBe(long);
    expect(within(spill).getByTestId('lane-origin')).toBeTruthy();
    expect(within(spill).getByRole('button', { name: 'discard lane' })).toBeTruthy();
    // What it does, change by change, a click opening one; lines stay under 80 characters.
    const changes = within(spill).getByTestId('lane-spill-changes');
    expect(changes.textContent).toBe('modify slide 5, New s5: r');
    expect(within(changes).getByRole('listitem').style.maxWidth).toBe('80ch');
    expect(within(spill).getByTestId('lane-name').parentElement!.style.maxWidth).toBe('80ch');
    fireEvent.click(within(changes).getByRole('button'));
    expect(open).toHaveBeenCalledWith('l1', 'c5');
    // Scrolled so that fewer than three empty columns show before it: the name goes back to the gutter.
    rerender(<LaneRow lane={one} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} view={{ first: 2, end: 5 }} />);
    expect(screen.queryByTestId('lane-spill')).toBeNull();
    expect(within(document.querySelector<HTMLElement>('.gutter')!).getByTestId('lane-name').textContent).toBe(long);
    // Not measured (no view): the gutter.
    rerender(<LaneRow lane={one} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.queryByTestId('lane-spill')).toBeNull();
  });

  it('a lane whose changed slides lie past the columns in view shows an edge chip that reveals them', () => {
    const modifyS5: Change = { id: 'c5', kind: 'modify', slide: 's5', patch: { title: 'New s5' }, reason: 'r', status: 'pending' };
    const p: LanePreviewPayload = { order, slides: { ...mainSlides, s5: slide('s5', 'New s5') }, skipped: [], thumbs: {} };
    const reveal = vi.fn();
    const { rerender } = render(
      <LaneRow lane={lane({ anchor: { kind: 'slide', slide: 's5' }, changes: [modifyS5] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} view={{ first: 0, end: 3 }} onReveal={reveal} />,
    );
    const chip = screen.getByTestId('edge-chip');
    expect(chip.getAttribute('data-side')).toBe('right');
    expect(chip.textContent).toContain('slide 5');
    expect(chip.textContent).not.toMatch(/[←→⟶⟵]/);
    fireEvent.click(chip);
    expect(reveal).toHaveBeenCalledWith(4);
    // Scrolled past it: the chip points left.
    rerender(<LaneRow lane={lane({ anchor: { kind: 'slide', slide: 's1' }, changes: [{ ...modifyS5, slide: 's1' }] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} view={{ first: 2, end: 5 }} onReveal={reveal} />);
    expect(screen.getByTestId('edge-chip').getAttribute('data-side')).toBe('left');
    expect(screen.getByTestId('edge-chip').textContent).toContain('slide 1');
    // In view: no chip.
    rerender(<LaneRow lane={lane({ anchor: { kind: 'slide', slide: 's5' }, changes: [modifyS5] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} view={{ first: 2, end: 5 }} onReveal={reveal} />);
    expect(screen.queryByTestId('edge-chip')).toBeNull();
  });

  it('flashes once when asked: an accent outline that clears when its animation ends', () => {
    const { rerender } = render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} flash />);
    const row = screen.getByTestId('lane-row');
    expect(row.getAttribute('data-flash')).toBe('true');
    expect(row.className).toContain('lane-flash');
    const done = vi.fn();
    rerender(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={stubApi()} flash onFlashEnd={done} />);
    fireEvent.animationEnd(row);
    expect(done).toHaveBeenCalledWith('l1');
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

describe('placeCards', () => {
  it('gives each card four columns at least, pulls it left at the deck end, stacks overlaps, and drops rows past the limit', () => {
    const items = [
      { id: 'a', col: 0, span: 1 },
      { id: 'b', col: 1, span: 1 },
      { id: 'c', col: 9, span: 1 },
      { id: 'd', col: 5, span: 1, selected: true },
    ];
    expect(placeCards(items, 10)).toEqual([
      { id: 'd', start: 5, width: 4, row: 0, inset: false },
      { id: 'a', start: 0, width: 4, row: 0, inset: false },
      { id: 'b', start: 1, width: 4, row: 1, inset: false },
      { id: 'c', start: 6, width: 4, row: 1, inset: false },
    ]);
    expect(placeCards(items, 10, 1).map((p) => p.id)).toEqual(['d', 'a']);
  });

  it('keeps cards inside the columns in view: those anchored outside are left out, the others end at the edge', () => {
    const items = [
      { id: 'a', col: 1, span: 1 },
      { id: 'b', col: 6, span: 1 },
      { id: 'c', col: 9, span: 1 },
    ];
    expect(placeCards(items, 12, Infinity, { first: 2, end: 8 })).toEqual([{ id: 'b', start: 4, width: 4, row: 0, inset: false }]);
  });

  it('keeps cards clear of the columns a moved hairline runs down: ends before one, or starts on it inset', () => {
    // Lines at columns 4 and 5 (main's slides 5 and 6 moved): the card on slide 2 ends before column 4 (pulled
    // left to keep four columns), the card on slide 6 starts on its own line's column, inset past the line.
    const items = [
      { id: 'a', col: 1, span: 1 },
      { id: 'b', col: 5, span: 1 },
    ];
    expect(placeCards(items, 12, Infinity, undefined, new Set([4, 5]))).toEqual([
      { id: 'a', start: 0, width: 4, row: 0, inset: false },
      { id: 'b', start: 5, width: 4, row: 0, inset: true },
    ]);
    // Squeezed between two lines, a card comes out narrower rather than cover one.
    expect(placeCards([{ id: 'c', col: 2, span: 1 }], 12, Infinity, undefined, new Set([1, 4]))).toEqual([{ id: 'c', start: 1, width: 3, row: 0, inset: true }]);
    // Never under two columns: a card squeezed into one column runs over the line into its neighbours instead.
    expect(placeCards([{ id: 'd', col: 2, span: 1 }], 12, Infinity, undefined, new Set([2, 3]))).toEqual([{ id: 'd', start: 2, width: 4, row: 0, inset: true }]);
  });
});

describe('variants', () => {
  const mod = (id: string, s: SlideId, patch: Record<string, string>, variantOf: string[] = []) => ({ id, kind: 'modify' as const, slide: s, patch, reason: 'r', status: 'pending' as const, variantOf });
  const at = (n: number) => `2026-09-30T10:0${n}:00.000Z`;

  it('groups lanes whose pending modify shares a slide and a field, oldest first; a lane joins one group at most', () => {
    const a = lane({ id: 'a', createdAt: at(1), changes: [mod('ca', 's2', { title: 'A' }, ['b', 'c'])] });
    const b = lane({ id: 'b', createdAt: at(2), changes: [mod('cb', 's2', { title: 'B', body: '<p>x</p>' }, ['a', 'c'])] });
    const c = lane({ id: 'c', createdAt: at(0), changes: [mod('cc', 's2', { title: 'C' }, ['a', 'b'])] });
    const d = lane({ id: 'd', createdAt: at(3), changes: [mod('cd', 's3', { notes: 'n' })] });
    // variantOf names a lane that no longer has that field pending: no group.
    const e = lane({ id: 'e', createdAt: at(4), changes: [mod('ce', 's4', { story: 's' }, ['d'])] });
    const groups = variantGroups([a, b, c, d, e]);
    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({ slide: 's2', field: 'title' });
    expect(groups[0]!.members.map((x) => [x.lane.id, x.change.id])).toEqual([['c', 'cc'], ['a', 'ca'], ['b', 'cb']]);
  });

  it('a variant row names the slide and field, and gives each variant its thumb, text, time and its own accept and refuse', async () => {
    const a = lane({ id: 'a', label: 'Four-word hook title', createdAt: at(1), changes: [mod('ca', 's2', { title: 'One home' }, ['b'])] });
    const b = lane({ id: 'b', label: 'Shorter hook title', createdAt: at(2), changes: [mod('cb', 's2', { title: 'One answer' }, ['a'])] });
    const [group] = variantGroups([a, b]);
    const pv = (t: string): LanePreviewPayload => ({ order, slides: { ...mainSlides, s2: slide('s2', t) }, skipped: [], thumbs: { s2: { hash: `h_${t}`, ready: true } } });
    const api = stubApi();
    const open = vi.fn();
    render(<VariantRow group={group!} previews={{ a: pv('One home'), b: pv('One answer') }} mainOrder={order} mainThumbs={{}} api={api} onOpenChange={open} />);
    expect(screen.getByTestId('variant-label').textContent).toBe('slide 2, title: 2 variants');
    const cells = screen.getAllByTestId('variant-cell');
    expect(cells.map((c) => c.style.gridColumn)).toEqual(['1 / span 2', '3 / span 2']);
    expect(screen.getByTestId('variant-region').style.gridColumn).toBe('2 / span 4');
    expect(within(cells[1]!).getByTestId('variant-text').textContent).toBe('One answer');
    expect(within(cells[0]!).getByTestId('thumb-image').getAttribute('src')).toBe('/api/thumbs/h_One home.png');
    fireEvent.click(within(cells[1]!).getByRole('button', { name: /^refuse: / }));
    await waitFor(() => api.refuseChange.mock.calls.length === 1);
    expect(api.refuseChange).toHaveBeenCalledWith('b', 'cb');
    fireEvent.click(within(cells[0]!).getByRole('button', { name: /^accept: / }));
    await waitFor(() => api.acceptChange.mock.calls.length === 1);
    expect(api.acceptChange).toHaveBeenCalledWith('a', 'ca');
    fireEvent.click(within(cells[0]!).getByTestId('thumb'));
    expect(open).toHaveBeenCalledWith('a', 'ca');
  });
});

describe('LaneRow QA4: decided cells, no ghosts, "+N" on pending only, moved slots open focus', () => {
  const accepted: Change = { ...modifyS3, status: 'accepted' };
  const refusedMove: Change = { id: 'c9', kind: 'move', slide: 's4', after: 's1', reason: 'earlier', status: 'refused' };
  const stale: Change = { id: 'c6', kind: 'modify', slide: 's2', patch: { notes: 'n' }, reason: 'r', status: 'orphan' };
  const pendingS5: Change = { id: 'c5', kind: 'modify', slide: 's5', patch: { title: 'New s5' }, reason: 'r', status: 'pending' };
  const p: LanePreviewPayload = { order, slides: { ...mainSlides, s5: slide('s5', 'New s5') }, skipped: [], thumbs: {} };
  const decidedLane = (): Lane => ({ ...lane({ changes: [accepted, refusedMove, stale, pendingS5] }), causes: { c6: 'slide 2 changed on main' } } as Lane);
  const at = (id: string) => screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === id)!;

  it('an accepted change keeps its column with its thumb and a muted "accepted" tag, no buttons; a refused one is dimmed and says "refused"; an orphan says "stale: <cause>"', () => {
    render(<LaneRow lane={decidedLane()} preview={p} mainOrder={order} mainThumbs={{ s3: '/api/thumbs/main-s3.png', s4: '/api/thumbs/main-s4.png' }} api={stubApi()} />);
    expect(screen.getAllByTestId('lane-cell').map((c) => `${c.getAttribute('data-slide')}:${c.getAttribute('data-mark')}:${c.getAttribute('data-col')}`)).toEqual([
      's2:settled:1',
      's3:settled:2',
      's4:settled:3',
      's5:modified:4',
    ]);
    const tag = (id: string) => within(at(id)).getByTestId('settled-tag');
    expect(tag('s3').textContent).toBe('accepted');
    expect(tag('s3').className).toContain('meta');
    expect((within(at('s3')).getByTestId('thumb-image') as HTMLImageElement).getAttribute('src')).toBe('/api/thumbs/main-s3.png');
    expect(within(at('s3')).getByTestId('settled-card').getAttribute('data-settled')).toBe('accepted');
    expect(within(at('s3')).getByTestId('settled-card').style.opacity).toBe('');
    // A refused move is no moved slot any more: its slide, dimmed, in its own column.
    expect(tag('s4').textContent).toBe('refused');
    expect(within(at('s4')).queryByTestId('moved-slot')).toBeNull();
    expect(Number(within(at('s4')).getByTestId('settled-card').style.opacity)).toBeLessThan(1);
    expect(tag('s2').textContent).toBe('stale: slide 2 changed on main');
    expect(Number(within(at('s2')).getByTestId('settled-card').style.opacity)).toBeLessThan(1);
    for (const id of ['s2', 's3', 's4']) expect(within(at(id)).queryByTestId('change-buttons')).toBeNull();
    expect(within(at('s5')).getByTestId('change-buttons')).toBeTruthy();
  });

  it('unchanged slides of main never render in a lane row: after a move is accepted, only the cells of the lane\'s own changes remain', () => {
    // Main after accepting "move slide 4 after slide 1": the anchor s2..s4 now spans the shifted slides s4, s2.
    const after: SlideId[] = ['s1', 's4', 's2', 's3', 's5'];
    const acceptedMove: Change = { ...refusedMove, status: 'accepted' };
    const pv: LanePreviewPayload = { ...p, order: after };
    render(<LaneRow lane={lane({ changes: [acceptedMove, pendingS5] })} preview={pv} mainOrder={after} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getAllByTestId('lane-cell').map((c) => `${c.getAttribute('data-slide')}:${c.getAttribute('data-mark')}:${c.getAttribute('data-col')}`)).toEqual(['s4:settled:1', 's5:modified:4']);
  });

  it('a lane with only pending changes has no context cell either, whatever its anchor covers', () => {
    render(<LaneRow lane={lane({ anchor: { kind: 'range', from: 's1', to: 's5' }, changes: [pendingS5] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getAllByTestId('lane-cell').map((c) => c.getAttribute('data-slide'))).toEqual(['s5']);
  });

  it('the row\'s "+N" counts the pending changes past the visible end, never the decided cells', async () => {
    const { useRef } = await import('react');
    const { EdgeFade, useVisibleColumns } = await import('../../web/src/components/EdgeFade.js');
    function Canvas() {
      const ref = useRef<HTMLDivElement>(null);
      const visible = useVisibleColumns(ref, '[data-edge-item]', []);
      return (
        <div ref={ref} data-testid="scroller">
          <LaneRow lane={decidedLane()} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />
          <EdgeFade visible={visible} />
        </div>
      );
    }
    const rect = (left: number, width: number, top = 0, height = 99): DOMRect => ({ left, width, top, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    // Column c at 126 + 184c, 176 wide, in a 900px scroller: columns 3 and 4 reach past its end (900 - 48).
    const spyRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-edge-item')) return rect(126 + Number(this.getAttribute('data-col')) * 184, 176);
      if (this.classList.contains('gutter')) return rect(0, 120);
      return rect(0, 900, 0, 300);
    });
    const spyWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    try {
      render(<Canvas />);
      // The refused s4 (column 3) is past the end too, but only the pending modify of s5 counts.
      expect(at('s4').getAttribute('data-edge-weight')).toBe('0');
      expect(at('s5').getAttribute('data-edge-weight')).toBe('1');
      expect(screen.getByTestId('edge-fade-count').textContent).toBe('+1');
    } finally {
      spyRect.mockRestore();
      spyWidth.mockRestore();
    }
  });

  it('a decided cell alone past the end is still covered, with no count', async () => {
    const { useRef } = await import('react');
    const { EdgeFade, useVisibleColumns } = await import('../../web/src/components/EdgeFade.js');
    function Canvas() {
      const ref = useRef<HTMLDivElement>(null);
      const visible = useVisibleColumns(ref, '[data-edge-item]', []);
      return (
        <div ref={ref}>
          <LaneRow lane={lane({ changes: [accepted, refusedMove] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />
          <EdgeFade visible={visible} />
        </div>
      );
    }
    const rect = (left: number, width: number, top = 0, height = 99): DOMRect => ({ left, width, top, height, right: left + width, bottom: top + height, x: left, y: top, toJSON: () => ({}) }) as DOMRect;
    const spyRect = vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      if (this.hasAttribute('data-edge-item')) return rect(126 + Number(this.getAttribute('data-col')) * 184, 176);
      if (this.classList.contains('gutter')) return rect(0, 120);
      return rect(0, 900, 0, 300);
    });
    const spyWidth = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(900);
    try {
      render(<Canvas />);
      expect(screen.getByTestId('edge-fade')).toBeTruthy();
      expect(screen.queryByTestId('edge-fade-count')).toBeNull();
    } finally {
      spyRect.mockRestore();
      spyWidth.mockRestore();
    }
  });

  it('a moved slot is a link to that change in focus, named after the move', () => {
    const move: Change = { id: 'c9', kind: 'move', slide: 's4', after: 's1', reason: 'earlier', status: 'pending' };
    const moved: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    const open = vi.fn();
    render(<LaneRow lane={lane({ changes: [move] })} preview={moved} mainOrder={order} mainThumbs={{ s4: '/api/thumbs/main-s4.png' }} api={stubApi()} onOpenChange={open} />);
    const link = within(screen.getByTestId('moved-slot')).getByRole('link', { name: 'open in focus: move slide 4 (Title s4)' });
    expect(link.getAttribute('href')).toBe(focusPath('l1', 'c9'));
    // The thumbnail, "moved to 2" and the title are all inside the link: a click anywhere on the slot opens it.
    expect(within(link).getByTestId('thumb-image').getAttribute('src')).toBe('/api/thumbs/main-s4.png');
    expect(within(link).getByTestId('moved-title')).toBeTruthy();
    expect(link.querySelector('button')).toBeNull();
    fireEvent.click(within(link).getByTestId('thumb-image'));
    expect(open).toHaveBeenCalledWith('l1', 'c9');
  });

  it('without a handler, clicking a moved slot navigates to focusPath(lane, change)', () => {
    const move: Change = { id: 'c9', kind: 'move', slide: 's4', after: 's1', reason: 'earlier', status: 'pending' };
    const moved: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    history.replaceState(null, '', '/');
    render(<LaneRow lane={lane({ changes: [move] })} preview={moved} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    fireEvent.click(screen.getByRole('link', { name: 'open in focus: move slide 4 (Title s4)' }));
    expect(location.pathname).toBe(focusPath('l1', 'c9'));
    history.replaceState(null, '', '/');
  });
});

describe('LaneRow QA5: optimistic decisions, in-row move paths, changes listed when off-screen', () => {
  const move = (id: string, slideId: SlideId, after: SlideId | null): Change => ({ id, kind: 'move', slide: slideId, after, reason: `move ${slideId}`, status: 'pending' });
  const cellOf = (id: string) => screen.getAllByTestId('lane-cell').find((c) => c.getAttribute('data-slide') === id)!;

  it('a click on accept or refuse switches that cell to "accepted" / "refused" at once, buttons gone, before the server answers', async () => {
    const api = stubApi();
    let answer: (v: unknown) => void = () => undefined;
    api.acceptChange.mockImplementation(() => new Promise((resolve) => (answer = resolve)));
    api.refuseChange.mockImplementation(() => new Promise(() => undefined));
    const l = lane();
    const { rerender } = render(<LaneRow lane={l} preview={preview} mainOrder={order} mainThumbs={{}} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'accept: modify slide 3, Sharper s3' }));
    // Same tick, no server answer yet.
    expect(cellOf('s3').getAttribute('data-mark')).toBe('settled');
    expect(within(cellOf('s3')).getByTestId('settled-tag').textContent).toBe('accepted');
    expect(within(cellOf('s3')).queryByTestId('change-buttons')).toBeNull();
    expect(screen.queryByRole('button', { name: 'accept: modify slide 3, Sharper s3' })).toBeNull();
    await act(async () => answer({}));
    // lane.updated: the server's lane agrees, the cell stays decided.
    rerender(<LaneRow lane={{ ...l, changes: l.changes.map((c) => (c.id === 'c1' ? { ...c, status: 'accepted' as const } : c)) }} preview={preview} mainOrder={order} mainThumbs={{}} api={api} />);
    expect(within(cellOf('s3')).getByTestId('settled-tag').textContent).toBe('accepted');

    fireEvent.click(screen.getByRole('button', { name: 'refuse: remove slide 4, Title s4' }));
    expect(cellOf('s4').getAttribute('data-mark')).toBe('settled');
    expect(within(cellOf('s4')).getByTestId('settled-tag').textContent).toBe('refused');
    expect(within(cellOf('s4')).queryByTestId('change-buttons')).toBeNull();
  });

  it('a decision the server rejects comes back with its buttons and the error', async () => {
    const api = stubApi();
    api.acceptChange.mockRejectedValueOnce(new Error('409 change c1 is orphan'));
    render(<LaneRow lane={lane()} preview={preview} mainOrder={order} mainThumbs={{}} api={api} />);
    fireEvent.click(screen.getByRole('button', { name: 'accept: modify slide 3, Sharper s3' }));
    expect(cellOf('s3').getAttribute('data-mark')).toBe('settled');
    await waitFor(() => screen.queryByRole('alert'));
    expect(cellOf('s3').getAttribute('data-mark')).toBe('modified');
    expect(within(cellOf('s3')).getByTestId('change-buttons')).toBeTruthy();
  });

  it('a move draws its path inside its own row, on the row grid from its column to where it lands; none for a move that stays', () => {
    const earlier = move('m1', 's4', 's1');
    const p: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [earlier] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    const row = screen.getByTestId('lane-row');
    const path = screen.getByTestId('move-path');
    expect(row.contains(path)).toBe(true);
    expect(path.parentElement).toBe(screen.getByTestId('lane-grid'));
    // s4 (column 3) lands before column 1: the path spans columns 1..2 and reaches the moved card's dot.
    expect(path.getAttribute('data-from')).toBe('3');
    expect(path.getAttribute('data-to')).toBe('1');
    expect(path.style.gridColumn).toBe('2 / 4');
    expect(path.style.gridRow).toBe('1');
    expect(path.style.position).toBe('relative');
    cleanup();

    const later = move('m2', 's1', 's4');
    const q: LanePreviewPayload = { order: ['s2', 's3', 's4', 's1', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [later] })} preview={q} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.getByTestId('move-path').style.gridColumn).toBe('1 / 5');
    cleanup();

    // Lands where it already is: no path.
    const noop = move('m3', 's3', 's2');
    render(<LaneRow lane={lane({ changes: [noop] })} preview={{ order, slides: mainSlides, skipped: [], thumbs: {} }} mainOrder={order} mainThumbs={{}} api={stubApi()} />);
    expect(screen.queryByTestId('move-path')).toBeNull();
  });

  it('changed columns outside the window: the edge chip and, under it, each pending change on one line, a link to focus', () => {
    const big: SlideId[] = Array.from({ length: 20 }, (_, i) => `s${i + 1}`);
    const bigSlides = Object.fromEntries(big.map((id) => [id, slide(id)]));
    // Slides 17 and 18 go to 9 and 10; slide 8's move is settled (no-op accepted), in view.
    const moves: Change[] = [move('m17', 's17', 's8'), move('m18', 's18', 's17'), { ...move('m8', 's8', 's7'), status: 'accepted' }];
    const laneOrder = [...big.slice(0, 8), 's17', 's18', ...big.slice(8, 16), 's19', 's20'];
    const p: LanePreviewPayload = { order: laneOrder, slides: bigSlides, skipped: [], thumbs: {} };
    const open = vi.fn();
    render(
      <LaneRow
        lane={lane({ anchor: { kind: 'arc' }, changes: moves })}
        preview={p}
        mainOrder={big}
        mainSlides={bigSlides}
        mainThumbs={{}}
        api={stubApi()}
        view={{ first: 6, end: 9 }}
        onReveal={vi.fn()}
        onOpenChange={open}
      />,
    );
    expect(screen.getByTestId('edge-chip').textContent).toContain('slide 17');
    const list = screen.getByTestId('lane-offscreen');
    const links = within(list).getAllByRole('link');
    expect(links.map((a) => a.textContent)).toEqual(['move slide 17 to 9', 'move slide 18 to 10']);
    expect(links[0]!.getAttribute('href')).toBe(focusPath('l1', 'm17'));
    fireEvent.click(links[1]!);
    expect(open).toHaveBeenCalledWith('l1', 'm18');
    // The list lives in the header column.
    expect(list.closest('.gutter')).toBeTruthy();
  });

  it('no list while a changed cell is in view', () => {
    const p: LanePreviewPayload = { order: ['s1', 's4', 's2', 's3', 's5'], slides: mainSlides, skipped: [], thumbs: {} };
    render(<LaneRow lane={lane({ changes: [move('m1', 's4', 's1')] })} preview={p} mainOrder={order} mainThumbs={{}} api={stubApi()} view={{ first: 0, end: 5 }} onReveal={vi.fn()} />);
    expect(screen.queryByTestId('lane-offscreen')).toBeNull();
  });
});
