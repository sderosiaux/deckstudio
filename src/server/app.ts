import fastifyStatic from '@fastify/static';
import websocket from '@fastify/websocket';
import Fastify, { type FastifyInstance, type FastifyReply, type FastifyRequest } from 'fastify';
import type { AgentSession } from '../agent/session.js';
import { FONTS_DIR } from '../render/theme.js';
import type { BrowserPool, ThumbService } from '../render/thumbs.js';
import { DeckStore } from '../store/deckStore.js';
import type { Bus } from './bus.js';
import { deckPlugin } from './deckPlugin.js';
import { createDeckServices, type DeckServicesOptions } from './deckServices.js';
import { CreateDeckSchema, DeckRegistry, ImportDeckSchema, RegistryError } from './registry.js';
import type { ChecksRunner } from './routes/checks.js';

declare module 'fastify' {
  interface FastifyInstance {
    /** Single-deck apps (buildApp) only. */
    bus: Bus;
    store: DeckStore;
    /** Studio apps (buildStudio) only. */
    registry: DeckRegistry;
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

const LOCAL_HOSTNAMES = new Set(['127.0.0.1', 'localhost']);

const hostnameOf = (hostHeader: string): string | null => {
  try {
    return new URL(`http://${hostHeader}`).hostname;
  } catch {
    return null;
  }
};

/**
 * The server only listens on 127.0.0.1, but a page on any site can still reach it from the browser
 * (DNS rebinding through Host, cross-site form posts or WebSockets through Origin). Both headers must
 * name this machine. Any port is accepted: the Vite dev proxy forwards its own Host (localhost:5173).
 */
export function isLocalRequest(host: string | undefined, origin: string | undefined): boolean {
  if (!host) return false;
  const h = hostnameOf(host);
  if (!h || !LOCAL_HOSTNAMES.has(h)) return false;
  if (origin === undefined) return true;
  try {
    return LOCAL_HOSTNAMES.has(new URL(origin).hostname);
  } catch {
    return false;
  }
}

/** Root wiring shared by both apps: the local-request guard, websockets, fonts and reply.sendFile. */
async function baseApp(): Promise<FastifyInstance> {
  const app = Fastify({ logger: { level: 'warn' } });
  // First hook on the root instance: it runs for every route, the /ws upgrades and the 404 handler.
  app.addHook('onRequest', async (req, reply) => {
    if (!isLocalRequest(req.headers.host, req.headers.origin)) return reply.code(403).send({ error: 'forbidden: not a local request' });
  });
  await app.register(websocket);
  // Same font files the thumbnail renderer serves, so present mode matches the thumbs offline. This registration
  // also decorates reply.sendFile, which deck assets and the SPA fallback use.
  await app.register(fastifyStatic, { root: FONTS_DIR, prefix: '/fonts/' });
  return app;
}

/** One deck served at the root (/api/..., /ws, /assets/...): the tests' app, and the shape of every /d/<id>/ mount. */
export async function buildApp(opts: BuildAppOptions): Promise<FastifyInstance> {
  const store = await DeckStore.open(opts.deckDir);
  const deck = await createDeckServices({
    store,
    thumbs: opts.thumbs,
    ownsThumbs: false,
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.checks !== undefined ? { checks: opts.checks } : {}),
  });
  const app = await baseApp();
  app.decorate('bus', deck.bus);
  app.decorate('store', store);
  app.addHook('onClose', async () => deck.dispose());
  await app.register(deckPlugin, { resolve: async () => deck, base: () => '' });
  return app;
}

export interface BuildStudioOptions {
  /** Folder holding one sub-folder per deck (created when missing). */
  home: string;
  /** Shared browser for thumbnails; the studio launches its own when absent. */
  pool?: BrowserPool;
  /** Tests: an agent factory per deck. Default: the real SDK session. */
  agent?: DeckServicesOptions['agent'];
  /** Tests: null turns checks off for every deck. */
  checks?: null;
}

const sendRegistryError = (err: unknown, reply: FastifyReply) => {
  if (err instanceof RegistryError) return reply.code(err.status).send({ error: err.message });
  throw err;
};

/**
 * Every deck of a home folder in one server: /api/decks lists and creates decks, each deck lives under
 * /d/<id>/ (same routes as buildApp). A deck added to the folder while the server runs is served on first request.
 */
export async function buildStudio(opts: BuildStudioOptions): Promise<FastifyInstance> {
  const registry = await DeckRegistry.open(opts.home, {
    ...(opts.pool ? { pool: opts.pool } : {}),
    ...(opts.agent ? { agent: opts.agent } : {}),
    ...(opts.checks === null ? { checks: null } : {}),
  });
  const app = await baseApp();
  app.decorate('registry', registry);
  app.addHook('onClose', async () => registry.close());

  app.get('/api/decks', async () => registry.list());

  app.get<{ Params: { id: string } }>('/api/decks/:id', async (req, reply) => {
    try {
      return await registry.summary(req.params.id);
    } catch (err) {
      return sendRegistryError(err, reply);
    }
  });

  app.post('/api/decks', async (req, reply) => {
    const body = CreateDeckSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `invalid deck: ${body.error.message}` });
    try {
      return reply.code(201).send(await registry.create(body.data));
    } catch (err) {
      return sendRegistryError(err, reply);
    }
  });

  app.post('/api/decks/import', async (req, reply) => {
    const body = ImportDeckSchema.safeParse(req.body);
    if (!body.success) return reply.code(400).send({ error: `invalid import: ${body.error.message}` });
    try {
      return reply.code(201).send(await registry.importHtml(body.data));
    } catch (err) {
      return sendRegistryError(err, reply);
    }
  });

  const deckId = (req: FastifyRequest): string => (req.params as { deckId?: string }).deckId ?? '';
  await app.register(deckPlugin, {
    prefix: '/d/:deckId',
    resolve: async (req) => ((await registry.has(deckId(req))) ? registry.services(deckId(req)) : null),
    base: (req) => `/d/${encodeURIComponent(deckId(req))}`,
  });
  return app;
}
