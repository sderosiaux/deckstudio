import { useLayoutEffect, useRef, useState, type CSSProperties, type MouseEvent } from 'react';
import type { Anchor, Remark as RemarkT, SlideId } from '../../../src/model/types.js';

/** Short anchor label against main's current order: "slide 6", "slides 14–19", "arc". */
export function anchorLabel(anchor: Anchor, order: SlideId[]): string {
  const num = (id: SlideId): string => {
    const i = order.indexOf(id);
    return i < 0 ? '?' : String(i + 1);
  };
  if (anchor.kind === 'arc') return 'arc';
  if (anchor.kind === 'slide') return `slide ${num(anchor.slide)}`;
  const [a, b] = [order.indexOf(anchor.from), order.indexOf(anchor.to)];
  const [from, to] = a <= b ? [anchor.from, anchor.to] : [anchor.to, anchor.from];
  return `slides ${num(from)}–${num(to)}`;
}

export interface RemarkCardProps {
  remark: RemarkT;
  order: SlideId[];
  onShow(anchor: Anchor): void;
  onPropose(id: string): Promise<void>;
  /** Focus route of the lane answering this remark, when that lane still has pending changes. */
  laneHref?: string | undefined;
  onOpenLane?(href: string): void;
  /** Set when `remark.laneId` is a draft lane (proposed by a check, not on main yet): opening it replaces "propose". */
  draftLaneId?: string | undefined;
  onOpenDraft?(laneId: string): Promise<void>;
  /** Created by the latest run of its check, after the run this screen saw before. */
  isNew?: boolean;
}

const chip: CSSProperties = { display: 'inline-block', padding: '2px 8px', borderRadius: 4, border: '1px solid var(--line)', fontSize: 12, fontWeight: 500, color: 'var(--ink)' };

/** One remark from a check: where it points, what it says, and the two ways to act on it. */
export function RemarkCard({ remark, order, onShow, onPropose, laneHref, onOpenLane, draftLaneId, onOpenDraft, isNew = false }: RemarkCardProps) {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'sending' } | { kind: 'sent' } | { kind: 'opened' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const act = (fn: () => Promise<void>, done: 'sent' | 'opened'): void => {
    setState({ kind: 'sending' });
    fn().then(
      () => setState({ kind: done }),
      (err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };
  const propose = (): void => act(() => onPropose(remark.id), 'sent');
  const draft = draftLaneId !== undefined && onOpenDraft !== undefined;
  return (
    <div
      data-testid="remark"
      data-remark={remark.id}
      data-severity={remark.severity}
      style={{ border: '1px solid var(--line)', borderRadius: 'var(--radius)', padding: 12, display: 'flex', flexDirection: 'column', gap: 8, background: 'var(--card)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span data-testid="anchor-chip" style={chip}>{anchorLabel(remark.anchor, order)}</span>
        {isNew ? (
          <span data-testid="remark-new" style={{ color: 'var(--accent)', fontSize: 12, fontWeight: 700 }}>new</span>
        ) : null}
        {remark.severity === 'info' ? <span className="muted" title={SEVERITY_HINT.info} style={{ fontSize: 12 }}>info</span> : null}
        {draft ? (
          <button
            type="button"
            disabled={state.kind === 'sending'}
            onClick={() => act(() => onOpenDraft(draftLaneId), 'opened')}
            className="link"
            style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink)' }}
          >
            open draft lane
          </button>
        ) : remark.laneId ? (
          laneHref ? (
            <a
              href={laneHref}
              data-testid="lane-ready"
              onClick={(e) => {
                if (!onOpenLane) return;
                e.preventDefault();
                onOpenLane(laneHref);
              }}
              className="link"
              style={{ marginLeft: 'auto', fontSize: 12, color: 'var(--ink)' }}
            >
              lane ready
            </a>
          ) : (
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>lane closed</span>
          )
        ) : null}
      </div>
      <p style={{ margin: 0, fontSize: 13, lineHeight: 1.45 }}>{remark.text}</p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" className="btn" onClick={() => onShow(remark.anchor)}>show</button>
        {draft ? null : (
          <button type="button" className="btn" disabled={state.kind === 'sending'} onClick={propose}>propose</button>
        )}
        {state.kind === 'sent' ? <span className="muted" style={{ fontSize: 12 }}>asked the co-author; the lane appears on main</span> : null}
        {state.kind === 'opened' ? <span className="muted" style={{ fontSize: 12 }}>lane opened on main</span> : null}
        {state.kind === 'error' ? <span style={{ fontSize: 12, color: 'var(--warn)' }}>{state.message}</span> : null}
      </div>
    </div>
  );
}

export interface PostItProps {
  remark: RemarkT;
  onPropose(id: string): Promise<void>;
  onResolve(id: string): Promise<unknown>;
  /** Set when `remark.laneId` is a draft lane: the card offers to open it instead of proposing. */
  draftLaneId?: string | undefined;
  onOpenLane?(laneId: string): Promise<void>;
  /** The current selection is on this remark's slides: the one card with an accent border. */
  selected?: boolean;
  /** The lane linked to this remark is open on main: the card names it, as a link that brings its row into view. */
  openedLane?: { label: string; onShow(): void } | undefined;
  /** A click on the text opens it whole (and closes it again); without it the text stays cut at three lines. */
  expandable?: boolean;
}

/** A click on a card's action is that action only: it never reaches the card, which selects the remark's slides. */
const only = (fn: () => void) => (e: MouseEvent): void => {
  e.stopPropagation();
  fn();
};

const CLAMP_LINES = 3;

const SEVERITY_HINT: Record<RemarkT['severity'], string> = {
  info: 'info: worth a look, nothing is broken',
  warn: 'warn: the check found a problem on these slides',
};
const LINE_H = 1.35;

/**
 * The longest start of `text` that `fits`, cut after a whole word and ended with an ellipsis; the text itself when
 * it fits whole. A single word too long for the box is still kept whole.
 */
export function cutAtWord(text: string, fits: (candidate: string) => boolean): string {
  if (fits(text)) return text;
  const words = text.split(/\s+/).filter(Boolean);
  const cut = (n: number): string => `${words.slice(0, n).join(' ')}…`;
  let lo = 1;
  let hi = words.length - 1;
  while (lo < hi) {
    const mid = Math.ceil((lo + hi) / 2);
    if (fits(cut(mid))) lo = mid;
    else hi = mid - 1;
  }
  return lo >= words.length ? text : cut(lo);
}

/**
 * The text on `lines` lines at most, cut after a whole word. Measured in the browser on an invisible probe of the
 * same width, again when the card changes width; in jsdom, where nothing has a height, the full text stays.
 */
function WordClamp({ text, lines }: { text: string; lines: number }) {
  // React never fills the probe: trial cuts are written there, then it is emptied.
  const probe = useRef<HTMLSpanElement>(null);
  const [shown, setShown] = useState(text);
  useLayoutEffect(() => {
    const el = probe.current;
    if (!el) return;
    const fit = (): void => {
      const max = (parseFloat(getComputedStyle(el).lineHeight) || 0) * lines + 1;
      el.textContent = text;
      const measurable = el.scrollHeight > 0 && max > 1;
      const next = measurable
        ? cutAtWord(text, (candidate) => {
            el.textContent = candidate;
            return el.scrollHeight <= max;
          })
        : text;
      el.textContent = '';
      setShown(next);
    };
    fit();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(() => fit());
    ro?.observe(el);
    return () => ro?.disconnect();
  }, [text, lines]);
  const box: CSSProperties = { display: 'block', lineHeight: LINE_H, overflowWrap: 'normal', wordBreak: 'normal' };
  return (
    <span style={{ position: 'relative', display: 'block' }}>
      <span style={{ ...box, color: 'var(--ink)' }}>{shown}</span>
      <span ref={probe} aria-hidden style={{ ...box, position: 'absolute', top: 0, left: 0, right: 0, visibility: 'hidden', pointerEvents: 'none' }} />
    </span>
  );
}

/** A remark pinned under its slide: a plain card with the text (three lines at most, cut after a word), propose and resolve. Fills its slot's width. */
export function RemarkPostIt({ remark, onPropose, onResolve, draftLaneId, onOpenLane, selected = false, openedLane, expandable = false }: PostItProps) {
  const [expanded, setExpanded] = useState(false);
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'sent' } | { kind: 'opened' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const draft = draftLaneId !== undefined && onOpenLane !== undefined && !openedLane;
  const act = (fn: () => Promise<unknown>, after: 'idle' | 'sent' | 'opened'): void => {
    setState({ kind: 'busy' });
    fn().then(
      () => setState({ kind: after }),
      (err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };
  const verb: CSSProperties = { fontSize: 12, fontWeight: 500, color: 'var(--ink)' };
  return (
    <div
      data-testid="post-it"
      data-remark={remark.id}
      data-selected={selected ? 'true' : undefined}
      title={remark.text}
      style={{
        position: 'relative',
        zIndex: 1,
        width: '100%',
        minWidth: 0,
        padding: '8px 10px',
        borderRadius: 'var(--radius)',
        background: 'var(--card)',
        border: `1px solid ${selected ? 'var(--accent)' : 'var(--line)'}`,
        fontSize: 13,
        lineHeight: 1.35,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
        transition: 'border-color .15s ease',
      }}
    >
      {expandable ? (
        <button
          type="button"
          data-testid="remark-text"
          aria-expanded={expanded}
          onClick={only(() => setExpanded((x) => !x))}
          title={expanded ? 'show less' : 'show the whole remark'}
          style={{ all: 'unset', cursor: 'pointer', display: 'block', minWidth: 0 }}
        >
          {expanded ? <span style={{ display: 'block', lineHeight: LINE_H, color: 'var(--ink)', whiteSpace: 'pre-wrap' }}>{remark.text}</span> : <WordClamp text={remark.text} lines={CLAMP_LINES} />}
        </button>
      ) : (
        <WordClamp text={remark.text} lines={CLAMP_LINES} />
      )}
      {draft ? (
        <span data-testid="draft-ready" className="meta">
          {state.kind === 'opened' ? 'opening…' : 'draft ready'}
        </span>
      ) : null}
      {openedLane ? (
        <button type="button" className="link" data-testid="lane-opened" onClick={only(openedLane.onShow)} style={{ ...verb, overflowWrap: 'anywhere', whiteSpace: 'normal' }}>
          lane opened: {openedLane.label}
        </button>
      ) : null}
      {/* Actions wrap inside the card: a narrow card stacks them, never spills them over its border. */}
      <div style={{ display: 'flex', flexWrap: 'wrap', columnGap: 12, rowGap: 4, alignItems: 'center', minWidth: 0 }}>
        {openedLane ? null : draft ? (
          <button type="button" className="link" disabled={state.kind === 'busy' || state.kind === 'opened'} onClick={only(() => act(() => onOpenLane(draftLaneId), 'opened'))} style={verb}>
            open lane
          </button>
        ) : (
          <button type="button" className="link" disabled={state.kind === 'busy'} onClick={only(() => act(() => onPropose(remark.id), 'sent'))} style={verb}>
            {state.kind === 'sent' ? 'asked' : 'propose'}
          </button>
        )}
        <button type="button" className="link" aria-label="resolve" disabled={state.kind === 'busy'} onClick={only(() => act(() => onResolve(remark.id), 'idle'))} style={{ fontSize: 12 }}>
          resolve
        </button>
        {state.kind === 'error' ? <span style={{ fontSize: 12, color: 'var(--warn)' }} title={state.message}>failed</span> : null}
        {/* The severity is a fact about the remark, not an action: a plain muted word at the end, explained on hover. */}
        <span data-testid="severity-tag" className="meta" data-severity={remark.severity} title={SEVERITY_HINT[remark.severity]} style={{ marginLeft: 'auto', cursor: 'default' }}>
          {remark.severity}
        </span>
      </div>
    </div>
  );
}
