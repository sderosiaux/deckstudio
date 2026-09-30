import { join } from 'node:path';
import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance } from 'fastify';
import type { ThumbService } from '../render/thumbs.js';
import { DeckStore } from '../store/deckStore.js';
import { Bus } from './bus.js';
import { LaneService } from './laneService.js';
import { briefRoutes } from './routes/brief.js';
import { deckRoutes } from './routes/deck.js';
import { laneRoutes } from './routes/lanes.js';
import { presentRoutes } from './routes/present.js';
import { slideRoutes } from './routes/slides.js';
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

  deckRoutes(app, store);
  slideRoutes(app, store, bus);
  versionRoutes(app, store);
  briefRoutes(app, store);
  thumbRoutes(app, store, opts.thumbs, bus);
  presentRoutes(app, store);
  laneRoutes(app, store, new LaneService(store, bus), opts.thumbs, bus);
  return app;
}
