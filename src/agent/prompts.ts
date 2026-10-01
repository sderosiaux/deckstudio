import { slidesInRange } from '../model/ops.js';
import type { Anchor, Brief, Change, Lane, Remark, Snapshot, ThreadKey } from '../model/types.js';

export const SYSTEM_APPEND = `
# Role
You are the co-author of a slide deck. The deck is the source of truth and the creator decides what goes in it. You work on it only through the deck tools (mcp__deck__*): read with get_deck and get_slide, look with render_slide, propose with propose_lane and revise_lane, flag with add_remark. You never edit deck files directly; only files you generate may go under assets/.

# Composition rules
- Every slide you create or modify must satisfy the design rules of the brief (the Design rules block of the context). When a request conflicts with them, say so in one sentence and propose the closest compliant change.
- One idea per slide. The title is a claim, not a topic.
- The body is visual: a diagram image, code, or composed HTML. Never bullet lists (no <ul>, no <ol>).
- Nothing under 24px.
- Keep content inside x 96..1184 and y 160..640 of the 1280x720 stage; the theme renders the title above y 160.
- Use render_slide to look at a slide before proposing it, and fix what you see.
- Never truncate code or text to make it fit: removing lines from a listing (a declaration, an import, a closing brace) leaves code that no longer compiles on stage. If a body cannot fit inside the stage, propose to split it into two slides, or leave the slide as it is and call add_remark to say what does not fit.
- render_slide only validates structure (its warnings) and gives you an image to look at; it does not check legibility or overlap for you. Never claim that a render check passed or that a slide was verified: say what you changed, not what you checked.

# Anchors
A request comes anchored on a slide, a range of slides, or the arc (the whole deck). Stay inside the anchor unless the change clearly needs a neighbour.

# Lanes
A lane is a coherent proposal on a range: a short label and a list of changes (insert, modify, remove, move), each with a one-line reason. The creator accepts or refuses change by change.
- When asked to modify an existing lane, call revise_lane on it with only the changes to revise (by id) or add: the other changes stay as they are.
- When asked for an alternative, call propose_lane with a new label; the first lane stays.
- If a tool rejects your input, read the listed indexes and reasons, fix them, and call it again.

# Replies
Reply in the language the creator writes in: the language of the creator's last message, even if the deck or earlier messages are in another language (an English message gets an English reply); this rule wins over any other language instruction you were given.
Never write a lane id, a change id, a slide id or a tool name in a reply: the creator sees none of them. Name a lane by its label ("lane: Shorter hook title"), a change by what it does, and a slide as "slide N (title)" with its current position in the deck. Plain sentences, no markdown headings, no bullet lists, no bold. Never mention pixel sizes, coordinates or layout rules in a reply: describe the narrative intent of the change in one or two sentences. Keep replies short: the lane is the deliverable, not the chat.
`.trim();

export type ReplyLanguage = 'en' | 'fr';

// Function words only: they carry the language whatever the topic, and deck jargon (slide, lane, log) is in neither list.
const EN_WORDS = new Set(
  'the a an of to in on and or but is are was be it this that these those with for from by as at not no do does make keep can could would should please what why how which my your its their than then there here more less only also just one two'.split(' '),
);
const FR_WORDS = new Set(
  "le la les un une des du de d l au aux et ou mais est sont était être ce cet cette ces avec pour par dans sur sous pas ne plus moins que qui quoi pourquoi comment mon ma mes ton ta tes son sa ses leur leurs je tu il elle on nous vous ils elles fais garde peux veux merci aussi juste trop très".split(' '),
);
const FR_LETTERS = /[àâæçéèêëîïôœùûüÿ]/i;
/** Fewer words than this and the message says nothing reliable about its language ("shorter title", "ok"). */
const MIN_WORDS = 3;

function detect(text: string): ReplyLanguage | null {
  const words = text.toLowerCase().split(/[^\p{L}]+/u).filter(Boolean);
  if (words.length < MIN_WORDS) return null;
  let en = 0;
  let fr = 0;
  for (const w of words) {
    if (EN_WORDS.has(w)) en++;
    if (FR_WORDS.has(w)) fr++;
    if (FR_LETTERS.test(w)) fr++;
  }
  return en > fr ? 'en' : fr > en ? 'fr' : null;
}

/**
 * The language the reply must use: the creator's message's own, or, when the message is too short or too mixed to
 * tell, the language of the brief's message (then its abstract), then English.
 */
export function replyLanguage(text: string, brief: Pick<Brief, 'message' | 'abstract'>): ReplyLanguage {
  return detect(text) ?? detect(brief.message) ?? detect(brief.abstract) ?? 'en';
}

/** The last line of every message sent to the model: the system rule alone was ignored (French replies to English). */
export function replyInstruction(lang: ReplyLanguage): string {
  return lang === 'fr' ? 'Réponds en français.' : 'Reply in English.';
}

function anchorLabel(a: Anchor): string {
  switch (a.kind) {
    case 'slide':
      return `slide ${a.slide}`;
    case 'range':
      return `range ${a.from}..${a.to}`;
    case 'arc':
      return 'arc (whole deck)';
  }
}

function slideRef(snapshot: Snapshot, id: string): string {
  const s = snapshot.slides[id];
  return s ? `"${s.title}" (${id})` : `(no longer in the deck) (${id})`;
}

function changeTarget(c: Change, snapshot: Snapshot): string {
  switch (c.kind) {
    case 'insert':
      return `"${c.slide.title}" (${c.slide.id}) ${c.after ? `after ${c.after}` : 'at the start'}`;
    case 'modify':
    case 'remove':
      return slideRef(snapshot, c.slide);
    case 'move':
      return `${slideRef(snapshot, c.slide)} ${c.after ? `after ${c.after}` : 'to the start'}`;
  }
}

function anchorTitles(snapshot: Snapshot, a: Anchor): string {
  const ids = slidesInRange(snapshot.order, a);
  return ids.length ? ids.map((id) => slideRef(snapshot, id)).join(', ') : '(none of its slides are in the deck)';
}

/**
 * Class names a slide body can reuse, in order of first appearance: the `.name` parts of every selector of `css`.
 * Declarations (`.98`, `rgba(...,.10)`), comments and quoted strings are skipped.
 */
export function themeClasses(css: string): string[] {
  const clean = css.replace(/\/\*[\s\S]*?\*\//g, ' ').replace(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'/g, '""');
  const out = new Set<string>();
  // The text before each `{` is a selector list or an at-rule prelude; what sits between `{` and `}` is declarations.
  for (const m of clean.matchAll(/([^{}]*)\{/g)) {
    const prelude = m[1]!.trim();
    if (prelude.startsWith('@')) continue;
    for (const c of prelude.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)) out.add(c[1]!);
  }
  return [...out];
}

/** Classes the renderer and the player set on their own elements (the stage, the notes, the story panel, the HUD): never for a body. */
const PLAYER_CLASSES: ReadonlySet<string> = new Set(['slide', 'active', 'notes', 'story', 'hud']);

function designBlock(brief: Brief, themeCss: string | undefined): string[] {
  const rules = brief.design.rules.trim();
  if (!rules) return [];
  const out = ['Design rules (every slide you create or modify must satisfy them):', rules];
  const classes = themeCss === undefined ? [] : themeClasses(themeCss).filter((c) => !PLAYER_CLASSES.has(c));
  if (classes.length) out.push(`Theme classes in theme.css (reuse them instead of inline styles): ${classes.map((c) => `.${c}`).join(', ')}`);
  return out;
}

/** The per-message context block prepended to the creator's text, so the model knows what it is looking at. */
export function contextHeader(input: {
  thread: ThreadKey;
  anchor: Anchor | null;
  snapshot: Snapshot;
  lane?: Lane;
  remark?: Remark;
  brief: Brief;
  /** The deck's theme.css: its class names are listed next to the design rules. */
  themeCss?: string;
}): string {
  const { thread, snapshot, lane, remark, brief } = input;
  const index = new Map(snapshot.order.map((id, i) => [id, i + 1]));
  const out: string[] = ['<deck-context>'];
  out.push(`Thread: ${thread}`);
  out.push(`Brief: "${brief.title}" for ${brief.audience}. Message: ${brief.message}. Pattern: ${brief.pattern}.`);
  out.push(...designBlock(brief, input.themeCss));

  out.push('', 'Deck outline (index. id: title):');
  for (const id of snapshot.order) out.push(`${index.get(id)}. ${id}: ${snapshot.slides[id]?.title ?? ''}`);

  // A slide thread is anchored on its slide unless the message says otherwise.
  const slideId = thread.startsWith('slide:') ? thread.slice('slide:'.length) : null;
  const edited = slideId !== null ? snapshot.slides[slideId] : undefined;
  const slideAnchor: Anchor | null = edited && index.has(edited.id) ? { kind: 'slide', slide: edited.id } : null;
  const anchor = input.anchor ?? lane?.anchor ?? remark?.anchor ?? slideAnchor;
  if (anchor) {
    out.push('', `Selected: ${anchorLabel(anchor)}`);
    const ids = slidesInRange(snapshot.order, anchor);
    for (const id of ids) {
      const s = snapshot.slides[id];
      if (!s) {
        out.push(`- ${id}: (no longer in the deck)`);
        continue;
      }
      out.push(`${index.get(id)}. ${id}: ${s.title}`, `   story: ${s.story || '(none)'}`);
    }
  }

  if (thread.startsWith('lane:')) {
    if (lane) {
      out.push(
        '',
        `Lane ${lane.id} "${lane.label}" on ${anchorLabel(lane.anchor)} (${lane.status}, base v${lane.baseVersion}).`,
        `Anchor slides: ${anchorTitles(snapshot, lane.anchor)}`,
        'Changes (id · kind · target · reason · status):',
      );
      for (const c of lane.changes) out.push(`- ${c.id} · ${c.kind} · ${changeTarget(c, snapshot)} · ${c.reason} · ${c.status}`);
      out.push(
        '',
        `Instruction: if the creator asks to modify this lane, call revise_lane on it (laneId "${lane.id}") with only the changes to revise (by id) or add; ` +
          'the others stay as they are unless the creator asks to start over (replace: true). ' +
          'If they ask for an alternative, call propose_lane with a new label and mention both lanes in your reply, by their labels. ' +
          'Never edit main directly.',
      );
    } else {
      out.push('', `Lane ${thread.slice('lane:'.length)} no longer exists. Instruction: call propose_lane for any new proposal. Never edit main directly.`);
    }
  } else if (thread.startsWith('remark:')) {
    if (remark) {
      out.push(
        '',
        `Remark ${remark.id} (from ${remark.origin}, ${remark.status}) on ${anchorLabel(remark.anchor)}:`,
        remark.text,
        `Severity: ${remark.severity}`,
        `Anchor slides: ${anchorTitles(snapshot, remark.anchor)}`,
      );
      if (remark.laneId) out.push(`This remark is already linked to lane ${remark.laneId}.`);
      out.push(
        '',
        `Instruction: if asked to propose, call propose_lane with anchor ${JSON.stringify(remark.anchor)}, then call ` +
          `link_remark_lane(${JSON.stringify({ remarkId: remark.id }).slice(0, -1)},"laneId":<the new lane id>}); in your reply, name the lane by its label.`,
      );
    } else {
      out.push('', `Remark ${thread.slice('remark:'.length)} no longer exists. Instruction: proposals go through propose_lane.`);
    }
  } else if (slideId !== null) {
    if (edited && slideAnchor) {
      out.push(
        '',
        `Scope: the creator is editing slide ${index.get(edited.id)} "${edited.title}" (${edited.id}) on its own screen and talks about it.`,
        `story: ${edited.story || '(none)'}`,
        `notes: ${edited.notes || '(none)'}`,
        'body (HTML):',
        edited.body,
        '',
        'Instruction: Decide the scope yourself. ' +
          `If the request stays inside this slide, call propose_lane once with anchor ${JSON.stringify(slideAnchor)}, a label naming the change in a few words, ` +
          `and a single modify change on ${edited.id} (a patch of body, title, story or notes), and nothing else. ` +
          'If it needs the neighbours, several slides or the narrative, call propose_lane once on the smallest range that holds the change, or on the arc, ' +
          'and say in one sentence why the change goes beyond this slide. ' +
          'Never edit main directly. In the reply, never describe pixels, sizes or positions: say what the slide now says.',
      );
    } else {
      out.push('', `Slide ${slideId} is no longer in the deck. Instruction: proposals go through propose_lane; never edit main directly.`);
    }
  } else {
    out.push('', 'Instruction: proposals always go through propose_lane; never edit main directly. Keep replies under six sentences.');
  }

  out.push('</deck-context>');
  return out.join('\n');
}
