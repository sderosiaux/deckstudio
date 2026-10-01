import { createHash } from 'node:crypto';
import { mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { createSdkMcpServer, tool, type McpSdkServerConfigWithInstance } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { newId } from '../model/ids.js';
import { imageStyleFor, type ImageGen } from './imageGen.js';
import { applyChange, orderedAnchor, validateBody } from '../model/ops.js';
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
/** A ref names, inside one call, a slide an insert of that call creates: the model cannot know its id beforehand. */
const REF = /^[A-Za-z][\w-]{0,31}$/;
const AFTER_DESCRIPTION =
  'the slide this one goes right after: an existing slide id, the ref of an insert listed earlier in this call, the slideId returned for an insert of this lane, or null for the first position';
const insertTool = insertIn.extend({
  ref: z
    .string()
    .regex(REF, 'a ref is a short name like "n1": a letter, then letters, digits, _ or -')
    .optional()
    .describe('a short name for the slide this insert creates ("n1"); a later change of the same call may use it as its after'),
  after: z.string().nullable().describe(AFTER_DESCRIPTION),
});
const moveTool = moveIn.extend({ after: z.string().nullable().describe(AFTER_DESCRIPTION) });
/** A NewChange as the co-author writes it: an insert may carry a ref that later changes of the call use as their after. */
export const ToolChangeSchema = z.discriminatedUnion('kind', [insertTool, modifyIn, removeIn, moveTool]);
export type ToolChange = z.infer<typeof ToolChangeSchema>;
/** A ToolChange that may name the lane change it revises. */
export const RevisedChangeSchema = z.discriminatedUnion('kind', [insertTool.extend(changeId), modifyIn.extend(changeId), removeIn.extend(changeId), moveTool.extend(changeId)]);
export type RevisedChange = z.infer<typeof RevisedChangeSchema>;
/** propose_lane's input: a lane, and whether the creator asked for an alternative to an existing lane. */
export const ProposeLaneToolSchema = ProposeLaneInputSchema.extend({
  changes: z.array(ToolChangeSchema).min(1),
  alternative: z
    .boolean()
    .optional()
    .describe('true only when the creator asked for an alternative to an existing lane: it then stays a separate lane'),
});
/** A proposal this close to an open lane of the same thread revises that lane instead of opening a twin. */
export const DUPLICATE_WINDOW_MS = 3600_000;
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

/** What the lane inserts, as seen from one of its changes. */
interface LaneSlides {
  /** Slides inserted by earlier changes of the lane: an `after` may name them. */
  inserted: ReadonlySet<string>;
  /** Slides inserted by changes listed after this one. */
  later?: ReadonlySet<string>;
  /** Slide id -> the ref the model wrote for it, so errors use the model's own words. */
  names?: ReadonlyMap<string, string>;
}

function refProblems(snap: Snapshot, c: NewChange | Change, lane: LaneSlides = { inserted: new Set() }): string[] {
  const reasons: string[] = [];
  const ref = (id: string | null, role: 'after' | 'target') => {
    if (id === null || has(snap, id) || (role === 'after' && lane.inserted.has(id))) return;
    const name = lane.names?.get(id) ?? id;
    if (role === 'after' && lane.later?.has(id)) reasons.push(`after slide "${name}" is inserted later in this lane: list each insert after the one it follows`);
    else reasons.push(`${role} slide "${name}" does not exist in the current deck`);
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

/** Gives ids and a pending status to AI-proposed changes; an insert takes `slideId` when its id was given up front. */
function materialize(c: NewChange, slideId: string = newId('s')): Change {
  const base = { id: newId('c'), status: 'pending' as const, reason: c.reason };
  switch (c.kind) {
    case 'insert':
      return { ...base, kind: 'insert', after: c.after, slide: { id: slideId, ...c.slide } };
    case 'modify':
      return { ...base, kind: 'modify', slide: c.slide, patch: c.patch };
    case 'remove':
      return { ...base, kind: 'remove', slide: c.slide };
    case 'move':
      return { ...base, kind: 'move', slide: c.slide, after: c.after };
  }
}

interface BoundRefs {
  /** The input without refs, each `after` that named a ref now naming that insert's slide id. */
  changes: RevisedChange[];
  /** The slide id each insert of the input will create (undefined for other kinds). */
  slideIds: (string | undefined)[];
  /** Slide id -> ref, for error messages. */
  names: Map<string, string>;
  /** Per input index, what is wrong with its ref, if anything. */
  problems: (string | null)[];
}

/**
 * Gives every insert its slide id up front and rewrites each `after` that names a ref of the call to that id, so a
 * chain of inserts (an outline: n1 first, n2 after n1, ...) is proposed in one call. A ref is unique in the call and
 * never shadows a slide id of the deck, so an `after` reads one way only.
 */
function bindRefs(snap: Snapshot, input: readonly RevisedChange[]): BoundRefs {
  const byRef = new Map<string, string>();
  const names = new Map<string, string>();
  const problems: (string | null)[] = input.map(() => null);
  const slideIds = input.map((c, i) => {
    if (c.kind !== 'insert') return undefined;
    const id = newId('s');
    if (c.ref === undefined) return id;
    if (byRef.has(c.ref)) problems[i] = `ref "${c.ref}" is already used by another insert of this call; give each insert its own ref`;
    else if (Object.hasOwn(snap.slides, c.ref) || snap.order.includes(c.ref)) problems[i] = `ref "${c.ref}" is the id of a slide of the deck; pick another ref`;
    else {
      byRef.set(c.ref, id);
      names.set(id, c.ref);
    }
    return id;
  });
  const resolve = (after: string | null): string | null => (after !== null ? (byRef.get(after) ?? after) : null);
  const changes = input.map((c): RevisedChange => {
    if (c.kind === 'insert') {
      const { ref: _ref, ...rest } = c;
      return { ...rest, after: resolve(c.after) };
    }
    return c.kind === 'move' ? { ...c, after: resolve(c.after) } : c;
  });
  return { changes, slideIds, names, problems };
}

/** `text` with every slide id of `names` replaced by the ref the model wrote for it. */
const named = (text: string, names: ReadonlyMap<string, string>): string => [...names].reduce((t, [id, ref]) => t.replaceAll(id, `"${ref}"`), text);

/**
 * Checks each change against the current deck, then replays them in order so a lane that
 * contradicts itself (remove s3, then modify s3) is caught before the creator sees it.
 * An insert may follow a slide inserted by an earlier change of the same lane (by ref).
 */
function checkChanges(snap: Snapshot, input: readonly RevisedChange[]): { changes: Change[]; invalid: Invalid[] } {
  const bound = bindRefs(snap, input);
  const changes = bound.changes.map((c, i) => materialize(c, bound.slideIds[i]));
  const later = new Set(bound.slideIds.filter((id): id is string => id !== undefined));
  const inserted = new Set<string>();
  const invalid: Invalid[] = [];
  let sim = snap;
  bound.changes.forEach((c, index) => {
    const id = bound.slideIds[index];
    if (id !== undefined) later.delete(id);
    const problem = bound.problems[index];
    const reasons = [...(problem ? [problem] : []), ...refProblems(snap, c, { inserted, later, names: bound.names })];
    if (id !== undefined) inserted.add(id);
    if (reasons.length) {
      invalid.push({ index, reason: reasons.join('; ') });
      return;
    }
    const r = applyChange(sim, changes[index]!);
    if (r.ok) sim = r.next;
    else invalid.push({ index, reason: named(`conflicts with an earlier change in this lane: ${r.error}`, bound.names) });
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

/** One line per change in a tool result; an insert also gives the id of the slide it creates (a later after may name it). */
const described = (c: Change): { id: string; summary: string; slideId?: string } =>
  c.kind === 'insert' ? { id: c.id, summary: summarize(c), slideId: c.slide.id } : { id: c.id, summary: summarize(c) };

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
function planRevision(lane: Lane, input: RevisedChange[], replace: boolean, slideIds: readonly (string | undefined)[] = []): RevisionPlan {
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
    const fresh = materialize(stripId(c) as NewChange, slideIds[index]);
    changes.push(fresh);
    sourceIndex.push(index);
    added.push(fresh.id);
  });
  // A revised insert keeps its slide id, not the one given up front: an `after` of this call naming the latter follows it.
  const renamed = new Map<string, string>();
  for (const [oldId, index] of matched) {
    const old = lane.changes.find((x) => x.id === oldId)!;
    const given = slideIds[index];
    if (old.kind === 'insert' && given !== undefined) renamed.set(given, old.slide.id);
  }
  const follow = (c: Change): Change => ((c.kind === 'insert' || c.kind === 'move') && c.after !== null && renamed.has(c.after) ? { ...c, after: renamed.get(c.after)! } : c);
  return { changes: changes.map(follow), sourceIndex, kept, updated, added, dropped, invalid };
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

type LockedStore = Pick<DeckToolContext, 'store' | 'bus'>;
type ProposeLaneInput = z.infer<typeof ProposeLaneInputSchema>;

/** Call under the deck lock: validates `input` against current main and saves it as one new lane. */
async function createLocked(ctx: LockedStore, input: ProposeLaneInput, as: { origin: Origin; status: 'draft' | 'open' }): Promise<object> {
  const { store, bus } = ctx;
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
  return { laneId: lane.id, changes: changes.map(described) };
}

/** Call under the deck lock: merges a revision into a lane that is not closed, validated against current main. */
async function reviseLocked(ctx: LockedStore, lane: Lane, input: RevisedChange[], replace: boolean): Promise<object> {
  const { store, bus } = ctx;
  const [state, snap] = await Promise.all([store.state(), store.snapshot()]);
  const bound = bindRefs(snap, input);
  const refErrors = bound.problems.flatMap((reason, index) => (reason ? [{ index, reason }] : []));
  if (refErrors.length) return rejected(refErrors);
  const plan = planRevision(lane, bound.changes, replace, bound.slideIds);
  if (plan.invalid.length) return rejected(plan.invalid);
  // An `after` may name any slide the lane inserts; whether it comes before is the replay's call, in lane order.
  const inserted = new Set([
    ...plan.changes.flatMap((c) => (c.kind === 'insert' ? [c.slide.id] : [])),
    ...bound.slideIds.filter((id): id is string => id !== undefined),
  ]);
  const refs = bound.changes.flatMap((c, index) => {
    const reasons = refProblems(snap, c, { inserted, names: bound.names });
    return reasons.length ? [{ index, reason: reasons.join('; ') }] : [];
  });
  if (refs.length) return rejected(refs);
  // The pending changes replay in lane order on current main, so a revision that contradicts a kept change is caught.
  const conflicts = replay(snap, plan.changes, plan.sourceIndex).map((x) => ({ ...x, reason: named(x.reason, bound.names) }));
  if (conflicts.length) return rejected(conflicts);
  // Validated against the current main, so the lane now bases on it.
  const next: Lane = { ...lane, baseVersion: state.version, changes: plan.changes };
  await store.putLane(next);
  bus.emit({ type: 'lane.updated', laneId: lane.id });
  return {
    laneId: lane.id,
    kept: plan.kept,
    updated: plan.updated,
    added: plan.added,
    dropped: plan.dropped,
    changes: plan.changes.map(described),
  };
}

const sameAnchor = (a: Anchor, b: Anchor): boolean => JSON.stringify(a) === JSON.stringify(b);
const normLabel = (s: string): string => s.toLowerCase().replace(/\s+/g, ' ').trim();
/** "slide\0field" for every field a modify patches. */
const modifyKeys = (c: NewChange | Change): string[] => (c.kind === 'modify' ? Object.keys(c.patch).map((f) => `${c.slide}\u0000${f}`) : []);

/**
 * The open user lane a new proposal duplicates, if any: same anchor and the same label (case and spacing aside), or,
 * unless the creator asked for an alternative, a single modify on a slide field that a pending modify of a lane on the
 * same anchor created within the last hour already changes. The thread a lane came from is not stored: a lane on the
 * same anchor stands for the same thread (a slide thread proposes on its slide).
 */
function duplicateOf(lanes: readonly Lane[], input: z.infer<typeof ProposeLaneToolSchema>, now: number): Lane | null {
  const candidates = lanes.filter((l) => l.status === 'open' && l.origin === 'user' && sameAnchor(l.anchor, input.anchor));
  const byLabel = candidates.find((l) => normLabel(l.label) === normLabel(input.label));
  if (byLabel) return byLabel;
  if (input.alternative === true || input.changes.length !== 1) return null;
  const keys = modifyKeys(input.changes[0]!);
  if (keys.length === 0) return null;
  return (
    candidates.find((l) => {
      if (now - Date.parse(l.createdAt) > DUPLICATE_WINDOW_MS) return false;
      const theirs = new Set(l.changes.flatMap((c) => (c.status === 'pending' ? modifyKeys(c) : [])));
      return keys.some((k) => theirs.has(k));
    }) ?? null
  );
}

/**
 * Validates a propose_lane input against the current deck and saves it as one lane, with the given origin
 * and status, in a single write: the co-author opens user lanes, a check saves drafts under its own origin.
 */
export async function createLane(ctx: LockedStore, args: unknown, as: { origin: Origin; status: 'draft' | 'open' }): Promise<object> {
  const p = parse(ProposeLaneInputSchema, args);
  if (!p.ok) return p.err;
  const input = p.value;
  return ctx.store.withLock(() => createLocked(ctx, input, as));
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
      const p = parse(ProposeLaneToolSchema, args);
      if (!p.ok) return p.err;
      const { alternative: _alternative, ...input } = p.value;
      return store.withLock(async () => {
        const twin = duplicateOf(await store.lanes(), p.value, Date.now());
        if (!twin) return createLocked(ctx, input, { origin: 'user', status: 'open' });
        const res = await reviseLocked(ctx, twin, input.changes, false);
        if ('error' in res) return res;
        return {
          ...res,
          revisedExisting: true,
          note:
            `The open lane "${twin.label}" already proposed this on the same slides, so it was revised instead of opening a second lane. ` +
            'Tell the creator you updated that lane, by its label. For a real alternative, call propose_lane again with alternative: true.',
        };
      });
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
        return reviseLocked(ctx, lane, input, replace === true);
      });
    },

    async add_remark(args) {
      const p = parse(AddRemarkInputSchema, args);
      if (!p.ok) return p.err;
      const { anchor, text, severity } = p.value;
      return store.withLock(async () => {
        const main = await store.snapshot();
        const anchorErr = anchorProblem(main, anchor);
        if (anchorErr) return { error: `Rejected; nothing was saved: ${anchorErr}` };
        const remark: Remark = {
          id: newId('r'),
          anchor: orderedAnchor(main.order, anchor),
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
        'Propose a lane: a labelled, coherent set of changes (insert/modify/remove/move) anchored on a slide, a range, or the arc, with a one-line reason per change. Slide ids must exist; insert.after/move.after may be null for "first". ' +
          'To insert several slides in a row (an outline, or a whole deck when it has no slides yet), give each insert a ref ("n1", "n2", ...) and set the after of the next insert to the ref of the one before; the result gives the slideId of every insert. ' +
          'Invalid input is rejected with the offending change indexes and nothing is saved. ' +
          'A proposal that repeats an open lane (same anchor and label, or the same slide field changed by a recent lane on that anchor) revises that lane instead: the result then says revisedExisting. Set alternative: true only when the creator asked for an alternative.',
        ProposeLaneToolSchema.shape,
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
