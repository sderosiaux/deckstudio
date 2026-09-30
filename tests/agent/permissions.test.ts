import { describe, expect, it } from 'vitest';
import { join } from 'node:path';
import { canUseTool, type CanUseTool } from '../../src/agent/permissions.js';

const deck = '/tmp/decks/demo';
const hook = canUseTool(deck);
const opts: Parameters<CanUseTool>[2] = { signal: new AbortController().signal, toolUseID: 't1', requestId: 'q1' };
const check = async (tool: string, input: Record<string, unknown>) => {
  const r = await hook(tool, input, opts);
  if (!r) throw new Error('canUseTool must always decide');
  return r;
};
const decide = async (tool: string, input: Record<string, unknown>) => (await check(tool, input)).behavior;

describe('canUseTool', () => {
  it('denies file writes inside the deck outside assets/', async () => {
    for (const tool of ['Write', 'Edit', 'MultiEdit']) {
      expect(await decide(tool, { file_path: join(deck, 'slides/x.json') }), tool).toBe('deny');
    }
    expect(await decide('Write', { file_path: join(deck, 'deck.json') })).toBe('deny');
    expect(await decide('Write', { file_path: join(deck, 'assets/../slides/x.json') })).toBe('deny');
    expect(await decide('Write', { file_path: 'slides/x.json' })).toBe('deny'); // relative to the session cwd = deck
    expect(await decide('NotebookEdit', { notebook_path: join(deck, 'n.ipynb') })).toBe('deny');
  });

  it('allows file writes under assets/ and outside the deck', async () => {
    expect(await decide('Write', { file_path: join(deck, 'assets/a.png') })).toBe('allow');
    expect(await decide('Edit', { file_path: join(deck, 'assets/sub/b.svg') })).toBe('allow');
    expect(await decide('Write', { file_path: '/tmp/decks/demo-other/x.json' })).toBe('allow');
    expect(await decide('Write', { file_path: '/tmp/scratch.txt' })).toBe('allow');
  });

  it('allows read-only tools and deck MCP tools anywhere', async () => {
    expect(await decide('Read', { file_path: join(deck, 'slides/x.json') })).toBe('allow');
    for (const tool of ['Glob', 'Grep', 'LS', 'WebFetch', 'WebSearch', 'mcp__deck__propose_lane']) {
      expect(await decide(tool, { path: deck }), tool).toBe('allow');
    }
  });

  it('returns the input unchanged on allow and a message on deny', async () => {
    const input = { file_path: join(deck, 'assets/a.png'), content: 'x' };
    expect(await check('Write', input)).toEqual({ behavior: 'allow', updatedInput: input });
    const d = await check('Write', { file_path: join(deck, 'slides/x.json') });
    expect(d.behavior).toBe('deny');
    if (d.behavior === 'deny') expect(d.message).toMatch(/propose_lane/);
    const b = await check('Bash', { command: `rm ${deck}/deck.json` });
    if (b.behavior !== 'deny') throw new Error('expected deny');
    expect(b.message).toContain(`${deck}/deck.json`);
  });

  it.each([
    `rm -rf ${deck}/slides`,
    'rm -rf slides',
    `rm -rf ${deck}`,
    'rm -rf /tmp/decks',
    `mv ${deck}/slides/a.json /tmp/a.json`,
    `cp /tmp/a.json ${deck}/slides/a.json`,
    `echo x > ${deck}/deck.json`,
    `echo x >> ${deck}/remarks.json`,
    `echo x>${deck}/deck.json`,
    `echo x | tee ${deck}/brief.json`,
    `sed -i '' 's/a/b/' ${deck}/slides/a.json`,
    `truncate -s 0 ${deck}/deck.json`,
    `sed -E -i 's/a/b/' ${deck}/slides/a.json`,
    `perl -pi -e 's/a/b/' ${deck}/slides/a.json`,
    `dd if=/dev/zero of=${deck}/deck.json bs=1 count=1`,
    `git checkout -- ${deck}/slides`,
    `git reset HEAD ${deck}/deck.json`,
    `cd ${deck} && rm deck.json`,
    `ls && rm "${deck}/lanes/l1.json"`,
    `find ${deck}/versions -name '*.json' -delete`,
  ])('denies Bash: %s', async (command) => {
    expect(await decide('Bash', { command })).toBe('deny');
  });

  it.each([
    `ls ${deck}/slides`,
    `cat ${deck}/deck.json | jq .`,
    `grep -r claim ${deck}/slides`,
    `cp /tmp/gen.png ${deck}/assets/gen.png`,
    `cp ${deck}/slides/a.json /tmp/a.json`,
    `mv /tmp/gen.png ${deck}/assets/`,
    `rm ${deck}/assets/old.png`,
    `echo x > /tmp/out.txt`,
    `sed -i '' 's/a/b/' /tmp/x.txt`,
    `sed -E 's/a/b/' ${deck}/slides/a.json`,
    `cd /tmp && rm -rf build`,
    `curl -o ${deck}/assets/img.png https://example.com/i.png`,
    'git status',
    `echo "${deck}/slides" 2>&1`,
  ])('allows Bash: %s', async (command) => {
    expect(await decide('Bash', { command })).toBe('allow');
  });
});
