// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BriefChecks } from '../../web/src/screens/BriefChecks.js';
import { RemarkPostIt, anchorLabel } from '../../web/src/components/Remark.js';
import { mainPath, selectionFromSearch, type BriefChecksApi, type BusEvent, type ChecksStatus, type DeckPayload } from '../../web/src/api.js';
import type { Brief, Lane, Remark, Slide, SlideId } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: '', notes: '', body: '<p>x</p>', assets: [], kind: 'text' });
const order: SlideId[] = ['s1', 's2', 's3', 's4', 's5', 's6'];
const brief: Brief = { title: 'From Prompts to Products', audience: 'Product teams', message: 'AI can help.', pattern: 'solution-first', abstract: 'abs' };
const deck: DeckPayload = {
  state: { name: 'demo', order, version: 2, sessionId: null, model: 'm' },
  brief,
  order,
  slides: Object.fromEntries(order.map((id) => [id, slide(id)])),
};

const remark = (id: string, over: Partial<Remark>): Remark => ({
  id,
  anchor: { kind: 'arc' },
  text: `text ${id}`,
  origin: 'check:arc',
  severity: 'warn',
  status: 'open',
  laneId: null,
  createdAt: '2026-09-30T00:00:00.000Z',
  ...over,
});

const remarks: Remark[] = [
  remark('r_order', { origin: 'check:order', anchor: { kind: 'slide', slide: 's3' }, text: 'Key concept appears after a dependent detail.', laneId: 'l1' }),
  remark('r_gaps', { origin: 'check:gaps', anchor: { kind: 'range', from: 's4', to: 's6' }, text: 'Implementation details are thin.', severity: 'info' }),
  remark('r_old', { origin: 'check:gaps', anchor: { kind: 'slide', slide: 's1' }, text: 'already handled', status: 'resolved' }),
];

const lane: Lane = {
  id: 'l1',
  label: 'reorder',
  anchor: { kind: 'slide', slide: 's3' },
  origin: 'check:order',
  baseVersion: 2,
  changes: [
    { id: 'c0', kind: 'modify', slide: 's3', patch: { title: 'a' }, reason: 'r', status: 'refused' },
    { id: 'c1', kind: 'move', slide: 's3', after: 's1', reason: 'r', status: 'pending' },
  ],
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
};

const status: ChecksStatus = { running: [], lastRun: { arc: '2026-09-30T10:00:00.000Z', order: '2026-09-30T10:00:00.000Z', gaps: '2026-09-30T10:00:00.000Z', render: null } };

const stubApi = () => {
  const api = {
    getDeck: vi.fn(async () => deck),
    getBrief: vi.fn(async () => brief),
    putBrief: vi.fn(async (b: Brief) => b),
    getRemarks: vi.fn(async () => remarks),
    proposeRemark: vi.fn(async () => undefined),
    runChecks: vi.fn(async () => ({ started: ['arc', 'order', 'gaps', 'render'] as const }) as { started: ('arc' | 'order' | 'gaps' | 'render')[] }),
    getChecksStatus: vi.fn(async () => status),
    getLanes: vi.fn(async () => [lane]),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h${id}`, ready: true })),
  };
  return api satisfies BriefChecksApi;
};

const noEvents = (_h: (e: BusEvent) => void) => () => undefined;
const row = (name: string) => screen.getAllByTestId('check-row').find((r) => r.getAttribute('data-check') === name)!;
const header = (name: string) => within(row(name)).getAllByRole('button')[0]!;

afterEach(() => cleanup());

describe('BriefChecks', () => {
  it('renders one row per check with a green dot unless open warn remarks exist', async () => {
    render(<BriefChecks api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    expect(screen.getAllByTestId('check-row').map((r) => r.getAttribute('data-check'))).toEqual(['arc', 'order', 'gaps', 'render']);
    const dot = (name: string) => within(row(name)).getByTestId('check-dot').getAttribute('data-status');
    // order has an open warn; gaps only an open info (its warn is resolved); arc and render have nothing.
    expect(['arc', 'order', 'gaps', 'render'].map(dot)).toEqual(['ok', 'warn', 'ok', 'ok']);
    expect((screen.getByLabelText('title') as HTMLInputElement).value).toBe('From Prompts to Products');
  });

  it('expanding a row shows its open remarks with an anchor chip; show navigates to main with the selection', async () => {
    const navigate = vi.fn();
    render(<BriefChecks api={stubApi()} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    await waitFor(() => header('order').getAttribute('aria-expanded') === 'true');
    expect(header('gaps').getAttribute('aria-expanded')).toBe('false');
    expect(within(row('gaps')).queryAllByTestId('remark')).toHaveLength(0);

    fireEvent.click(header('gaps'));
    const cards = within(row('gaps')).getAllByTestId('remark');
    expect(cards.map((c) => c.getAttribute('data-remark'))).toEqual(['r_gaps']);
    expect(within(cards[0]!).getByTestId('anchor-chip').textContent).toBe('slides 4–6');
    expect(cards[0]!.textContent).toContain('Implementation details are thin.');

    fireEvent.click(within(cards[0]!).getByRole('button', { name: 'show' }));
    expect(navigate).toHaveBeenLastCalledWith('/?select=s4&to=s6');

    fireEvent.click(header('gaps'));
    expect(within(row('gaps')).queryAllByTestId('remark')).toHaveLength(0);
  });

  it('propose calls the api for that remark; a linked lane shows "lane ready" to its first pending change', async () => {
    const api = stubApi();
    const navigate = vi.fn();
    render(<BriefChecks api={api} subscribe={noEvents} navigate={navigate} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    await waitFor(() => within(row('order')).queryAllByTestId('remark').length === 1);
    const card = within(row('order')).getByTestId('remark');
    expect(within(card).getByTestId('anchor-chip').textContent).toBe('slide 3');
    await waitFor(() => within(card).queryByTestId('lane-ready'));
    fireEvent.click(within(card).getByTestId('lane-ready'));
    expect(navigate).toHaveBeenLastCalledWith('/lane/l1/change/c1');

    fireEvent.click(within(card).getByRole('button', { name: 'propose' }));
    expect(api.proposeRemark).toHaveBeenCalledWith('r_order');
    await waitFor(() => card.textContent?.includes('asked the co-author'));
  });

  it('highlights the anchored slides in the filmstrip and runs checks from the top button', async () => {
    const api = stubApi();
    render(<BriefChecks api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('brief-thumb').length === 6);
    await waitFor(() => header('order').getAttribute('aria-expanded') === 'true');
    // Only "order" is expanded: its remark on s3 is lit, the rest dimmed.
    const lit = () => screen.getAllByTestId('brief-thumb').filter((t) => t.getAttribute('data-lit') === 'true').map((t) => t.getAttribute('data-slide'));
    expect(lit()).toEqual(['s3']);
    fireEvent.click(header('gaps'));
    expect(lit()).toEqual(['s3', 's4', 's5', 's6']);

    fireEvent.click(screen.getByRole('button', { name: 'run checks' }));
    await waitFor(() => api.getChecksStatus.mock.calls.length >= 2);
    expect(api.runChecks).toHaveBeenCalledWith();
  });

  it('saves the brief on blur only when it changed, and the pattern on change', async () => {
    const api = stubApi();
    render(<BriefChecks api={api} subscribe={noEvents} navigate={vi.fn()} />);
    const title = (await waitFor(() => screen.queryByLabelText('title'))) as HTMLInputElement;
    fireEvent.blur(title);
    expect(api.putBrief).not.toHaveBeenCalled();
    fireEvent.change(title, { target: { value: 'New title' } });
    fireEvent.blur(title);
    expect(api.putBrief).toHaveBeenLastCalledWith({ ...brief, title: 'New title' });
    await waitFor(() => screen.getByTestId('brief-save').textContent === 'saved');
    fireEvent.click(screen.getByLabelText('problem by problem, build up'));
    expect(api.putBrief).toHaveBeenLastCalledWith({ ...brief, title: 'New title', pattern: 'problem-driven' });
  });

  it('refreshes remarks when the server announces remarks.changed', async () => {
    const api = stubApi();
    let push: (e: BusEvent) => void = () => undefined;
    render(<BriefChecks api={api} subscribe={(h) => ((push = h), () => undefined)} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    api.getRemarks.mockResolvedValueOnce([remark('r_arc', { anchor: { kind: 'slide', slide: 's2' } })]);
    push({ type: 'remarks.changed' });
    await waitFor(() => within(row('arc')).getByTestId('check-dot').getAttribute('data-status') === 'warn');
    expect(within(row('order')).getByTestId('check-dot').getAttribute('data-status')).toBe('ok');
  });
});

describe('remark helpers', () => {
  it('labels anchors and round-trips the main selection query', () => {
    expect(anchorLabel({ kind: 'slide', slide: 's6' }, order)).toBe('slide 6');
    expect(anchorLabel({ kind: 'range', from: 's5', to: 's2' }, order)).toBe('slides 2–5');
    expect(anchorLabel({ kind: 'arc' }, order)).toBe('arc');
    expect(selectionFromSearch(mainPath({ kind: 'slide', slide: 's3' }).slice(1))).toEqual({ kind: 'slide', slide: 's3' });
    expect(selectionFromSearch(mainPath({ kind: 'range', from: 's2', to: 's4' }).slice(1))).toEqual({ kind: 'range', from: 's2', to: 's4' });
    expect(mainPath({ kind: 'arc' })).toBe('/');
    expect(selectionFromSearch('')).toBeNull();
  });

  it('a post-it truncates long text and its buttons call propose and resolve', async () => {
    const onPropose = vi.fn(async () => undefined);
    const onResolve = vi.fn(async () => undefined);
    const long = remark('r_long', { text: 'x'.repeat(200), anchor: { kind: 'slide', slide: 's2' } });
    render(<RemarkPostIt remark={long} onPropose={onPropose} onResolve={onResolve} />);
    const p = screen.getByTestId('post-it');
    expect(p.textContent!.length).toBeLessThan(120);
    fireEvent.click(within(p).getByRole('button', { name: 'propose' }));
    expect(onPropose).toHaveBeenCalledWith('r_long');
    await waitFor(() => within(p).queryByRole('button', { name: 'asked' }));
    fireEvent.click(within(p).getByRole('button', { name: 'resolve' }));
    expect(onResolve).toHaveBeenCalledWith('r_long');
  });
});
