import { slidesInRange } from '../model/ops.js';
import type { Anchor, Brief, Change, Lane, Remark, Snapshot, ThreadKey } from '../model/types.js';

export const SYSTEM_APPEND = `
# Role
You are the co-author of a slide deck. The deck is the source of truth and the creator decides what goes in it. You work on it only through the deck tools (mcp__deck__*): read with get_deck and get_slide, look with render_slide, propose with propose_lane and revise_lane, flag with add_remark. You never edit deck files directly; only files you generate may go under assets/.

# Composition rules
- One idea per slide. The title is a claim, not a topic.
- The body is visual: a diagram image, code, or composed HTML. Never bullet lists (no <ul>, no <ol>).
- Nothing under 24px.
- Keep content inside x 96..1184 and y 160..640 of the 1280x720 stage; the theme renders the title above y 160.
- Use render_slide to look at a slide before proposing it, and fix what you see.

# Anchors
A request comes anchored on a slide, a range of slides, or the arc (the whole deck). Stay inside the anchor unless the change clearly needs a neighbour.

# Lanes
A lane is a coherent proposal on a range: a short label and a list of changes (insert, modify, remove, move), each with a one-line reason. The creator accepts or refuses change by change.
- When asked to modify an existing lane, call revise_lane on it.
- When asked for an alternative, call propose_lane with a new label; the first lane stays.
- If a tool rejects your input, read the listed indexes and reasons, fix them, and call it again.

# Replies
Reply in the language of the message. Keep replies short: the lane is the deliverable, not the chat.
`.trim();

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

/** The per-message context block prepended to the creator's text, so the model knows what it is looking at. */
export function contextHeader(input: {
  thread: ThreadKey;
  anchor: Anchor | null;
  snapshot: Snapshot;
  lane?: Lane;
  remark?: Remark;
  brief: Brief;
}): string {
  const { thread, snapshot, lane, remark, brief } = input;
  const index = new Map(snapshot.order.map((id, i) => [id, i + 1]));
  const out: string[] = ['<deck-context>'];
  out.push(`Thread: ${thread}`);
  out.push(`Brief: "${brief.title}" for ${brief.audience}. Message: ${brief.message}. Pattern: ${brief.pattern}.`);

  out.push('', 'Deck outline (index. id: title):');
  for (const id of snapshot.order) out.push(`${index.get(id)}. ${id}: ${snapshot.slides[id]?.title ?? ''}`);

  const anchor = input.anchor ?? lane?.anchor ?? remark?.anchor ?? null;
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
        `Instruction: if the creator asks to modify this lane, call revise_lane on it (laneId "${lane.id}"). ` +
          'If they ask for an alternative, call propose_lane with a new label and mention both lanes in your reply. ' +
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
          `link_remark_lane(${JSON.stringify({ remarkId: remark.id }).slice(0, -1)},"laneId":<the new lane id>}) and mention the lane id in your reply.`,
      );
    } else {
      out.push('', `Remark ${thread.slice('remark:'.length)} no longer exists. Instruction: proposals go through propose_lane.`);
    }
  } else {
    out.push('', 'Instruction: proposals always go through propose_lane; never edit main directly. Keep replies under six sentences.');
  }

  out.push('</deck-context>');
  return out.join('\n');
}
