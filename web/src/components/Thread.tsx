import { useCallback, useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react';
import type React from 'react';
import type { Anchor, Change, Lane, Slide, SlideId, ThreadKey, ThreadMessage } from '../../../src/model/types.js';
import {
  focusPath,
  hasProposals,
  navigate as defaultNavigate,
  thumbUrl,
  type BusEvent,
  type LanePreviewPayload,
  type ProposalApi,
  type ThreadApi,
  type ThumbStatus,
} from '../api.js';
import { ContextChip, describeAnchor } from './ContextChip.js';
import { SlidePreview, type SlidePreviewProps } from './SlidePreview.js';

/** A line the screen (or the thread itself) adds to the conversation, eg "accepted into main as v8". Not stored. */
export interface ThreadNote {
  id: string;
  text: string;
  at: string;
}

export interface ThreadProps {
  threadKey: ThreadKey;
  /** Sent with every message; shown as the chip above the conversation. */
  context: Anchor;
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  /** With the ProposalApi calls too, a reply shows the lane it proposed, with its thumbs and accept / refuse. */
  api: ThreadApi & Partial<ProposalApi>;
  /** Server events; returns the unsubscribe function. */
  subscribe(handler: (e: BusEvent) => void): () => void;
  onClearContext?(): void;
  /** Adds an "edit" link to a slide context chip. */
  onEditContext?(slide: SlideId): void;
  /** What to ask for, shown while the thread is empty. */
  hint?: string;
  title?: string;
  /** A line under the title, eg the lane the thread belongs to. */
  subtitle?: string;
  /** `panel` fills its container with a scrolling log; `inline` grows with its messages inside a scrolling screen body. */
  layout?: 'panel' | 'inline';
  /** Follows a lane link of a reply. */
  navigate?(path: string): void;
  /** Lines the screen adds to the conversation, merged by time. */
  notes?: ThreadNote[];
  /** Only the turns sent on this anchor: each user message with that context and the replies that follow it. */
  only?: Anchor;
  /** Puts the caret in the composer when the thread mounts or changes key. */
  autoFocus?: boolean;
  /**
   * Shown between the header and the messages, eg the remarks of the selection. In a panel it scrolls on its own: it
   * takes the room the conversation leaves while that is empty, under half of it once messages arrive.
   */
  lead?: React.ReactNode;
  /** Inline only: the log stops growing at this height and scrolls, following the latest message. */
  logMaxHeight?: string;
  /**
   * Panel only: the lead and the log scroll together as one middle between the header and the composer, so the
   * composer is never pushed out however tall they grow; a fade at the middle's bottom says more lies below. Opening
   * keeps the top (the lead) in view; the middle follows the end only while a turn runs.
   */
  scrollBody?: boolean;
  /**
   * What a reply's proposal offers besides its before/after pair: `all` decides in place (accept, refuse, open in
   * focus); `focus-link` when the screen already lists the lane with its own accept and refuse; `none` on the focus
   * screen of that lane, where deciding and opening it are the screen itself.
   */
  proposalActions?: ProposalActions;
  /** `section` titles a panel like the sections beside it in a side column; `screen` (the default) like a screen's bar. */
  heading?: 'screen' | 'section';
  /** Messages of another thread shown read-only before this one's, under `label`: where the conversation started. */
  seed?: { label: string; messages: ThreadMessage[] };
  /**
   * Lanes the screen already lists: a stored reply gets the card of a lane created during its turn (between the
   * request and the reply) that answers that turn, so the proposal stays under it after a reload.
   */
  knownLanes?: readonly Lane[];
  /** Makes "lane: <label>" on a proposal card show that lane where the screen lists it, instead of a link to focus. */
  onShowLane?(laneId: string): void;
}

export type ProposalActions = 'all' | 'focus-link' | 'none';

const time = (iso: string): string => {
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
};

const TOOL_WORDS: Record<string, string> = {
  mcp__deck__get_deck: 'reading the deck', mcp__deck__get_slide: 'reading a slide', mcp__deck__render_slide: 'rendering',
  mcp__deck__propose_lane: 'proposing a lane', mcp__deck__revise_lane: 'revising the lane', mcp__deck__add_remark: 'writing a remark',
  mcp__deck__generate_image: 'generating an image', mcp__deck__run_check: 'running a check', mcp__deck__link_remark_lane: 'linking the remark',
  Read: 'reading a file', Glob: 'listing files', Grep: 'searching files', Bash: 'running a command', WebFetch: 'fetching a page', WebSearch: 'searching the web',
};
/** Elapsed time of a turn as m:ss. */
export function formatElapsed(ms: number): string {
  const s = Math.max(0, Math.floor(ms / 1000));
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
}

export function describeTool(name: string): string {
  return TOOL_WORDS[name] ?? name.replace(/^mcp__deck__/, '').replace(/_/g, ' ');
}

/** Minimal inline markdown: **bold**, `code`, *italic*. Anything else stays as written. */
export function renderInline(text: string): React.ReactNode[] {
  const out: React.ReactNode[] = [];
  const re = /(\*\*[^*]+\*\*|`[^`]+`|\*[^*\n]+\*)/g;
  let last = 0; let k = 0;
  for (const m of text.matchAll(re)) {
    const i = m.index ?? 0;
    if (i > last) out.push(text.slice(last, i));
    const tok = m[0];
    if (tok.startsWith('**')) out.push(<strong key={k++}>{tok.slice(2, -2)}</strong>);
    else if (tok.startsWith('`')) out.push(<code key={k++} className="mono">{tok.slice(1, -1)}</code>);
    else out.push(<em key={k++}>{tok.slice(1, -1)}</em>);
    last = i + tok.length;
  }
  if (last < text.length) out.push(text.slice(last));
  return out;
}

const targetOf = (c: Change): SlideId => (c.kind === 'insert' ? c.slide.id : c.slide);
const errorText = (err: unknown): string => (err instanceof Error ? err.message : String(err));

function sameAnchor(a: Anchor | null, b: Anchor | null): boolean {
  if (!a || !b) return false;
  if (a.kind === 'slide' && b.kind === 'slide') return a.slide === b.slide;
  if (a.kind === 'range' && b.kind === 'range') return a.from === b.from && a.to === b.to;
  return a.kind === 'arc' && b.kind === 'arc';
}

/**
 * Whether a lane the co-author created or revised during a turn answers that turn: the lane of a lane thread, a lane
 * on the turn's anchor, or a lane that changes the turn's slide. Drafts (proposed by checks) never do.
 */
export function laneAnswers(lane: Lane, context: Anchor, threadKey: ThreadKey): boolean {
  if (lane.status === 'draft') return false;
  if (threadKey === `lane:${lane.id}`) return true;
  if (sameAnchor(lane.anchor, context)) return true;
  return context.kind === 'slide' && lane.changes.some((c) => targetOf(c) === context.slide);
}

/** The pending changes a reply shows: those on the turn's slide when there are any, else all of them. */
export function changesToShow(lane: Lane, context: Anchor): Change[] {
  const pending = lane.status === 'open' ? lane.changes.filter((c) => c.status === 'pending') : [];
  if (context.kind !== 'slide') return pending;
  const here = pending.filter((c) => targetOf(c) === context.slide);
  return here.length > 0 ? here : pending;
}

/** Notes slotted between the messages by time; the messages keep their own order. */
function merge(messages: ThreadMessage[], notes: ThreadNote[]): ({ kind: 'message'; m: ThreadMessage } | { kind: 'note'; n: ThreadNote })[] {
  const rest = [...notes].sort((a, b) => a.at.localeCompare(b.at));
  const out: ({ kind: 'message'; m: ThreadMessage } | { kind: 'note'; n: ThreadNote })[] = [];
  for (const m of messages) {
    while (rest.length > 0 && rest[0]!.at < m.at) out.push({ kind: 'note', n: rest.shift()! });
    out.push({ kind: 'message', m });
  }
  for (const n of rest) out.push({ kind: 'note', n });
  return out;
}

/** The turns sent on `anchor`: a user message with that context opens a turn, the replies up to the next user message belong to it. */
export function turnsOn(messages: readonly ThreadMessage[], anchor: Anchor): ThreadMessage[] {
  let inside = false;
  return messages.filter((m) => {
    if (m.role === 'user') inside = sameAnchor(m.context, anchor);
    return inside;
  });
}

/** Each thumb of a proposal card's main/proposed pair: two fit side by side in the panel under the strip. */
const PAIR_WIDTH = 200;

const FIELDS = ['title', 'story', 'notes', 'body', 'assets', 'kind'] as const;
/** Body HTML as the words it shows, for a one-line diff. */
const plain = (html: string): string => html.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
const fieldText = (field: (typeof FIELDS)[number], value: unknown): string =>
  Array.isArray(value) ? value.join(', ') : field === 'body' ? plain(String(value ?? '')) : String(value ?? '');

/** One changed field of a proposal, as the card writes it: "title: Two answers → One home". An empty side is left out. */
export interface FieldLine {
  field: string;
  from: string;
  to: string;
}

/**
 * What a change does, one line per field: a modify lists each patched field whose value differs from main (main's
 * value, then the proposed one); an insert names the new slide, a remove the slide it drops, a move its two positions.
 */
export function fieldLines(c: Change, slides: Record<SlideId, Slide>, order: SlideId[], laneOrder?: SlideId[]): FieldLine[] {
  if (c.kind === 'insert') return [{ field: 'new slide', from: '', to: c.slide.title }];
  const before = slides[c.slide];
  if (c.kind === 'remove') return [{ field: 'removed', from: before?.title ?? 'a slide', to: '' }];
  if (c.kind === 'move') {
    const from = order.indexOf(c.slide);
    const to = laneOrder ? laneOrder.indexOf(c.slide) : -1;
    return [{ field: 'moved', from: from >= 0 ? `slide ${from + 1}` : '', to: to >= 0 ? `slide ${to + 1}` : '' }];
  }
  return FIELDS.flatMap((f) => {
    const next = c.patch[f];
    if (next === undefined) return [];
    const was = before?.[f];
    if (JSON.stringify(was) === JSON.stringify(next)) return [];
    return [{ field: f, from: fieldText(f, was), to: fieldText(f, next) }];
  });
}

const lineBox: CSSProperties = { margin: 0, fontSize: 'var(--fs-body)', lineHeight: 1.4, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

function FieldDiff({ line }: { line: FieldLine }) {
  const full = [line.from, line.to].filter(Boolean).join(' → ');
  return (
    <p data-testid="field-diff" data-field={line.field} title={`${line.field}: ${full}`} style={lineBox}>
      <span className="muted">{line.field}:</span> {line.from ? <span style={{ color: 'var(--grey)' }}>{line.from}</span> : null}
      {line.from && line.to ? ' ' : null}
      {line.from && line.to ? (
        <span data-testid="diff-arrow" className="muted">
          →
        </span>
      ) : null}
      {line.from && line.to ? ' ' : null}
      {line.to ? <span style={{ color: 'var(--ink)', fontWeight: 500 }}>{line.to}</span> : null}
    </p>
  );
}

interface ProposalProps {
  laneId: string;
  context: Anchor;
  threadKey: ThreadKey;
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  api: ProposalApi;
  subscribe(handler: (e: BusEvent) => void): () => void;
  navigate(path: string): void;
  onNote(text: string): void;
  actions: ProposalActions;
  onShowLane?(laneId: string): void;
}

/**
 * The lane a reply proposed, under that reply: its title as a link to its first pending change in focus, then per
 * change main's thumb against the lane's, the reason, accept, refuse and open in focus. A decision says itself here.
 */
function Proposal({ laneId, context, threadKey, order, slides, api, subscribe, navigate, onNote, actions, onShowLane }: ProposalProps) {
  const [data, setData] = useState<{ lane: Lane; preview: LanePreviewPayload | null } | null>(null);
  const [mainThumbs, setMainThumbs] = useState<Record<SlideId, ThumbStatus>>({});
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [ack, setAck] = useState<string | null>(null);
  const gen = useRef(0);

  const load = useCallback(async () => {
    const g = ++gen.current;
    try {
      const lane = await api.getLane(laneId);
      // A closed lane has no preview to ask for: its changes are all decided.
      const preview = lane.status === 'open' ? await api.getLanePreview(laneId) : null;
      if (g !== gen.current) return;
      setData({ lane, preview });
      setError(null);
      const ids = [...new Set(changesToShow(lane, context).filter((c) => c.kind !== 'insert').map(targetOf))];
      for (const id of ids) {
        const t = await api.thumbFor(id);
        if (g !== gen.current) return;
        setMainThumbs((prev) => ({ ...prev, [id]: t }));
      }
    } catch (err) {
      if (g === gen.current) setError(errorText(err));
    }
  }, [api, laneId, context]);

  useEffect(() => {
    void load();
    return subscribe((e) => {
      if ((e.type === 'lane.updated' || e.type === 'lane.closed') && e.laneId === laneId) void load();
      else if (e.type === 'deck.changed') void load();
      else if (e.type === 'thumb.ready') {
        setMainThumbs((prev) => {
          const hit = Object.keys(prev).filter((id) => prev[id]!.hash === e.hash && !prev[id]!.ready);
          if (hit.length === 0) return prev;
          return { ...prev, ...Object.fromEntries(hit.map((id) => [id, { hash: e.hash, ready: true }])) };
        });
        setData((prev) => {
          const thumbs = prev?.preview?.thumbs;
          if (!prev || !prev.preview || !thumbs) return prev;
          const hit = Object.keys(thumbs).filter((id) => thumbs[id]!.hash === e.hash && !thumbs[id]!.ready);
          if (hit.length === 0) return prev;
          return { ...prev, preview: { ...prev.preview, thumbs: { ...thumbs, ...Object.fromEntries(hit.map((id) => [id, { hash: e.hash, ready: true }])) } } };
        });
      }
    });
  }, [load, subscribe, laneId]);

  if (!data) return error ? <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>Could not load the proposed lane: {error}</p> : null;
  const { lane, preview } = data;
  if (!laneAnswers(lane, context, threadKey)) return null;

  const changes = changesToShow(lane, context);
  const first = lane.status === 'open' ? lane.changes.find((c) => c.status === 'pending') : undefined;
  const follow = (path: string) => (e: MouseEvent) => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    navigate(path);
  };
  const mainUrl = (id: SlideId): string | undefined => {
    const t = mainThumbs[id];
    return t?.ready ? thumbUrl(t.hash) : undefined;
  };
  const pair = (c: Change): [SlidePreviewProps, SlidePreviewProps] => {
    const id = targetOf(c);
    const mainAt = order.indexOf(id);
    const laneAt = preview ? preview.order.indexOf(id) : -1;
    const left: SlidePreviewProps =
      c.kind === 'insert'
        ? { label: 'main', variant: 'missing', missingText: 'not in main' }
        : mainAt < 0
          ? { label: 'main', variant: 'missing', missingText: 'no longer in main' }
          : { label: `main, slide ${mainAt + 1}`, variant: 'main', title: slides[id]?.title ?? id, url: mainUrl(id) };
    const thumb = preview?.thumbs[id];
    const right: SlidePreviewProps =
      !preview || preview.skipped.includes(c.id)
        ? { label: 'proposed', variant: 'missing', missingText: 'no longer applies on main' }
        : c.kind === 'remove' || laneAt < 0
          ? { label: 'proposed', variant: 'missing', missingText: 'removed' }
          : {
              label: `proposed, slide ${laneAt + 1}`,
              variant: 'lane',
              title: preview.slides[id]?.title ?? id,
              url: thumb ? (thumb.ready ? thumbUrl(thumb.hash) : undefined) : mainUrl(id),
            };
    return [left, right];
  };

  const decide = async (verb: 'accept' | 'refuse', c: Change): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      const text = verb === 'accept' ? `accepted into main as v${(await api.acceptChange(lane.id, c.id)).version.n}` : (await api.refuseChange(lane.id, c.id), 'refused');
      setAck(text);
      onNote(text);
      void load();
    } catch (err) {
      setError(errorText(err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div
      data-testid="thread-proposal"
      data-lane={lane.id}
      style={{ display: 'flex', flexDirection: 'column', gap: 12, marginTop: 6, padding: 12, borderRadius: 'var(--radius)', background: 'var(--card)', boxShadow: '0 0 0 1px var(--line)' }}
    >
      {actions !== 'none' && onShowLane ? (
        <button type="button" className="link" onClick={() => onShowLane(lane.id)} style={{ color: 'var(--ink)', fontWeight: 700, whiteSpace: 'normal', alignSelf: 'flex-start' }}>
          lane: {lane.label}
        </button>
      ) : first && actions !== 'none' ? (
        <a href={focusPath(lane.id, first.id)} onClick={follow(focusPath(lane.id, first.id))} className="link" style={{ color: 'var(--ink)', fontWeight: 700, whiteSpace: 'normal' }}>
          lane: {lane.label}
        </a>
      ) : (
        <span style={{ fontWeight: 700 }}>lane: {lane.label}</span>
      )}
      {changes.map((c) => {
        const [left, right] = pair(c);
        const href = focusPath(lane.id, c.id);
        return (
          <div key={c.id} data-testid="proposal-change" data-change={c.id} style={{ display: 'flex', flexDirection: 'column', gap: 8 }}>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 12 }}>
              <SlidePreview {...left} width={PAIR_WIDTH} />
              <SlidePreview {...right} width={PAIR_WIDTH} />
            </div>
            <div style={{ display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }}>
              {fieldLines(c, slides, order, preview?.order).map((l) => (
                <FieldDiff key={l.field} line={l} />
              ))}
            </div>
            <p className="meta" style={{ margin: 0, lineHeight: 1.4 }}>
              {c.kind}: {c.reason}
            </p>
            {actions === 'none' ? null : (
              <div style={{ display: 'flex', alignItems: 'center', gap: 10 }}>
                {actions === 'all' ? (
                  <>
                    <button type="button" className="btn-primary" disabled={busy} onClick={() => void decide('accept', c)}>
                      accept
                    </button>
                    <button type="button" className="btn" disabled={busy} onClick={() => void decide('refuse', c)}>
                      refuse
                    </button>
                  </>
                ) : null}
                <a href={href} onClick={follow(href)} className="link" style={actions === 'all' ? { marginLeft: 6 } : undefined}>
                  open in focus
                </a>
              </div>
            )}
          </div>
        );
      })}
      {ack ? (
        <p role="status" style={{ margin: 0, fontSize: 'var(--fs-body)', fontWeight: 500, color: 'var(--ink)' }}>
          {ack}
        </p>
      ) : null}
      {changes.length === 0 && !ack ? <p className="meta" style={{ margin: 0 }}>No change left to decide in this lane.</p> : null}
      {error ? (
        <p role="alert" style={{ margin: 0, fontSize: 12, color: 'var(--warn)' }}>
          {error}
        </p>
      ) : null}
    </div>
  );
}

/** A conversation with the co-author. The reply streams in from `assistant.delta`; on `assistant.done` the stored thread is reloaded. */
const DEFAULT_HINT =
  'Ask the co-author for a change. Select a slide (shift-click for a range) to anchor the request; with nothing selected it applies to the whole deck.';

/** The turn this thread started: what it was about, and the lanes created or revised while it ran. */
interface Turn {
  context: Anchor;
  lanes: Set<string>;
}

/**
 * Lanes each stored reply proposed, read from the lanes themselves: a lane created after the turn's request and no
 * later than the reply, that answers the turn's context, belongs under that reply.
 */
export function inferTurns(messages: readonly ThreadMessage[], lanes: readonly Lane[], threadKey: ThreadKey): Record<string, Turn> {
  const out: Record<string, Turn> = {};
  let ask: { at: string; context: Anchor } | null = null;
  for (const m of messages) {
    if (m.role === 'user') {
      ask = m.context ? { at: m.at, context: m.context } : null;
      continue;
    }
    if (!ask) continue;
    const { at, context } = ask;
    const hits = lanes.filter((l) => l.createdAt > at && l.createdAt <= m.at && laneAnswers(l, context, threadKey));
    if (hits.length > 0) out[m.id] = { context, lanes: new Set(hits.map((l) => l.id)) };
  }
  return out;
}

export function Thread({
  threadKey,
  context,
  order,
  slides,
  api,
  subscribe,
  onClearContext,
  onEditContext,
  hint = DEFAULT_HINT,
  title = 'Thread',
  subtitle,
  layout = 'panel',
  navigate = defaultNavigate,
  notes,
  only,
  autoFocus = false,
  lead,
  logMaxHeight,
  scrollBody = false,
  proposalActions = 'all',
  seed,
  heading = 'screen',
  knownLanes,
  onShowLane,
}: ThreadProps) {
  const [messages, setMessages] = useState<ThreadMessage[]>([]);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [streaming, setStreaming] = useState('');
  const [tool, setTool] = useState<string | null>(null);
  const [agentError, setAgentError] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  // From Send to the reply: the row that says the co-author works, with its timer and the last tool it ran.
  const [pending, setPending] = useState<{ since: number; context: Anchor; tool: string | null } | null>(null);
  const [now, setNow] = useState(() => Date.now());
  // Lanes each reply proposed, by message id; only known for the turns sent from this screen.
  const [attached, setAttached] = useState<Record<string, Turn>>({});
  const [ownNotes, setOwnNotes] = useState<ThreadNote[]>([]);
  const turn = useRef<Turn | null>(null);
  const log = useRef<HTMLDivElement>(null);
  const body = useRef<HTMLDivElement>(null);
  const composer = useRef<HTMLInputElement>(null);

  const load = useCallback(async (): Promise<ThreadMessage[] | null> => {
    try {
      const list = await api.getThread(threadKey);
      setMessages(list);
      setLoadError(null);
      return list;
    } catch (err) {
      setLoadError(errorText(err));
      return null;
    }
  }, [api, threadKey]);

  useEffect(() => {
    setMessages([]);
    setStreaming('');
    setPending(null);
    setAttached({});
    setOwnNotes([]);
    turn.current = null;
    void load();
    return subscribe((e) => {
      if (e.type === 'hello') {
        // The socket (re)opened: deltas or the done event may have been lost while it was down.
        setTool(null);
        setStreaming('');
        void load().then((list) => {
          // The reply landed while the socket was down: the turn is over.
          if (list && list.at(-1)?.role === 'assistant') {
            turn.current = null;
            setPending(null);
          }
        });
        return;
      }
      if ((e.type === 'lane.created' || e.type === 'lane.updated') && turn.current) {
        turn.current.lanes.add(e.laneId);
        return;
      }
      if (!('thread' in e) || e.thread !== threadKey) return;
      if (e.type === 'assistant.delta') {
        setStreaming((s) => s + e.text);
        setTool(null);
      } else if (e.type === 'tool.call') {
        setTool(e.name);
        setPending((p) => (p ? { ...p, tool: e.name } : p));
      } else if (e.type === 'assistant.done') {
        setTool(null);
        setPending(null);
        const done = turn.current;
        turn.current = null;
        if (done && done.lanes.size > 0) setAttached((a) => ({ ...a, [e.messageId]: done }));
        void load().then(() => setStreaming(''));
      } else if (e.type === 'agent.error') {
        setTool(null);
        setStreaming('');
        setPending(null);
        turn.current = null;
        setAgentError(e.message);
      }
    });
  }, [threadKey, load, subscribe]);

  // The pending row's timer ticks once a second while the co-author works.
  const since = pending?.since ?? null;
  useEffect(() => {
    if (since === null) return;
    setNow(Date.now());
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, [since]);

  useEffect(() => {
    if (autoFocus) composer.current?.focus({ preventScroll: true });
  }, [autoFocus, threadKey]);

  // Scroll the log itself: scrollIntoView would also scroll every ancestor, the page included. Inline, the screen
  // scrolls, unless the log has a height of its own.
  const ownScroll = layout === 'panel' || logMaxHeight !== undefined;
  // The seed arrives on its own, above the messages: it pushes the newest one down, so it scrolls the log as well.
  const seedMessages = seed?.messages;
  const pinned = scrollBody && layout === 'panel';
  const live = pending !== null || streaming !== '';
  useEffect(() => {
    // A pinned panel's middle starts on its lead; it follows the end once a turn runs.
    const el = pinned ? body.current : log.current;
    if (el && ownScroll && (!pinned || live)) el.scrollTop = el.scrollHeight;
  }, [messages, streaming, pending, ownScroll, pinned, live, seedMessages, notes, ownNotes]);

  // The pinned middle's bottom fade: while more of it lies below its visible end.
  const [more, setMore] = useState(false);
  const measureMore = useCallback(() => {
    const el = body.current;
    setMore(el !== null && el.scrollHeight - el.clientHeight - el.scrollTop > 1);
  }, []);
  useLayoutEffect(() => {
    if (pinned) measureMore();
  });
  useEffect(() => {
    const el = body.current;
    if (!pinned || !el) return;
    el.addEventListener('scroll', measureMore, { passive: true });
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(measureMore);
    ro?.observe(el);
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(measureMore);
    mo?.observe(el, { childList: true, subtree: true, characterData: true });
    return () => {
      el.removeEventListener('scroll', measureMore);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [pinned, measureMore]);

  const addNote = useCallback((text: string) => {
    const at = new Date().toISOString();
    setOwnNotes((n) => [...n, { id: `note-${at}-${n.length}`, text, at }]);
  }, []);

  const submit = async (ev: FormEvent) => {
    ev.preventDefault();
    const text = draft.trim();
    if (!text || sending) return;
    setSending(true);
    setAgentError(null);
    const at = new Date();
    const local: ThreadMessage = { id: `local-${at.getTime()}`, thread: threadKey, role: 'user', text, context, at: at.toISOString() };
    setMessages((m) => [...m, local]);
    setDraft('');
    turn.current = { context, lanes: new Set() };
    setPending({ since: at.getTime(), context, tool: null });
    try {
      await api.postMessage(threadKey, text, context);
    } catch (err) {
      setMessages((m) => m.filter((x) => x.id !== local.id));
      setDraft(text);
      turn.current = null;
      setPending(null);
      setAgentError(errorText(err));
    } finally {
      setSending(false);
    }
  };

  const proposals = hasProposals(api) ? api : null;
  const shown = only ? turnsOn(messages, only) : messages;
  const inferred = knownLanes ? inferTurns(shown, knownLanes, threadKey) : {};
  // A turn seen live knows its lanes (revisions too); a stored one falls back on the lanes created during it.
  const turns: Record<string, Turn> = { ...inferred, ...attached };
  const items = merge(shown, [...(notes ?? []), ...ownNotes]);
  const inline = layout === 'inline';
  const root: CSSProperties = inline
    ? { display: 'flex', flexDirection: 'column', gap: 12 }
    : pinned
      ? { display: 'flex', flexDirection: 'column', flex: '1 1 0', minHeight: 0, overflow: 'hidden' }
      : { display: 'flex', flexDirection: 'column', height: '100%', minHeight: 0 };
  // A panel's empty log is its hint only: the lead above takes the room, the composer stays at the bottom.
  const quiet = shown.length === 0 && !streaming && !pending;
  const logStyle: CSSProperties = inline
    ? { display: 'flex', flexDirection: 'column', gap: 16, ...(logMaxHeight ? { maxHeight: logMaxHeight, overflowY: 'auto' } : {}) }
    : pinned
      ? { flex: '0 0 auto', padding: '4px 20px 12px', display: 'flex', flexDirection: 'column', gap: 16 }
      : { flex: quiet && lead ? '0 0 auto' : '1 1 0', minHeight: 0, overflowY: 'auto', padding: '4px 20px', display: 'flex', flexDirection: 'column', gap: 16 };
  const textStyle: CSSProperties = { fontSize: inline ? 'var(--fs-body)' : 13, lineHeight: 1.5, whiteSpace: 'pre-wrap' };

  const logView = (
    <div ref={log} role="log" aria-live="polite" style={logStyle}>
      {seed && seed.messages.length > 0 ? (
        <div data-testid="thread-seed" style={{ display: 'flex', flexDirection: 'column', gap: 8, paddingBottom: 12, borderBottom: '1px solid var(--line)' }}>
          <span className="meta">{seed.label}</span>
          {seed.messages.map((m) => (
            <div key={m.id} data-testid="seed-message" data-role={m.role} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
                <strong style={{ fontWeight: 700, color: 'var(--ink)' }}>{m.role === 'assistant' ? 'co-author' : 'you'}</strong>
                <span className="muted">{time(m.at)}</span>
              </div>
              <div style={{ ...textStyle, color: 'var(--grey)' }}>{renderInline(m.text)}</div>
            </div>
          ))}
        </div>
      ) : null}
      {loadError ? <p style={{ color: 'var(--warn)', fontSize: 12, margin: 0 }}>Could not load the thread: {loadError}</p> : null}
      {!loadError && shown.length === 0 && !streaming && !pending ? (
        <p className="muted" style={{ fontSize: 13, margin: 0, lineHeight: 1.5 }}>
          {hint}
        </p>
      ) : null}
      {items.map((item) =>
        item.kind === 'note' ? (
          <p key={item.n.id} data-testid="thread-note" className="meta" style={{ margin: 0, color: 'var(--ink)' }}>
            {item.n.text}
          </p>
        ) : (
          <div key={item.m.id} data-testid="thread-message" data-role={item.m.role} style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
            <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', fontSize: 12 }}>
              <strong style={{ fontWeight: 700, color: 'var(--ink)' }}>{item.m.role === 'assistant' ? 'co-author' : 'you'}</strong>
              <span className="muted">{time(item.m.at)}</span>
              {item.m.role === 'user' && item.m.context && !sameAnchor(item.m.context, context) ? (
                <span data-testid="message-context" className="muted">
                  on {describeAnchor(item.m.context, order, slides)}
                </span>
              ) : null}
            </div>
            <div style={textStyle}>{renderInline(item.m.text)}</div>
            {proposals && turns[item.m.id]
              ? [...turns[item.m.id]!.lanes].map((laneId) => (
                  <Proposal
                    key={laneId}
                    laneId={laneId}
                    context={turns[item.m.id]!.context}
                    threadKey={threadKey}
                    order={order}
                    slides={slides}
                    api={proposals}
                    subscribe={subscribe}
                    navigate={navigate}
                    onNote={addNote}
                    actions={proposalActions}
                    onShowLane={onShowLane}
                  />
                ))
              : null}
          </div>
        ),
      )}
      {pending ? (
        <p data-testid="thread-pending" role="status" style={{ margin: 0, display: 'flex', flexWrap: 'wrap', alignItems: 'baseline', gap: 12, fontSize: 12 }}>
          <span style={{ color: 'var(--ink)', fontWeight: 500 }}>co-author is working on {describeAnchor(pending.context, order, slides)}</span>
          <span data-testid="thread-elapsed" className="mono muted">
            {formatElapsed(now - pending.since)}
          </span>
          {pending.tool ? <span className="muted">{describeTool(pending.tool)}</span> : null}
        </p>
      ) : null}
      {streaming || (tool && !pending) ? (
        <div data-testid="thread-streaming" style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
          <strong style={{ fontSize: 12, color: 'var(--ink)' }}>co-author</strong>
          {streaming ? <div style={textStyle}>{streaming}</div> : null}
          {tool && !pending ? <span className="meta">{describeTool(tool)}…</span> : null}
        </div>
      ) : null}
      {agentError ? (
        <p role="alert" style={{ color: 'var(--warn)', fontSize: 12, margin: 0 }}>
          {agentError}
        </p>
      ) : null}
    </div>
  );

  return (
    <div data-testid="thread" data-thread={threadKey} data-layout={layout} style={root}>
      <div style={inline ? { display: 'flex', alignItems: 'baseline', flexWrap: 'wrap', gap: 12 } : { flex: '0 0 auto', padding: heading === 'section' ? '14px 20px 8px' : '18px 20px 12px', display: 'flex', flexDirection: 'column', gap: heading === 'section' ? 8 : 12 }}>
        <div>
          <h2 className={inline || heading === 'section' ? 'row-label' : 'screen-title'} style={inline || heading === 'section' ? { margin: 0 } : undefined}>
            {title}
          </h2>
          {subtitle ? <p className="meta" style={{ margin: '2px 0 0' }}>{subtitle}</p> : null}
        </div>
        <div>
          <ContextChip context={context} order={order} slides={slides} onClear={onClearContext} onEdit={onEditContext} />
        </div>
      </div>
      {pinned ? null : lead && !inline ? (
        <div data-testid="thread-lead" style={{ flex: '0 1 auto', minHeight: 0, maxHeight: quiet ? undefined : '45%', overflowY: 'auto', padding: '0 20px 12px' }}>
          {lead}
        </div>
      ) : (
        lead
      )}
      {pinned ? (
        <div ref={body} data-testid="thread-body" className="thread-body" style={{ flex: '1 1 0', minHeight: 0, overflowY: 'auto', overflowX: 'hidden', display: 'flex', flexDirection: 'column' }}>
          {lead ? (
            <div data-testid="thread-lead" style={{ flex: '0 0 auto', padding: '0 20px 12px' }}>
              {lead}
            </div>
          ) : null}
          {logView}
          {more ? <div data-testid="panel-fade" className="panel-fade" aria-hidden /> : null}
        </div>
      ) : (
        logView
      )}
      <form onSubmit={(e) => void submit(e)} style={inline ? { display: 'flex', gap: 8 } : { display: 'flex', flexShrink: 0, gap: 8, padding: 16, marginTop: 'auto', borderTop: '1px solid var(--line)' }}>
        <input
          ref={composer}
          aria-label="message"
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="Write a message…"
          style={{ flex: 1, minWidth: 0, padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--line)', background: 'var(--card)', font: 'inherit', color: 'var(--ink)' }}
        />
        <button type="submit" disabled={sending || draft.trim() === ''} className="btn-primary">
          Send
        </button>
      </form>
    </div>
  );
}
