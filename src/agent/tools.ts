import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { newId } from '../model/ids.js';
import { imageStyleFor, type ImageGen } from './imageGen.js';
import { applyChange, validateBody } from '../model/ops.js';
import { AddRemarkInputSchema, NewChangeSchema, ProposeLaneInputSchema, SlideKindSchema, type NewChange } from '../model/schema.js';
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

const changeId = { id: z.string().min(1).optional().describe('id of the lane change this one revises; omit to match by kind and target slide') };
const [insertIn, modifyIn, removeIn, moveIn] = NewChangeSchema.options;
/** A NewChange that may name the lane change it revises. */
export const RevisedChangeSchema = z.discriminatedUnion('kind', [insertIn.extend(changeId), modifyIn.extend(changeId), removeIn.extend(changeId), moveIn.extend(changeId)]);
export type RevisedChange = z.infer<typeof RevisedChangeSchema>;
export const ReviseLaneInputSchema = z.object({
  laneId: z.string().min(1),
  changes: z.array(RevisedChangeSchema).min(1),
  keep: z.boolean().optional().describe('default true: pending changes you do not mention stay as they are, with their ids'),
  replace: z.boolean().optional().describe('true: pending changes you do not mention are discarded'),
});

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
export const DECK_TOOL_NAMES = [
  'get_deck',
  'get_slide',
  'render_slide',
  'propose_lane',
  'revise_lane',
  'add_remark',
  'generate_image',
  'run_check',
  'link_remark_lane',
] as const;
export type DeckToolName = (typeof DECK_TOOL_NAMES)[number];
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

/** The slide a change is about: what a revision without an id is matched on, with its kind. */
function targetOf(c: NewChange | Change): string | null {
  return c.kind === 'insert' ? c.after : c.slide;
}

interface RevisionPlan {
  changes: Change[];
  /** changes[i] came from input[sourceIndex[i]]; -1 for a change kept as it was. */
  sourceIndex: number[];
  kept: string[];
  updated: string[];
  added: string[];
  dropped: string[];
  invalid: Invalid[];
}

/** The revised version of an existing change: same id (and inserted slide id), new content, pending again. */
function revised(old: Change, c: NewChange): Change {
  const base = { id: old.id, status: 'pending' as const, reason: c.reason };
  if (c.kind === 'modify' && old.kind === 'modify') return { ...base, kind: 'modify', slide: c.slide, patch: { ...old.patch, ...c.patch } };
  if (c.kind === 'insert' && old.kind === 'insert') return { ...base, kind: 'insert', after: c.after, slide: { id: old.slide.id, ...stripId(c.slide) } };
  return { ...materialize(c), id: old.id };
}
const stripId = <T extends object>(o: T): Omit<T, 'id'> => {
  const { id: _id, ...rest } = o as T & { id?: unknown };
  return rest;
};

/**
 * Merges a revision into a lane. Decided changes (accepted, refused) always stay. Each input change revises the
 * pending (or orphan) change it names by id, else the first one of the same kind on the same target, else it is new.
 * Unmentioned pending changes stay with their ids, unless `replace` drops them.
 */
function planRevision(lane: Lane, input: RevisedChange[], replace: boolean): RevisionPlan {
  const open = lane.changes.filter((c) => c.status === 'pending' || c.status === 'orphan');
  const invalid: Invalid[] = [];
  const matched = new Map<string, number>();
  input.forEach((c, index) => {
    if (c.id !== undefined) {
      const old = lane.changes.find((x) => x.id === c.id);
      if (!old) invalid.push({ index, reason: `change "${c.id}" is not in this lane` });
      else if (old.status === 'accepted' || old.status === 'refused') invalid.push({ index, reason: `change "${c.id}" is already ${old.status}; it cannot be revised` });
      else if (old.kind !== c.kind) invalid.push({ index, reason: `change "${c.id}" is a ${old.kind}, not a ${c.kind}` });
      else if (matched.has(old.id)) invalid.push({ index, reason: `change "${c.id}" is revised twice` });
      else matched.set(old.id, index);
      return;
    }
    const old = open.find((x) => !matched.has(x.id) && x.kind === c.kind && targetOf(x) === targetOf(c));
    if (old) matched.set(old.id, index);
  });
  const empty = { changes: [], sourceIndex: [], kept: [], updated: [], added: [], dropped: [] };
  if (invalid.length) return { ...empty, invalid };

  const changes: Change[] = [];
  const sourceIndex: number[] = [];
  const kept: string[] = [];
  const updated: string[] = [];
  const dropped: string[] = [];
  for (const c of lane.changes) {
    const index = matched.get(c.id);
    if (index !== undefined) {
      changes.push(revised(c, stripId(input[index]!) as NewChange));
      sourceIndex.push(index);
      updated.push(c.id);
    } else if (c.status === 'accepted' || c.status === 'refused') {
      changes.push(c);
      sourceIndex.push(-1);
    } else if (replace) {
      dropped.push(c.id);
    } else {
      changes.push(c);
      sourceIndex.push(-1);
      kept.push(c.id);
    }
  }
  const used = new Set(matched.values());
  const added: string[] = [];
  input.forEach((c, index) => {
    if (used.has(index)) return;
    const fresh = materialize(stripId(c) as NewChange);
    changes.push(fresh);
    sourceIndex.push(index);
    added.push(fresh.id);
  });
  return { changes, sourceIndex, kept, updated, added, dropped, invalid };
}

/**
 * Replays the pending changes on `snap` in lane order. A failing change that came from the input is reported at its
 * input index; a kept change that no longer applies is left to the rebase (it shows as skipped, as before).
 */
function replay(snap: Snapshot, changes: Change[], sourceIndex: number[]): Invalid[] {
  const invalid: Invalid[] = [];
  let sim = snap;
  changes.forEach((c, i) => {
    if (c.status !== 'pending') return;
    const r = applyChange(sim, c);
    if (r.ok) sim = r.next;
    else if (sourceIndex[i]! >= 0) invalid.push({ index: sourceIndex[i]!, reason: `conflicts with another change in this lane: ${r.error}` });
  });
  return invalid;
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
      const { laneId, changes: input, replace } = p.value;
      return store.withLock(async () => {
        const lane = await store.lane(laneId);
        if (!lane) return { error: `lane "${laneId}" does not exist.` };
        // A draft (proposed by a check) can be revised too; it stays a draft until the creator opens it.
        if (lane.status === 'closed') return { error: `lane "${laneId}" is closed; call propose_lane for a new proposal.` };
        const [state, snap] = await Promise.all([store.state(), store.snapshot()]);
        const plan = planRevision(lane, input, replace === true);
        if (plan.invalid.length) return rejected(plan.invalid);
        const refs = input.flatMap((c, index) => {
          const reasons = refProblems(snap, c);
          return reasons.length ? [{ index, reason: reasons.join('; ') }] : [];
        });
        if (refs.length) return rejected(refs);
        // The pending changes replay in lane order on current main, so a revision that contradicts a kept change is caught.
        const conflicts = replay(snap, plan.changes, plan.sourceIndex);
        if (conflicts.length) return rejected(conflicts);
        // Validated against the current main, so the lane now bases on it.
        const next: Lane = { ...lane, baseVersion: state.version, changes: plan.changes };
        await store.putLane(next);
        bus.emit({ type: 'lane.updated', laneId });
        return {
          laneId,
          kept: plan.kept,
          updated: plan.updated,
          added: plan.added,
          dropped: plan.dropped,
          changes: plan.changes.map((c) => ({ id: c.id, summary: summarize(c) })),
        };
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
        'Revise an open lane. Each change revises the pending change it names by id (or, without an id, the one of the same kind on the same slide; a modify patch merges into the old one), or is added. ' +
          'Pending changes you do not mention stay as they are with their ids (keep, the default); replace: true discards them. Accepted and refused changes always stay. ' +
          'Returns the kept, updated, added and dropped change ids. Use when asked to modify an existing lane.',
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
