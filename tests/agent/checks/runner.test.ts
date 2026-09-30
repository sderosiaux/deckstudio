import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Options, query, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CHECKS, CheckRunner, parseCheckOutput, RETRY_INSTRUCTION } from '../../../src/agent/checks/runner.js';
import type { Brief, Lane, Slide, Snapshot } from '../../../src/model/types.js';
import { ThumbService } from '../../../src/render/thumbs.js';
import { Bus, type BusEvent } from '../../../src/server/bus.js';
import { DeckStore } from '../../../src/store/deckStore.js';
import { tmpDir } from '../../helpers/tmp.js';
import { waitFor } from '../../helpers/waitFor.js';
import { themeCss } from '../../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'The log is the memory.' };
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

  it('a remark lane goes through propose_lane validation, gets the check origin, and is closed when the remark is replaced', async () => {
    const lane = { label: 'Hook first', anchor: { kind: 'range', from: 's1', to: 's3' }, changes: [{ kind: 'move', slide: 's3', after: null, reason: 'the question opens' }] };
    const badLane = { label: 'Bad', anchor: { kind: 'slide', slide: 's1' }, changes: [{ kind: 'remove', slide: 'ghost', reason: 'x' }] };
    const { r } = runner([JSON.stringify({ remarks: [
      { anchor: { kind: 'arc' }, severity: 'warn', text: 'no hook', lane },
      { anchor: { kind: 'slide', slide: 's1' }, severity: 'info', text: 'rejected lane', lane: badLane },
    ] })]);
    const out = await r.run('arc');
    expect(out.lanes).toHaveLength(1);
    const created = (await store.lane(out.lanes[0]!.id)) as Lane;
    expect(created).toMatchObject({ origin: 'check:arc', status: 'open', label: 'Hook first' });
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
    await store.putLane({ ...l, changes: l.changes.map((c, i) => (i === 0 ? { ...c, status: 'refused' as const } : c)) });
    await runner([JSON.stringify({ remarks: [] })]).r.run('arc');
    expect((await store.lane(l.id))!.status).toBe('open');
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
    // Sequential: each check ends before the next starts.
    const running = events.flatMap((e) => (e.type === 'checks.status' ? [e.running] : []));
    expect(running).toEqual([['arc'], [], ['order'], [], ['gaps'], [], ['render'], []]);
  });

  it('scheduleAfterLane runs the render check on the lane’s changed slides only and links the remarks to the lane', async () => {
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
    expect(prompt).toContain('title: Sharper');
    expect(prompt).not.toContain('id=s3');
    expect(prompt).toMatch(/image: .*cache\/thumbs\/[0-9a-f]+\.png/);
    expect(prompt).toContain('"lane" must be null');
    const [remark] = await store.remarks();
    expect(remark).toMatchObject({ origin: 'check:render', anchor: { kind: 'slide', slide: 'n1' }, laneId: 'l1' });

    // A later deck-wide render run leaves the lane's remarks alone while the lane is open.
    await runner([remarkJson({ kind: 'slide', slide: 's4' }, 'overflow')]).r.run('render');
    expect((await store.remarks()).map((x) => x.text).sort()).toEqual(['overflow', 'text under 24px']);
  });

  it('parseCheckOutput takes the first { to the last } of a chatty answer', () => {
    const ok = parseCheckOutput(`Here you go:\n\`\`\`json\n${remarkJson({ kind: 'arc' }, 'x')}\n\`\`\`\nDone.`, new Set(['s1']));
    expect(ok.ok).toBe(true);
  });

  it('trigger rejects an unknown check name', () => {
    const { r } = runner(['{}']);
    expect(() => r.trigger('spelling')).toThrow(/unknown check "spelling"/);
  });
});
