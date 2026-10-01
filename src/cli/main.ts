import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { basename, dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { buildStudio } from '../server/app.js';
import { DECK_ID } from '../server/registry.js';
import { defaultHome } from './home.js';

const PORT = Number(process.env['DECKSTUDIO_PORT'] ?? 4177);

// Server paths the SPA fallback must not answer with index.html: their 404 is a real 404.
const SERVER_PATH = /^\/(?:api|fonts)\/|^\/d\/[^/]+\/(?:api\/|assets\/|ws(?:$|\?))/;

/** `deckstudio` serves the home folder; `deckstudio <deck-folder>` serves its parent and opens that deck. */
async function target(arg: string | undefined): Promise<{ home: string; path: string }> {
  if (!arg) return { home: await defaultHome(), path: '/' };
  const deckDir = resolve(arg);
  if (!existsSync(join(deckDir, 'deck.json'))) {
    console.error(`${deckDir} is not a deck folder (no deck.json). Run "deckstudio" alone to open the home screen.`);
    process.exit(2);
  }
  const id = basename(deckDir);
  if (!DECK_ID.test(id)) {
    console.error(`deck folder name "${id}" cannot be a deck id: letters, digits, "_" and "-" only`);
    process.exit(2);
  }
  return { home: dirname(deckDir), path: `/d/${id}/` };
}

async function main(): Promise<void> {
  const { home, path } = await target(process.argv[2]);
  const app = await buildStudio({ home });

  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
    // The SPA owns every other GET: / (home), /d/<id>/ and its screens.
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !SERVER_PATH.test(req.url)) return reply.sendFile('index.html', webDist);
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.log.warn(`no web build at ${webDist}; run "pnpm build" (API still served)`);
  }

  const shutdown = async (): Promise<void> => {
    await app.close();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: PORT, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${PORT}${path}`;
  console.log(`deckstudio: ${home}\n${url}`);
  if (process.env['DECKSTUDIO_NO_OPEN'] !== '1' && process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
