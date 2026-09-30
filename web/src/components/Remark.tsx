import { useState, type CSSProperties } from 'react';
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

const chip: CSSProperties = { display: 'inline-block', padding: '4px 10px', borderRadius: 8, background: 'var(--line)', fontSize: 12, fontWeight: 600, color: 'var(--ink)' };
const btn = (primary: boolean): CSSProperties => ({
  padding: '8px 18px',
  borderRadius: 8,
  border: 'none',
  cursor: 'pointer',
  fontWeight: 600,
  fontSize: 13,
  background: primary ? '#FBE3DA' : 'var(--line)',
  color: primary ? 'var(--accent)' : 'var(--ink)',
  transition: 'filter .15s ease',
});

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
      style={{ border: '1px solid var(--line)', borderRadius: 10, padding: 14, display: 'flex', flexDirection: 'column', gap: 10, background: 'var(--card)' }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
        <span data-testid="anchor-chip" style={chip}>{anchorLabel(remark.anchor, order)}</span>
        {isNew ? (
          <span data-testid="remark-new" style={{ padding: '2px 8px', borderRadius: 6, background: '#FBE3DA', color: 'var(--accent)', fontSize: 11, fontWeight: 700 }}>new</span>
        ) : null}
        {remark.severity === 'info' ? <span className="muted" style={{ fontSize: 12 }}>info</span> : null}
        {draft ? (
          <button
            type="button"
            disabled={state.kind === 'sending'}
            onClick={() => act(() => onOpenDraft(draftLaneId), 'opened')}
            style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, border: 'none', cursor: 'pointer', background: '#E3F1E8', color: 'var(--ok)', fontSize: 12, fontWeight: 600 }}
          >
            draft ready · open
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
              style={{ marginLeft: 'auto', padding: '3px 10px', borderRadius: 6, background: '#E3F1E8', color: 'var(--ok)', fontSize: 12, fontWeight: 600, textDecoration: 'none' }}
            >
              lane ready
            </a>
          ) : (
            <span className="muted" style={{ marginLeft: 'auto', fontSize: 12 }}>lane closed</span>
          )
        ) : null}
      </div>
      <p style={{ margin: 0, fontSize: 14, lineHeight: 1.4 }}>{remark.text}</p>
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        <button type="button" style={btn(false)} onClick={() => onShow(remark.anchor)}>show</button>
        {draft ? null : (
          <button type="button" style={btn(true)} disabled={state.kind === 'sending'} onClick={propose}>propose</button>
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
  /** Set when `remark.laneId` is a draft lane: the post-it offers to open it instead of proposing. */
  draftLaneId?: string | undefined;
  onOpenLane?(laneId: string): Promise<void>;
}

const POST_IT_CHARS = 90;

/** A remark pinned under its slide: truncated text, propose, resolve. Fills its container's width (a column, or the columns of a range). */
export function RemarkPostIt({ remark, onPropose, onResolve, draftLaneId, onOpenLane }: PostItProps) {
  const [state, setState] = useState<{ kind: 'idle' } | { kind: 'busy' } | { kind: 'sent' } | { kind: 'opened' } | { kind: 'error'; message: string }>({ kind: 'idle' });
  const draft = draftLaneId !== undefined && onOpenLane !== undefined;
  const act = (fn: () => Promise<unknown>, after: 'idle' | 'sent' | 'opened'): void => {
    setState({ kind: 'busy' });
    fn().then(
      () => setState({ kind: after }),
      (err: unknown) => setState({ kind: 'error', message: err instanceof Error ? err.message : String(err) }),
    );
  };
  const short = remark.text.length > POST_IT_CHARS ? `${remark.text.slice(0, POST_IT_CHARS - 1).trimEnd()}…` : remark.text;
  const warn = remark.severity === 'warn';
  return (
    <div
      data-testid="post-it"
      data-remark={remark.id}
      title={remark.text}
      style={{
        boxSizing: 'border-box',
        width: '100%',
        padding: '8px 10px',
        borderRadius: 6,
        background: warn ? '#FDF1EC' : '#FBF6E3',
        borderLeft: `3px solid ${warn ? 'var(--warn)' : 'var(--grey-2)'}`,
        fontSize: 12,
        lineHeight: 1.35,
        display: 'flex',
        flexDirection: 'column',
        gap: 6,
      }}
    >
      <span style={{ color: 'var(--ink)' }}>{short}</span>
      {draft ? (
        <span data-testid="draft-ready" style={{ color: 'var(--ok)', fontWeight: 700 }}>
          {state.kind === 'opened' ? 'opening…' : 'draft ready'}
        </span>
      ) : null}
      <div style={{ display: 'flex', gap: 10, alignItems: 'center' }}>
        {draft ? (
          <button
            type="button"
            disabled={state.kind === 'busy' || state.kind === 'opened'}
            onClick={() => act(() => onOpenLane(draftLaneId), 'opened')}
            style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', fontWeight: 700 }}
          >
            open lane
          </button>
        ) : (
          <button
            type="button"
            disabled={state.kind === 'busy'}
            onClick={() => act(() => onPropose(remark.id), 'sent')}
            style={{ all: 'unset', cursor: 'pointer', color: 'var(--accent)', fontWeight: 700 }}
          >
            {state.kind === 'sent' ? 'asked' : 'propose'}
          </button>
        )}
        <button
          type="button"
          aria-label="resolve"
          disabled={state.kind === 'busy'}
          onClick={() => act(() => onResolve(remark.id), 'idle')}
          style={{ all: 'unset', cursor: 'pointer', color: 'var(--grey)' }}
        >
          resolve
        </button>
        {state.kind === 'error' ? <span style={{ color: 'var(--warn)' }} title={state.message}>failed</span> : null}
      </div>
    </div>
  );
}
