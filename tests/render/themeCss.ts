import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const deckHtml = readFileSync(fileURLToPath(new URL('../fixtures/deck-3.html', import.meta.url)), 'utf8');
const m = /<style>([\s\S]*?)<\/style>/.exec(deckHtml);
if (!m?.[1]) throw new Error('deck-3.html: no <style> block');
export const themeCss: string = m[1];
export const assetsDir: string = fileURLToPath(new URL('../fixtures/assets', import.meta.url));
