import { execFile } from 'node:child_process';
import { access, mkdir } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

const run = promisify(execFile);
const exists = (p: string): Promise<boolean> => access(p).then(() => true, () => false);

/** The style prefix every slide diagram shares (see ~/.claude/knowledge/_image-styles/100-keynote-flat-diagram.md). */
export const DIAGRAM_STYLE =
  'A flat, strictly frontal 2D illustration in a premium tech-keynote diagram style: no perspective, no isometric view, no hand-drawn wobble, no photo, no frame. Clean crisp vector-style shapes with soft matte fills, very subtle drop shadows under blocks, rounded corners, small flat monochrome icons, on a flat off-white background (#FAF9F6) filling the whole frame edge to edge. Palette strictly off-white, near-black ink (#17171A), one burnt-orange accent (#E4572E), light warm greys. Every text element, including sub-labels, captions, tags and badges, is set as large as the block labels; nothing small, nothing fine-print. No gradients anywhere, flat fills only. All labels in a clean geometric sans-serif, spelled exactly as given, no other text anywhere. Wide panoramic composition, generous margins. ';

export interface ImageGenOptions {
  /** Path of the generation script; default ~/.claude/scripts/generate_image.py, override with DECKSTUDIO_IMAGE_SCRIPT. */
  script?: string;
  /** Directory holding paperize3.py and trim.py (background flatten + crop). */
  postDir?: string;
  exec?: typeof run;
}

const SIZES: Record<string, string> = { wide: '1632x544', tall: '1632x688', half: '1280x720' };

/**
 * Generates a diagram image into <assetsDir>/<name>.png and returns the asset reference ("assets/<name>.png").
 * Fails with a clear message when the image script is not installed; never returns a placeholder.
 */
export function makeImageGen(assetsDir: string, opts: ImageGenOptions = {}): (prompt: string, size: string) => Promise<string> {
  const script = opts.script ?? process.env['DECKSTUDIO_IMAGE_SCRIPT'] ?? join(homedir(), '.claude', 'scripts', 'generate_image.py');
  const postDir = opts.postDir ?? resolve(dirname(fileURLToPath(import.meta.url)), '..', '..', 'scripts', 'img');
  const exec = opts.exec ?? run;
  return async (prompt, size) => {
    if (!(await exists(script))) throw new Error(`image generation unavailable: ${script} not found (set DECKSTUDIO_IMAGE_SCRIPT)`);
    const dims = SIZES[size] ?? size;
    if (!/^\d{2,4}x\d{2,4}$/.test(dims)) throw new Error(`unknown size "${size}": use wide, tall, half, or WIDTHxHEIGHT`);
    await mkdir(assetsDir, { recursive: true });
    const name = `gen-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}.png`;
    const out = join(assetsDir, name);
    await exec('python3', [script, DIAGRAM_STYLE + prompt, out, '--size', dims, '--allow-text', '--quality', 'high'], { timeout: 600_000 });
    if (!(await exists(out))) throw new Error('image generation produced no file');
    await exec('python3', [join(postDir, 'paperize3.py'), out], { timeout: 120_000 });
    await exec('python3', [join(postDir, 'trim.py'), out], { timeout: 120_000 });
    return `assets/${name}`;
  };
}
