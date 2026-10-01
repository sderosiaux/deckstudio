import { z } from 'zod';
import { AnchorSchema, ProposeLaneInputSchema } from '../../model/schema.js';
import type { Brief, SlideId, Snapshot } from '../../model/types.js';

export const CHECK_NAMES = ['arc', 'order', 'gaps', 'render'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export const isCheckName = (s: string): s is CheckName => (CHECK_NAMES as readonly string[]).includes(s);

export interface ChecksStatus {
  /** Checks queued or running, in CHECK_NAMES order. */
  running: CheckName[];
  /** When each check's last run ended (ISO), null if it has not run since the server started. */
  lastRun: Record<CheckName, string | null>;
  /**
   * What the last run of each check could not do, in words for the creator ("no slides yet"); null after a normal run.
   * The runner always sets it; optional because the web app also builds statuses of its own (web/src/screens/BriefChecks.tsx).
   */
  note?: Record<CheckName, string | null>;
}

export const CheckResultSchema = z.object({
  remarks: z.array(
    z.object({
      anchor: AnchorSchema,
      severity: z.enum(['info', 'warn']),
      text: z.string().min(1),
      lane: ProposeLaneInputSchema.nullable(),
    }),
  ),
});
export type CheckResult = z.infer<typeof CheckResultSchema>;

export interface CheckPromptInput {
  brief: Brief;
  snap: Snapshot;
  /** Order that numbers the slides ("slide N"): the whole deck (or lane preview), even when `snap` shows a subset. */
  deckOrder: readonly SlideId[];
  /** Slide id -> absolute path of its rendered thumbnail (render check only). */
  thumbs?: Record<SlideId, string>;
  /** False when the run may not propose lanes (e.g. a render check on a lane's own preview). */
  allowLanes: boolean;
}

export interface CheckDef {
  name: CheckName;
  /** System prompt of the fresh single-shot query. */
  system: string;
  /** True: the runner renders thumbnails first and lets the model Read them. */
  needsThumbs: boolean;
  buildPrompt(input: CheckPromptInput): string;
}

/** The brief, and its design rules as context: only the render check verifies them. */
export function briefBlock(b: Brief): string {
  const brief = [
    '<brief>',
    `Title: ${b.title}`,
    `Audience: ${b.audience}`,
    `Message: ${b.message}`,
    `Pattern: ${b.pattern}`,
    `Abstract:\n${b.abstract}`,
    '</brief>',
  ].join('\n');
  const rules = designRulesBlock(b);
  return rules ? `${brief}\n\n${rules}\nThe design rules above are context only: another check verifies them; do not report on them.` : brief;
}

/** The creator's design rules, verbatim, or '' when the brief has none. */
export function designRulesBlock(b: Brief): string {
  const rules = b.design.rules.trim();
  return rules ? `<design-rules>\n${rules}\n</design-rules>` : '';
}

const BODY_TEXT_MAX = 600;

/** Visible text of a body fragment: what a viewer reads on the slide, without markup. */
export function bodyText(html: string): string {
  const text = html
    .replace(/<(script|style)[^>]*>[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&')
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > BODY_TEXT_MAX ? `${text.slice(0, BODY_TEXT_MAX)}…` : text;
}

/** How a slide is named to the model and to the creator: its 1-based position in `deckOrder` and its title. */
export function slideName(deckOrder: readonly SlideId[], id: SlideId, title: string): string {
  return `slide ${deckOrder.indexOf(id) + 1} (${title})`;
}

/** A slide id as newId('s') makes it, not glued to a longer token. */
const SLIDE_ID_SOURCE = 's_[A-Za-z0-9_-]{10}';
const escapeRe = (s: string): string => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** What naming a slide needs: the order that numbers it and its title. */
export interface SlideBook {
  order: readonly SlideId[];
  slides: Readonly<Record<SlideId, { title: string } | undefined>>;
}

/**
 * Replaces slide ids in prose (any newId('s') id, and every id of `book`) by "slide N (title)" in `book`'s order,
 * or "slide N" with `titles: false`. A "slide"/"slides" word right before the id is absorbed, so "slide s_x" never
 * reads "slide slide 3". An id not in the order reads "a removed slide": the creator never sees ids, nor "slide ?".
 */
export function nameSlides(text: string, book: SlideBook, opts: { titles?: boolean } = {}): string {
  const titles = opts.titles ?? true;
  const known = book.order.filter((id) => !new RegExp(`^${SLIDE_ID_SOURCE}$`).test(id)).sort((a, b) => b.length - a.length);
  const ids = [SLIDE_ID_SOURCE, ...known.map(escapeRe)].join('|');
  const re = new RegExp(`(\\b[Ss]lides?\\s+)?(?<![A-Za-z0-9_-])(${ids})(?![A-Za-z0-9_-])`, 'g');
  return text.replace(re, (_m, word: string | undefined, id: string) => {
    const capital = word !== undefined && word.startsWith('S');
    const i = book.order.indexOf(id);
    if (i < 0) return capital ? 'A removed slide' : 'a removed slide';
    const title = book.slides[id]?.title;
    const name = titles && title ? `slide ${i + 1} (${title})` : `slide ${i + 1}`;
    return capital ? `S${name.slice(1)}` : name;
  });
}

/** One entry per slide in deck order: "slide N (title)", id, kind, story, and optionally the body text. */
export function deckOutline(snap: Snapshot, deckOrder: readonly SlideId[], opts: { bodies: boolean }): string {
  const lines = ['<slides>'];
  snap.order.forEach((id) => {
    const s = snap.slides[id];
    if (!s) return;
    lines.push(`${slideName(deckOrder, id, s.title)} · id=${id} · ${s.kind}`);
    lines.push(`   story: ${s.story || '(none)'}`);
    if (opts.bodies) lines.push(`   on screen: ${bodyText(s.body) || '(no text)'}`);
  });
  lines.push('</slides>');
  return lines.join('\n');
}

/** The exact output contract every check prompt ends with; the runner validates against CheckResultSchema. */
export function jsonContract(allowLanes: boolean): string {
  const laneRule = allowLanes
    ? '"lane" is null unless you can propose a concrete fix; a lane must only use slide ids listed above and its changes must be one of the NewChange shapes.'
    : '"lane" must be null for every remark in this check.';
  return `
# Output
Return one JSON object and nothing else (no prose, no code fence), exactly this shape:
{ "remarks": [ { "anchor": Anchor, "severity": "info" | "warn", "text": "one or two sentences", "lane": null | { "label": "short label, max 80 chars", "anchor": Anchor, "changes": [ NewChange, ... ] } } ] }

Anchor is one of:
  { "kind": "slide", "slide": "<slide id>" }
  { "kind": "range", "from": "<slide id>", "to": "<slide id>" }
  { "kind": "arc" }

NewChange is one of:
  { "kind": "insert", "after": "<slide id>" | null, "slide": { "title": "...", "story": "...", "notes": "...", "body": "<HTML fragment, no <ul>/<ol>>", "assets": [], "kind": "cover" | "diagram" | "code" | "text" | "close" }, "reason": "one line" }
  { "kind": "modify", "slide": "<slide id>", "patch": { any subset of "title", "story", "notes", "body", "assets", "kind" }, "reason": "one line" }
  { "kind": "remove", "slide": "<slide id>", "reason": "one line" }
  { "kind": "move", "slide": "<slide id>", "after": "<slide id>" | null, "reason": "one line" }

Rules: use only the slide ids listed above ("after": null means first position). Every remark has all four keys. ${laneRule}
In "text", refer to a slide by its id alone (e.g. "the claim of s_AbCdEfGhIj comes too late"): the creator reads it as "slide N (title)" in the deck order of the moment, so numbers stay right when slides move. "label" names the fix, not the slide: an imperative of what the lane does ("Enlarge the caption under the diagram", "Define the term before its first use"), never "slide N (title)" alone and never an id. Name the slide in the reason of each change, by its id like in "text".
If there is nothing to report, return { "remarks": [] }.`.trim();
}
