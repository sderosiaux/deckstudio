import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options, query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CHECKS, CheckRunner, parseCheckOutput, RETRY_INSTRUCTION } from '../../../src/agent/checks/runner.js';
import type { Brief, Lane, Slide, Snapshot } from '../../../src/model/types.js';
import { ThumbService } from '../../../src/render/thumbs.js';
import { Bus, type BusEvent } from '../../../src/server/bus.js';
import { LaneService } from '../../../src/server/laneService.js';
import { DeckStore } from '../../../src/store/deckStore.js';
import { tmpDir } from '../../helpers/tmp.js';
import { waitFor } from '../../helpers/waitFor.js';
import { themeCss } from '../../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'The log is the memory.', design: { rules: '', imageStyle: '' } };
const slide = (id: string, over: Partial<Slide> = {}): Slide => ({
  id,
  title: `Title ${id}`,
  story: `story of ${id}`,
  notes: '',
  body: `<p>body ${id}</p>`,
  assets: [],
  kind: 'text',
  ...over,
});
const five = ['s1', 's2', 's3', 's4', 's5'].map((id) => slide(id));
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });

type Call = { prompt: string; options: Options };
const result = (text: string) => ({ type: 'result', subtype: 'success', is_error: false, result: text, session_id: 'x', total_cost_usd: 0, errors: [] });

/** A fake `query` answering each call with the next scripted text (the last one repeats). */
function fakeQuery(texts: string[]): { impl: typeof query; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((params: Call) => {
    calls.push({ prompt: params.prompt, options: params.options });
    const text = texts[Math.min(calls.length - 1, texts.length - 1)]!;
    return (async function* () {
      yield result(text);
    })() as AsyncGenerator<SDKMessage, void>;
  }) as unknown as typeof query;
  return { impl, calls };
}

/**
 * A fake `query` whose calls each wait for `release()` (or for their abort signal, then throw like the SDK).
 * `texts` answers call n with texts[n] (the last one repeats).
 */
function gatedQuery(texts: string[]): { impl: typeof query; calls: Call[]; release: () => void } {
  const calls: Call[] = [];
  const gates: Array<() => void> = [];
  let released = 0;
  const impl = ((params: Call) => {
    calls.push({ prompt: params.prompt, options: params.options });
    const text = texts[Math.min(calls.length - 1, texts.length - 1)]!;
    const signal = params.options.abortController!.signal;
    const opened = new Promise<void>((resolve, reject) => {
      gates.push(resolve);
      signal.addEventListener('abort', () => reject(new Error('aborted by user')), { once: true });
    });
    return (async function* () {
      await opened;
      yield result(text);
    })() as AsyncGenerator<SDKMessage, void>;
  }) as unknown as typeof query;
  const release = () => {
    while (released < gates.length) gates[released++]!();
  };
  return { impl, calls, release };
}

const remarkJson = (anchor: object, text: string, lane: object | null = null) =>
  JSON.stringify({ remarks: [{ anchor, severity: 'warn', text, lane }] });

describe('CheckRunner', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let store: DeckStore;
  let bus: Bus;
  let events: BusEvent[];
  let thumbs: ThumbService;
  let runners: CheckRunner[];

  beforeAll(async () => {
    tmp = await tmpDir();
  });
  afterAll(async () => {
    await tmp?.cleanup();
  });
  beforeEach(async () => {
    const deckDir = join(tmp.dir, `deck-${Date.now()}-${Math.random().toString(36).slice(2)}`);
    store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    await writeFile(join(deckDir, 'theme.css'), themeCss);
    bus = new Bus();
    events = [];
    bus.on('any', (e) => events.push(e));
    // Started only by the render test: the other checks never render.
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    runners = [];
  });
  afterEach(async () => {
    for (const r of runners) r.dispose();
    await thumbs.stop();
  });

  const gated = (texts: string[], debounceMs?: number) => {
    const fake = gatedQuery(texts);
    const r = new CheckRunner({ store, thumbs, bus, model: 'claude-opus-5', queryImpl: fake.impl, ...(debounceMs !== undefined ? { debounceMs } : {}) });
    runners.push(r);
    return { r, ...fake };
  };
  const timerArmed = (r: CheckRunner): boolean => (r as unknown as { timer: unknown }).timer !== null;

  const runner = (texts: string[], debounceMs?: number) => {
    const fake = fakeQuery(texts);
    const r = new CheckRunner({ store, thumbs, bus, model: 'claude-opus-5', queryImpl: fake.impl, ...(debounceMs !== undefined ? { debounceMs } : {}) });
    runners.push(r);
    return { r, calls: fake.calls };
  };

  it('invalid JSON then valid: retries once with the instruction, persists the remark, emits status and remarks.changed', async () => {
    const { r, calls } = runner(['Sure! Here is my review: not json', remarkJson({ kind: 'slide', slide: 's3' }, 'uses "share group" before s4 defines it')]);
    const out = await r.run('order');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain(RETRY_INSTRUCTION);
    expect(calls[1]!.prompt.startsWith(calls[0]!.prompt)).toBe(true);
    expect(calls[0]!.options).toMatchObject({ cwd: store.dir, model: 'claude-opus-5', settingSources: [], allowedTools: [], permissionMode: 'dontAsk', maxTurns: 1 });
    expect(calls[0]!.options.systemPrompt).toBe(CHECKS.order.system);
    const remarks = await store.remarks();
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({ anchor: { kind: 'slide', slide: 's3' }, origin: 'check:order', severity: 'warn', status: 'open', laneId: null });
    expect(out.remarks.map((x) => x.id)).toEqual(remarks.map((x) => x.id));
    const status = events.filter((e) => e.type === 'checks.status');
    expect(status).toEqual([{ type: 'checks.status', running: ['order'] }, { type: 'checks.status', running: [] }]);
    expect(events.at(-2)).toEqual({ type: 'remarks.changed' });
  });

  it('twice invalid: one failure remark on the arc, exactly two calls', async () => {
    const { r, calls } = runner(['nope', '{ "remarks": "still wrong" }']);
    await r.run('gaps');
    expect(calls).toHaveLength(2);
    const remarks = await store.remarks();
    expect(remarks).toHaveLength(1);
    expect(remarks[0]).toMatchObject({ anchor: { kind: 'arc' }, severity: 'info', origin: 'check:gaps', laneId: null });
    expect(remarks[0]!.text).toMatch(/^check gaps failed: the JSON does not match the contract/);
  });

  it('a failed run keeps the check’s earlier remarks and lanes and only replaces its failure remark', async () => {
    const lane = { label: 'Hook first', anchor: { kind: 'arc' }, changes: [{ kind: 'move', slide: 's3', after: null, reason: 'hook' }] };
    const good = await runner([remarkJson({ kind: 'arc' }, 'no hook', lane)]).r.run('arc');
    const laneId = good.lanes[0]!.id;
    await runner(['nope', 'nope']).r.run('arc');
    await runner(['still nope', 'still nope']).r.run('arc');
    const remarks = await store.remarks();
    expect(remarks.map((x) => x.text)).toEqual(['no hook', 'check arc failed: the answer contains no JSON object']);
    expect(remarks[0]!.laneId).toBe(laneId);
    expect((await store.lane(laneId))!.status).toBe('draft');
    expect(events).not.toContainEqual({ type: 'lane.closed', laneId });

    // The next good run replaces both the old remarks and the failure remark.
    await runner([JSON.stringify({ remarks: [] })]).r.run('arc');
    expect(await store.remarks()).toEqual([]);
  });

  it('dispose during the first query: no retry, nothing persisted', async () => {
    const { r, calls } = gated([remarkJson({ kind: 'arc' }, 'late')]);
    const run = r.run('arc');
    await waitFor(() => calls.length === 1);
    r.dispose();
    await expect(run).rejects.toThrow('check runner stopped');
    expect(calls).toHaveLength(1);
    expect(await store.remarks()).toEqual([]);
    expect(events).not.toContainEqual({ type: 'remarks.changed' });
  });

  it('status() reports queued and running checks, dedupes a run of the same name and stamps lastRun', async () => {
    const { r, calls, release } = gated([JSON.stringify({ remarks: [] })]);
    expect(r.status()).toEqual({ running: [], lastRun: { arc: null, order: null, gaps: null, render: null }, note: { arc: null, order: null, gaps: null, render: null } });
    const a = r.run('order');
    const b = r.run('gaps');
    expect(r.run('order')).toBe(a);
    await waitFor(() => calls.length === 1);
    // gaps is queued behind order: it is not reported as running.
    expect(r.status().running).toEqual(['order']);
    expect(r.start(['order', 'gaps', 'arc'])).toEqual(['arc']);
    expect(r.status().running).toEqual(['order']);
    const done = waitFor(async () => {
      release();
      return r.status().running.length === 0;
    });
    await Promise.all([a, b, done]);
    expect(calls).toHaveLength(3);
    const s = r.status();
    expect(s.lastRun.order).toMatch(/^\d{4}-/);
    expect(s.lastRun.gaps).toMatch(/^\d{4}-/);
    expect(s.lastRun.arc).toMatch(/^\d{4}-/);
    expect(s.lastRun.render).toBeNull();
  });

  it('accepts during a running batch coalesce into exactly one more batch', async () => {
    // Thumbs are not started: render fails before querying, so each batch makes three queries.
    const { r, calls, release } = gated([JSON.stringify({ remarks: [] })], 10);
    r.scheduleAfterAccept();
    await waitFor(() => calls.length === 1);
    for (let k = 0; k < 3; k++) {
      r.scheduleAfterAccept();
      await waitFor(() => !timerArmed(r));
    }
    await waitFor(async () => {
      release();
      return r.status().running.length === 0 && !timerArmed(r) && calls.length >= 6;
    });
    const arcCalls = calls.filter((c) => c.options.systemPrompt === CHECKS.arc.system);
    expect(arcCalls).toHaveLength(2);
    expect(calls).toHaveLength(6);
  });

  it('an anchor naming an unknown slide counts as an unusable answer', async () => {
    const { r, calls } = runner([remarkJson({ kind: 'slide', slide: 'nope' }, 'x'), remarkJson({ kind: 'range', from: 's1', to: 's2' }, 'ok')]);
    await r.run('arc');
    expect(calls).toHaveLength(2);
    expect(calls[1]!.prompt).toContain('unknown slide id(s) nope');
    expect((await store.remarks()).map((x) => x.anchor)).toEqual([{ kind: 'range', from: 's1', to: 's2' }]);
  });

  it('running order twice replaces its own remarks without touching arc remarks', async () => {
    const arcRun = runner([remarkJson({ kind: 'arc' }, 'no hook in the first three slides')]);
    await arcRun.r.run('arc');
    const first = runner([JSON.stringify({ remarks: [
      { anchor: { kind: 'slide', slide: 's2' }, severity: 'warn', text: 'first A', lane: null },
      { anchor: { kind: 'slide', slide: 's3' }, severity: 'info', text: 'first B', lane: null },
    ] })]);
    await first.r.run('order');
    const second = runner([remarkJson({ kind: 'slide', slide: 's5' }, 'second')]);
    await second.r.run('order');
    const remarks = await store.remarks();
    expect(remarks.filter((x) => x.origin === 'check:arc').map((x) => x.text)).toEqual(['no hook in the first three slides']);
    expect(remarks.filter((x) => x.origin === 'check:order').map((x) => x.text)).toEqual(['second']);
  });

  it('a remark lane goes through propose_lane validation, is saved as a draft with the check origin, and is closed when the remark is replaced', async () => {
    const lane = { label: 'Hook first', anchor: { kind: 'range', from: 's1', to: 's3' }, changes: [{ kind: 'move', slide: 's3', after: null, reason: 'the question opens' }] };
    const badLane = { label: 'Bad', anchor: { kind: 'slide', slide: 's1' }, changes: [{ kind: 'remove', slide: 'ghost', reason: 'x' }] };
    const { r } = runner([JSON.stringify({ remarks: [
      { anchor: { kind: 'arc' }, severity: 'warn', text: 'no hook', lane },
      { anchor: { kind: 'slide', slide: 's1' }, severity: 'info', text: 'rejected lane', lane: badLane },
    ] })]);
    const out = await r.run('arc');
    expect(out.lanes).toHaveLength(1);
    const created = (await store.lane(out.lanes[0]!.id)) as Lane;
    expect(created).toMatchObject({ origin: 'check:arc', status: 'draft', label: 'Hook first' });
    const remarks = await store.remarks();
    expect(remarks.find((x) => x.text === 'no hook')!.laneId).toBe(created.id);
    expect(remarks.find((x) => x.text === 'rejected lane')!.laneId).toBeNull();
    expect((await store.lanes())).toHaveLength(1);

    const again = runner([JSON.stringify({ remarks: [] })]);
    await again.r.run('arc');
    expect(await store.remarks()).toEqual([]);
    expect((await store.lane(created.id))!.status).toBe('closed');
    expect(events).toContainEqual({ type: 'lane.closed', laneId: created.id });
  });

  it('a check lane the creator already acted on stays open when its remark is replaced', async () => {
    const lane = { label: 'Two moves', anchor: { kind: 'arc' }, changes: [
      { kind: 'move', slide: 's3', after: null, reason: 'a' },
      { kind: 'move', slide: 's5', after: 's1', reason: 'b' },
    ] };
    const { r } = runner([remarkJson({ kind: 'arc' }, 'reorder', lane)]);
    const out = await r.run('arc');
    const l = out.lanes[0]!;
    await new LaneService(store, bus).refuse(l.id, l.changes[0]!.id);
    await runner([JSON.stringify({ remarks: [] })]).r.run('arc');
    expect((await store.lane(l.id))!.status).toBe('open');
    // The remark the creator acted on stays too.
    expect((await store.remarks()).map((x) => [x.text, x.laneId])).toEqual([['reorder', l.id]]);
  });

  it('scheduleAfterAccept debounces and then runs the four checks one after the other', async () => {
    const { r, calls } = runner([JSON.stringify({ remarks: [] })], 30);
    await thumbs.start();
    r.scheduleAfterAccept();
    r.scheduleAfterAccept();
    r.scheduleAfterAccept();
    await waitFor(() => calls.length >= 4 && events.filter((e) => e.type === 'checks.status').length >= 8, { timeout: 20_000 });
    expect(calls.map((c) => c.options.systemPrompt)).toEqual([CHECKS.arc.system, CHECKS.order.system, CHECKS.gaps.system, CHECKS.render.system]);
    expect(calls[3]!.options).toMatchObject({ allowedTools: ['Read'], maxTurns: 6 });
    // All four are queued at once; each one is reported running only while its own run goes, in order.
    const running = events.flatMap((e) => (e.type === 'checks.status' ? [e.running] : []));
    expect(running).toEqual([['arc'], [], ['order'], [], ['gaps'], [], ['render'], []]);
  });

  it('scheduleAfterLane runs the render check on the lane’s changed slides only and tags the remarks with the scanned lane', async () => {
    await thumbs.start();
    const inserted = slide('n1', { title: 'Where does memory live?', body: '<p>new</p>' });
    const lane: Lane = {
      id: 'l1',
      label: 'Hook',
      anchor: { kind: 'range', from: 's1', to: 's2' },
      origin: 'user',
      baseVersion: 1,
      changes: [
        { id: 'c1', kind: 'insert', after: 's1', slide: inserted, reason: 'hook', status: 'pending' },
        { id: 'c2', kind: 'modify', slide: 's2', patch: { title: 'Sharper' }, reason: 'claim', status: 'pending' },
      ],
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await store.putLane(lane);
    const { r, calls } = runner([remarkJson({ kind: 'slide', slide: 'n1' }, 'text under 24px')]);
    r.scheduleAfterLane('l1');
    await waitFor(async () => (await store.remarks()).length === 1, { timeout: 20_000 });
    expect(calls).toHaveLength(1);
    const prompt = calls[0]!.prompt;
    expect(prompt).toContain('id=n1');
    // Slides are numbered by their position in the lane's preview, not in the subset shown.
    expect(prompt).toContain('slide 3 (Sharper)');
    expect(prompt).not.toContain('id=s3');
    expect(prompt).toMatch(/image: .*cache\/thumbs\/[0-9a-f]+\.png/);
    expect(prompt).toContain('"lane" must be null');
    const [remark] = await store.remarks();
    expect(remark).toMatchObject({ origin: 'check:render', anchor: { kind: 'slide', slide: 'n1' }, laneId: null, sourceLaneId: 'l1' });

    // A later deck-wide render run leaves the lane's remarks alone while the lane is open.
    await runner([remarkJson({ kind: 'slide', slide: 's4' }, 'overflow')]).r.run('render');
    expect((await store.remarks()).map((x) => x.text).sort()).toEqual(['overflow', 'text under 24px']);

    // Discarding the lane resolves the remarks found on its preview.
    await new LaneService(store, bus).closeLane('l1');
    const after = await store.remarks();
    expect(after.find((x) => x.text === 'text under 24px')!.status).toBe('resolved');
    expect(after.find((x) => x.text === 'overflow')!.status).toBe('open');
    expect(events).toContainEqual({ type: 'remarks.changed' });
  });

  it('a lane-scoped render run does not replace a deck-wide render remark the creator linked to that lane', async () => {
    await thumbs.start();
    await runner([remarkJson({ kind: 'slide', slide: 's2' }, 'title overflows')]).r.run('render');
    const [deckWide] = await store.remarks();
    const l: Lane = {
      id: 'l1',
      label: 'Fix s2',
      anchor: { kind: 'slide', slide: 's2' },
      origin: 'user',
      baseVersion: 1,
      changes: [{ id: 'c1', kind: 'modify', slide: 's2', patch: { body: '<p>shorter</p>' }, reason: 'fit', status: 'pending' }],
      status: 'open',
      createdAt: new Date().toISOString(),
    };
    await store.putLane(l);
    await store.putRemarks([{ ...deckWide!, laneId: 'l1' }]);
    const { r, calls } = runner([JSON.stringify({ remarks: [] })]);
    r.scheduleAfterLane('l1');
    await waitFor(() => calls.length === 1 && r.status().running.length === 0, { timeout: 20_000 });
    expect((await store.remarks()).map((x) => [x.text, x.laneId, x.status])).toEqual([['title overflows', 'l1', 'open']]);
  });

  const move = (slideId: string, label: string) => ({ label, anchor: { kind: 'slide', slide: slideId }, changes: [{ kind: 'move', slide: slideId, after: null, reason: 'r' }] });
  const item = (slideId: string, text: string, lane: object | null = null) => ({ anchor: { kind: 'slide', slide: slideId }, severity: 'warn', text, lane });

  it('creates at most 3 lanes per run: the other remarks keep lane null', async () => {
    const texts = ['s1', 's2', 's3', 's4', 's5'].map((id) => item(id, `problem on ${id}`, move(id, `fix ${id}`)));
    const out = await runner([JSON.stringify({ remarks: texts })]).r.run('order');
    expect(out.lanes).toHaveLength(3);
    const lanes = await store.lanes();
    expect(lanes).toHaveLength(3);
    expect(lanes.every((l) => l.status === 'draft' && l.origin === 'check:order')).toBe(true);
    const remarks = await store.remarks();
    expect(remarks).toHaveLength(5);
    expect(remarks.map((x) => x.laneId !== null)).toEqual([true, true, true, false, false]);
  });

  it('a second run keeps the id (and draft lane) of a remark it finds again and replaces the rest', async () => {
    const first = await runner([JSON.stringify({ remarks: [item('s2', 'Share group is used before it is defined.', move('s2', 'Define it')), item('s3', 'Stray slide.')] })]).r.run('order');
    const [a1, b1] = await store.remarks();
    const laneId = first.lanes[0]!.id;
    expect(a1!.laneId).toBe(laneId);
    await runner([JSON.stringify({ remarks: [item('s2', '  share group is used before it is  defined', move('s2', 'Define it')), item('s4', 'New one.')] })]).r.run('order');
    const after = await store.remarks();
    expect(after.map((x) => x.text)).toEqual(['  share group is used before it is  defined', 'New one.']);
    expect(after[0]!.id).toBe(a1!.id);
    expect(after[0]!.laneId).toBe(laneId);
    expect(after.some((x) => x.id === b1!.id)).toBe(false);
    // The lane was reused, not duplicated nor closed.
    expect((await store.lanes()).map((l) => [l.id, l.status])).toEqual([[laneId, 'draft']]);
    expect(events).not.toContainEqual({ type: 'lane.closed', laneId });
    expect(after[0]!.createdAt >= a1!.createdAt).toBe(true);
  });

  it('two runs with the same findings leave every createdAt as it was: a remark found again is not new', async () => {
    const findings = JSON.stringify({ remarks: [item('s2', 'Weak hook.'), item('s3', 'Too dense.')] });
    await runner([findings]).r.run('order');
    const old = '2026-01-01T00:00:00.000Z';
    await store.putRemarks((await store.remarks()).map((x) => ({ ...x, createdAt: old })));
    const before = await store.remarks();
    await runner([findings]).r.run('order');
    const after = await store.remarks();
    expect(after.map((x) => [x.id, x.createdAt])).toEqual(before.map((x) => [x.id, old]));
  });

  it('keeps remarks the creator resolved or proposed on, and does not duplicate them when found again', async () => {
    await runner([JSON.stringify({ remarks: [item('s2', 'Weak hook.'), item('s3', 'Too dense.'), item('s4', 'Gone next time.')] })]).r.run('order');
    const [hook, dense] = await store.remarks();
    const userLane: Lane = {
      id: 'l_user',
      label: 'Lighter s3',
      anchor: { kind: 'slide', slide: 's3' },
      origin: 'user',
      baseVersion: 1,
      changes: [{ id: 'c1', kind: 'modify', slide: 's3', patch: { title: 'Light' }, reason: 'r', status: 'refused' }],
      status: 'closed',
      createdAt: new Date().toISOString(),
    };
    await store.putLane(userLane);
    await store.putRemarks((await store.remarks()).map((x) => (x.id === hook!.id ? { ...x, status: 'resolved' as const } : x.id === dense!.id ? { ...x, laneId: 'l_user' } : x)));
    await runner([JSON.stringify({ remarks: [item('s2', 'weak hook'), item('s3', 'Too dense.'), item('s5', 'Fresh.')] })]).r.run('order');
    const after = await store.remarks();
    expect(after.map((x) => [x.id === hook!.id ? 'hook' : x.id === dense!.id ? 'dense' : x.text, x.status, x.laneId])).toEqual([
      ['hook', 'resolved', null],
      ['dense', 'open', 'l_user'],
      ['Fresh.', 'open', null],
    ]);
  });

  it('numbers slides as "slide N (title)" in prompts and lane labels; remark text keeps ids so it can be named at read time', async () => {
    const ids = ['s_AAAAAAAAAA', 's_BBBBBBBBBB', 's_CCCCCCCCCC', 's_DDDDDDDDDD'];
    await store.commit(snap(ids.map((id, i) => slide(id, { title: `T${i + 1}` }))), { kind: 'import' });
    const text = 's_BBBBBBBBBB uses "offset" before s_DDDDDDDDDD defines it.';
    const { r, calls } = runner([JSON.stringify({ remarks: [item('s_BBBBBBBBBB', text, move('s_DDDDDDDDDD', 'Move s_DDDDDDDDDD before s_BBBBBBBBBB'))] })]);
    await r.run('order');
    expect(calls[0]!.prompt).toContain('slide 2 (T2)');
    expect(calls[0]!.prompt).toMatch(/In "text", refer to a slide by its id/);
    const [remark] = await store.remarks();
    expect(remark!.text).toBe(text);
    const [lane] = await store.lanes();
    expect(lane!.label).toBe('Move slide 4 before slide 2');
    expect(remark!.anchor).toEqual({ kind: 'slide', slide: 's_BBBBBBBBBB' });
  });

  it('render skips the slides whose hash did not change since its last good run, and keeps their remarks', async () => {
    await thumbs.start();
    const first = runner([remarkJson({ kind: 'slide', slide: 's2' }, 'title overflows')]);
    await first.r.run('render');
    expect(first.calls[0]!.prompt).toContain('id=s1');
    expect(first.calls[0]!.prompt).toContain('id=s5');

    // Nothing changed: no query at all, the remark stays, lastRun is stamped.
    const idle = runner([JSON.stringify({ remarks: [] })]);
    await idle.r.run('render');
    expect(idle.calls).toHaveLength(0);
    expect(idle.r.status().lastRun.render).toMatch(/^\d{4}-/);
    expect((await store.remarks()).map((x) => x.text)).toEqual(['title overflows']);

    // One slide changed: only that one is shown, and remarks on the others survive.
    const main = await store.snapshot();
    await store.commit({ ...main, slides: { ...main.slides, s4: slide('s4', { body: '<p>changed</p>' }) } }, { kind: 'import' });
    const next = runner([remarkJson({ kind: 'slide', slide: 's4' }, 'text under 24px')]);
    await next.r.run('render');
    expect(next.calls).toHaveLength(1);
    expect(next.calls[0]!.prompt).toContain('id=s4');
    expect(next.calls[0]!.prompt).not.toContain('id=s2');
    expect((await store.remarks()).map((x) => x.text).sort()).toEqual(['text under 24px', 'title overflows']);
  });

  it('render re-checks every slide after a failed run, and when the design rules change', async () => {
    await thumbs.start();
    await runner(['nope', 'nope']).r.run('render');
    const retry = runner([JSON.stringify({ remarks: [] })]);
    await retry.r.run('render');
    expect(retry.calls[0]!.prompt).toContain('id=s1');
    await store.setBrief({ ...brief, design: { rules: 'One color.', imageStyle: '' } });
    const again = runner([JSON.stringify({ remarks: [] })]);
    await again.r.run('render');
    expect(again.calls).toHaveLength(1);
    expect(again.calls[0]!.prompt).toContain('id=s5');
  });

  it('a run drops remarks whose slide left main (unless found on a lane preview) and resolves leftovers of closed lanes', async () => {
    const base = { origin: 'check:arc' as const, severity: 'warn' as const, status: 'open' as const, laneId: null, createdAt: '2026-09-30T00:00:00.000Z' };
    await store.putLane({ id: 'l_closed', label: 'x', anchor: { kind: 'arc' }, origin: 'user', baseVersion: 1, changes: [], status: 'closed', createdAt: base.createdAt });
    await store.putLane({
      id: 'l_open',
      label: 'y',
      anchor: { kind: 'arc' },
      origin: 'user',
      baseVersion: 1,
      changes: [{ id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'Y' }, reason: 'r', status: 'pending' }],
      status: 'open',
      createdAt: base.createdAt,
    });
    await store.putRemarks([
      { ...base, id: 'r_gone', anchor: { kind: 'slide', slide: 's9' }, text: 'gone', origin: 'user' },
      { ...base, id: 'r_leftover', anchor: { kind: 'slide', slide: 'n1' }, text: 'leftover', origin: 'check:render', sourceLaneId: 'l_closed' },
      { ...base, id: 'r_preview', anchor: { kind: 'slide', slide: 'n2' }, text: 'preview', origin: 'check:render', sourceLaneId: 'l_open' },
      { ...base, id: 'r_user', anchor: { kind: 'slide', slide: 's2' }, text: 'mine', origin: 'user' },
    ]);
    await runner([JSON.stringify({ remarks: [] })]).r.run('order');
    expect((await store.remarks()).map((x) => [x.id, x.status])).toEqual([
      ['r_leftover', 'resolved'],
      ['r_preview', 'open'],
      ['r_user', 'open'],
    ]);
  });

  it('QA3 render lanes must change what is rendered: a notes-only lane is dropped, the remark stays without a draft', async () => {
    await thumbs.start();
    const notesOnly = { label: 'Explain the sub-caption', anchor: { kind: 'slide', slide: 's2' }, changes: [{ kind: 'modify', slide: 's2', patch: { notes: 'say it' }, reason: 'r' }] };
    const storyOnly = { label: 'Retell', anchor: { kind: 'slide', slide: 's3' }, changes: [{ kind: 'modify', slide: 's3', patch: { story: 'x', notes: 'y' }, reason: 'r' }] };
    const visual = { label: 'Enlarge the caption under the diagram', anchor: { kind: 'slide', slide: 's4' }, changes: [{ kind: 'modify', slide: 's4', patch: { body: '<p class="big">x</p>', notes: 'n' }, reason: 'r' }] };
    const { r } = runner([JSON.stringify({ remarks: [
      { anchor: { kind: 'slide', slide: 's2' }, severity: 'warn', text: 'sub-caption at 17px', lane: notesOnly },
      { anchor: { kind: 'slide', slide: 's3' }, severity: 'warn', text: 'overlap', lane: storyOnly },
      { anchor: { kind: 'slide', slide: 's4' }, severity: 'warn', text: 'tiny caption', lane: visual },
    ] })]);
    const out = await r.run('render');
    expect(out.lanes.map((l) => l.label)).toEqual(['Enlarge the caption under the diagram']);
    const remarks = await store.remarks();
    expect(remarks.map((x) => [x.text, x.laneId === null])).toEqual([
      ['sub-caption at 17px', true],
      ['overlap', true],
      ['tiny caption', false],
    ]);
    expect(await store.lanes()).toHaveLength(1);
  });

  it('QA3 the render prompt asks for lanes that change the render, labelled by the fix with the slide in the reason', () => {
    const p = CHECKS.render.buildPrompt({ brief, snap: snap(five), deckOrder: snap(five).order, thumbs: { s1: '/t/s1.png' }, allowLanes: true });
    expect(p).toMatch(/must change what is rendered \(the body or the title\)/);
    expect(p).toMatch(/never only the notes or the story/);
    const contract = CHECKS.order.buildPrompt({ brief, snap: snap(five), deckOrder: snap(five).order, allowLanes: true });
    expect(contract).toMatch(/"label" names the fix, not the slide/);
    expect(contract).toContain('Enlarge the caption under the diagram');
    expect(contract).toMatch(/name the slide in the reason/i);
  });

  it('QA3 a reworded finding on the same anchor keeps its id and createdAt and takes the new text; distinct findings stay apart', async () => {
    await runner([JSON.stringify({ remarks: [
      item('s2', 'The sub-caption on s2 renders at about 17px, below the readable floor.'),
      item('s2', 'The caption is under 24px.'),
    ] })]).r.run('order');
    const old = '2026-01-01T00:00:00.000Z';
    await store.putRemarks((await store.remarks()).map((x) => ({ ...x, createdAt: old })));
    const [sub, caption] = await store.remarks();
    await runner([JSON.stringify({ remarks: [
      item('s2', 'On s2 the sub-caption renders around 17px, under the readable floor.'),
      item('s2', 'On s2 the sub-caption renders near 17px, under the readable floor!'),
      item('s2', 'The footer is under 24px.'),
      item('s3', 'The caption is under 24px.'),
    ] })]).r.run('order');
    const after = await store.remarks();
    expect(after.map((x) => [x.id === sub!.id ? 'sub' : x.id === caption!.id ? 'caption' : 'new', x.anchor.kind === 'slide' ? x.anchor.slide : '', x.text, x.createdAt === old])).toEqual([
      ['sub', 's2', 'On s2 the sub-caption renders around 17px, under the readable floor.', true],
      ['new', 's2', 'The footer is under 24px.', false],
      ['new', 's3', 'The caption is under 24px.', false],
    ]);
  });

  it('a run rebases the lanes on main first: a draft whose change main already took is closed', async () => {
    const lane: Lane = {
      id: 'l_d',
      label: 'Same title',
      anchor: { kind: 'slide', slide: 's2' },
      origin: 'check:arc',
      baseVersion: 1,
      changes: [{ id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'Taken' }, reason: 'r', status: 'pending' }],
      status: 'draft',
      createdAt: new Date().toISOString(),
    };
    await store.putLane(lane);
    const main = await store.snapshot();
    await store.commit({ ...main, slides: { ...main.slides, s2: { ...main.slides.s2!, title: 'Taken' } } }, { kind: 'import' });
    await runner([JSON.stringify({ remarks: [] })]).r.run('order');
    expect(await store.lane('l_d')).toMatchObject({ status: 'closed', changes: [{ status: 'accepted' }] });
    expect(events).toContainEqual({ type: 'lane.closed', laneId: 'l_d' });
  });

  it('lastRun survives a restart: a new runner on the same deck reads it back', async () => {
    await runner([JSON.stringify({ remarks: [] })]).r.run('gaps');
    const { r } = runner([JSON.stringify({ remarks: [] })]);
    await waitFor(() => r.status().lastRun.gaps !== null);
    expect(r.status().lastRun.gaps).toMatch(/^\d{4}-/);
    expect(r.status().lastRun.arc).toBeNull();
  });

  it('reads the design rules from the stored brief when it builds a check prompt', async () => {
    await store.setBrief({ ...brief, design: { rules: 'No emoji on stage.', imageStyle: '' } });
    const { r, calls } = runner([JSON.stringify({ remarks: [] })]);
    await r.run('arc');
    expect(calls[0]!.prompt).toContain('No emoji on stage.');
  });

  it('parseCheckOutput takes the first { to the last } of a chatty answer', () => {
    const ok = parseCheckOutput(`Here you go:\n\`\`\`json\n${remarkJson({ kind: 'arc' }, 'x')}\n\`\`\`\nDone.`, new Set(['s1']));
    expect(ok.ok).toBe(true);
  });

  it('an empty deck: every check returns no remarks without a model call, and records lastRun with the note "no slides yet"', async () => {
    const blank = await DeckStore.init(join(tmp.dir, `blank-${Date.now()}-${Math.random().toString(36).slice(2)}`), 'blank', brief);
    // A failure remark left by an earlier run on that deck is superseded like any other run's.
    await blank.putRemarks([
      { id: 'r_f', anchor: { kind: 'arc' }, text: 'check arc failed: timeout', origin: 'check:arc', severity: 'info', status: 'open', laneId: null, createdAt: '2026-09-30T00:00:00.000Z' },
    ]);
    const fake = fakeQuery([remarkJson({ kind: 'arc' }, 'should never be asked')]);
    const r = new CheckRunner({ store: blank, thumbs, bus, model: 'claude-opus-5', queryImpl: fake.impl });
    runners.push(r);
    for (const name of ['arc', 'order', 'gaps', 'render'] as const) {
      expect(await r.run(name)).toEqual({ remarks: [], lanes: [] });
      expect(r.status().lastRun[name]).toMatch(/^\d{4}-/);
      expect(r.status().note?.[name]).toBe('no slides yet');
    }
    expect(fake.calls).toEqual([]);
    expect(await blank.remarks()).toEqual([]);

    // The note survives a restart, and the first run on slides clears it.
    const again = new CheckRunner({ store: blank, thumbs, bus, model: 'claude-opus-5', queryImpl: fake.impl });
    runners.push(again);
    await waitFor(() => again.status().note?.gaps != null);
    expect(again.status().note?.gaps).toBe('no slides yet');
    await blank.commit(snap(five), { kind: 'import' });
    await again.run('arc');
    expect(fake.calls).toHaveLength(1);
    expect(again.status().note?.arc).toBeNull();
    expect(again.status().note?.gaps).toBe('no slides yet');
  });

  it('trigger rejects an unknown check name', () => {
    const { r } = runner(['{}']);
    expect(() => r.trigger('spelling')).toThrow(/unknown check "spelling"/);
  });
});
