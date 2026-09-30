import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { access, cp } from 'node:fs/promises';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import type { FastifyInstance } from 'fastify';
import { AgentSession } from '../src/agent/session.js';
import { makeDeckTools } from '../src/agent/tools.js';
import type { Lane, SlideId, Version } from '../src/model/types.js';
import { loadThemeCss } from '../src/render/defaultTheme.js';
import { ThumbService } from '../src/render/thumbs.js';
import { buildApp } from '../src/server/app.js';
import { Bus } from '../src/server/bus.js';
import { DeckStore } from '../src/store/deckStore.js';
import { tmpDir } from '../tests/helpers/tmp.js';
import { waitFor } from '../tests/helpers/waitFor.js';

const SOURCE_DECK = '/Users/sderosiaux/code/personal/deckstudio/decks/dss-sf-2026';
const ENABLED = process.env['DECKSTUDIO_E2E'] === '1';
if (!ENABLED) console.warn('e2e/smoke skipped: set DECKSTUDIO_E2E=1 (real Claude Agent SDK call, needs claude credentials, costs money).');

const PROMPT =
  'Propose one lane on slides 1 to 6 that inserts a single new slide after slide 1 asking where the memory of an agent swarm should live ' +
  '(an external database, or the Kafka log that already holds the conversation). One insert change only, with a composed HTML body ' +
  '(a title-less body: two short columns of large text, no lists) and a one-line reason. Do not modify other slides.';

const exists = (p: string) => access(p).then(() => true, () => false);

describe.skipIf(!ENABLED)('smoke: real SDK session proposes a lane that gets accepted', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let deckDir: string;
  let thumbs: ThumbService;
  let app: FastifyInstance;
  const results: Extract<SDKMessage, { type: 'result' }>[] = [];

  beforeAll(async () => {
    tmp = await tmpDir('deckstudio-e2e-');
    deckDir = join(tmp.dir, 'dss-sf-2026');
    await cp(SOURCE_DECK, deckDir, { recursive: true });
    const store = await DeckStore.open(deckDir);
    // The copy must not resume the source deck's conversation.
    await store.setSessionId(null);
    thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss: await loadThemeCss(deckDir), assetsDir: join(deckDir, 'assets') });
    await thumbs.start();

    const bus = new Bus();
    bus.on('any', (e) => {
      if (e.type === 'tool.call') console.log(`[tool] ${e.name}`);
      if (e.type === 'agent.error') console.error(`[agent.error] ${e.message}`);
    });
    const tools = makeDeckTools({
      store,
      thumbs,
      bus,
      imageGen: async () => {
        throw new Error('image generation is not available in this test; compose the body in HTML');
      },
      runCheck: async () => {
        throw new Error('checks are not available in this test');
      },
    });
    // Real query(), tapped only to read the result message (cost) for the report.
    const tapped = ((params: Parameters<typeof query>[0]) => {
      const q = query(params);
      return (async function* () {
        for await (const m of q) {
          if (m.type === 'result') results.push(m);
          yield m;
        }
      })();
    }) as unknown as typeof query;
    const agent = new AgentSession({ store, tools, bus, model: 'claude-opus-5', deckDir: store.dir, queryImpl: tapped });
    app = await buildApp({ deckDir, thumbs, agent });
    await app.ready();
  });

  afterAll(async () => {
    await app?.close();
    await thumbs?.stop();
    const cost = results.reduce((sum, r) => sum + r.total_cost_usd, 0);
    console.log(`e2e/smoke total cost: $${cost.toFixed(4)} over ${results.length} result message(s)`);
    await tmp?.cleanup();
  });

  it('global message -> lane with one insert -> accept -> next version with one more slide -> thumb rendered', async () => {
    const deck = (await app.inject({ method: 'GET', url: '/api/deck' })).json() as { order: SlideId[] };
    const initialCount = deck.order.length;
    const initialVersion = deck.state.version;
    expect(initialCount).toBeGreaterThanOrEqual(29);
    const order = deck.order;

    const sent = await app.inject({
      method: 'POST',
      url: '/api/threads/global/messages',
      payload: { text: PROMPT, context: { kind: 'range', from: order[0], to: order[5] } },
    });
    expect(sent.statusCode).toBe(202);

    const lane = await waitFor(
      async () => {
        const lanes = (await app.inject({ method: 'GET', url: '/api/lanes' })).json() as Lane[];
        return lanes.find((l) => l.changes.filter((c) => c.kind === 'insert' && c.status === 'pending').length === 1) ?? null;
      },
      { timeout: 240_000, interval: 1_000 },
    );
    const change = lane.changes.find((c) => c.kind === 'insert' && c.status === 'pending')!;
    if (change.kind !== 'insert') throw new Error('unreachable');
    const newId = change.slide.id;

    const acc = await app.inject({ method: 'POST', url: `/api/lanes/${lane.id}/changes/${change.id}/accept` });
    expect(acc.statusCode).toBe(200);

    const after = (await app.inject({ method: 'GET', url: '/api/deck' })).json() as { order: SlideId[] };
    expect(after.order).toHaveLength(initialCount + 1);
    expect(after.order).toContain(newId);
    const versions = (await app.inject({ method: 'GET', url: '/api/versions' })).json() as Version[];
    expect(versions.some((v) => v.n === initialVersion + 1)).toBe(true);

    const hash = await waitFor(
      async () => {
        const r = (await app.inject({ method: 'GET', url: `/api/thumbs/for/${newId}` })).json() as { hash: string; ready: boolean };
        return r.ready ? r.hash : null;
      },
      { timeout: 60_000, interval: 250 },
    );
    expect(await exists(join(deckDir, 'cache', 'thumbs', `${hash}.png`))).toBe(true);
  });
});
