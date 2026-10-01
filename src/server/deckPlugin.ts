import { access } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import { deckOf } from './deckRequest.js';
import type { DeckServices } from './deckServices.js';
import { briefRoutes } from './routes/brief.js';
import { checkRoutes } from './routes/checks.js';
import { deckRoutes } from './routes/deck.js';
import { historyRoutes } from './routes/history.js';
import { laneRoutes } from './routes/lanes.js';
import { presentRoutes } from './routes/present.js';
import { remarkRoutes } from './routes/remarks.js';
import { slideRoutes } from './routes/slides.js';
import { threadRoutes } from './routes/threads.js';
import { thumbRoutes } from './routes/thumbs.js';
import { versionRoutes } from './routes/versions.js';
import { attachBus } from './ws.js';

export interface DeckPluginOptions {
  /** The deck a request addresses, or null for an unknown deck (answered 404). Async: a deck opens lazily. */
  resolve: (req: FastifyRequest) => Promise<DeckServices | null>;
  /** URL path the plugin is mounted under, for links the server writes into pages (present mode). */
  base: (req: FastifyRequest) => string;
}

// A slide asset is a single file of the deck's assets folder.
const ASSET_FILE = /^[A-Za-z0-9._-]+$/;
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

export { deckOf };

/**
 * Every per-deck route (API, /ws, /assets/*). Handlers read their services from req.deck, never from a closure,
 * so one registration serves any number of decks, including decks created after startup.
 * Needs @fastify/websocket and @fastify/static (with reply.sendFile) registered on an ancestor.
 */
export async function deckPlugin(app: FastifyInstance, opts: DeckPluginOptions): Promise<void> {
  app.decorateRequest('deck', null);
  app.decorateRequest('deckBase', '');
  app.addHook('onRequest', async (req, reply) => {
    const deck = await opts.resolve(req);
    if (!deck) return reply.code(404).send({ error: 'unknown deck' });
    req.deck = deck;
    req.deckBase = opts.base(req);
  });

  // Not a static root: the folder depends on the deck. Flat names only, so nothing escapes assets/.
  app.get<{ Params: { '*': string } }>('/assets/*', async (req, reply) => {
    const name = req.params['*'];
    const dir = join(deckOf(req).store.dir, 'assets');
    if (!ASSET_FILE.test(name) || name === '.' || name === '..' || !(await exists(join(dir, name)))) {
      return reply.code(404).send({ error: 'asset not found' });
    }
    return reply.sendFile(name, dir);
  });

  attachBus(app);
  deckRoutes(app);
  slideRoutes(app);
  versionRoutes(app);
  briefRoutes(app);
  thumbRoutes(app);
  presentRoutes(app);
  laneRoutes(app);
  historyRoutes(app);
  threadRoutes(app);
  remarkRoutes(app);
  checkRoutes(app);
}
