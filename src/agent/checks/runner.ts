import { createHash } from 'node:crypto';
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { query, type SDKMessage } from '@anthropic-ai/claude-agent-sdk';
import { z } from 'zod';
import { hashSlide, newId } from '../../model/ids.js';
import { slidesInRange } from '../../model/ops.js';
import type { Anchor, Brief, Lane, Origin, Remark, SlideId, Snapshot } from '../../model/types.js';
import { loadThemeCss } from '../../render/defaultTheme.js';
import type { ThumbService } from '../../render/thumbs.js';
import type { Bus } from '../../server/bus.js';
import { emitLaneRebase, LaneService, rebaseOpenLanesAfterMain, resolveLaneRemarks } from '../../server/laneService.js';
import type { DeckStore } from '../../store/deckStore.js';
import { createLane } from '../tools.js';
import { arc } from './arc.js';
import { gaps } from './gaps.js';
import { CHECK_NAMES, CheckResultSchema, isCheckName, nameSlides, type CheckDef, type CheckName, type CheckResult, type ChecksStatus } from './index.js';
import { order } from './order.js';
import { render } from './render.js';

export { CheckResultSchema, nameSlides, type CheckDef, type CheckName, type ChecksStatus } from './index.js';

export const CHECKS: Readonly<Record<CheckName, CheckDef>> = { arc, order, gaps, render };

export const RETRY_INSTRUCTION = 'Return only the JSON object';
const DEFAULT_DEBOUNCE_MS = 3000;
/** Checks that Read thumbnails need a few turns (read images, then answer); the others answer in one. */
const THUMB_CHECK_MAX_TURNS = 6;
/** Lanes one check keeps attached to its remarks after a run; the other remarks get no lane. */
export const MAX_LANES_PER_RUN = 3;
/** The status note of a run on a deck without slides: nothing to judge, so no model call. */
export const NO_SLIDES_NOTE = 'no slides yet';

/**
 * What the runner remembers across restarts, in the deck's cache dir: when each check last ended, and for the
 * render check the slide hashes its last good run looked at, under a key of what else shapes a render judgement
 * (theme.css and the design rules). A changed key means every slide is looked at again.
 */
const MemoSchema = z.object({
  lastRun: z.record(z.string(), z.string().nullable()).default({}),
  note: z.record(z.string(), z.string().nullable()).default({}),
  render: z.object({ key: z.string(), slides: z.record(z.string(), z.string()) }).nullable().default(null),
});
type Memo = z.infer<typeof MemoSchema>;
const MEMO_FILE = 'checks.json';

const renderKey = (themeCss: string, brief: Brief): string => createHash('sha256').update(themeCss).update('\u0000').update(brief.design.rules).digest('hex');

const anchorKey = (a: Anchor): string => (a.kind === 'slide' ? `slide:${a.slide}` : a.kind === 'range' ? `range:${a.from}:${a.to}` : 'arc');
/** Case, punctuation, spacing and slide numbers (which shift when slides move) do not make a remark new. */
const normText = (text: string): string =>
  text
    .toLowerCase()
    .replace(/\bslide \d+\b/g, 'slide')
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim();
/** Words that carry no finding: two remarks sharing only these say nothing alike. */
const STOP_WORDS = new Set(
  'a an the of to in on at by for from with and or but is are was were be been it its this that these those as about than then there here so not no only also its their his her one'.split(' '),
);
const wordSet = (text: string): Set<string> => new Set(normText(text).split(' ').filter((w) => w !== '' && !STOP_WORDS.has(w)));
/** Share of the two word sets' union that both hold (Jaccard); 1 for two texts with no meaningful word. */
function similarity(a: string, b: string): number {
  const x = wordSet(a);
  const y = wordSet(b);
  if (x.size === 0 && y.size === 0) return 1;
  let shared = 0;
  for (const w of x) if (y.has(w)) shared++;
  return shared / (x.size + y.size - shared);
}
/** From this similarity on, two remarks of one check on the same anchor report the same problem. */
export const SAME_REMARK_SIMILARITY = 0.6;
/**
 * Does `a` report the same problem as `b`? Same anchor and similar wording (owner checked by the caller). A re-run
 * keeps the old remark (its id and createdAt) instead of adding a reworded twin.
 */
const sameFinding = (a: { anchor: Anchor; text: string }, b: { anchor: Anchor; text: string }): boolean =>
  anchorKey(a.anchor) === anchorKey(b.anchor) && similarity(a.text, b.text) >= SAME_REMARK_SIMILARITY;
/** The most similar entry of `pool` reporting the same finding as `it`, if any. */
function bestMatch<T extends { anchor: Anchor; text: string }>(it: { anchor: Anchor; text: string }, pool: readonly T[]): T | undefined {
  let best: T | undefined;
  let score = -1;
  for (const r of pool) {
    if (!sameFinding(it, r)) continue;
    const s = similarity(it.text, r.text);
    if (s > score) {
      best = r;
      score = s;
    }
  }
  return best;
}
/** Render lanes must change what the audience sees: a lane touching only these fields does not fix a render remark. */
const UNRENDERED_FIELDS: ReadonlySet<string> = new Set(['notes', 'story']);
/** True when every change of the lane is a modify of notes or story only: nothing on the stage would change. */
export function changesOnlyUnrendered(lane: { changes: readonly { kind: string; patch?: object }[] }): boolean {
  return lane.changes.every((c) => c.kind === 'modify' && c.patch !== undefined && Object.keys(c.patch).every((f) => UNRENDERED_FIELDS.has(f)));
}

export interface CheckRunnerOptions {
  store: DeckStore;
  thumbs: ThumbService;
  bus: Bus;
  model: string;
  queryImpl?: typeof query;
  /** Quiet period after the last accept before all checks run. */
  debounceMs?: number;
}

export interface CheckRunResult {
  remarks: Remark[];
  lanes: Lane[];
}

type Item = CheckResult['remarks'][number];
type Outcome = { ok: true; items: Item[] } | { ok: false; reason: string };

/** What one run looks at and which remarks it owns. */
interface Target {
  def: CheckDef;
  brief: Brief;
  /** Slides shown to the model. */
  snap: Snapshot;
  /** Slide ids a remark anchor may reference. */
  validIds: ReadonlySet<SlideId>;
  /** Order used to resolve range anchors when deciding which old remarks are in scope. */
  order: readonly SlideId[];
  allowLanes: boolean;
  /** Set for a render check on a lane's preview: its remarks carry it as sourceLaneId. */
  laneId: string | null;
  /** Null: the run covers the whole deck and replaces all of its check's remarks. */
  scopeIds: ReadonlySet<SlideId> | null;
  /** Called once the run's remarks are persisted from a usable answer (not on a failure). */
  afterSuccess?: () => Promise<void>;
}

const errorMessage = (e: unknown): string => (e instanceof Error ? e.message : String(e));
const STOPPED = 'check runner stopped';
const failurePrefix = (name: CheckName): string => `check ${name} failed: `;
/** The single remark a failed run leaves (per check, per scanned lane). */
const isFailureRemark = (r: Remark, name: CheckName): boolean =>
  r.anchor.kind === 'arc' && r.severity === 'info' && r.laneId === null && r.text.startsWith(failurePrefix(name));
const pick = (snap: Snapshot, ids: readonly SlideId[]): Snapshot => ({
  order: ids.filter((id) => snap.slides[id] !== undefined),
  slides: Object.fromEntries(ids.flatMap((id) => (snap.slides[id] ? [[id, snap.slides[id]!]] : []))),
});

function anchorIds(a: Anchor): SlideId[] {
  return a.kind === 'slide' ? [a.slide] : a.kind === 'range' ? [a.from, a.to] : [];
}

/** The first `{` to the last `}` of the answer, parsed and validated; anchors must name known slides. */
export function parseCheckOutput(text: string, validIds: ReadonlySet<SlideId>): Outcome {
  const i = text.indexOf('{');
  const j = text.lastIndexOf('}');
  if (i < 0 || j < i) return { ok: false, reason: 'the answer contains no JSON object' };
  let raw: unknown;
  try {
    raw = JSON.parse(text.slice(i, j + 1));
  } catch (e) {
    return { ok: false, reason: `invalid JSON: ${errorMessage(e)}` };
  }
  const parsed = CheckResultSchema.safeParse(raw);
  if (!parsed.success) {
    const issues = parsed.error.issues.slice(0, 5).map((iss) => `${iss.path.map(String).join('.') || '(root)'}: ${iss.message}`);
    return { ok: false, reason: `the JSON does not match the contract: ${issues.join('; ')}` };
  }
  const unknown = parsed.data.remarks.flatMap((r, k) => {
    const bad = anchorIds(r.anchor).filter((id) => !validIds.has(id));
    return bad.length ? [`remarks.${k}.anchor names unknown slide id(s) ${bad.join(', ')}`] : [];
  });
  if (unknown.length) return { ok: false, reason: unknown.join('; ') };
  return { ok: true, items: parsed.data.remarks };
}

/**
 * Runs the deck checks as fresh single-shot SDK queries (no session, no user settings), validates their
 * JSON, and persists the result as remarks that replace the check's previous ones. Runs are serialized:
 * at most one check query is in flight per deck. The runner is the only owner of check status: which
 * checks are queued or running, and when each last ended (in memory: a restart forgets it).
 */
export class CheckRunner {
  private readonly opts: CheckRunnerOptions;
  private readonly queryImpl: typeof query;
  private tail: Promise<unknown> = Promise.resolve();
  /** Runs per check name whose query work has started: what status() reports as running (queued ones are not). */
  private readonly started = new Map<CheckName, number>();
  /** The queued or running deck-wide run of each check, which a new unscoped run of that name joins. */
  private readonly pending = new Map<CheckName, Promise<CheckRunResult>>();
  private readonly lastRun: Record<CheckName, string | null> = { arc: null, order: null, gaps: null, render: null };
  private readonly note: Record<CheckName, string | null> = { arc: null, order: null, gaps: null, render: null };
  /** Memo reads and writes, in call order. */
  private memoChain: Promise<unknown>;
  /** The after-accept batch queued or running; an accept meanwhile only marks it dirty. */
  private batch: Promise<void> | null = null;
  private dirty = false;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private current: AbortController | null = null;
  private disposed = false;

  constructor(opts: CheckRunnerOptions) {
    this.opts = opts;
    this.queryImpl = opts.queryImpl ?? query;
    // lastRun from before a restart; a run that ends meanwhile keeps its newer stamp.
    this.memoChain = this.readMemo().then((m) => {
      for (const name of CHECK_NAMES) {
        if (this.lastRun[name] !== null) continue;
        this.lastRun[name] = m.lastRun[name] ?? null;
        this.note[name] = m.note[name] ?? null;
      }
    });
  }

  /**
   * Runs one check after any queued run. An unscoped run joins the deck-wide run of the same check that is
   * already queued or running instead of starting another. `scope` restricts the slides shown and the remarks replaced.
   */
  run(name: CheckName, scope?: Anchor): Promise<CheckRunResult> {
    if (scope === undefined) {
      const joined = this.pending.get(name);
      if (joined) return joined;
    }
    const p = this.tracked(name, () => this.runDeck(name, scope));
    if (scope === undefined) {
      this.pending.set(name, p);
      const clear = () => {
        if (this.pending.get(name) === p) this.pending.delete(name);
      };
      p.then(clear, clear);
    }
    return p;
  }

  /** Fire-and-forget start of the named checks not already queued or running; returns the ones started. */
  start(names: readonly CheckName[]): CheckName[] {
    if (this.disposed) return [];
    const started = [...new Set(names)].filter((n) => !this.pending.has(n));
    for (const name of started) this.run(name).catch((e) => this.report(name, e));
    return started;
  }

  /** Fire-and-forget start by name, for the run_check tool. Throws on an unknown name. */
  trigger(name: string): void {
    if (!isCheckName(name)) throw new Error(`unknown check "${name}"; available: ${CHECK_NAMES.join(', ')}`);
    this.start([name]);
  }

  /** `running` lists the checks whose run has started; a run queued behind another is not reported. */
  status(): ChecksStatus {
    return { running: CHECK_NAMES.filter((n) => this.started.has(n)), lastRun: { ...this.lastRun }, note: { ...this.note } };
  }

  scheduleAfterAccept(): void {
    if (this.disposed) return;
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.batch) this.dirty = true;
      else this.runBatch();
    }, this.opts.debounceMs ?? DEFAULT_DEBOUNCE_MS);
    this.timer.unref?.();
  }

  scheduleAfterLane(laneId: string): void {
    if (this.disposed) return;
    this.tracked('render', () => this.runLane(laneId)).catch((e) => this.report(`render on lane ${laneId}`, e));
  }

  /** Stops pending schedules and aborts the query in flight. */
  dispose(): void {
    this.disposed = true;
    this.dirty = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.current?.abort();
  }

  // -------------------------------------------------------------------------

  /** All four checks on the current deck; accepts that land meanwhile add exactly one more batch. */
  private runBatch(): void {
    const all = CHECK_NAMES.map((name) => this.run(name).catch((e) => this.report(name, e)));
    this.batch = Promise.all(all).then(() => {
      this.batch = null;
      if (this.dirty && !this.disposed) {
        this.dirty = false;
        this.runBatch();
      }
    });
  }

  private enqueue<T>(fn: () => Promise<T>): Promise<T> {
    const p = this.tail.then(() => {
      if (this.disposed) throw new Error(STOPPED);
      return fn();
    });
    this.tail = p.catch(() => undefined);
    return p;
  }

  /** Enqueues `fn`, counting `name` as running once `fn` starts, until it settles. */
  private tracked<T>(name: CheckName, fn: () => Promise<T>): Promise<T> {
    let began = false;
    const p = this.enqueue(() => {
      began = true;
      this.setStarted(name, 1);
      return fn();
    });
    const done = () => {
      if (began) this.setStarted(name, -1);
    };
    p.then(done, done);
    return p;
  }

  private setStarted(name: CheckName, delta: 1 | -1): void {
    const before = this.status().running;
    bump(this.started, name, delta);
    const running = this.status().running;
    if (running.join() !== before.join()) this.opts.bus.emit({ type: 'checks.status', running });
  }

  private memoPath(): string {
    return join(this.opts.store.dir, 'cache', MEMO_FILE);
  }

  private async readMemo(): Promise<Memo> {
    try {
      const parsed = MemoSchema.safeParse(JSON.parse(await readFile(this.memoPath(), 'utf8')));
      if (parsed.success) return parsed.data;
    } catch {
      // Missing or unreadable: the checks have not run on this deck, as far as the runner can tell.
    }
    return MemoSchema.parse({});
  }

  /** Read-modify-write of the memo, chained so two updates never interleave. */
  private updateMemo(fn: (m: Memo) => Memo): Promise<void> {
    const w = this.memoChain.then(async () => {
      const next = fn(await this.readMemo());
      const path = this.memoPath();
      await mkdir(join(this.opts.store.dir, 'cache'), { recursive: true });
      const tmp = `${path}.${process.pid}.${Date.now()}.tmp`;
      await writeFile(tmp, JSON.stringify(next, null, 2));
      await rename(tmp, path);
    });
    this.memoChain = w.catch((e) => this.report('could not save the checks memo', e));
    return this.memoChain.then(() => undefined);
  }

  /**
   * Housekeeping before a run: lanes are rebased on main (a stale change is orphaned, one main already took is
   * accepted, a lane left with nothing to decide closes), remarks found on the preview of a lane that is now closed
   * are resolved, and a remark anchored on a slide that left main (and not on a lane preview) is dropped: it would
   * read "slide ?".
   */
  private async tidyRemarks(): Promise<void> {
    const { store, bus } = this.opts;
    const rebase = await store.withLock(async () => rebaseOpenLanesAfterMain(store, await store.snapshot()));
    emitLaneRebase(bus, rebase);
    const changed = await store.withLock(async () => {
      const [remarks, main, lanes] = await Promise.all([store.remarks(), store.snapshot(), store.lanes()]);
      const closed = lanes.filter((l) => l.status === 'closed').map((l) => l.id);
      const resolved = resolveLaneRemarks(remarks, closed) ?? remarks;
      const onMain = new Set(main.order);
      const next = resolved.filter((r) => r.sourceLaneId || anchorIds(r.anchor).every((id) => onMain.has(id)));
      if (resolved === remarks && next.length === remarks.length) return false;
      await store.putRemarks(next);
      return true;
    });
    if (changed) bus.emit({ type: 'remarks.changed' });
  }

  private report(what: string, e: unknown): void {
    if (this.disposed) return;
    console.error(`[checks] ${what}: ${errorMessage(e)}`);
  }

  private async runDeck(name: CheckName, scope?: Anchor): Promise<CheckRunResult> {
    const { store } = this.opts;
    await this.tidyRemarks();
    const [brief, main] = await Promise.all([store.brief(), store.snapshot()]);
    if (main.order.length === 0) {
      // Nothing to judge: no model call. The check's earlier remarks (a failure, findings on slides now gone) are superseded.
      const target: Target = { def: CHECKS[name], brief, snap: main, validIds: new Set(), order: [], allowLanes: false, laneId: null, scopeIds: null };
      try {
        return await this.persist(target, []);
      } finally {
        await this.stamp(name, NO_SLIDES_NOTE);
      }
    }
    let ids = scope ? slidesInRange(main.order, scope) : main.order;
    let scopeIds: ReadonlySet<SlideId> | null = scope && scope.kind !== 'arc' ? new Set(ids) : null;
    let afterSuccess: (() => Promise<void>) | undefined;
    if (name === 'render') {
      // Rendering and reading every slide is the costly part: only slides changed since the last good run are looked at.
      const key = renderKey(await loadThemeCss(store.dir), brief);
      const memo = await this.readMemo();
      const seen = memo.render?.key === key ? memo.render.slides : null;
      if (seen) {
        ids = ids.filter((id) => seen[id] !== hashSlide(main.slides[id]!));
        scopeIds = new Set(ids);
        if (ids.length === 0) {
          await this.stamp(name);
          return { remarks: [], lanes: [] };
        }
      }
      const checked = Object.fromEntries(ids.map((id) => [id, hashSlide(main.slides[id]!)]));
      afterSuccess = () =>
        this.updateMemo((m) => {
          const kept = m.render?.key === key ? m.render.slides : {};
          const slides = Object.fromEntries(Object.entries({ ...kept, ...checked }).filter(([id]) => main.slides[id] !== undefined));
          return { ...m, render: { key, slides } };
        });
    }
    return this.execute({
      def: CHECKS[name],
      brief,
      snap: pick(main, ids),
      validIds: new Set(main.order),
      order: main.order,
      allowLanes: true,
      laneId: null,
      scopeIds,
      ...(afterSuccess ? { afterSuccess } : {}),
    });
  }

  /** Records that `name` just ended a run, with a status note or none, in memory and in the memo. Never rejects. */
  private stamp(name: CheckName, note: string | null = null): Promise<void> {
    const at = new Date().toISOString();
    this.lastRun[name] = at;
    this.note[name] = note;
    return this.updateMemo((m) => ({ ...m, lastRun: { ...m.lastRun, [name]: at }, note: { ...m.note, [name]: note } }));
  }

  /** Render check on the slides a lane changes, as they look with the lane's pending changes applied. */
  private async runLane(laneId: string): Promise<CheckRunResult> {
    const { store, bus } = this.opts;
    await this.tidyRemarks();
    const lane = await store.lane(laneId);
    // Lanes proposed by the render check itself are not re-checked: their remarks would share an owner.
    if (!lane || lane.status !== 'open' || lane.origin === 'check:render') return { remarks: [], lanes: [] };
    const [brief, preview] = await Promise.all([store.brief(), new LaneService(store, bus).preview(laneId)]);
    if (preview.changed.length === 0) return { remarks: [], lanes: [] };
    return this.execute({
      def: render,
      brief,
      snap: pick(preview, preview.changed),
      validIds: new Set(preview.changed),
      order: preview.order,
      allowLanes: false,
      laneId,
      scopeIds: new Set(preview.changed),
    });
  }

  private async execute(t: Target): Promise<CheckRunResult> {
    const name = t.def.name;
    try {
      const outcome = await this.evaluate(t);
      if (this.disposed) throw new Error(STOPPED);
      if (!outcome.ok) return await this.persistFailure(t, `${failurePrefix(name)}${outcome.reason}`);
      const out = await this.persist(t, outcome.items);
      await t.afterSuccess?.();
      return out;
    } finally {
      await this.stamp(name);
    }
  }

  /** One query, and one retry with a stricter instruction when the answer is unusable. */
  private async evaluate(t: Target): Promise<Outcome> {
    let thumbs: Record<SlideId, string> | undefined;
    if (t.def.needsThumbs) {
      try {
        thumbs = await this.thumbPaths(t.snap);
      } catch (e) {
        return { ok: false, reason: `could not render thumbnails: ${errorMessage(e)}` };
      }
    }
    const prompt = t.def.buildPrompt({ brief: t.brief, snap: t.snap, deckOrder: t.order, allowLanes: t.allowLanes, ...(thumbs ? { thumbs } : {}) });
    const first = await this.ask(t, prompt);
    // Disposed (the query was aborted): a retry would only start a query nobody waits for.
    if (first.ok || this.disposed) return first;
    const second = await this.ask(t, `${prompt}\n\nYour previous answer could not be used (${first.reason}). ${RETRY_INSTRUCTION}.`);
    return second.ok ? second : { ok: false, reason: second.reason };
  }

  private async thumbPaths(snap: Snapshot): Promise<Record<SlideId, string>> {
    const out: Record<SlideId, string> = {};
    for (const id of snap.order) out[id] = (await this.opts.thumbs.thumb(snap.slides[id]!)).path;
    return out;
  }

  private async ask(t: Target, prompt: string): Promise<Outcome> {
    let text: string;
    try {
      text = await this.complete(t.def, prompt);
    } catch (e) {
      return { ok: false, reason: errorMessage(e) };
    }
    return parseCheckOutput(text, t.validIds);
  }

  private async complete(def: CheckDef, prompt: string): Promise<string> {
    if (this.disposed) throw new Error(STOPPED);
    const { store, model } = this.opts;
    const abortController = new AbortController();
    this.current = abortController;
    const tools = def.needsThumbs ? ['Read'] : [];
    let text: string | null = null;
    let error: string | null = null;
    try {
      const q = this.queryImpl({
        prompt,
        options: {
          cwd: store.dir,
          model,
          systemPrompt: def.system,
          settingSources: [],
          tools,
          allowedTools: tools,
          permissionMode: 'dontAsk',
          maxTurns: def.needsThumbs ? THUMB_CHECK_MAX_TURNS : 1,
          abortController,
        },
      });
      for await (const m of q as AsyncIterable<SDKMessage>) {
        if (m.type !== 'result') continue;
        if (m.subtype === 'success' && !m.is_error) text = m.result;
        else error = m.subtype === 'success' ? m.result : `${m.subtype}${m.errors.length ? `: ${m.errors.join('; ')}` : ''}`;
      }
    } catch (e) {
      // The SDK throws after yielding an error result; keep the result's own reason.
      if (error === null) error = abortController.signal.aborted ? 'interrupted' : errorMessage(e);
    } finally {
      if (this.current === abortController) this.current = null;
    }
    if (text !== null) return text;
    throw new Error(error ?? 'the query ended without a result');
  }

  /**
   * Did the creator act on this remark? Resolved it, asked the co-author for a lane from it, or opened or
   * decided on the draft the check attached to it. Such a remark is never replaced by a re-run.
   */
  private async actedOn(r: Remark, origin: Origin): Promise<boolean> {
    if (r.status === 'resolved') return true;
    if (r.laneId === null) return false;
    const lane = await this.opts.store.lane(r.laneId);
    if (!lane) return false;
    if (lane.origin !== origin) return true;
    return lane.status === 'open' || lane.changes.some((c) => c.status === 'accepted' || c.status === 'refused');
  }

  /** Is `r` one of the remarks this run supersedes? */
  private async owned(t: Target, r: Remark, origin: Origin): Promise<boolean> {
    if (r.origin !== origin) return false;
    const source = r.sourceLaneId ?? null;
    if (t.laneId !== null) {
      // A lane run owns exactly the remarks found on that lane's preview.
      if (source !== t.laneId) return false;
    } else if (source !== null) {
      // Remarks found on a lane's preview stay while that lane is not closed; after, a deck-wide run drops them.
      const lane = await this.opts.store.lane(source);
      return !(lane && lane.status !== 'closed');
    }
    // A failure remark is always superseded by the check's next run on the same target.
    if (isFailureRemark(r, t.def.name)) return true;
    if (await this.actedOn(r, origin)) return false;
    if (t.laneId !== null || t.scopeIds === null) return true;
    const ids = r.anchor.kind === 'range' ? slidesInRange([...t.order], r.anchor) : anchorIds(r.anchor);
    return ids.some((id) => t.scopeIds!.has(id));
  }

  private async split(t: Target, remarks: readonly Remark[], origin: Origin): Promise<{ kept: Remark[]; replaced: Remark[] }> {
    const kept: Remark[] = [];
    const replaced: Remark[] = [];
    for (const r of remarks) ((await this.owned(t, r, origin)) ? replaced : kept).push(r);
    return { kept, replaced };
  }

  /**
   * Replaces the check's remarks with the new ones, except that a new remark matching a kept remark (one the
   * creator acted on, or out of scope) is dropped, and one matching a superseded remark keeps its id, its
   * createdAt and its draft lane. Drafts no remark points to any more are closed.
   */
  private async persist(t: Target, items: Item[]): Promise<CheckRunResult> {
    const { store, bus } = this.opts;
    const origin = `check:${t.def.name}` as const;
    const source = t.laneId;
    const sameOwner = (r: Remark): boolean => r.origin === origin && (r.sourceLaneId ?? null) === source;

    // Remark text keeps its slide ids: they are named at read time in the order of that moment, so numbers never
    // go stale. A lane label is stored as is, so it is named now. A problem reported twice in one answer (the same
    // finding, even reworded) is kept once, as first worded.
    const fresh: Item[] = [];
    for (const it of items) {
      if (bestMatch(it, fresh)) continue;
      const lane = it.lane ? { ...it.lane, label: nameSlides(it.lane.label, { order: t.order, slides: t.snap.slides }, { titles: false }) } : null;
      // A render remark is about what the audience sees: a lane that only edits notes or story does not fix it.
      if (lane && t.def.name === 'render' && changesOnlyUnrendered(lane)) {
        console.warn(`[checks] render: proposed lane "${lane.label}" dropped: it changes neither the body nor the title`);
        fresh.push({ ...it, lane: null });
      } else fresh.push({ ...it, lane });
    }

    // Lanes first: createLane takes the deck lock itself. Planned on the remarks as they are now; the write
    // below re-reads them under the lock and closes any draft that ends up unreferenced.
    const before = await this.split(t, await store.remarks(), origin);
    const keptBefore = before.kept.filter(sameOwner);
    const reusable: { anchor: Anchor; text: string; laneId: string }[] = [];
    for (const r of before.replaced) {
      if (!r.laneId) continue;
      const lane = await store.lane(r.laneId);
      if (lane && lane.origin === origin && lane.status === 'draft') reusable.push({ anchor: r.anchor, text: r.text, laneId: lane.id });
    }
    const laneIds: (string | null)[] = [];
    const created: string[] = [];
    const reused = new Set<string>();
    let attached = 0;
    let overCap = 0;
    for (const it of fresh) {
      laneIds.push(null);
      if (!t.allowLanes || bestMatch(it, keptBefore)) continue;
      const reuse = bestMatch(
        it,
        reusable.filter((x) => !reused.has(x.laneId)),
      )?.laneId;
      if (!reuse && !it.lane) continue;
      if (attached >= MAX_LANES_PER_RUN) {
        overCap++;
        continue;
      }
      if (reuse) {
        reused.add(reuse);
        laneIds[laneIds.length - 1] = reuse;
        attached++;
        continue;
      }
      const res = await createLane({ store, bus }, it.lane, { origin, status: 'draft' });
      if (!('laneId' in res) || typeof res.laneId !== 'string') {
        console.warn(`[checks] ${t.def.name}: proposed lane "${it.lane!.label}" rejected: ${JSON.stringify(res)}`);
        continue;
      }
      laneIds[laneIds.length - 1] = res.laneId;
      created.push(res.laneId);
      attached++;
    }
    if (overCap > 0) console.info(`[checks] ${t.def.name}: ${overCap} lane(s) not created, over the cap of ${MAX_LANES_PER_RUN} per run`);

    const now = new Date().toISOString();
    const out = await store.withLock(async () => {
      const { kept, replaced } = await this.split(t, await store.remarks(), origin);
      const keptNow = kept.filter(sameOwner);
      // Each superseded remark is claimed by at most one new remark: the most similar report of the same finding.
      const unclaimed = [...replaced];
      const remarks: Remark[] = [];
      fresh.forEach((it, k) => {
        if (bestMatch(it, keptNow)) return;
        const was = bestMatch(it, unclaimed);
        if (was) unclaimed.splice(unclaimed.indexOf(was), 1);
        remarks.push({
          id: was?.id ?? newId('r'),
          anchor: it.anchor,
          text: it.text,
          origin,
          severity: it.severity,
          status: 'open',
          laneId: laneIds[k] ?? null,
          ...(source !== null ? { sourceLaneId: source } : {}),
          // A problem found again (even reworded) is as old as its first report: the UI reads createdAt to mark what is new.
          createdAt: was?.createdAt ?? now,
        });
      });
      const referenced = new Set(remarks.flatMap((r) => (r.laneId ? [r.laneId] : [])));
      const candidates = new Set([...replaced.flatMap((r) => (r.laneId ? [r.laneId] : [])), ...created]);
      const closedIds: string[] = [];
      for (const id of candidates) {
        if (referenced.has(id)) continue;
        const lane = await store.lane(id);
        // Only the check's own drafts: a lane the creator opened is theirs now.
        if (!lane || lane.origin !== origin || lane.status !== 'draft') continue;
        await store.putLane({ ...lane, status: 'closed' });
        closedIds.push(id);
      }
      const next = [...kept, ...remarks];
      await store.putRemarks(resolveLaneRemarks(next, closedIds) ?? next);
      return { remarks, closedIds };
    });

    for (const id of out.closedIds) bus.emit({ type: 'lane.closed', laneId: id });
    bus.emit({ type: 'remarks.changed' });
    const lanes: Lane[] = [];
    for (const id of created) {
      if (out.closedIds.includes(id)) continue;
      const lane = await store.lane(id);
      if (lane) lanes.push(lane);
    }
    return { remarks: out.remarks, lanes };
  }

  /** A failed run leaves the check's remarks and lanes as they were; only its failure remark is added or replaced. */
  private async persistFailure(t: Target, text: string): Promise<CheckRunResult> {
    const { store, bus } = this.opts;
    const origin = `check:${t.def.name}` as const;
    const source = t.laneId;
    const remark: Remark = {
      id: newId('r'),
      anchor: { kind: 'arc' },
      text,
      origin,
      severity: 'info',
      status: 'open',
      laneId: null,
      ...(source !== null ? { sourceLaneId: source } : {}),
      createdAt: new Date().toISOString(),
    };
    await store.withLock(async () => {
      const existing = await store.remarks();
      const kept = existing.filter((r) => !(r.origin === origin && (r.sourceLaneId ?? null) === source && isFailureRemark(r, t.def.name)));
      await store.putRemarks([...kept, remark]);
    });
    bus.emit({ type: 'remarks.changed' });
    return { remarks: [remark], lanes: [] };
  }
}

function bump(counts: Map<CheckName, number>, name: CheckName, delta: 1 | -1): void {
  const n = (counts.get(name) ?? 0) + delta;
  if (n > 0) counts.set(name, n);
  else counts.delete(name);
}
