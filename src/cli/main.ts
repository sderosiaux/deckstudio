import { existsSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import fastifyStatic from '@fastify/static';
import { loadThemeCss } from '../render/defaultTheme.js';
import { ThumbService } from '../render/thumbs.js';
import { buildApp } from '../server/app.js';

const PORT = Number(process.env['DECKSTUDIO_PORT'] ?? 4177);

async function main(): Promise<void> {
  const arg = process.argv[2];
  if (!arg) {
    console.error('usage: deckstudio <deck-folder>');
    process.exit(2);
  }
  const deckDir = resolve(arg);
  if (!existsSync(join(deckDir, 'deck.json'))) {
    console.error(`${deckDir} is not a deck folder (no deck.json). Import one with: pnpm import:sf`);
    process.exit(2);
  }
  const themeCss = await loadThemeCss(deckDir);
  const thumbs = new ThumbService({ cacheDir: join(deckDir, 'cache'), themeCss, assetsDir: join(deckDir, 'assets') });
  await thumbs.start();
  const app = await buildApp({ deckDir, thumbs });

  const webDist = resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'dist', 'web');
  if (existsSync(join(webDist, 'index.html'))) {
    await app.register(fastifyStatic, { root: webDist, prefix: '/', decorateReply: false });
    app.setNotFoundHandler((req, reply) => {
      if (req.method === 'GET' && !req.url.startsWith('/api/') && !req.url.startsWith('/assets/')) return reply.sendFile('index.html', webDist);
      return reply.code(404).send({ error: 'not found' });
    });
  } else {
    app.log.warn(`no web build at ${webDist}; run "pnpm build" (API still served)`);
  }

  const shutdown = async (): Promise<void> => {
    await app.close();
    await thumbs.stop();
    process.exit(0);
  };
  process.on('SIGINT', () => void shutdown());
  process.on('SIGTERM', () => void shutdown());

  await app.listen({ port: PORT, host: '127.0.0.1' });
  const url = `http://127.0.0.1:${PORT}/`;
  console.log(`deckstudio: ${deckDir}\n${url}`);
  if (process.env['DECKSTUDIO_NO_OPEN'] !== '1' && process.platform === 'darwin') spawn('open', [url], { stdio: 'ignore', detached: true }).unref();
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
