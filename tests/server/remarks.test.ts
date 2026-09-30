import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import { AgentSession } from '../../src/agent/session.js';
import { makeDeckTools } from '../../src/agent/tools.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { buildApp } from '../../src/server/app.js';
import { Bus, type BusEvent } from '../../src/server/bus.js';
import type { ChecksRunner } from '../../src/server/routes/checks.js';
import { DeckStore } from '../../src/store/deckStore.js';
import type { Anchor, Brief, Remark, Slide, Snapshot, ThreadMessage } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs' };
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

  it('checks: 503 when no runner is wired; status still answers', async () => {
    await build();
    const res = await app.inject({ method: 'POST', url: '/api/checks/run', payload: {} });
    expect(res.statusCode).toBe(503);
    expect(res.json()).toEqual({ error: 'checks unavailable' });
    expect((await app.inject({ method: 'GET', url: '/api/checks/status' })).json()).toEqual({
      running: [],
      lastRun: { arc: null, order: null, gaps: null, render: null },
    });
  });

  it('checks: runs the named checks in the background, reports running then lastRun', async () => {
    const release: Array<() => void> = [];
    const ran: Array<[string, Anchor | undefined]> = [];
    await build({
      run: (name, scope) => {
        ran.push([name, scope]);
        return new Promise((resolve) => release.push(() => resolve({ remarks: [], lanes: [] })));
      },
    });
    const res = await app.inject({ method: 'POST', url: '/api/checks/run', payload: { names: ['order', 'gaps'] } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ started: ['order', 'gaps'] });
    expect(ran.map((r) => r[0])).toEqual(['order', 'gaps']);
    const status = async () => (await app.inject({ method: 'GET', url: '/api/checks/status' })).json() as { running: string[]; lastRun: Record<string, string | null> };
    expect((await status()).running).toEqual(['order', 'gaps']);
    // A check already running is not started twice.
    expect((await app.inject({ method: 'POST', url: '/api/checks/run', payload: { names: ['order'] } })).json()).toEqual({ started: [] });
    expect(ran).toHaveLength(2);
    for (const r of release) r();
    const done = await waitFor(async () => {
      const s = await status();
      return s.running.length === 0 ? s : null;
    });
    expect(done.lastRun.order).toMatch(/^\d{4}-/);
    expect(done.lastRun.gaps).toMatch(/^\d{4}-/);
    expect(done.lastRun.arc).toBeNull();
    expect(events.filter((e) => e.type === 'checks.status').length).toBeGreaterThanOrEqual(2);
    expect((await app.inject({ method: 'POST', url: '/api/checks/run', payload: { names: ['nope'] } })).statusCode).toBe(400);
  });
});
