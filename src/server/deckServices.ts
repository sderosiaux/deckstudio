import { join } from 'node:path';
import { CHECK_NAMES, isCheckName } from '../agent/checks/index.js';
import { CheckRunner } from '../agent/checks/runner.js';
import { makeImageGen } from '../agent/imageGen.js';
import { AgentSession } from '../agent/session.js';
import { makeDeckTools } from '../agent/tools.js';
import type { ThumbService } from '../render/thumbs.js';
import type { DeckStore } from '../store/deckStore.js';
import { Bus } from './bus.js';
import { HistoryService } from './historyService.js';
import { LaneService } from './laneService.js';
import type { ChecksRunner } from './routes/checks.js';

/** Everything the per-deck routes need for one deck. One instance per open deck, built once and cached. */
export interface DeckServices {
  readonly store: DeckStore;
  readonly bus: Bus;
  readonly thumbs: ThumbService;
  readonly lanes: LaneService;
  readonly history: HistoryService;
  readonly agent: AgentSession;
  /** Null: checks cannot run for this deck (tests). */
  readonly checks: ChecksRunner | null;
  /** Interrupts the agent, stops the checks, and stops the thumbs when this object owns them. */
  dispose(): Promise<void>;
}

export interface AgentDeps {
  store: DeckStore;
  thumbs: ThumbService;
  bus: Bus;
  model: string;
  checks: ChecksRunner | null;
}

export interface DeckServicesOptions {
  store: DeckStore;
  /** Started by the caller. */
  thumbs: ThumbService;
  /** True: dispose() stops the thumbs (registry decks); false: the caller owns them (buildApp). */
  ownsThumbs: boolean;
  /** Undefined builds the real SDK session; a function builds one per deck (tests, registry). */
  agent?: AgentSession | ((deps: AgentDeps) => AgentSession);
  /** A runner, null for no checks, undefined for the real CheckRunner. */
  checks?: ChecksRunner | null;
}

export function defaultAgent({ store, thumbs, bus, model, checks }: AgentDeps): AgentSession {
  const tools = makeDeckTools({
    store,
    thumbs,
    bus,
    imageGen: makeImageGen(join(store.dir, 'assets')),
    runCheck: async (name) => {
      if (!checks) throw new Error('checks are not available in this build');
      if (!isCheckName(name)) throw new Error(`unknown check "${name}"; available: ${CHECK_NAMES.join(', ')}`);
      checks.start([name]);
    },
  });
  return new AgentSession({ store, tools, bus, model, deckDir: store.dir });
}

export async function createDeckServices(opts: DeckServicesOptions): Promise<DeckServices> {
  const { store, thumbs } = opts;
  const bus = new Bus();
  const model = (await store.state()).model;
  const checks = opts.checks === undefined ? new CheckRunner({ store, thumbs, bus, model }) : opts.checks;
  const lanes = new LaneService(store, bus);
  // Whoever moved main (accept, restore, direct edit, co-author tool), the lanes are judged again on it.
  const offs: Array<() => void> = [bus.on('deck.changed', () => lanes.scheduleSync())];
  if (checks instanceof CheckRunner) {
    offs.push(bus.on('deck.changed', () => checks.scheduleAfterDeckChange()));
    offs.push(
      bus.on('lane.created', (e) => {
        if (e.type === 'lane.created') checks.scheduleAfterLane(e.laneId);
      }),
    );
    // A draft opened by the creator gets the same render check as a lane the co-author just proposed.
    offs.push(
      bus.on('lane.opened', (e) => {
        if (e.type === 'lane.opened') checks.scheduleAfterLane(e.laneId);
      }),
    );
  }
  const deps: AgentDeps = { store, thumbs, bus, model, checks };
  const agent = opts.agent === undefined ? defaultAgent(deps) : typeof opts.agent === 'function' ? opts.agent(deps) : opts.agent;
  let disposed: Promise<void> | null = null;
  return {
    store,
    bus,
    thumbs,
    lanes,
    history: new HistoryService(store, bus),
    agent,
    checks,
    dispose: () =>
      (disposed ??= (async () => {
        for (const off of offs) off();
        lanes.dispose();
        // A turn still running when the deck closes is aborted, not left writing into a closed deck.
        await agent.interrupt();
        if (checks instanceof CheckRunner) checks.dispose();
        if (opts.ownsThumbs) await thumbs.stop();
      })()),
  };
}
