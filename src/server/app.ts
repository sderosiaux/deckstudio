import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import { CheckRunner } from '../agent/checks/runner.js';
import { makeImageGen } from '../agent/imageGen.js';
import { AgentSession } from '../agent/session.js';
import { makeDeckTools } from '../agent/tools.js';
import { FONTS_DIR } from '../render/theme.js';
import type { ThumbService } from '../render/thumbs.js';
import { DeckStore } from '../store/deckStore.js';
import { Bus } from './bus.js';
import { LaneService } from './laneService.js';
import { briefRoutes } from './routes/brief.js';
import { checkRoutes, type ChecksRunner } from './routes/checks.js';
import { deckRoutes } from './routes/deck.js';
import { laneRoutes } from './routes/lanes.js';
import { presentRoutes } from './routes/present.js';
import { remarkRoutes } from './routes/remarks.js';
import { slideRoutes } from './routes/slides.js';
import { threadRoutes } from './routes/threads.js';
import { thumbRoutes } from './routes/thumbs.js';
import { versionRoutes } from './routes/versions.js';
import { attachBus } from './ws.js';

declare module 'fastify' {
  interface FastifyInstance {
    bus: Bus;
    store: DeckStore;
  }
}

export interface BuildAppOptions {
  deckDir: string;
  /** Owned by the caller: started before buildApp, stopped after app.close(). */
  thumbs: ThumbService;
  /** Injected by tests; otherwise a real SDK session is built on the deck's model. */
  agent?: AgentSession;
  /** Injected by tests: a fake runner, or null for no checks at all. Undefined builds the real CheckRunner. */
  checks?: ChecksRunner | null;
}

function defaultAgent(store: DeckStore, thumbs: ThumbService, bus: Bus, model: string, checks: ChecksRunner | null): AgentSession {
  const tools = makeDeckTools({
    store,
    thumbs,
    bus,
    imageGen: makeImageGen(join(store.dir, 'assets')),
    runCheck: async (name) => {
      if (!checks) throw new Error('checks are not available in this build');
      if (checks instanceof CheckRunner) checks.trigger(name);
      else void checks.run(name as Parameters<typeof checks.run>[0]);
    },
  });
  return new AgentSession({ store, tools, bus, model, deckDir: store.dir });
}

export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const store = await DeckStore.open(opts.deckDir);
  const bus = new Bus();
  const app = Fastify({ logger: { level: 'warn' } });
  app.decorate('bus', bus);
  app.decorate('store', store);

  await app.register(websocket);
  attachBus(app, bus);
  await app.register(fastifyStatic, { root: join(store.dir, 'assets'), prefix: '/assets/' });
  // Same font files the thumbnail renderer serves, so /api/present matches the thumbs offline.
  await app.register(fastifyStatic, { root: FONTS_DIR, prefix: '/fonts/', decorateReply: false });

  deckRoutes(app, store);
  slideRoutes(app, store, bus);
  versionRoutes(app, store);
  briefRoutes(app, store);
  thumbRoutes(app, store, opts.thumbs, bus);
  presentRoutes(app, store);
  laneRoutes(app, store, new LaneService(store, bus), opts.thumbs, bus);
  const model = (await store.state()).model;
  const checks = opts.checks === undefined ? new CheckRunner({ store, thumbs: opts.thumbs, bus, model }) : opts.checks;
  if (checks) app.decorate('checks', checks);
  if (checks instanceof CheckRunner) {
    bus.on('deck.changed', () => checks.scheduleAfterAccept());
    bus.on('lane.created', (e) => {
      if (e.type === 'lane.created') checks.scheduleAfterLane(e.laneId);
    });
    app.addHook('onClose', async () => checks.dispose());
  }
  const agent = opts.agent ?? defaultAgent(store, opts.thumbs, bus, model, checks);
  threadRoutes(app, store, agent);
  remarkRoutes(app, store, agent, bus);
  checkRoutes(app, bus);
  return app;
}
