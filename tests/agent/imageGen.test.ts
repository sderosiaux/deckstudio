import { mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { DIAGRAM_STYLE, imageStyleFor, makeImageGen } from '../../src/agent/imageGen.js';
import type { Brief } from '../../src/model/types.js';

describe('makeImageGen', () => {
  it('fails clearly when the script is missing', async () => {
    const gen = makeImageGen(await mkdtemp(join(tmpdir(), 'ds-img-')), { script: '/nope/generate_image.py' });
    await expect(gen('a box', 'wide', DIAGRAM_STYLE)).rejects.toThrow(/image generation unavailable/);
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
    const ref = await gen('one black bar labeled exactly "the log"', 'wide', DIAGRAM_STYLE);
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
    await expect(gen('x', 'giant', DIAGRAM_STYLE)).rejects.toThrow(/unknown size/);
  });

  it('prefixes the prompt with the style it is given, one space between them', async () => {
    const dir = await mkdtemp(join(tmpdir(), 'ds-img-'));
    const script = join(dir, 'gen.py');
    await writeFile(script, '');
    const prompts: string[] = [];
    const exec = (async (_cmd: string, args: readonly string[]) => {
      if (args[0] === script) {
        prompts.push(args[1]!);
        await writeFile(args[2]!, 'png');
      }
      return { stdout: '', stderr: '' };
    }) as unknown as NonNullable<Parameters<typeof makeImageGen>[1]>['exec'];
    await makeImageGen(join(dir, 'assets'), { script, postDir: '/post', exec })('a bar', 'half', 'Ink sketch.  ');
    expect(prompts).toEqual(['Ink sketch. a bar']);
  });

  it('imageStyleFor: the brief image style when set, else the built-in style', () => {
    const b = (imageStyle: string): Brief => ({ title: 't', audience: 'a', message: 'm', pattern: 'solution-first', abstract: '', design: { rules: '', imageStyle } });
    expect(imageStyleFor(b('Ink sketch.'))).toBe('Ink sketch.');
    expect(imageStyleFor(b(' \n'))).toBe(DIAGRAM_STYLE);
  });
});
