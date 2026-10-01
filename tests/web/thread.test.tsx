// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { LONG_TURN_TEXT, Thread, describeTool, formatElapsed, laneCounts, plural } from '../../web/src/components/Thread.js';
import type { BusEvent, LanePreviewPayload, ProposalApi, ThreadApi } from '../../web/src/api.js';
import type { Change, Lane, Slide, SlideId, ThreadMessage, Version } from '../../src/model/types.js';
import { waitFor } from '../helpers/waitFor.js';

const slide = (id: string, title = `Title ${id}`): Slide => ({ id, title, story: '', notes: '', body: '', assets: [], kind: 'text' });
const order: SlideId[] = ['s1', 's2', 's3'];
const slides: Record<SlideId, Slide> = Object.fromEntries(order.map((id) => [id, slide(id)]));

const onS2: Change = { id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'Shorter' }, reason: 'shorter labels', status: 'pending' };
const onS3: Change = { id: 'c2', kind: 'modify', slide: 's3', patch: { title: 'Other' }, reason: 'other slide', status: 'pending' };
const mkLane = (id: string, anchor: Lane['anchor'], changes: Change[], label = 'Shorter labels on the three jobs'): Lane => ({
  id,
  label,
  anchor,
  origin: 'user',
  baseVersion: 3,
  changes,
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
});
const preview: LanePreviewPayload = {
  order,
  slides: { ...slides, s2: slide('s2', 'Shorter') },
  skipped: [],
  thumbs: { s2: { hash: 'lane_s2', ready: true }, s3: { hash: 'lane_s3', ready: true } },
};
const version = (n: number): Version => ({ n, order, slides: {}, cause: { kind: 'import' }, createdAt: '' });

function setup(lanes: Record<string, Lane> = {}) {
  const handlers = new Set<(e: BusEvent) => void>();
  const emit = (e: BusEvent) => act(() => handlers.forEach((h) => h(e)));
  const stored: ThreadMessage[] = [];
  const api = {
    getThread: vi.fn(async () => [...stored]),
    postMessage: vi.fn(async () => undefined),
    getLane: vi.fn(async (id: string) => lanes[id]!),
    getLanePreview: vi.fn(async () => preview),
    thumbFor: vi.fn(async (id: SlideId) => ({ hash: `main_${id}`, ready: true })),
    acceptChange: vi.fn(async (laneId: string) => ({ version: version(8), lane: { ...lanes[laneId]!, changes: lanes[laneId]!.changes.map((c) => ({ ...c, status: 'accepted' as const })) } })),
    refuseChange: vi.fn(async (laneId: string) => lanes[laneId]!),
  } satisfies ThreadApi & ProposalApi;
  const subscribe = (h: (e: BusEvent) => void) => {
    handlers.add(h);
    return () => {
      handlers.delete(h);
    };
  };
  return { api, emit, subscribe, stored, navigate: vi.fn() };
}

const send = (text: string) => {
  fireEvent.change(screen.getByLabelText('message'), { target: { value: text } });
  fireEvent.click(screen.getByRole('button', { name: 'Send' }));
};

afterEach(() => {
  cleanup();
  vi.useRealTimers();
});

describe('Thread pending state', () => {
  it('right after Send shows who works on what with a live timer and the last tool in plain words; done clears it', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t = setup();
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} />);
    send('shorter labels please');
    const pending = () => screen.queryByTestId('thread-pending');
    expect(pending()!.textContent).toContain('co-author is working on slide 2');
    expect(within(pending()!).getByTestId('thread-elapsed').textContent).toBe('0:00');
    act(() => vi.advanceTimersByTime(12_000));
    expect(within(pending()!).getByTestId('thread-elapsed').textContent).toBe('0:12');

    t.emit({ type: 'tool.call', thread: 'slide:s2', name: 'mcp__deck__render_slide' });
    expect(pending()!.textContent).toContain('rendering');
    // the stream starts: the row keeps the last tool and the timer
    t.emit({ type: 'assistant.delta', thread: 'slide:s2', text: 'Done.' });
    expect(pending()!.textContent).toContain('rendering');
    t.emit({ type: 'tool.call', thread: 'slide:s2', name: 'mcp__deck__propose_lane' });
    expect(pending()!.textContent).toContain('proposing a lane');
    expect(pending()!.textContent).not.toContain('·');

    t.emit({ type: 'assistant.done', thread: 'slide:s2', messageId: 'm2' });
    await vi.waitFor(() => expect(pending()).toBeNull());
  });

  it('an agent error clears the pending row', async () => {
    const t = setup();
    render(<Thread threadKey="global" context={{ kind: 'arc' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} />);
    send('hi');
    expect(screen.getByTestId('thread-pending').textContent).toContain('co-author is working on whole deck');
    t.emit({ type: 'agent.error', thread: 'global', message: 'boom' });
    expect(screen.queryByTestId('thread-pending')).toBeNull();
  });

  it('formats elapsed time as m:ss and names tools in plain words', () => {
    expect(formatElapsed(0)).toBe('0:00');
    expect(formatElapsed(12_400)).toBe('0:12');
    expect(formatElapsed(125_000)).toBe('2:05');
    expect(describeTool('mcp__deck__render_slide')).toBe('rendering');
    expect(describeTool('mcp__deck__get_slide')).toBe('reading a slide');
  });
});

describe('Thread replies carry their proposal', () => {
  it('a lane created for this context during the turn shows under the reply: title link, before/after thumbs on this slide, accept, refuse, open in focus', async () => {
    const lane = mkLane('l1', { kind: 'slide', slide: 's2' }, [onS2, onS3]);
    const unrelated = mkLane('l9', { kind: 'slide', slide: 's3' }, [onS3], 'Elsewhere');
    const t = setup({ l1: lane, l9: unrelated });
    render(
      <Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} layout="inline" />,
    );
    await vi.waitFor(() => expect(t.api.getThread).toHaveBeenCalled());
    send('shorter labels please');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalled());
    t.emit({ type: 'lane.created', laneId: 'l1' });
    t.emit({ type: 'lane.created', laneId: 'l9' });
    t.stored.push(
      { id: 'm1', thread: 'slide:s2', role: 'user', text: 'shorter labels please', context: { kind: 'slide', slide: 's2' }, at: '2026-09-30T10:00:00.000Z' },
      { id: 'm2', thread: 'slide:s2', role: 'assistant', text: 'Proposed shorter labels.', context: null, at: '2026-09-30T10:00:05.000Z' },
    );
    t.emit({ type: 'assistant.done', thread: 'slide:s2', messageId: 'm2' });

    await vi.waitFor(() => expect(screen.queryAllByTestId('thread-proposal')).toHaveLength(1));
    const reply = screen.getAllByTestId('thread-message').find((m) => m.getAttribute('data-role') === 'assistant')!;
    const block = within(reply).getByTestId('thread-proposal');
    expect(block.getAttribute('data-lane')).toBe('l1');
    const title = within(block).getByRole('link', { name: 'lane: Shorter labels on the three jobs' });
    expect(title.getAttribute('href')).toBe('/lane/l1/change/c1');
    fireEvent.click(title);
    expect(t.navigate).toHaveBeenLastCalledWith('/lane/l1/change/c1');

    // only the change on this slide, as a main/lane thumb pair
    await vi.waitFor(() => expect(within(block).getAllByTestId('proposal-change')).toHaveLength(1));
    const change = within(block).getByTestId('proposal-change');
    expect(change.getAttribute('data-change')).toBe('c1');
    await vi.waitFor(() => expect(change.querySelectorAll('img')).toHaveLength(2));
    expect(Array.from(change.querySelectorAll('img')).map((i) => i.getAttribute('src'))).toEqual(['/api/thumbs/main_s2.png', '/api/thumbs/lane_s2.png']);

    fireEvent.click(within(change).getByRole('link', { name: 'open in focus' }));
    expect(t.navigate).toHaveBeenLastCalledWith('/lane/l1/change/c1');

    fireEvent.click(within(change).getByRole('button', { name: 'accept' }));
    await vi.waitFor(() => expect(t.api.acceptChange).toHaveBeenCalledWith('l1', 'c1'));
    await vi.waitFor(() => expect(within(block).getByRole('status').textContent).toBe('accepted into main as v8'));
    // the acknowledgement is also a line of the thread
    expect(screen.getAllByTestId('thread-note').map((n) => n.textContent)).toContain('accepted into main as v8');
  });

  it('a lane revised in a lane thread attaches to the reply; nothing attaches without a lane event or for another context', async () => {
    const lane = mkLane('l1', { kind: 'range', from: 's1', to: 's3' }, [onS2]);
    const t = setup({ l1: lane });
    render(<Thread threadKey="lane:l1" context={{ kind: 'slide', slide: 's1' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    await vi.waitFor(() => expect(t.api.getThread).toHaveBeenCalled());

    send('no lane this time');
    t.stored.push({ id: 'a1', thread: 'lane:l1', role: 'assistant', text: 'Nothing to change.', context: null, at: '2026-09-30T10:00:01.000Z' });
    t.emit({ type: 'assistant.done', thread: 'lane:l1', messageId: 'a1' });
    await vi.waitFor(() => expect(screen.queryAllByTestId('thread-message')).toHaveLength(1));
    expect(screen.queryByTestId('thread-proposal')).toBeNull();

    send('revise it');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalledTimes(2));
    t.emit({ type: 'lane.updated', laneId: 'l1' });
    t.stored.push({ id: 'a2', thread: 'lane:l1', role: 'assistant', text: 'Revised.', context: null, at: '2026-09-30T10:00:09.000Z' });
    t.emit({ type: 'assistant.done', thread: 'lane:l1', messageId: 'a2' });
    await vi.waitFor(() => expect(screen.queryAllByTestId('thread-proposal')).toHaveLength(1));
    const reply = screen.getAllByTestId('thread-message').find((m) => m.textContent?.includes('Revised.'))!;
    expect(within(reply).getByTestId('thread-proposal').getAttribute('data-lane')).toBe('l1');
  });

  it('refuse says refused, in the block and in the thread', async () => {
    const lane = mkLane('l1', { kind: 'slide', slide: 's2' }, [onS2]);
    const t = setup({ l1: lane });
    t.api.refuseChange.mockResolvedValueOnce({ ...lane, status: 'closed', changes: [{ ...onS2, status: 'refused' }] });
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} />);
    send('x');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalled());
    t.emit({ type: 'lane.created', laneId: 'l1' });
    t.stored.push({ id: 'm2', thread: 'slide:s2', role: 'assistant', text: 'ok', context: null, at: '2026-09-30T10:00:05.000Z' });
    t.emit({ type: 'assistant.done', thread: 'slide:s2', messageId: 'm2' });
    await vi.waitFor(() => expect(screen.queryAllByRole('button', { name: 'refuse' })).toHaveLength(1));
    fireEvent.click(screen.getByRole('button', { name: 'refuse' }));
    await vi.waitFor(() => expect(within(screen.getByTestId('thread-proposal')).getByRole('status').textContent).toBe('refused'));
    expect(screen.getAllByTestId('thread-note').map((n) => n.textContent)).toContain('refused');
  });

  it('shows notes given by the screen as thread lines', async () => {
    const t = setup();
    render(
      <Thread
        threadKey="lane:l1"
        context={{ kind: 'arc' }}
        order={order}
        slides={slides}
        api={t.api}
        subscribe={t.subscribe}
        notes={[{ id: 'n1', text: 'accepted into main as v8', at: '2026-09-30T10:00:00.000Z' }]}
      />,
    );
    await vi.waitFor(() => expect(screen.getAllByTestId('thread-note').map((n) => n.textContent)).toEqual(['accepted into main as v8']));
  });
});

describe('Thread scoped to a selection', () => {
  const msg = (id: string, role: 'user' | 'assistant', context: ThreadMessage['context'], at: string): ThreadMessage => ({ id, thread: 'global', role, text: `text ${id}`, context, at });
  const range = { kind: 'range' as const, from: 's1', to: 's2' };

  it('with `only`, shows the turns whose message was sent on that anchor: the user message and the replies after it', async () => {
    const t = setup();
    t.stored.push(
      msg('u1', 'user', range, '2026-09-30T00:00:01.000Z'),
      msg('a1', 'assistant', null, '2026-09-30T00:00:02.000Z'),
      msg('u2', 'user', { kind: 'arc' }, '2026-09-30T00:00:03.000Z'),
      msg('a2', 'assistant', null, '2026-09-30T00:00:04.000Z'),
      msg('u3', 'user', { kind: 'range', from: 's2', to: 's3' }, '2026-09-30T00:00:05.000Z'),
      msg('u4', 'user', range, '2026-09-30T00:00:06.000Z'),
    );
    render(<Thread threadKey="global" context={range} only={range} order={order} slides={slides} api={t.api} subscribe={t.subscribe} />);
    await waitFor(() => screen.queryAllByTestId('thread-message').length > 0);
    expect(screen.getAllByTestId('thread-message').map((m) => m.textContent)).toEqual([
      expect.stringContaining('text u1'),
      expect.stringContaining('text a1'),
      expect.stringContaining('text u4'),
    ]);
    // A message sent here is about the range: it shows at once.
    send('tighter');
    await waitFor(() => screen.getAllByTestId('thread-message').length === 4);
    expect(t.api.postMessage).toHaveBeenCalledWith('global', 'tighter', range);
  });

  it('a message sent on another anchor than the current context keeps its own context under it', async () => {
    const t = setup();
    t.stored.push(msg('u1', 'user', range, '2026-09-30T00:00:01.000Z'), msg('u2', 'user', { kind: 'arc' }, '2026-09-30T00:00:02.000Z'));
    render(<Thread threadKey="global" context={{ kind: 'arc' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} />);
    await waitFor(() => screen.queryAllByTestId('thread-message').length === 2);
    const [first, second] = screen.getAllByTestId('thread-message');
    expect(within(first!).getByTestId('message-context').textContent).toBe('on slides 1–2');
    expect(within(second!).queryByTestId('message-context')).toBeNull();
  });

  it('autoFocus puts the caret in the composer; `lead` renders between the header and the messages', async () => {
    const t = setup();
    render(
      <Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} autoFocus lead={<p data-testid="lead">remarks</p>} />,
    );
    expect(document.activeElement).toBe(screen.getByLabelText('message'));
    const lead = screen.getByTestId('lead');
    expect(lead.compareDocumentPosition(screen.getByRole('log')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
  });
});

describe('Thread proposal actions and seed', () => {
  /** Sends a turn on slide s2 that creates lane l1, and waits for its proposal under the reply. */
  const proposeOnS2 = async (t: ReturnType<typeof setup>) => {
    send('shorter labels please');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalled());
    t.emit({ type: 'lane.created', laneId: 'l1' });
    t.stored.push({ id: 'm2', thread: 'slide:s2', role: 'assistant', text: 'Proposed.', context: null, at: '2026-09-30T10:00:05.000Z' });
    t.emit({ type: 'assistant.done', thread: 'slide:s2', messageId: 'm2' });
    await vi.waitFor(() => expect(screen.queryAllByTestId('proposal-change')).toHaveLength(1));
    return screen.getByTestId('proposal-change');
  };

  it('proposalActions="focus-link" keeps the before/after pair and open in focus, without accept or refuse', async () => {
    const t = setup({ l1: mkLane('l1', { kind: 'slide', slide: 's2' }, [onS2]) });
    render(
      <Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} proposalActions="focus-link" />,
    );
    const change = await proposeOnS2(t);
    await vi.waitFor(() => expect(change.querySelectorAll('img')).toHaveLength(2));
    expect(within(change).queryByRole('button', { name: 'accept' })).toBeNull();
    expect(within(change).queryByRole('button', { name: 'refuse' })).toBeNull();
    expect(within(change).getByRole('link', { name: 'open in focus' })).toBeTruthy();
  });

  it('proposalActions="none" keeps only the pair: no decision, no link to the screen it is already on', async () => {
    const t = setup({ l1: mkLane('l1', { kind: 'slide', slide: 's2' }, [onS2]) });
    render(
      <Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} proposalActions="none" />,
    );
    const change = await proposeOnS2(t);
    await vi.waitFor(() => expect(change.querySelectorAll('img')).toHaveLength(2));
    const block = screen.getByTestId('thread-proposal');
    expect(within(block).queryAllByRole('button')).toHaveLength(0);
    expect(within(block).queryAllByRole('link')).toHaveLength(0);
    expect(block.textContent).toContain('Shorter labels on the three jobs');
  });

  it('a seed shows read-only before the thread’s own messages, under its label', async () => {
    const t = setup();
    t.stored.push({ id: 'own', thread: 'lane:l1', role: 'user', text: 'own message', context: null, at: '2026-09-30T09:00:00.000Z' });
    const seed: ThreadMessage[] = [
      { id: 'u', thread: 'slide:s2', role: 'user', text: 'make it shorter', context: { kind: 'slide', slide: 's2' }, at: '2026-09-30T10:00:00.000Z' },
      { id: 'a', thread: 'slide:s2', role: 'assistant', text: 'Opened a lane.', context: null, at: '2026-09-30T10:00:05.000Z' },
    ];
    render(
      <Thread threadKey="lane:l1" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} seed={{ label: 'from the slide conversation', messages: seed }} />,
    );
    await waitFor(() => screen.queryAllByTestId('thread-message').length === 1);
    const block = screen.getByTestId('thread-seed');
    expect(within(block).getByText('from the slide conversation')).toBeTruthy();
    expect(within(block).getAllByTestId('seed-message').map((m) => m.textContent)).toEqual([expect.stringContaining('make it shorter'), expect.stringContaining('Opened a lane.')]);
    expect(within(block).queryAllByRole('button')).toHaveLength(0);
    expect(block.compareDocumentPosition(screen.getByTestId('thread-message')) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    // The seed is no message of this thread: the hint for an empty thread still reads as such.
    expect(screen.getAllByTestId('thread-message')).toHaveLength(1);
  });
});

describe('Thread heading', () => {
  it('a panel with heading="section" titles itself like the sections beside it, not like a screen', () => {
    const t = setup();
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} title="conversation about this slide" heading="section" />);
    const h = screen.getByRole('heading', { name: 'conversation about this slide' });
    expect(h.className).toBe('row-label');
    cleanup();
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} title="Thread" />);
    expect(screen.getByRole('heading', { name: 'Thread' }).className).toBe('screen-title');
  });
});

describe('Thread proposal cards (QA3)', () => {
  it('a proposal card shows ~200px thumbs and one line per changed field, the arrow a glyph in a span, outside any button', async () => {
    const both: Change = { id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'One home already exists', notes: 'say it slowly', story: '' }, reason: 'one idea', status: 'pending' };
    const lane = mkLane('l1', { kind: 'slide', slide: 's2' }, [both]);
    const t = setup({ l1: lane });
    const withNotes = { ...slides, s2: { ...slides.s2!, title: 'Two answers, one already exists', notes: 'old notes' } };
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={withNotes} api={t.api} subscribe={t.subscribe} navigate={t.navigate} layout="inline" />);
    send('one idea');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalled());
    t.emit({ type: 'lane.created', laneId: 'l1' });
    t.stored.push({ id: 'm2', thread: 'slide:s2', role: 'assistant', text: 'Proposed.', context: null, at: '2026-09-30T10:00:05.000Z' });
    t.emit({ type: 'assistant.done', thread: 'slide:s2', messageId: 'm2' });
    const change = await waitFor(() => screen.queryByTestId('proposal-change'));
    const lines = within(change).getAllByTestId('field-diff');
    // story '' equals main's '': no line for it.
    expect(lines.map((l) => l.getAttribute('data-field'))).toEqual(['title', 'notes']);
    expect(lines[0]!.textContent).toBe('title: Two answers, one already exists → One home already exists');
    const arrow = within(lines[0]!).getByTestId('diff-arrow');
    expect(arrow.tagName).toBe('SPAN');
    expect(arrow.textContent).toBe('→');
    expect(arrow.closest('button')).toBeNull();
    for (const b of within(change).getAllByRole('button')) expect(b.textContent).not.toContain('→');
    const previews = within(change).getAllByTestId('slide-preview');
    expect(previews.map((p) => p.style.width)).toEqual(['200px', '200px']);
  });

  it('with onShowLane, "lane: <label>" is a control that shows the lane row instead of leaving the screen', async () => {
    const t = setup({ l1: mkLane('l1', { kind: 'slide', slide: 's2' }, [onS2]) });
    const show = vi.fn();
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} onShowLane={show} />);
    send('x');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalled());
    t.emit({ type: 'lane.created', laneId: 'l1' });
    t.stored.push({ id: 'm2', thread: 'slide:s2', role: 'assistant', text: 'ok', context: null, at: '2026-09-30T10:00:05.000Z' });
    t.emit({ type: 'assistant.done', thread: 'slide:s2', messageId: 'm2' });
    const lane = await waitFor(() => screen.queryByRole('button', { name: 'lane: Shorter labels on the three jobs' }));
    fireEvent.click(lane);
    expect(show).toHaveBeenCalledWith('l1');
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it('a stored reply gets the card of a lane created during its turn, without live events (a reload keeps it in place)', async () => {
    const created = { ...mkLane('l1', { kind: 'slide', slide: 's2' }, [onS2]), createdAt: '2026-09-30T10:00:02.000Z' };
    const older = { ...mkLane('l0', { kind: 'slide', slide: 's2' }, [onS2], 'Older'), createdAt: '2026-09-30T09:00:00.000Z' };
    const t = setup({ l1: created, l0: older });
    t.stored.push(
      { id: 'u1', thread: 'slide:s2', role: 'user', text: 'shorter', context: { kind: 'slide', slide: 's2' }, at: '2026-09-30T10:00:00.000Z' },
      { id: 'a1', thread: 'slide:s2', role: 'assistant', text: 'Proposed.', context: null, at: '2026-09-30T10:00:05.000Z' },
    );
    render(<Thread threadKey="slide:s2" context={{ kind: 'slide', slide: 's2' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} knownLanes={[older, created]} />);
    const card = await waitFor(() => screen.queryByTestId('thread-proposal'));
    expect(screen.getAllByTestId('thread-proposal')).toHaveLength(1);
    expect(card.getAttribute('data-lane')).toBe('l1');
    const reply = screen.getAllByTestId('thread-message').find((m) => m.getAttribute('data-role') === 'assistant')!;
    expect(reply.contains(card)).toBe(true);
  });
});

describe('an outline reply is a receipt, not ten cards', () => {
  const inserts: Change[] = Array.from({ length: 10 }, (_, i) => ({
    id: `i${i + 1}`,
    kind: 'insert',
    after: i === 0 ? null : `n${i}`,
    slide: slide(`n${i + 1}`, `Claim number ${i + 1}`),
    reason: `slide ${i + 1} of the outline`,
    status: 'pending',
  }));
  const outline = mkLane('lo', { kind: 'arc' }, inserts, 'Outline of the talk');

  const reply = async (t: ReturnType<typeof setup>, onShowLane?: (id: string) => void) => {
    render(<Thread threadKey="global" context={{ kind: 'arc' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} navigate={t.navigate} onShowLane={onShowLane} />);
    send('Draft the outline: 10 slides');
    await vi.waitFor(() => expect(t.api.postMessage).toHaveBeenCalled());
    t.emit({ type: 'lane.created', laneId: 'lo' });
    t.stored.push({ id: 'm2', thread: 'global', role: 'assistant', text: 'Here is the outline.', context: null, at: '2026-09-30T10:00:05.000Z' });
    t.emit({ type: 'assistant.done', thread: 'global', messageId: 'm2' });
    return waitFor(() => screen.queryByTestId('thread-proposal'));
  };

  it('more than 3 changes: one head "lane: <label>, 10 inserts", the titles numbered one per line, one accept all, open on the strip', async () => {
    const t = setup({ lo: outline });
    const show = vi.fn();
    const card = await reply(t, show);
    await vi.waitFor(() => expect(within(card).getByTestId('receipt-head').textContent).toBe('lane: Outline of the talk, 10 inserts'));
    const lines = within(card).getAllByTestId('receipt-line');
    expect(lines).toHaveLength(10);
    expect(lines.map((l) => l.textContent)).toEqual(inserts.map((_, i) => `${i + 1}Claim number ${i + 1}`));
    // no before/after pairs, no per-change buttons
    expect(within(card).queryAllByTestId('proposal-change')).toHaveLength(0);
    expect(within(card).queryAllByTestId('slide-preview')).toHaveLength(0);
    expect(within(card).queryAllByRole('button', { name: 'accept' })).toHaveLength(0);
    expect(within(card).getAllByRole('button', { name: 'accept all in order' })).toHaveLength(1);
    fireEvent.click(within(card).getByRole('button', { name: 'open on the strip' }));
    expect(show).toHaveBeenCalledWith('lo');
    expect(t.navigate).not.toHaveBeenCalled();
  });

  it('accept all in order accepts each pending change after the previous one resolves, then says it once in the thread', async () => {
    const t = setup({ lo: outline });
    const waiting: Array<() => void> = [];
    t.api.acceptChange.mockImplementation(
      (laneId: string) =>
        new Promise((resolve) => {
          const n = waiting.length + 2;
          waiting.push(() => resolve({ version: version(n), lane: { ...outline, changes: [] } }));
        }),
    );
    const card = await reply(t);
    fireEvent.click(await waitFor(() => within(card).queryByRole('button', { name: 'accept all in order' })));
    for (let i = 0; i < 10; i++) {
      // one call in flight at a time, in the lane's order
      await vi.waitFor(() => expect(t.api.acceptChange).toHaveBeenCalledTimes(i + 1));
      expect(t.api.acceptChange).toHaveBeenLastCalledWith('lo', `i${i + 1}`);
      expect(within(card).getByTestId('accept-all-progress').textContent).toBe(`accepting ${i + 1} of 10…`);
      await act(async () => waiting[i]!());
    }
    await vi.waitFor(() => expect(screen.getAllByTestId('thread-note').map((n) => n.textContent)).toContain('accepted 10 changes into main, now v11'));
    expect(t.api.acceptChange).toHaveBeenCalledTimes(10);
  });

  it('accept all stops on the first error and reports it in the thread notes', async () => {
    const t = setup({ lo: outline });
    let calls = 0;
    t.api.acceptChange.mockImplementation(async () => {
      calls++;
      if (calls === 3) throw new Error('slide n2 is not on main');
      return { version: version(calls + 1), lane: { ...outline, changes: [] } };
    });
    const card = await reply(t);
    fireEvent.click(await waitFor(() => within(card).queryByRole('button', { name: 'accept all in order' })));
    const note = await waitFor(() => screen.queryAllByTestId('thread-note').find((n) => n.textContent?.startsWith('accept all stopped')));
    expect(note.textContent).toBe('accept all stopped at change 3 of 10 (Claim number 3): slide n2 is not on main, 2 changes accepted before it');
    expect(t.api.acceptChange).toHaveBeenCalledTimes(3);
    expect(within(card).getByRole('alert').textContent).toContain('accept all stopped at change 3 of 10');
  });

  it('3 changes or fewer keep the before/after pairs', async () => {
    const t = setup({ lo: { ...outline, changes: inserts.slice(0, 3) } });
    const card = await reply(t);
    await vi.waitFor(() => expect(within(card).getAllByTestId('proposal-change')).toHaveLength(3));
    expect(within(card).queryByTestId('receipt-head')).toBeNull();
    expect(within(card).queryByRole('button', { name: 'accept all in order' })).toBeNull();
  });
});

describe('plurals and the long-turn line', () => {
  it('"1 slide", "2 slides"; a lane by kind: "1 insert", "10 inserts", "2 inserts, 1 move"', () => {
    expect(plural(1, 'slide')).toBe('1 slide');
    expect(plural(2, 'slide')).toBe('2 slides');
    expect(plural(0, 'slide')).toBe('0 slides');
    const ins = (id: string): Change => ({ id, kind: 'insert', after: null, slide: slide(id), reason: '', status: 'pending' });
    const mv: Change = { id: 'm', kind: 'move', slide: 's1', after: 's3', reason: '', status: 'pending' };
    expect(laneCounts([ins('a')])).toBe('1 insert');
    expect(laneCounts(Array.from({ length: 10 }, (_, i) => ins(`a${i}`)))).toBe('10 inserts');
    expect(laneCounts([ins('a'), mv, ins('b')])).toBe('2 inserts, 1 move');
  });

  it('past 4 minutes the pending row keeps counting and adds that long outlines take a few minutes', async () => {
    vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval', 'Date'] });
    const t = setup();
    render(<Thread threadKey="global" context={{ kind: 'arc' }} order={order} slides={slides} api={t.api} subscribe={t.subscribe} />);
    send('Draft the outline');
    act(() => vi.advanceTimersByTime(239_000));
    expect(screen.getByTestId('thread-elapsed').textContent).toBe('3:59');
    expect(screen.queryByTestId('thread-long')).toBeNull();
    act(() => vi.advanceTimersByTime(8_000));
    expect(screen.getByTestId('thread-elapsed').textContent).toBe('4:07');
    expect(screen.getByTestId('thread-long').textContent).toBe(LONG_TURN_TEXT);
    act(() => vi.advanceTimersByTime(60_000));
    expect(screen.getByTestId('thread-elapsed').textContent).toBe('5:07');
    expect(screen.getByTestId('thread-pending').textContent).toContain('still working, long outlines take a few minutes');
  });
});
