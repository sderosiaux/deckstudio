import { z } from 'zod';
import { AnchorSchema, ProposeLaneInputSchema } from '../../model/schema.js';
import type { Brief, SlideId, Snapshot } from '../../model/types.js';

export const CHECK_NAMES = ['arc', 'order', 'gaps', 'render'] as const;
export type CheckName = (typeof CHECK_NAMES)[number];
export const isCheckName = (s: string): s is CheckName => (CHECK_NAMES as readonly string[]).includes(s);

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

export function briefBlock(b: Brief): string {
  return [
    '<brief>',
    `Title: ${b.title}`,
    `Audience: ${b.audience}`,
    `Message: ${b.message}`,
    `Pattern: ${b.pattern}`,
    `Abstract:\n${b.abstract}`,
    '</brief>',
  ].join('\n');
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

/** One entry per slide in deck order: position, id, kind, title, story, and optionally the body text. */
export function deckOutline(snap: Snapshot, opts: { bodies: boolean }): string {
  const lines = ['<slides>'];
  snap.order.forEach((id, i) => {
    const s = snap.slides[id];
    if (!s) return;
    lines.push(`${i + 1}. id=${id} (${s.kind}) title: ${s.title}`);
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
If there is nothing to report, return { "remarks": [] }.`.trim();
}
