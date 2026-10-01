import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import { CheckRunner } from '../../src/agent/checks/runner.js';
import { AgentSession } from '../../src/agent/session.js';
import { makeDeckTools } from '../../src/agent/tools.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { buildApp } from '../../src/server/app.js';
import { Bus, type BusEvent } from '../../src/server/bus.js';
import type { ChecksRunner } from '../../src/server/routes/checks.js';
import { DeckStore } from '../../src/store/deckStore.js';
import type { Brief, Remark, Slide, Snapshot, ThreadMessage } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: '', notes: '', body: `<p>body ${id}</p>`, assets: [], kind: 'text' });
const five = ['s1', 's2', 's3', 's4', 's5'].map(slide);
const snap = (slides: Slide[]): Snapshot => ({ order: slides.map((s) => s.id), slides: Object.fromEntries(slides.map((s) => [s.id, s])) });

type Call = { prompt: string; options: Options };

describe('remarks and checks API', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let deckDir: string;
  let store: DeckStore;
  let thumbs: ThumbService;
  let app: FastifyInstance;
  let calls: Call[];
  let events: BusEvent[];

  const build = async (checks?: ChecksRunner): Promise<void> => {
    const bus = new Bus();
    const tools = makeDeckTools({
      store,
      thumbs,
      bus,
      imageGen: async () => {
        throw new Error('unused');
      },
      runCheck: async () => {
        throw new Error('unused');
      },
    });
    calls = [];
    const impl = ((params: { prompt: string; options: Options }) => {
      calls.push({ prompt: params.prompt, options: params.options });
      return (async function* () {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'On it.' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-r', total_cost_usd: 0, errors: [] };
      })() as AsyncGenerator<SDKMessage, void>;
    }) as unknown as typeof query;
    const agent = new AgentSession({ store, tools, bus, model: 'claude-opus-5', deckDir, queryImpl: impl });
    app = await buildApp({ deckDir, thumbs, agent, checks: checks ?? null });
    events = [];
    app.bus.on('any', (e) => events.push(e));
    await app.ready();
  };

  beforeEach(async () => {
    tmp = await tmpDir();
    deckDir = join(tmp.dir, 'deck');
    store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
  });
  afterEach(async () => {
    await app?.close();
    await tmp?.cleanup();
  });

  const list = async (url = '/api/remarks'): Promise<Remark[]> => (await app.inject({ method: 'GET', url })).json();
  const create = (payload: Record<string, unknown>) => app.inject({ method: 'POST', url: '/api/remarks', payload });

  it('creates a user remark, persists it and announces remarks.changed', async () => {
    await build();
    const res = await create({ anchor: { kind: 'range', from: 's2', to: 's4' }, text: 'Thin middle.', severity: 'warn' });
    expect(res.statusCode).toBe(201);
    const r = res.json() as Remark;
    expect(r).toMatchObject({ anchor: { kind: 'range', from: 's2', to: 's4' }, text: 'Thin middle.', severity: 'warn', origin: 'user', status: 'open', laneId: null });
    expect(r.id).toMatch(/^r_/);
    expect(await store.remarks()).toEqual([r]);
    expect(events).toContainEqual({ type: 'remarks.changed' });
  });

  it('QA4 a range written backwards is stored in deck order, so a later deck change cannot read it as reversed', async () => {
    await build();
    const res = await create({ anchor: { kind: 'range', from: 's4', to: 's2' }, text: 'Thin middle.', severity: 'warn' });
    expect(res.statusCode).toBe(201);
    expect((res.json() as Remark).anchor).toEqual({ kind: 'range', from: 's2', to: 's4' });
    expect((await store.remarks())[0]!.anchor).toEqual({ kind: 'range', from: 's2', to: 's4' });
  });

  it('rejects an invalid body or an anchor on an unknown slide, saving nothing', async () => {
    await build();
    expect((await create({ anchor: { kind: 'arc' }, text: '', severity: 'warn' })).statusCode).toBe(400);
    const bad = await create({ anchor: { kind: 'slide', slide: 's9' }, text: 'x', severity: 'info' });
    expect(bad.statusCode).toBe(400);
    expect(bad.json().error).toContain('s9');
    expect(await store.remarks()).toEqual([]);
  });

  it('lists open remarks first; resolving hides a remark from the open list', async () => {
    await build();
    const a = (await create({ anchor: { kind: 'slide', slide: 's1' }, text: 'first', severity: 'info' })).json() as Remark;
    const b = (await create({ anchor: { kind: 'arc' }, text: 'second', severity: 'warn' })).json() as Remark;
    const res = await app.inject({ method: 'POST', url: `/api/remarks/${a.id}/resolve` });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toMatchObject({ id: a.id, status: 'resolved' });
    expect((await list()).map((r) => [r.id, r.status])).toEqual([
      [b.id, 'open'],
      [a.id, 'resolved'],
    ]);
    expect((await list('/api/remarks?status=open')).map((r) => r.id)).toEqual([b.id]);
    expect((await app.inject({ method: 'POST', url: '/api/remarks/r_missing/resolve' })).statusCode).toBe(404);
  });

  const stored = (over: Partial<Remark>): Remark => ({
    id: 'r_x',
    anchor: { kind: 'arc' },
    text: 'x',
    origin: 'check:order',
    severity: 'warn',
    status: 'open',
    laneId: null,
    createdAt: '2026-09-30T00:00:00.000Z',
    ...over,
  });

  it('GET names slide ids in remark text as "slide N (title)" in the current order, and leaves the store untouched', async () => {
    await build();
    const raw = stored({ id: 'r_1', anchor: { kind: 'slide', slide: 's3' }, text: 'Defined only on s3, after s_AAAAAAAAAA.' });
    await store.putRemarks([raw]);
    expect((await list())[0]!.text).toBe('Defined only on slide 3 (Title s3), after a removed slide.');
    // A slide inserted before it: the number follows.
    const main = await store.snapshot();
    await store.commit({ order: ['s0', ...main.order], slides: { ...main.slides, s0: slide('s0') } }, { kind: 'import' });
    expect((await list())[0]!.text).toBe('Defined only on slide 4 (Title s3), after a removed slide.');
    expect(await store.remarks()).toEqual([raw]);
  });

  it('GET drops a remark whose slide left main, unless it describes a lane preview, which is named on that preview', async () => {
    await build();
    const n1 = slide('n1');
    await store.putLane({
      id: 'l_p',
      label: 'Bridge',
      anchor: { kind: 'arc' },
      origin: 'user',
      baseVersion: 1,
      changes: [{ id: 'c_i', kind: 'insert', after: 's1', slide: n1, reason: 'r', status: 'pending' }],
      status: 'open',
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    await store.putRemarks([
      stored({ id: 'r_gone', anchor: { kind: 'slide', slide: 's9' }, text: 'on a slide that left' }),
      stored({ id: 'r_range', anchor: { kind: 'range', from: 's2', to: 's9' }, text: 'half gone' }),
      stored({ id: 'r_lane', anchor: { kind: 'slide', slide: 'n1' }, text: 'n1 is dense', origin: 'check:render', sourceLaneId: 'l_p' }),
      stored({ id: 'r_ok', anchor: { kind: 'slide', slide: 's2' }, text: 'fine' }),
    ]);
    const out = await list();
    expect(out.map((r) => [r.id, r.text])).toEqual([
      ['r_lane', 'slide 2 (Title n1) is dense'],
      ['r_ok', 'fine'],
    ]);
  });

  it('propose sends the remark to the agent on thread remark:<id> with the anchor as context', async () => {
    await build();
    const r = (await create({ anchor: { kind: 'range', from: 's2', to: 's3' }, text: 'Concept used before defined.', severity: 'warn' })).json() as Remark;
    const res = await app.inject({ method: 'POST', url: `/api/remarks/${r.id}/propose` });
    expect(res.statusCode).toBe(202);
    const file = join(deckDir, 'threads', `remark_${r.id}.jsonl`);
    const msgs = await waitFor(async () => {
      const raw = await readFile(file, 'utf8').catch(() => '');
      const lines = raw.split('\n').filter(Boolean).map((l) => JSON.parse(l) as ThreadMessage);
      return lines.length === 2 ? lines : null;
    });
    expect(msgs[0]).toMatchObject({ role: 'user', thread: `remark:${r.id}`, text: 'Propose a lane for this remark.', context: { kind: 'range', from: 's2', to: 's3' } });
    expect(msgs[1]).toMatchObject({ role: 'assistant', text: 'On it.' });
    expect(calls).toHaveLength(1);
    expect(calls[0]!.prompt).toContain('Concept used before defined.');
    expect((await app.inject({ method: 'POST', url: '/api/remarks/r_missing/propose' })).statusCode).toBe(404);
  });

  it('propose on a remark whose lane is a check draft opens that lane instead of asking the co-author', async () => {
    await build();
    await store.putLane({
      id: 'l_d',
      label: 'Tighter hook',
      anchor: { kind: 'slide', slide: 's2' },
      origin: 'check:arc',
      baseVersion: 1,
      changes: [{ id: 'c_1', kind: 'modify', slide: 's2', patch: { title: 'Sharper' }, reason: 'hook', status: 'pending' }],
      status: 'draft',
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    const remark: Remark = {
      id: 'r_1',
      anchor: { kind: 'slide', slide: 's2' },
      text: 'weak hook',
      origin: 'check:arc',
      severity: 'warn',
      status: 'open',
      laneId: 'l_d',
      createdAt: '2026-09-30T00:00:00.000Z',
    };
    await store.putRemarks([remark]);
    const res = await app.inject({ method: 'POST', url: '/api/remarks/r_1/propose' });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ laneId: 'l_d', opened: true });
    expect((await store.lane('l_d'))!.status).toBe('open');
    expect(events).toContainEqual({ type: 'lane.updated', laneId: 'l_d' });
    expect(calls).toHaveLength(0);
    expect((await app.inject({ method: 'GET', url: '/api/lanes' })).json().map((l: { id: string }) => l.id)).toEqual(['l_d']);
  });

  it('propose on a remark whose lane is already open or closed asks the co-author as usual', async () => {
    await build();
    await store.putLane({
      id: 'l_c',
      label: 'Done',
      anchor: { kind: 'slide', slide: 's2' },
      origin: 'check:arc',
      baseVersion: 1,
      changes: [],
      status: 'closed',
      createdAt: '2026-09-30T00:00:00.000Z',
    });
    await store.putRemarks([
      { id: 'r_1', anchor: { kind: 'slide', slide: 's2' }, text: 'weak hook', origin: 'check:arc', severity: 'warn', status: 'open', laneId: 'l_c', createdAt: '2026-09-30T00:00:00.000Z' },
    ]);
    const res = await app.inject({ method: 'POST', url: '/api/remarks/r_1/propose' });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true, thread: 'remark:r_1' });
    await waitFor(() => calls.length === 1);
  });

  it('checks: 503 on run and status when no runner is wired', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url: '/api/checks/run', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'checks unavailable' });
    const st = await app.inject({ method: 'GET', url: '/api/checks/status' });
    expect(st.statusCode).toBe(503);
    expect(st.json()).toEqual({ error: 'checks unavailable' });
  });

  /** A real CheckRunner whose SDK queries each wait for `release()`. */
  const gatedRunner = (debounceMs = 10) => {
    const queried: string[] = [];
    const gates: Array<() => void> = [];
    const impl = ((params: { prompt: string; options: Options }) => {
      queried.push(String(params.options.systemPrompt));
      const opened = new Promise<void>((resolve) => gates.push(resolve));
      return (async function* () {
        await opened;
        yield { type: 'result', subtype: 'success', is_error: false, result: '{"remarks":[]}', session_id: 'x', total_cost_usd: 0, errors: [] };
      })() as AsyncGenerator<SDKMessage, void>;
    }) as unknown as typeof query;
    const runner = new CheckRunner({ store, thumbs, bus: new Bus(), model: 'claude-opus-5', queryImpl: impl, debounceMs });
    return { runner, queried, release: () => gates.splice(0).forEach((g) => g()) };
  };
  const status = async () => (await app.inject({ method: 'GET', url: '/api/checks/status' })).json() as { running: string[]; lastRun: Record<string, string | null> };

  it('checks: POST starts the named checks, GET status reads the runner, a queued or running check is not started twice', async () => {
    const { runner, queried, release } = gatedRunner();
    await build(runner);
    const res = await app.inject({ method: 'POST', url: '/api/checks/run', payload: { names: ['order', 'gaps'] } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: ['order', 'gaps'] });
    // gaps waits behind order: only order is reported running.
    await waitFor(() => queried.length === 1);
    expect((await status()).running).toEqual(['order']);
    expect((await app.inject({ method: 'POST', url: '/api/checks/run', payload: { names: ['order'] } })).json()).toEqual({ started: [] });
    const done = await waitFor(async () => {
      release();
      const s = await status();
      return s.running.length === 0 ? s : null;
    });
    expect(queried).toHaveLength(2);
    expect(done.lastRun.order).toMatch(/^\d{4}-/);
    expect(done.lastRun.gaps).toMatch(/^\d{4}-/);
    expect(done.lastRun.arc).toBeNull();
    expect((await app.inject({ method: 'POST', url: '/api/checks/run', payload: { names: ['nope'] } })).statusCode).toBe(400);
  });

  it('checks: an automatic run after deck.changed shows in GET status and is not doubled by POST', async () => {
    const { runner, queried, release } = gatedRunner();
    await build(runner);
    app.bus.emit({ type: 'deck.changed', version: 2 });
    await waitFor(() => queried.length === 1);
    // The four are queued; only the one whose query is in flight is reported running.
    expect((await status()).running).toEqual(['arc']);
    const post = await app.inject({ method: 'POST', url: '/api/checks/run', payload: {} });
    expect(post.json()).toEqual({ started: [] });
    await waitFor(async () => {
      release();
      return (await status()).running.length === 0;
    });
    // Thumbs are not started: render fails before querying. arc, order and gaps each ran once.
    expect(queried).toHaveLength(3);
  });

  it('QA4 a history restore schedules exactly one batch of checks', async () => {
    const { runner, queried, release } = gatedRunner();
    await build(runner);
    const main = await store.snapshot();
    await store.commit({ ...main, slides: { ...main.slides, s2: { ...main.slides.s2!, title: 'Changed' } } }, { kind: 'import' });
    const res = await app.inject({ method: 'POST', url: '/api/history/restore', payload: { from: 1, entry: { kind: 'modified', slide: 's2', fields: ['title'] } } });
    expect(res.statusCode).toBe(200);
    await waitFor(() => queried.length === 1);
    await waitFor(async () => {
      release();
      return queried.length >= 3 && (await status()).running.length === 0;
    });
    expect(queried).toHaveLength(3);
  });
});
