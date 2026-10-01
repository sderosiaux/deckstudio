import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { join } from 'node:path';
import type { query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import { AgentSession } from '../../src/agent/session.js';
import { makeDeckTools } from '../../src/agent/tools.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { buildApp } from '../../src/server/app.js';
import { Bus } from '../../src/server/bus.js';
import { DeckStore } from '../../src/store/deckStore.js';
import type { Brief, Slide, Snapshot, ThreadMessage } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
const slide = (id: string): Slide => ({ id, title: `Title ${id}`, story: `story of ${id}`, notes: `notes of ${id}`, body: `<p>body ${id}</p>`, assets: [], kind: 'text' });
const three = ['s1', 's2', 's3'].map(slide);
const snap: Snapshot = { order: three.map((s) => s.id), slides: Object.fromEntries(three.map((s) => [s.id, s])) };

describe('threads API: slide:<id>', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let app: FastifyInstance;
  let prompts: string[];
  let store: DeckStore;

  beforeEach(async () => {
    tmp = await tmpDir();
    const deckDir = join(tmp.dir, 'deck');
    store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap, { kind: 'import' });
    const thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    const bus = new Bus();
    const unused = async (): Promise<never> => {
      throw new Error('unused');
    };
    const tools = makeDeckTools({ store, thumbs, bus, imageGen: unused, runCheck: unused });
    prompts = [];
    const impl = ((params: { prompt: string; options: Options }) => {
      prompts.push(params.prompt);
      return (async function* () {
        yield { type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text: 'Lane proposed.' }] } };
        yield { type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id: 'sess-slide', total_cost_usd: 0, errors: [] };
      })() as AsyncGenerator<SDKMessage, void>;
    }) as unknown as typeof query;
    const agent = new AgentSession({ store, tools, bus, model: 'claude-opus-5', deckDir, queryImpl: impl });
    app = await buildApp({ deckDir, thumbs, agent, checks: null });
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    await tmp?.cleanup();
  });

  const url = (key: string, tail = '/messages') => `/api/threads/${encodeURIComponent(key)}${tail}`;

  it('accepts a message on a slide of main, anchors it on that slide and scopes the prompt on it', async () => {
    const res = await app.inject({ method: 'POST', url: url('slide:s2'), payload: { text: 'tighten the title', context: { kind: 'slide', slide: 's2' } } });
    expect(res.statusCode).toBe(202);
    const msgs = await waitFor(async () => {
      const r = (await app.inject({ method: 'GET', url: url('slide:s2', '') })).json() as ThreadMessage[];
      return r.length === 2 ? r : null;
    });
    expect(msgs.map((m) => [m.role, m.thread, m.context])).toEqual([
      ['user', 'slide:s2', { kind: 'slide', slide: 's2' }],
      ['assistant', 'slide:s2', null],
    ]);
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toContain('the creator is editing slide 2 "Title s2" (s2)');
    expect(prompts[0]).toContain('notes: notes of s2');
  });

  it('without a context the message is still anchored on the slide', async () => {
    expect((await app.inject({ method: 'POST', url: url('slide:s3'), payload: { text: 'hi' } })).statusCode).toBe(202);
    const msgs = await waitFor(async () => {
      const r = (await app.inject({ method: 'GET', url: url('slide:s3', '') })).json() as ThreadMessage[];
      return r.length === 2 ? r : null;
    });
    expect(msgs[0]!.context).toEqual({ kind: 'slide', slide: 's3' });
  });

  it('answers 404 for a slide that is not on main, and asks the co-author nothing', async () => {
    const res = await app.inject({ method: 'POST', url: url('slide:s9'), payload: { text: 'hi' } });
    expect(res.statusCode).toBe(404);
    expect(res.json().error).toContain('s9');
    expect((await app.inject({ method: 'GET', url: url('slide:s9', '') })).json()).toEqual([]);
    expect(prompts).toEqual([]);
  });

  it('GET slide:<id> also returns the global turns sent on exactly that slide, replies included, by time', async () => {
    const msg = (id: string, thread: ThreadMessage['thread'], role: ThreadMessage['role'], context: ThreadMessage['context'], at: string): ThreadMessage => ({
      id,
      thread,
      role,
      text: id,
      context,
      at: `2026-09-30T10:00:${at}.000Z`,
    });
    const on = (slide: string) => ({ kind: 'slide' as const, slide });
    for (const m of [
      msg('g1', 'global', 'user', on('s2'), '01'),
      msg('g1r', 'global', 'assistant', null, '02'),
      msg('g2', 'global', 'user', null, '03'),
      msg('g2r', 'global', 'assistant', null, '04'),
      msg('g3', 'global', 'user', { kind: 'range', from: 's2', to: 's3' }, '05'),
      msg('g3r', 'global', 'assistant', null, '06'),
      msg('g4', 'global', 'user', on('s3'), '07'),
      msg('g4r', 'global', 'assistant', null, '08'),
      msg('g5', 'global', 'user', on('s2'), '11'),
      msg('g5r', 'global', 'assistant', null, '12'),
      msg('g5r2', 'global', 'assistant', null, '13'),
      msg('g6', 'global', 'user', null, '14'),
    ]) await store.appendMessage(m);
    for (const m of [msg('t1', 'slide:s2', 'user', on('s2'), '09'), msg('t1r', 'slide:s2', 'assistant', null, '10')]) await store.appendMessage(m);
    const got = (await app.inject({ method: 'GET', url: url('slide:s2', '') })).json() as ThreadMessage[];
    expect(got.map((m) => m.id)).toEqual(['g1', 'g1r', 't1', 't1r', 'g5', 'g5r', 'g5r2']);
    // The global thread itself is unchanged and the slide thread of another slide only gets its own turns.
    expect(((await app.inject({ method: 'GET', url: url('global', '') })).json() as ThreadMessage[]).map((m) => m.id)).toHaveLength(12);
    expect(((await app.inject({ method: 'GET', url: url('slide:s3', '') })).json() as ThreadMessage[]).map((m) => m.id)).toEqual(['g4', 'g4r']);
  });

  it('rejects an empty slide id as a bad key', async () => {
    expect((await app.inject({ method: 'POST', url: url('slide:'), payload: { text: 'hi' } })).statusCode).toBe(400);
  });
});
