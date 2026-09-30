import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGRAM_STYLE, makeImageGen } from '../../src/agent/imageGen.js';

describe('makeImageGen', () => {
  it('fails clearly when the script is missing', async () => {
    const gen = makeImageGen(await mkdtemp(join(tmpdir(), 'ds-img-')), { script: '/nope/generate_image.py' });
    await expect(gen('a box', 'wide')).rejects.toThrow(/image generation unavailable/);
  });

  it('runs the script with the style prefix, size and post-processing, and returns the asset ref', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ds-img-'));
    const script = join(dir, 'gen.py');
    await writeFile(script, '');
    const calls: string[][] = [];
    const exec = (async (_cmd: string, args: readonly string[]) => {
      calls.push([...args]);
      if (args[0] === script) await writeFile(args[2]!, 'png');
      return { stdout: '', stderr: '' };
    }) as unknown as NonNullable<Parameters<typeof makeImageGen>[1]>['exec'];
    const gen = makeImageGen(join(dir, 'assets'), { script, postDir: '/post', exec });
    const ref = await gen('one black bar labeled exactly "the log"', 'wide');
    expect(ref).toMatch(/^assets\/gen-[a-z0-9-]+\.png$/);
    expect(calls[0]![1]!.startsWith(DIAGRAM_STYLE)).toBe(true);
    expect(calls[0]).toEqual(expect.arrayContaining(['--size', '1632x544', '--allow-text']));
    expect(calls[1]![0]).toBe('/post/paperize3.py');
    expect(calls[2]![0]).toBe('/post/trim.py');
  });

  it('rejects an unknown size word', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ds-img-'));
    const script = join(dir, 'gen.py');
    await writeFile(script, '');
    const gen = makeImageGen(join(dir, 'assets'), { script, exec: (async () => ({ stdout: '', stderr: '' })) as never });
    await expect(gen('x', 'giant')).rejects.toThrow(/unknown size/);
  });
});
