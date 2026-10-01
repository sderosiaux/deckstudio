import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { newId } from '../model/ids.js';
import { imageStyleFor, type ImageGen } from './imageGen.js';
import { applyChange, validateBody } from '../model/ops.js';
import {
  AddRemarkInputSchema,
  ProposeLaneInputSchema,
  ReviseLaneInputSchema,
  SlideKindSchema,
  type NewChange,
} from '../model/schema.js';
import type { Anchor, Change, Lane, Origin, Remark, Snapshot } from '../model/types.js';
import { loadThemeCss } from '../render/defaultTheme.js';
import { assembleSlideHtml } from '../render/theme.js';
import { ThumbService } from '../render/thumbs.js';
import type { Bus } from '../server/bus.js';
import type { DeckStore } from '../store/deckStore.js';

export interface DeckToolContext {
  store: DeckStore;
  thumbs: ThumbService;
  bus: Bus;
  /** Called with the brief's image style (imageStyleFor): the model only describes the content. */
  imageGen: ImageGen;
  runCheck: (name: string) => Promise<void>;
}

export const GetSlideInputSchema = z.object({ id: z.string().min(1) });
export const RenderSlideInputSchema = z.object({ title: z.string(), body: z.string(), kind: SlideKindSchema });
export const GenerateImageInputSchema = z.object({ prompt: z.string().min(1), size: z.string().min(1) });
export const RunCheckInputSchema = z.object({ name: z.string().min(1) });
export const LinkRemarkLaneInputSchema = z.object({ remarkId: z.string().min(1), laneId: z.string().min(1) });

export interface Invalid {
  index: number;
  reason: string;
}
export interface ToolError {
  error: string;
  invalid?: Invalid[];
}

export const GENERATE_IMAGE_DESCRIPTION =
  'Generate an image (e.g. a diagram) from a prompt; size wide, tall, half, or WIDTHxHEIGHT like "1536x1024". ' +
  'The image style of the brief is applied automatically as a prefix of your prompt: describe only the content (the shapes, their labels spelled exactly, how they connect), never the style, palette or rendering. ' +
  'Returns the asset path to use in a slide body.';

type Handler = (args: unknown) => Promise<object>;
export type DeckToolName =
  | 'get_deck'
  | 'get_slide'
  | 'render_slide'
  | 'propose_lane'
  | 'revise_lane'
  | 'add_remark'
  | 'generate_image'
  | 'run_check'
  | 'link_remark_lane';
export type DeckToolHandlers = Record<DeckToolName, Handler>;

// ---------------------------------------------------------------------------
// Validation helpers

function parse<T>(schema: z.ZodType<T>, args: unknown): { ok: true; value: T } | { ok: false; err: ToolError } {
  const r = schema.safeParse(args);
  if (r.success) return { ok: true, value: r.data };
  const invalid: Invalid[] = [];
  const lines: string[] = [];
  for (const issue of r.error.issues) {
    const where = issue.path.map(String).join('.') || '(input)';
    lines.push(`${where}: ${issue.message}`);
    const [head, idx] = issue.path;
    if ((head === 'changes' || head === 'replaceChanges') && typeof idx === 'number') {
      invalid.push({ index: idx, reason: `${issue.path.slice(2).map(String).join('.') || 'change'}: ${issue.message}` });
    }
  }
  return { ok: false, err: { error: `Invalid input; nothing was saved. ${lines.join('; ')}`, invalid } };
}

const has = (snap: Snapshot, id: string): boolean => Object.hasOwn(snap.slides, id) && snap.order.includes(id);

function anchorProblem(snap: Snapshot, anchor: Anchor): string | null {
  const missing = anchor.kind === 'slide' ? [anchor.slide] : anchor.kind === 'range' ? [anchor.from, anchor.to] : [];
  const unknown = missing.filter((id) => !has(snap, id));
  return unknown.length ? `anchor references unknown slide id(s): ${unknown.join(', ')}. Call get_deck for the current ids.` : null;
}

function refProblems(snap: Snapshot, c: NewChange): string[] {
  const reasons: string[] = [];
  const ref = (id: string | null, role: string) => {
    if (id !== null && !has(snap, id)) reasons.push(`${role} slide "${id}" does not exist in the current deck`);
  };
  switch (c.kind) {
    case 'insert': {
      ref(c.after, 'after');
      const v = validateBody(c.slide.body);
      if (!v.ok) reasons.push(...v.reasons);
      break;
    }
    case 'modify': {
      ref(c.slide, 'target');
      if (c.patch.body !== undefined) {
        const v = validateBody(c.patch.body);
        if (!v.ok) reasons.push(...v.reasons);
      }
      if (Object.keys(c.patch).length === 0) reasons.push('patch is empty');
      break;
    }
    case 'remove':
      ref(c.slide, 'target');
      break;
    case 'move':
      ref(c.slide, 'target');
      ref(c.after, 'after');
      if (c.after === c.slide) reasons.push('a slide cannot move after itself');
      break;
  }
  return reasons;
}

/** Gives ids and a pending status to AI-proposed changes. */
function materialize(c: NewChange): Change {
  const base = { id: newId('c'), status: 'pending' as const, reason: c.reason };
  switch (c.kind) {
    case 'insert':
      return { ...base, kind: 'insert', after: c.after, slide: { id: newId('s'), ...c.slide } };
    case 'modify':
      return { ...base, kind: 'modify', slide: c.slide, patch: c.patch };
    case 'remove':
      return { ...base, kind: 'remove', slide: c.slide };
    case 'move':
      return { ...base, kind: 'move', slide: c.slide, after: c.after };
  }
}

/**
 * Checks each change against the current deck, then replays them in order so a lane that
 * contradicts itself (remove s3, then modify s3) is caught before the creator sees it.
 */
function checkChanges(snap: Snapshot, input: NewChange[]): { changes: Change[]; invalid: Invalid[] } {
  const changes = input.map(materialize);
  const invalid: Invalid[] = [];
  let sim = snap;
  input.forEach((c, index) => {
    const reasons = refProblems(snap, c);
    if (reasons.length) {
      invalid.push({ index, reason: reasons.join('; ') });
      return;
    }
    const r = applyChange(sim, changes[index]!);
    if (r.ok) sim = r.next;
    else invalid.push({ index, reason: `conflicts with an earlier change in this lane: ${r.error}` });
  });
  return { changes, invalid };
}

function summarize(c: Change): string {
  switch (c.kind) {
    case 'insert':
      return `insert "${c.slide.title}" ${c.after ? `after ${c.after}` : 'at the start'}`;
    case 'modify':
      return `modify ${c.slide} (${Object.keys(c.patch).join(', ')})`;
    case 'remove':
      return `remove ${c.slide}`;
    case 'move':
      return `move ${c.slide} ${c.after ? `after ${c.after}` : 'to the start'}`;
  }
}

const rejected = (invalid: Invalid[]): ToolError => ({
  error: `Rejected: ${invalid.length} change(s) invalid; nothing was saved. Fix the listed changes (index is 0-based in the changes array) and call again.`,
  invalid,
});

// ---------------------------------------------------------------------------

/**
 * Validates a propose_lane input against the current deck and saves it as one lane, with the given origin
 * and status, in a single write: the co-author opens user lanes, a check saves drafts under its own origin.
 */
export async function createLane(
  ctx: Pick<DeckToolContext, 'store' | 'bus'>,
  args: unknown,
  as: { origin: Origin; status: 'draft' | 'open' },
): Promise<object> {
  const { store, bus } = ctx;
  const p = parse(ProposeLaneInputSchema, args);
  if (!p.ok) return p.err;
  const input = p.value;
  return store.withLock(async () => {
    const [state, snap] = await Promise.all([store.state(), store.snapshot()]);
    const anchorErr = anchorProblem(snap, input.anchor);
    if (anchorErr) return { error: `Rejected; nothing was saved: ${anchorErr}`, invalid: [] };
    const { changes, invalid } = checkChanges(snap, input.changes);
    if (invalid.length) return rejected(invalid);
    const lane: Lane = {
      id: newId('l'),
      label: input.label,
      anchor: input.anchor,
      origin: as.origin,
      baseVersion: state.version,
      changes,
      status: as.status,
      createdAt: new Date().toISOString(),
    };
    await store.putLane(lane);
    bus.emit({ type: 'lane.created', laneId: lane.id });
    return { laneId: lane.id, changes: changes.map((c) => ({ id: c.id, summary: summarize(c) })) };
  });
}

export function makeDeckToolHandlers(ctx: DeckToolContext): DeckToolHandlers {
  const { store, bus } = ctx;

  return {
    async get_deck() {
      const [state, brief, snap] = await Promise.all([store.state(), store.brief(), store.snapshot()]);
      return {
        name: state.name,
        version: state.version,
        brief,
        slides: snap.order.map((id, i) => {
          const s = snap.slides[id]!;
          return { index: i + 1, id, title: s.title, kind: s.kind, story: s.story };
        }),
      };
    },

    async get_slide(args) {
      const p = parse(GetSlideInputSchema, args);
      if (!p.ok) return p.err;
      const s = await store.slide(p.value.id);
      return s ?? { error: `slide "${p.value.id}" does not exist. Call get_deck for the current ids.` };
    },

    async render_slide(args) {
      const p = parse(RenderSlideInputSchema, args);
      if (!p.ok) return p.err;
      const { title, body, kind } = p.value;
      const html = assembleSlideHtml({ title, body, kind }, { themeCss: await loadThemeCss(store.dir), assetsBaseUrl: ThumbService.assetsBaseUrl });
      const png = await ctx.thumbs.render(html);
      const dir = join(store.dir, 'cache', 'renders');
      await mkdir(dir, { recursive: true });
      const png_path = join(dir, `${createHash('sha256').update(html).digest('hex')}.png`);
      const tmp = `${png_path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, png);
      await rename(tmp, png_path);
      const v = validateBody(body);
      return { png_path, warnings: v.ok ? [] : v.reasons };
    },

    async propose_lane(args) {
      return createLane(ctx, args, { origin: 'user', status: 'open' });
    },

    async revise_lane(args) {
      const p = parse(ReviseLaneInputSchema, args);
      if (!p.ok) return p.err;
      const { laneId, replaceChanges } = p.value;
      return store.withLock(async () => {
        const lane = await store.lane(laneId);
        if (!lane) return { error: `lane "${laneId}" does not exist.` };
        // A draft (proposed by a check) can be revised too; it stays a draft until the creator opens it.
        if (lane.status === 'closed') return { error: `lane "${laneId}" is closed; call propose_lane for a new proposal.` };
        const [state, snap] = await Promise.all([store.state(), store.snapshot()]);
        const { changes, invalid } = checkChanges(snap, replaceChanges);
        if (invalid.length) return rejected(invalid);
        // Decisions the creator already made stay; pending (and orphaned) proposals are superseded.
        const kept = lane.changes.filter((c) => c.status === 'accepted' || c.status === 'refused');
        // New changes were validated against the current main, so the lane now bases on it.
        const next: Lane = { ...lane, baseVersion: state.version, changes: [...kept, ...changes] };
        await store.putLane(next);
        bus.emit({ type: 'lane.updated', laneId });
        return { laneId, changes: changes.map((c) => ({ id: c.id, summary: summarize(c) })) };
      });
    },

    async add_remark(args) {
      const p = parse(AddRemarkInputSchema, args);
      if (!p.ok) return p.err;
      const { anchor, text, severity } = p.value;
      return store.withLock(async () => {
        const anchorErr = anchorProblem(await store.snapshot(), anchor);
        if (anchorErr) return { error: `Rejected; nothing was saved: ${anchorErr}` };
        const remark: Remark = {
          id: newId('r'),
          anchor,
          text,
          origin: 'user',
          severity,
          status: 'open',
          laneId: null,
          createdAt: new Date().toISOString(),
        };
        await store.putRemarks([...(await store.remarks()), remark]);
        bus.emit({ type: 'remarks.changed' });
        return { remarkId: remark.id };
      });
    },

    async link_remark_lane(args) {
      const p = parse(LinkRemarkLaneInputSchema, args);
      if (!p.ok) return p.err;
      const { remarkId, laneId } = p.value;
      return store.withLock(async () => {
        const remarks = await store.remarks();
        if (!remarks.some((r) => r.id === remarkId)) return { error: `remark "${remarkId}" does not exist.` };
        if (!(await store.lane(laneId))) return { error: `lane "${laneId}" does not exist.` };
        await store.putRemarks(remarks.map((r) => (r.id === remarkId ? { ...r, laneId } : r)));
        bus.emit({ type: 'remarks.changed' });
        return { remarkId, laneId };
      });
    },

    async generate_image(args) {
      const p = parse(GenerateImageInputSchema, args);
      if (!p.ok) return p.err;
      // Read per call: an image style saved in the brief applies to the next image.
      const style = imageStyleFor(await store.brief());
      return { asset: await ctx.imageGen(p.value.prompt, p.value.size, style) };
    },

    async run_check(args) {
      const p = parse(RunCheckInputSchema, args);
      if (!p.ok) return p.err;
      await ctx.runCheck(p.value.name);
      return { started: true };
    },
  };
}

// ---------------------------------------------------------------------------

function wrap(h: Handler) {
  return async (args: unknown) => {
    try {
      const r = await h(args);
      return { content: [{ type: 'text' as const, text: JSON.stringify(r) }], isError: 'error' in r };
    } catch (e) {
      return { content: [{ type: 'text' as const, text: JSON.stringify({ error: e instanceof Error ? e.message : String(e) }) }], isError: true };
    }
  };
}

export function makeDeckTools(ctx: DeckToolContext): { server: McpSdkServerConfigWithInstance; allowedTools: string[] } {
  const h = makeDeckToolHandlers(ctx);
  const server = createSdkMcpServer({
    name: 'deck',
    version: '1.0.0',
    tools: [
      tool('get_deck', 'Brief, current version, and the outline of the deck: 1-based index, id, title, kind, story per slide.', {}, wrap(h.get_deck)),
      tool('get_slide', 'Full content of one slide by id (title, story, notes, body HTML, assets, kind).', GetSlideInputSchema.shape, wrap(h.get_slide)),
      tool(
        'render_slide',
        'Render a candidate slide (title, body HTML fragment, kind) on the 1280x720 stage. Returns png_path (Read it to see the slide) and composition warnings. Use it before proposing a slide.',
        RenderSlideInputSchema.shape,
        wrap(h.render_slide),
      ),
      tool(
        'propose_lane',
        'Propose a lane: a labelled, coherent set of changes (insert/modify/remove/move) anchored on a slide, a range, or the arc, with a one-line reason per change. Slide ids must exist; insert.after/move.after may be null for "first". Invalid input is rejected with the offending change indexes and nothing is saved.',
        ProposeLaneInputSchema.shape,
        wrap(h.propose_lane),
      ),
      tool(
        'revise_lane',
        'Replace the pending changes of an open lane (accepted and refused changes are kept). Use when asked to modify an existing lane.',
        ReviseLaneInputSchema.shape,
        wrap(h.revise_lane),
      ),
      tool('add_remark', 'Attach a remark (info or warn) to a slide, a range, or the arc.', AddRemarkInputSchema.shape, wrap(h.add_remark)),
      tool('link_remark_lane', 'Record that a lane answers a remark.', LinkRemarkLaneInputSchema.shape, wrap(h.link_remark_lane)),
      tool(
        'generate_image',
        GENERATE_IMAGE_DESCRIPTION,
        GenerateImageInputSchema.shape,
        wrap(h.generate_image),
      ),
      tool('run_check', 'Start a background check on the deck by name (arc, order, gaps, render). Results arrive as remarks.', RunCheckInputSchema.shape, wrap(h.run_check)),
    ],
  });
  return { server, allowedTools: ['mcp__deck__*'] };
}
