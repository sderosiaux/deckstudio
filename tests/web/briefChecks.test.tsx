// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { BriefChecks, autoRows, dotState } from '../../web/src/screens/BriefChecks.js';
import { RemarkPostIt, anchorLabel, cutAtWord } from '../../web/src/components/Remark.js';
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
    getLanes: vi.fn(async (_status?: 'draft' | 'open' | 'all') => [lane]),
    openLane: vi.fn(async (_id: string) => undefined),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `h${id}`, ready: true })),
  };
  return api satisfies BriefChecksApi;
};

const noEvents = (_h: (e: BusEvent) => void) => () => undefined;
const row = (name: string) => screen.getAllByTestId('check-row').find((r) => r.getAttribute('data-check') === name)!;
const header = (name: string) => within(row(name)).getAllByRole('button')[0]!;

afterEach(() => cleanup());

describe('BriefChecks', () => {
  it('renders one row per check: green after a run without warnings, accent with warnings, grey never run', async () => {
    render(<BriefChecks api={stubApi()} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    expect(screen.getAllByTestId('check-row').map((r) => r.getAttribute('data-check'))).toEqual(['arc', 'order', 'gaps', 'render']);
    const dot = (name: string) => within(row(name)).getByTestId('check-dot').getAttribute('data-status');
    // order has an open warn; gaps only an open info (its warn is resolved); arc ran clean; render never ran.
    await waitFor(() => dot('render') === 'idle');
    expect(['arc', 'order', 'gaps', 'render'].map(dot)).toEqual(['ok', 'warn', 'ok', 'idle']);
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

    fireEvent.click(screen.getByRole('button', { name: 'Run checks' }));
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

describe('BriefChecks live status', () => {
  it('applies checks.status events from their payload: one status fetch on mount, none per event, one on a reconnect', async () => {
    const api = stubApi();
    let push: (e: BusEvent) => void = () => undefined;
    render(<BriefChecks api={api} subscribe={(h) => ((push = h), () => undefined)} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    // the initial status (arc ran, render never) has landed
    await waitFor(() => row('arc').textContent?.includes('last run'));
    expect(row('render').textContent).toContain('not run yet');
    const runBtn = () => screen.getByRole('button', { name: /checks/i });

    act(() => push({ type: 'checks.status', running: ['arc', 'render'] }));
    expect(row('render').textContent).toContain('running…');
    expect(runBtn().textContent).toBe('Checks running…');
    act(() => push({ type: 'checks.status', running: ['render'] }));
    expect(row('arc').textContent).not.toContain('running…');
    act(() => push({ type: 'checks.status', running: [] }));
    expect(row('render').textContent).toContain('last run');
    expect(runBtn().textContent).toBe('Run checks');
    expect(api.getChecksStatus).toHaveBeenCalledTimes(1);

    // First open of the socket: the mount already loaded. A reopen means lost events: resync.
    act(() => push({ type: 'hello', version: null }));
    expect(api.getChecksStatus).toHaveBeenCalledTimes(1);
    act(() => push({ type: 'hello', version: null }));
    await waitFor(() => api.getChecksStatus.mock.calls.length === 2);
  });

  it('lane-scoped remarks do not light a check red, count, or show in its list', async () => {
    const api = stubApi();
    api.getRemarks.mockResolvedValue([remark('r_lane', { origin: 'check:render', anchor: { kind: 'slide', slide: 's3' }, sourceLaneId: 'l1' })]);
    render(<BriefChecks api={api} subscribe={noEvents} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('brief-thumb').length === 6);
    await waitFor(() => api.getRemarks.mock.calls.length === 1 && api.getLanes.mock.calls.length === 1);
    await waitFor(() => within(row('render')).getByTestId('check-dot').getAttribute('data-status') === 'idle');
    fireEvent.click(header('render'));
    expect(within(row('render')).queryAllByTestId('remark')).toHaveLength(0);
    expect(screen.getAllByTestId('brief-thumb').filter((t) => t.getAttribute('data-lit') === 'true')).toHaveLength(0);
  });
});

describe('BriefChecks status dots', () => {
  const dot = (name: string) => within(row(name)).getByTestId('check-dot');

  it('grey and "not run yet" before any run, animated while running, green after a clean run, accent after one with warnings', async () => {
    const api = stubApi();
    api.getRemarks.mockResolvedValue([]);
    api.getChecksStatus.mockResolvedValue({ running: [], lastRun: { arc: null, order: null, gaps: null, render: null } });
    let push: (e: BusEvent) => void = () => undefined;
    render(<BriefChecks api={api} subscribe={(h) => ((push = h), () => undefined)} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    await waitFor(() => api.getChecksStatus.mock.calls.length === 1 && api.getRemarks.mock.calls.length === 1);
    expect(dot('arc').getAttribute('data-status')).toBe('idle');
    expect(dot('arc').getAttribute('aria-label')).toBe('not run yet');
    expect(dot('arc').style.background).toBe('var(--grey-2)');

    act(() => push({ type: 'checks.status', running: ['arc', 'order'] }));
    expect(dot('arc').getAttribute('data-status')).toBe('running');
    expect(dot('arc').getAttribute('aria-label')).toBe('running');
    expect(dot('arc').style.animation).toContain('check-dot-pulse');

    api.getRemarks.mockResolvedValue([remark('r_o', { origin: 'check:order', anchor: { kind: 'slide', slide: 's2' } })]);
    act(() => push({ type: 'remarks.changed' }));
    act(() => push({ type: 'checks.status', running: [] }));
    await waitFor(() => dot('order').getAttribute('data-status') === 'warn');
    expect(dot('order').style.background).toBe('var(--accent)');
    expect(dot('arc').getAttribute('data-status')).toBe('ok');
    expect(dot('arc').getAttribute('aria-label')).toBe('no warnings');
    expect(dot('arc').style.background).toBe('var(--ok)');
    expect(dot('gaps').getAttribute('data-status')).toBe('idle');
  });

  it('marks as new the remarks created after the previous run the screen saw', async () => {
    const api = stubApi();
    const old = remark('r_old_arc', { anchor: { kind: 'slide', slide: 's2' }, createdAt: '2026-09-30T09:00:00.000Z' });
    api.getRemarks.mockResolvedValue([old]);
    let push: (e: BusEvent) => void = () => undefined;
    render(<BriefChecks api={api} subscribe={(h) => ((push = h), () => undefined)} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    await waitFor(() => within(row('arc')).queryAllByTestId('remark').length === 1);
    await waitFor(() => row('arc').textContent?.includes('last run'));
    // Nothing is new on the first look: the screen never saw an earlier run.
    expect(within(row('arc')).queryAllByTestId('remark-new')).toHaveLength(0);

    act(() => push({ type: 'checks.status', running: ['arc'] }));
    api.getRemarks.mockResolvedValue([old, remark('r_new_arc', { anchor: { kind: 'slide', slide: 's4' }, createdAt: '2026-09-30T10:30:00.000Z' })]);
    act(() => push({ type: 'remarks.changed' }));
    act(() => push({ type: 'checks.status', running: [] }));
    await waitFor(() => within(row('arc')).queryAllByTestId('remark').length === 2);
    const card = (id: string) => within(row('arc')).getAllByTestId('remark').find((c) => c.getAttribute('data-remark') === id)!;
    await waitFor(() => within(card('r_new_arc')).queryByTestId('remark-new'));
    expect(within(card('r_old_arc')).queryByTestId('remark-new')).toBeNull();
  });
});

describe('BriefChecks draft lanes', () => {
  const draft: Lane = { ...lane, id: 'l2', label: 'draft fix', status: 'draft', changes: [{ id: 'd1', kind: 'modify', slide: 's2', patch: { title: 'b' }, reason: 'r', status: 'pending' }] };

  it('a remark linked to a draft lane offers "open draft lane" instead of propose; opening it turns into "lane ready"', async () => {
    const api = stubApi();
    api.getRemarks.mockResolvedValue([remark('r_d', { origin: 'check:order', anchor: { kind: 'slide', slide: 's2' }, laneId: 'l2' })]);
    api.getLanes.mockResolvedValue([lane, draft]);
    let push: (e: BusEvent) => void = () => undefined;
    render(<BriefChecks api={api} subscribe={(h) => ((push = h), () => undefined)} navigate={vi.fn()} />);
    await waitFor(() => screen.queryAllByTestId('check-row').length === 4);
    const card = await waitFor(() => within(row('order')).queryByTestId('remark'));
    expect(api.getLanes).toHaveBeenCalledWith('all');
    const open = await waitFor(() => within(card).queryByRole('button', { name: 'open draft lane' }));
    expect(within(card).queryByRole('button', { name: 'propose' })).toBeNull();
    expect(within(card).queryByTestId('lane-ready')).toBeNull();

    fireEvent.click(open);
    expect(api.openLane).toHaveBeenCalledWith('l2');
    api.getLanes.mockResolvedValue([lane, { ...draft, status: 'open' }]);
    act(() => push({ type: 'lane.updated', laneId: 'l2' }));
    await waitFor(() => within(card).queryByTestId('lane-ready'));
    expect(within(card).getByTestId('lane-ready').getAttribute('href')).toBe('/lane/l2/change/d1');
    expect(within(card).queryByRole('button', { name: 'open draft lane' })).toBeNull();
  });
});

describe('BriefChecks brief layout', () => {
  it('audience and message wrap in textareas whose rows follow their content', async () => {
    const api = stubApi();
    const long = 'Streaming platform engineers who already run Kafka in production and wonder whether agents belong on it at all.';
    api.getBrief.mockResolvedValue({ ...brief, audience: long, message: `${long}\n${long}` });
    render(<BriefChecks api={api} subscribe={noEvents} navigate={vi.fn()} />);
    const audience = (await waitFor(() => screen.queryByLabelText('audience'))) as HTMLTextAreaElement;
    const msg = screen.getByLabelText('message in one sentence') as HTMLTextAreaElement;
    expect(audience.tagName).toBe('TEXTAREA');
    expect(audience.rows).toBeGreaterThan(1);
    expect(msg.rows).toBeGreaterThan(audience.rows);
    fireEvent.change(msg, { target: { value: 'short' } });
    expect(msg.rows).toBe(2);
    // one grid row per label and per control: nothing can overlap
    const form = screen.getByTestId('brief-fields');
    expect(form.style.display).toBe('grid');
  });
});

describe('remark helpers', () => {
  it('autoRows counts hard lines and wraps long ones, never below the minimum', () => {
    expect(autoRows('', 2)).toBe(2);
    expect(autoRows('a\nb\nc', 1)).toBe(3);
    expect(autoRows('x'.repeat(100), 1, 40)).toBe(3);
  });

  it('dotState: running beats everything, warnings beat a clean run, never run is idle', () => {
    expect(dotState({ running: true, warn: true, ran: true })).toBe('running');
    expect(dotState({ running: false, warn: true, ran: false })).toBe('warn');
    expect(dotState({ running: false, warn: false, ran: true })).toBe('ok');
    expect(dotState({ running: false, warn: false, ran: false })).toBe('idle');
  });

  it('labels anchors and round-trips the main selection query', () => {
    expect(anchorLabel({ kind: 'slide', slide: 's6' }, order)).toBe('slide 6');
    expect(anchorLabel({ kind: 'range', from: 's5', to: 's2' }, order)).toBe('slides 2–5');
    expect(anchorLabel({ kind: 'arc' }, order)).toBe('arc');
    expect(selectionFromSearch(mainPath({ kind: 'slide', slide: 's3' }).slice(1))).toEqual({ kind: 'slide', slide: 's3' });
    expect(selectionFromSearch(mainPath({ kind: 'range', from: 's2', to: 's4' }).slice(1))).toEqual({ kind: 'range', from: 's2', to: 's4' });
    expect(mainPath({ kind: 'arc' })).toBe('/');
    expect(selectionFromSearch('')).toBeNull();
  });

  it('cuts remark text after a whole word, never inside one', () => {
    const text = 'Slide 7 is part of the arc but reads as a detour';
    // A box that holds 18 characters: the cut ends on "part", with the ellipsis.
    expect(cutAtWord(text, (c) => c.length <= 18)).toBe('Slide 7 is part…');
    expect(cutAtWord('short', () => true)).toBe('short');
    expect(cutAtWord('unbreakable', (c) => c.length <= 3)).toBe('unbreakable');
  });

  it('a post-it keeps its full text as the tooltip and its buttons call propose and resolve', async () => {
    const onPropose = vi.fn(async () => undefined);
    const onResolve = vi.fn(async () => undefined);
    const long = remark('r_long', { text: 'x'.repeat(200), anchor: { kind: 'slide', slide: 's2' } });
    render(<RemarkPostIt remark={long} onPropose={onPropose} onResolve={onResolve} />);
    const p = screen.getByTestId('post-it');
    expect(p.getAttribute('title')).toBe('x'.repeat(200));
    fireEvent.click(within(p).getByRole('button', { name: 'propose' }));
    expect(onPropose).toHaveBeenCalledWith('r_long');
    await waitFor(() => within(p).queryByRole('button', { name: 'asked' }));
    fireEvent.click(within(p).getByRole('button', { name: 'resolve' }));
    expect(onResolve).toHaveBeenCalledWith('r_long');
  });
});
