import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { cp } from 'node:fs/promises';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { CheckRunner } from '../src/agent/checks/runner.js';
import { loadThemeCss } from '../src/render/defaultTheme.js';
import { ThumbService } from '../src/render/thumbs.js';
import { Bus } from '../src/server/bus.js';
import { DeckStore } from '../src/store/deckStore.js';
import { tmpDir } from '../tests/helpers/tmp.js';

const SOURCE_DECK = '/Users/sderosiaux/code/personal/deckstudio/decks/dss-sf-2026';
const ENABLED = process.env['DECKSTUDIO_E2E'] === '1';
if (!ENABLED) console.warn('e2e/checks skipped: set DECKSTUDIO_E2E=1 (real Claude Agent SDK call, needs claude credentials, costs money).');

describe.skipIf(!ENABLED)('checks: real SDK gaps check on the SF deck', () => {
  let tmp: Awaited<ReturnType<typeof tmpDir>>;
  let store: DeckStore;
  let runner: CheckRunner;
  const results: Extract<SDKMessage, { type: 'result' }>[] = [];

  beforeAll(async () => {
    tmp = await tmpDir('deckstudio-e2e-checks-');
    const deckDir = join(tmp.dir, 'dss-sf-2026');
    await cp(SOURCE_DECK, deckDir, { recursive: true });
    store = await DeckStore.open(deckDir);
    // Never started: gaps reads titles and stories only.
    const thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss: await loadThemeCss(deckDir), assetsDir: join(deckDir, 'assets') });
    const tapped = ((params: Parameters<typeof query>[0]) => {
      const q = query(params);
      return (async function* () {
        for await (const m of q) {
          if (m.type === 'result') results.push(m);
          yield m;
        }
      })();
    }) as unknown as typeof query;
    runner = new CheckRunner({ store, thumbs, bus: new Bus(), model: (await store.state()).model, queryImpl: tapped });
  });

  afterAll(async () => {
    runner?.dispose();
    const cost = results.reduce((sum, r) => sum + r.total_cost_usd, 0);
    console.log(`e2e/checks total cost: $${cost.toFixed(4)} over ${results.length} result message(s)`);
    await tmp?.cleanup();
  });

  it('gaps produces at least one remark anchored on the arc or on slides of the deck', async () => {
    const { remarks, lanes } = await runner.run('gaps');
    const { order } = await store.state();
    for (const r of remarks) console.log(`[${r.severity}] ${JSON.stringify(r.anchor)}${r.laneId ? ` lane=${r.laneId}` : ''}\n  ${r.text}`);
    console.log(`lanes proposed: ${lanes.map((l) => `${l.id} "${l.label}"`).join(', ') || 'none'}`);

    expect(remarks.length).toBeGreaterThanOrEqual(1);
    expect(remarks.some((r) => r.text.startsWith('check gaps failed'))).toBe(false);
    const valid = (id: string) => order.includes(id);
    for (const r of remarks) {
      if (r.anchor.kind === 'slide') expect(valid(r.anchor.slide)).toBe(true);
      if (r.anchor.kind === 'range') expect(valid(r.anchor.from) && valid(r.anchor.to)).toBe(true);
    }
    // The deck copy may already hold gaps remarks that the run kept (dedupe by similarity): every returned remark is stored.
    const stored = new Set((await store.remarks()).filter((r) => r.origin === 'check:gaps').map((r) => r.id));
    for (const r of remarks) expect(stored.has(r.id)).toBe(true);
  });
});
