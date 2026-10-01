import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';

const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

/**
 * The folder holding the decks: DECKSTUDIO_HOME, else ./decks when it exists (running from the repo),
 * else ~/deckstudio/decks. Created when missing.
 */
export async function defaultHome(env: NodeJS.ProcessEnv = process.env, cwd: string = process.cwd()): Promise<string> {
  const fromEnv = env['DECKSTUDIO_HOME'];
  const local = join(cwd, 'decks');
  const home = fromEnv ? resolve(cwd, fromEnv) : (await exists(local)) ? local : join(homedir(), 'deckstudio', 'decks');
  await mkdir(home, { recursive: true });
  return home;
}
