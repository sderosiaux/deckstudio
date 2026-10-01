import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from 'vitest';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { query, Options, SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import { AgentSession, scrubReply } from '../../src/agent/session.js';
import { makeDeckTools } from '../../src/agent/tools.js';
import { ThumbService } from '../../src/render/thumbs.js';
import { buildApp } from '../../src/server/app.js';
import { Bus, type BusEvent } from '../../src/server/bus.js';
import { DeckStore } from '../../src/store/deckStore.js';
import type { Brief, Lane, Remark, Slide, Snapshot, ThreadMessage } from '../../src/model/types.js';
import { tmpDir } from '../helpers/tmp.js';
import { waitFor } from '../helpers/waitFor.js';
import { themeCss } from '../render/themeCss.js';

const brief: Brief = { title: 'Deck', audience: 'devs', message: 'one log', pattern: 'solution-first', abstract: 'abs', design: { rules: '', imageStyle: '' } };
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

const lane: Lane = {
  id: 'l1',
  label: 'Tighter opening',
  anchor: { kind: 'range', from: 's2', to: 's4' },
  origin: 'user',
  baseVersion: 1,
  changes: [
    { id: 'c1', kind: 'modify', slide: 's2', patch: { title: 'Shorter claim' }, reason: 'the claim is buried under the setup', status: 'pending' },
    { id: 'c2', kind: 'remove', slide: 's4', reason: 'repeats slide three', status: 'pending' },
  ],
  status: 'open',
  createdAt: '2026-09-30T00:00:00.000Z',
};

type Call = { prompt: string; options: Options };

// Messages are built as plain objects: only the fields the session reads are meaningful.
const delta = (text: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text } } });
const toolStart = (name: string) => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_start', index: 1, content_block: { type: 'tool_use', id: 'tu1', name, input: {} } } });
const toolDelta = () => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_delta', index: 1, delta: { type: 'input_json_delta', partial_json: '{}' } } });
const blockStop = () => ({ type: 'stream_event', parent_tool_use_id: null, event: { type: 'content_block_stop', index: 1 } });
const assistant = (text: string) => ({ type: 'assistant', parent_tool_use_id: null, message: { content: [{ type: 'text', text }] } });
const success = (session_id: string) => ({ type: 'result', subtype: 'success', is_error: false, result: 'ok', session_id, total_cost_usd: 0.01, errors: [] });

/** A fake `query`: records each call and plays the scripted messages for it. */
function fakeQuery(script: (call: Call, n: number) => AsyncGenerator<object, void>): { impl: typeof query; calls: Call[] } {
  const calls: Call[] = [];
  const impl = ((params: { prompt: string; options: Options }) => {
    const call = { prompt: params.prompt, options: params.options };
    calls.push(call);
    return script(call, calls.length) as AsyncGenerator<SDKMessage, void>;
  }) as unknown as typeof query;
  return { impl, calls };
}

describe('AgentSession', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let store: DeckStore;
  let bus: Bus;
  let events: BusEvent[];
  let tools: ReturnType<typeof makeDeckTools>;

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
    await store.putLane(lane);
    bus = new Bus();
    events = [];
    bus.on('any', (e) => events.push(e));
    // Never started: the fake query never calls a tool, so no browser is needed.
    const thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
    tools = makeDeckTools({
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
  });

  const session = (impl: typeof query) => new AgentSession({ store, tools, bus, model: 'claude-opus-5', deckDir: store.dir, queryImpl: impl });

  it('sends a lane message with the lane context, stores both messages, persists and resumes the session', async () => {
    const fake = fakeQuery(async function* () {
      yield delta('Shortened ');
      yield delta('the claim.');
      yield assistant('Shortened the claim.');
      yield success('sess-1');
    });
    const s = session(fake.impl);

    await s.send('lane:l1', 'shorten it', null);

    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain('Tighter opening');
    expect(prompt).toContain('the claim is buried under the setup');
    expect(prompt).toContain('repeats slide three');
    // The range section: from the Selected line up to the next blank line, the lane's s2..s4 with their stories.
    const range = prompt.slice(prompt.indexOf('Selected: range s2..s4')).split('\n\n')[0]!;
    expect(range.split('\n')).toEqual([
      'Selected: range s2..s4',
      '2. s2: Title s2',
      '   story: story of s2',
      '3. s3: Title s3',
      '   story: story of s3',
      '4. s4: Title s4',
      '   story: story of s4',
    ]);
    for (const id of ['s1', 's5']) expect(range).not.toContain(id);
    expect(prompt.endsWith('\n\nshorten it')).toBe(true);

    const opts = fake.calls[0]!.options;
    expect(opts.model).toBe('claude-opus-5');
    expect(opts.cwd).toBe(store.dir);
    expect(opts.resume).toBeUndefined();
    expect(opts.systemPrompt).toMatchObject({ type: 'preset', preset: 'claude_code' });
    expect(opts.settingSources).toEqual(['user', 'project']);
    expect(opts.mcpServers?.['deck']).toBe(tools.server);
    // Only deck tools are pre-approved: a bare 'Bash' in allowedTools would skip canUseTool (SDK shadowing).
    expect(opts.allowedTools).toEqual(tools.allowedTools);
    expect(opts.allowedTools).not.toContain('Bash');
    expect(typeof opts.canUseTool).toBe('function');
    expect(opts.includePartialMessages).toBe(true);
    expect(opts.abortController).toBeInstanceOf(AbortController);

    const lines = (await readFile(join(store.dir, 'threads', 'lane_l1.jsonl'), 'utf8')).trim().split('\n');
    const msgs = lines.map((l) => JSON.parse(l) as ThreadMessage);
    expect(msgs.map((m) => [m.role, m.text])).toEqual([
      ['user', 'shorten it'],
      ['assistant', 'Shortened the claim.'],
    ]);
    expect(msgs[0]!.id).toMatch(/^m_/);
    expect((await store.state()).sessionId).toBe('sess-1');

    expect(events.filter((e) => e.type === 'assistant.delta').map((e) => (e as { text: string }).text)).toEqual(['Shortened ', 'the claim.']);
    expect(events.at(-1)).toEqual({ type: 'assistant.done', thread: 'lane:l1', messageId: msgs[1]!.id });

    await s.send('global', 'and now?', { kind: 'slide', slide: 's1' });
    expect(fake.calls[1]!.options.resume).toBe('sess-1');
    expect(fake.calls[1]!.prompt).toContain('Selected: slide s1');
  });

  it('a reply naming ids and tool names is stored with lane labels, slide names and no tool names', async () => {
    const raw = 'Lane l1 : `propose_lane` done, c2 dropped on slide s3 and s_ghost00000; see `mcp__deck__render_slide`.';
    const fake = fakeQuery(async function* () {
      yield delta(raw);
      yield assistant(raw);
      yield success('sess-x');
    });
    await session(fake.impl).send('global', 'Make it shorter', null);
    const [, reply] = await store.thread('global');
    expect(reply!.text).toBe('Lane Tighter opening : done, this change dropped on slide 3 (Title s3) and a removed slide; see.');
  });

  it('scrubReply names unknown lanes and changes generically and leaves plain text alone', () => {
    const order = ['s_AAAAAAAAAA', 's_BBBBBBBBBB'];
    const ctx = {
      snapshot: { order, slides: Object.fromEntries(order.map((id, i) => [id, slide(id, { title: `T${i + 1}` })])) },
      lanes: [{ ...lane, id: 'l__w9KF0bWiS', label: 'Shorter hook title' }],
    };
    expect(scrubReply('Lane l__w9KF0bWiS: c_haxIgx-FsA moves s_BBBBBBBBBB, l_unknown123 waits.', ctx)).toBe(
      'Lane Shorter hook title: this change moves slide 2 (T2), this lane waits.',
    );
    expect(scrubReply('Use `revise_lane` then `render_slide` here.', ctx)).toBe('Use then here.');
    expect(scrubReply('Plain answer, nothing to do.', ctx)).toBe('Plain answer, nothing to do.');
  });

  it('lane thread header lists every change and the revise-or-fork instruction', async () => {
    const fake = fakeQuery(async function* () {
      yield assistant('ok');
      yield success('sess-l');
    });
    await session(fake.impl).send('lane:l1', 'give me another take', null);
    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain('c1 · modify · "Title s2" (s2) · the claim is buried under the setup · pending');
    expect(prompt).toContain('c2 · remove · "Title s4" (s4) · repeats slide three · pending');
    expect(prompt).toContain('Anchor slides: "Title s2" (s2), "Title s3" (s3), "Title s4" (s4)');
    expect(prompt).toContain('call revise_lane on it (laneId "l1")');
    expect(prompt).toContain('call propose_lane with a new label and mention both lanes');
  });

  it('remark thread header carries the remark text and the link_remark_lane instruction', async () => {
    const remark: Remark = {
      id: 'r1',
      anchor: { kind: 'slide', slide: 's3' },
      text: 'offsets are used before they are introduced',
      origin: 'check:order',
      severity: 'warn',
      status: 'open',
      laneId: null,
      createdAt: '2026-09-30T00:00:00.000Z',
    };
    await store.putRemarks([remark]);
    const fake = fakeQuery(async function* () {
      yield assistant('ok');
      yield success('sess-r');
    });
    await session(fake.impl).send('remark:r1', 'Propose a lane for this remark', null);
    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain('offsets are used before they are introduced');
    expect(prompt).toContain('Severity: warn');
    expect(prompt).toContain('Anchor slides: "Title s3" (s3)');
    expect(prompt).toContain('call propose_lane with anchor {"kind":"slide","slide":"s3"}');
    expect(prompt).toContain('link_remark_lane({"remarkId":"r1","laneId":<the new lane id>})');
    expect(prompt.endsWith('\n\nPropose a lane for this remark')).toBe(true);
  });

  it('slide thread: a message without context is anchored on that slide, stored so, and scoped on it in the prompt', async () => {
    const fake = fakeQuery(async function* () {
      yield assistant('ok');
      yield success('sess-s');
    });
    await session(fake.impl).send('slide:s3', 'make the claim sharper', null);
    const prompt = fake.calls[0]!.prompt;
    expect(prompt).toContain('Thread: slide:s3');
    expect(prompt).toContain('Selected: slide s3');
    expect(prompt).toContain('the creator is editing slide 3 "Title s3" (s3)');
    expect(prompt).toContain('<p>body s3</p>');
    expect(prompt.endsWith('\n\nmake the claim sharper')).toBe(true);
    const stored = await store.thread('slide:s3');
    expect(stored.map((m) => [m.role, m.context])).toEqual([
      ['user', { kind: 'slide', slide: 's3' }],
      ['assistant', null],
    ]);
  });

  it('slide thread: an explicit context wins over the slide anchor', async () => {
    const fake = fakeQuery(async function* () {
      yield assistant('ok');
      yield success('sess-s2');
    });
    await session(fake.impl).send('slide:s3', 'and its neighbours', { kind: 'range', from: 's2', to: 's4' });
    expect(fake.calls[0]!.prompt).toContain('Selected: range s2..s4');
    expect((await store.thread('slide:s3'))[0]!.context).toEqual({ kind: 'range', from: 's2', to: 's4' });
  });

  it('design rules and the classes of the deck theme.css reach the header of the global, lane and slide threads', async () => {
    await store.setBrief({ ...brief, design: { rules: 'One accent colour only.', imageStyle: '' } });
    await writeFile(join(store.dir, 'theme.css'), '.slide{padding:72px}\n.deck-only-claim{font-size:82px}');
    const fake = fakeQuery(async function* () {
      yield assistant('ok');
      yield success('sess-d');
    });
    const s = session(fake.impl);
    await s.send('global', 'a new slide on offsets', null);
    await s.send('lane:l1', 'tighter', null);
    await s.send('slide:s3', 'sharper', null);
    expect(fake.calls).toHaveLength(3);
    for (const { prompt } of fake.calls) {
      expect(prompt).toContain('One accent colour only.');
      expect(prompt).toContain('(reuse them instead of inline styles): .deck-only-claim\n');
    }
  });

  it('does not stream tool input as text and reports tool calls', async () => {
    const fake = fakeQuery(async function* () {
      yield toolStart('mcp__deck__get_deck');
      yield toolDelta();
      yield blockStop();
      yield delta('Done.');
      yield assistant('Done.');
      yield success('sess-2');
    });
    await session(fake.impl).send('global', 'look', null);
    expect(events.filter((e) => e.type !== 'assistant.done')).toEqual([
      { type: 'tool.call', name: 'mcp__deck__get_deck', thread: 'global' },
      { type: 'assistant.delta', thread: 'global', text: 'Done.' },
    ]);
  });

  it('runs one query at a time: a second send waits for the first to finish', async () => {
    let release!: () => void;
    const gate = new Promise<void>((r) => (release = r));
    const fake = fakeQuery(async function* (_call, n) {
      if (n === 1) await gate;
      yield assistant(`reply ${n}`);
      yield success(`sess-${n}`);
    });
    const s = session(fake.impl);
    const first = s.send('global', 'one', null);
    const second = s.send('global', 'two', null);
    await waitFor(() => fake.calls.length === 1);
    // Both user messages are stored at once; only the first query is running.
    await waitFor(async () => (await store.thread('global')).length === 2);
    expect(fake.calls).toHaveLength(1);
    release();
    await Promise.all([first, second]);
    expect(fake.calls).toHaveLength(2);
    expect(fake.calls[1]!.options.resume).toBe('sess-1');
    expect((await store.thread('global')).map((m) => m.text)).toEqual(['one', 'two', 'reply 1', 'reply 2']);
  });

  it('turns an error result followed by a throw into one agent.error and keeps the session usable', async () => {
    const fake = fakeQuery(async function* (_call, n) {
      if (n === 1) {
        yield { type: 'result', subtype: 'error_max_turns', is_error: true, session_id: 'sess-err', total_cost_usd: 0, errors: ['too many turns'] };
        throw new Error('Claude Code process exited with code 1');
      }
      yield assistant('fine');
      yield success('sess-ok');
    });
    const s = session(fake.impl);
    await s.send('global', 'go', null);
    const errors = events.filter((e) => e.type === 'agent.error');
    expect(errors).toEqual([{ type: 'agent.error', thread: 'global', message: 'error_max_turns: too many turns' }]);
    expect(events.some((e) => e.type === 'assistant.done')).toBe(false);
    // A turn that ran out of turns still has a transcript worth resuming.
    expect((await store.state()).sessionId).toBe('sess-err');

    await s.send('global', 'again', null);
    expect(fake.calls[1]!.options.resume).toBe('sess-err');
    expect(events.at(-1)).toMatchObject({ type: 'assistant.done', thread: 'global' });
    expect((await store.state()).sessionId).toBe('sess-ok');
  });

  it('drops a stale stored session id and retries the turn once without resume', async () => {
    await store.setSessionId('sess-gone');
    const fake = fakeQuery(async function* (call) {
      if (call.options.resume) {
        yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'sess-tmp', total_cost_usd: 0, errors: ['No conversation found with session ID: sess-gone'] };
        throw new Error('Claude Code process exited with code 1');
      }
      yield assistant('fresh');
      yield success('sess-new');
    });
    await session(fake.impl).send('global', 'hello', null);
    expect(fake.calls.map((c) => c.options.resume)).toEqual(['sess-gone', undefined]);
    expect(fake.calls[1]!.prompt).toBe(fake.calls[0]!.prompt);
    expect(events.some((e) => e.type === 'agent.error')).toBe(false);
    expect(events.at(-1)).toMatchObject({ type: 'assistant.done', thread: 'global' });
    expect((await store.state()).sessionId).toBe('sess-new');
    expect((await store.thread('global')).map((m) => m.text)).toEqual(['hello', 'fresh']);
  });

  it('does not retry a stale-session error forever: a second failure is reported', async () => {
    await store.setSessionId('sess-gone');
    const fake = fakeQuery(async function* () {
      yield { type: 'result', subtype: 'error_during_execution', is_error: true, session_id: 'x', total_cost_usd: 0, errors: ['No conversation found with session ID: x'] };
      throw new Error('exit 1');
    });
    await session(fake.impl).send('global', 'hello', null);
    expect(fake.calls).toHaveLength(2);
    expect(events.filter((e) => e.type === 'agent.error')).toEqual([
      { type: 'agent.error', thread: 'global', message: 'error_during_execution: No conversation found with session ID: x' },
    ]);
    expect((await store.state()).sessionId).toBeNull();
  });

  it('interrupt drops turns queued before it, aborts the running one and waits for both to settle', async () => {
    const fake = fakeQuery(async function* (call, n) {
      if (n === 1) {
        const signal = call.options.abortController!.signal;
        await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
        throw new Error('aborted by user');
      }
      yield assistant('back');
      yield success('sess-back');
    });
    const s = session(fake.impl);
    const first = s.send('global', 'one', null);
    const second = s.send('global', 'two', null);
    await waitFor(() => fake.calls.length === 1);
    await waitFor(async () => (await store.thread('global')).length === 2);
    await s.interrupt();
    // interrupt() resolves only once both turns are over: nothing is left running or writing.
    expect(fake.calls).toHaveLength(1);
    expect(events.filter((e) => e.type === 'agent.error')).toEqual([
      { type: 'agent.error', thread: 'global', message: 'interrupted' },
      { type: 'agent.error', thread: 'global', message: 'interrupted' },
    ]);
    // A dropped turn keeps its user message (it was said) and gets no assistant reply.
    expect((await store.thread('global')).map((m) => [m.role, m.text])).toEqual([
      ['user', 'one'],
      ['user', 'two'],
    ]);
    await Promise.all([first, second]);

    // Sends after the interrupt run normally.
    await s.send('global', 'three', null);
    expect(fake.calls).toHaveLength(2);
    expect((await store.thread('global')).map((m) => m.text).slice(-2)).toEqual(['three', 'back']);
  });

  it('interrupt aborts the running query', async () => {
    const fake = fakeQuery(async function* (call) {
      yield delta('Working');
      const signal = call.options.abortController!.signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('aborted by user');
    });
    const s = session(fake.impl);
    const turn = s.send('global', 'long task', null);
    await waitFor(() => events.some((e) => e.type === 'assistant.delta'));
    await s.interrupt();
    await turn;
    expect(events).toContainEqual({ type: 'agent.error', thread: 'global', message: 'interrupted' });
    // The partial text is kept in the thread.
    expect((await store.thread('global')).map((m) => [m.role, m.text])).toEqual([
      ['user', 'long task'],
      ['assistant', 'Working'],
    ]);
  });
});

describe('threads API', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let app: FastifyInstance;
  let thumbs: ThumbService;
  let calls: Call[];

  beforeEach(async () => {
    tmp = await tmpDir();
    const deckDir = join(tmp.dir, 'deck');
    const store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
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
    const fake = fakeQuery(async function* () {
      yield assistant('Here.');
      yield success('sess-api');
    });
    calls = fake.calls;
    const agent = new AgentSession({ store, tools, bus, model: 'claude-opus-5', deckDir, queryImpl: fake.impl });
    app = await buildApp({ deckDir, thumbs, agent, checks: null });
    await app.ready();
  });
  afterEach(async () => {
    await app?.close();
    await tmp?.cleanup();
  });

  it('POST returns 202 at once and the reply shows up in GET', async () => {
    const key = encodeURIComponent('lane:l_abc');
    const res = await app.inject({ method: 'POST', url: `/api/threads/${key}/messages`, payload: { text: 'hi', context: { kind: 'range', from: 's1', to: 's3' } } });
    expect(res.statusCode).toBe(202);
    expect(res.json()).toEqual({ accepted: true });
    const msgs = await waitFor(async () => {
      const r = (await app.inject({ method: 'GET', url: `/api/threads/${key}` })).json() as ThreadMessage[];
      return r.length === 2 ? r : null;
    });
    expect(msgs.map((m) => [m.role, m.text, m.thread])).toEqual([
      ['user', 'hi', 'lane:l_abc'],
      ['assistant', 'Here.', 'lane:l_abc'],
    ]);
    expect(msgs[0]!.context).toEqual({ kind: 'range', from: 's1', to: 's3' });
    expect(calls).toHaveLength(1);
  });

  it('app.close() aborts the running turn and only resolves once it has stopped writing', async () => {
    const deckDir = join(tmp.dir, 'deck-close');
    const store = await DeckStore.init(deckDir, 'demo', brief);
    await store.commit(snap(five), { kind: 'import' });
    const bus = new Bus();
    const events: BusEvent[] = [];
    bus.on('any', (e) => events.push(e));
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
    const fake = fakeQuery(async function* (call) {
      yield delta('Partial');
      const signal = call.options.abortController!.signal;
      await new Promise<void>((resolve) => signal.addEventListener('abort', () => resolve(), { once: true }));
      throw new Error('aborted');
    });
    const agent = new AgentSession({ store, tools, bus, model: 'claude-opus-5', deckDir, queryImpl: fake.impl });
    const local = await buildApp({ deckDir, thumbs, agent });
    await local.ready();
    await local.inject({ method: 'POST', url: '/api/threads/global/messages', payload: { text: 'one' } });
    await local.inject({ method: 'POST', url: '/api/threads/global/messages', payload: { text: 'two' } });
    await waitFor(() => events.some((e) => e.type === 'assistant.delta'));
    await local.close();
    expect(fake.calls).toHaveLength(1);
    expect(events.filter((e) => e.type === 'agent.error')).toHaveLength(2);
    expect((await store.thread('global')).map((m) => [m.role, m.text])).toEqual([
      ['user', 'one'],
      ['user', 'two'],
      ['assistant', 'Partial'],
    ]);
  });

  it('rejects a bad thread key or an empty text, and exposes interrupt', async () => {
    expect((await app.inject({ method: 'POST', url: '/api/threads/nope/messages', payload: { text: 'hi' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'POST', url: '/api/threads/global/messages', payload: { text: '  ' } })).statusCode).toBe(400);
    expect((await app.inject({ method: 'GET', url: '/api/threads/global' })).json()).toEqual([]);
    const r = await app.inject({ method: 'POST', url: '/api/threads/interrupt' });
    expect(r.statusCode).toBe(200);
  });
});
