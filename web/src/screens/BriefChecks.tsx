import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Anchor, Brief, Lane, Remark, SlideId } from '../../../src/model/types.js';
import {
  briefChecksApi,
  focusPath,
  mainPath,
  navigate as defaultNavigate,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BriefChecksApi,
  type BusEvent,
  type CheckName,
  type ChecksStatus,
  type DeckPayload,
} from '../api.js';
import { anchorColumns } from '../components/LaneRow.js';
import { RemarkCard } from '../components/Remark.js';
import { Thumb } from '../components/Thumb.js';
import { ScreenHeader } from '../components/ScreenHeader.js';

export interface BriefChecksProps {
  api?: BriefChecksApi;
  subscribe?(handler: (e: BusEvent) => void): () => void;
  navigate?(path: string): void;
}

export const CHECK_ROWS: { name: CheckName; label: string }[] = [
  { name: 'arc', label: 'narrative arc' },
  { name: 'order', label: 'concept order' },
  { name: 'gaps', label: 'gaps vs abstract' },
  { name: 'render', label: 'render' },
];

const PATTERNS: { value: Brief['pattern']; label: string }[] = [
  { value: 'solution-first', label: 'solution first, then decompose' },
  { value: 'problem-driven', label: 'problem by problem, build up' },
];

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; deck: DeckPayload };
type Save = { kind: 'idle' } | { kind: 'saving' } | { kind: 'saved' } | { kind: 'error'; message: string };

const message = (err: unknown): string => (err instanceof Error ? err.message : String(err));
const sameBrief = (a: Brief, b: Brief): boolean =>
  a.title === b.title && a.audience === b.audience && a.message === b.message && a.pattern === b.pattern && a.abstract === b.abstract;
// Remarks from a lane-scoped run describe that lane's preview, not main: they are shown on the lane row, not here.
const openOf = (rs: Remark[], name: CheckName): Remark[] => rs.filter((r) => r.status === 'open' && r.origin === `check:${name}` && !r.sourceLaneId);
const hasWarn = (rs: Remark[], name: CheckName): boolean => openOf(rs, name).some((r) => r.severity === 'warn');

/** The draft lane a remark points at, if any: a check proposed it and the creator has not opened it yet. */
function draftLaneOf(lanes: Lane[], laneId: string | null): string | undefined {
  return laneId && lanes.some((l) => l.id === laneId && l.status === 'draft') ? laneId : undefined;
}

export type DotState = 'idle' | 'running' | 'ok' | 'warn';

/** Grey until the check has run once: green must mean "ran and found nothing", not "never looked". */
export function dotState({ running, warn, ran }: { running: boolean; warn: boolean; ran: boolean }): DotState {
  if (running) return 'running';
  if (warn) return 'warn';
  return ran ? 'ok' : 'idle';
}

const DOT: Record<DotState, { label: string; style: CSSProperties }> = {
  idle: { label: 'not run yet', style: { background: 'var(--grey-2)' } },
  running: { label: 'running', style: { background: 'var(--grey)', animation: 'check-dot-pulse 1.1s ease-in-out infinite' } },
  ok: { label: 'no warnings', style: { background: 'var(--ok)' } },
  warn: { label: 'has warnings', style: { background: 'var(--accent)' } },
};
const DOT_CSS = `
@keyframes check-dot-pulse { 0%, 100% { opacity: 1; transform: scale(1); } 50% { opacity: .35; transform: scale(.7); } }
@media (prefers-reduced-motion: reduce) { [data-testid="check-dot"][data-status="running"] { animation-duration: 3s !important; } }
`;

/** Rows a textarea needs to show `text` without scrolling: one per hard line, long lines wrapped at `perLine` characters. */
export function autoRows(text: string, min: number, perLine = 44): number {
  const rows = text.split('\n').reduce((n, line) => n + Math.max(1, Math.ceil(line.length / perLine)), 0);
  return Math.max(min, rows);
}

/** Focus route for the first pending change of an open lane; undefined when nothing is left to review. */
function laneHref(lanes: Lane[], laneId: string | null): string | undefined {
  const lane = laneId ? lanes.find((l) => l.id === laneId && l.status === 'open') : undefined;
  const first = lane?.changes.find((c) => c.status === 'pending');
  return lane && first ? focusPath(lane.id, first.id) : undefined;
}

const CHECK_NAMES: ReadonlySet<string> = new Set(CHECK_ROWS.map((c) => c.name));

/** Applies a `checks.status` event: `running` is taken as is, a check that left it is stamped as just run. */
export function applyRunning(prev: ChecksStatus | null, running: readonly string[], now: string): ChecksStatus {
  const next = running.filter((n): n is CheckName => CHECK_NAMES.has(n));
  const lastRun = { ...(prev?.lastRun ?? { arc: null, order: null, gaps: null, render: null }) };
  for (const name of prev?.running ?? []) if (!next.includes(name)) lastRun[name] = now;
  return { running: next, lastRun };
}

// Columns, not cards: a hairline between them, the text sits on the page.
const card: CSSProperties = { padding: '0 20px', minHeight: 0, overflow: 'auto', borderLeft: '1px solid var(--line)' };
const h2: CSSProperties = { margin: '0 0 14px', fontSize: 20, fontWeight: 700 };
const fieldLabel: CSSProperties = { display: 'block', fontSize: 13, fontWeight: 500, margin: 0, padding: '10px 0 0' };
const input: CSSProperties = { display: 'block', width: '100%', margin: 0, padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--line)', background: 'var(--card)', font: 'inherit', fontSize: 13, lineHeight: 1.45, color: 'var(--ink)' };

function BriefCard({ initial, api }: { initial: Brief; api: BriefChecksApi }) {
  const [draft, setDraft] = useState<Brief>(initial);
  const saved = useRef<Brief>(initial);
  const [save, setSave] = useState<Save>({ kind: 'idle' });

  const persist = useCallback(
    (next: Brief): void => {
      if (sameBrief(next, saved.current)) return;
      setSave({ kind: 'saving' });
      api.putBrief(next).then(
        (b) => {
          saved.current = b;
          setSave({ kind: 'saved' });
        },
        (err: unknown) => setSave({ kind: 'error', message: message(err) }),
      );
    },
    [api],
  );

  // `minRows` set: a textarea that grows with its content. The label and the control are two grid rows, so they cannot overlap.
  const text = (key: 'title' | 'audience' | 'message' | 'abstract', label: string, minRows?: number) => {
    const common = {
      id: `brief-${key}`,
      value: draft[key],
      onBlur: () => persist(draft),
    };
    return (
      <>
        <label htmlFor={common.id} style={fieldLabel}>{label}</label>
        {minRows !== undefined ? (
          <textarea
            {...common}
            rows={autoRows(draft[key], minRows)}
            style={{ ...input, resize: 'vertical' }}
            onChange={(e) => setDraft({ ...draft, [key]: e.target.value })}
          />
        ) : (
          <input {...common} type="text" style={input} onChange={(e) => setDraft({ ...draft, [key]: e.target.value })} />
        )}
      </>
    );
  };

  return (
    <section style={{ ...card, borderLeft: 'none', paddingLeft: 0 }} aria-label="brief">
      <div style={{ display: 'flex', alignItems: 'baseline', justifyContent: 'space-between' }}>
        <h2 style={h2}>Brief</h2>
        <span data-testid="brief-save" style={{ fontSize: 12, color: save.kind === 'error' ? 'var(--warn)' : 'var(--grey)' }}>
          {save.kind === 'saving' ? 'saving…' : save.kind === 'saved' ? 'saved' : save.kind === 'error' ? `not saved: ${save.message}` : ''}
        </span>
      </div>
      <div data-testid="brief-fields" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'auto', rowGap: 8, alignItems: 'start' }}>
      {text('title', 'title')}
      {text('audience', 'audience', 1)}
      {text('message', 'message in one sentence', 2)}
      <span id="brief-pattern-label" style={fieldLabel}>narrative pattern</span>
      <div role="radiogroup" aria-labelledby="brief-pattern-label">
        {PATTERNS.map((p) => (
          <label key={p.value} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '6px 0', cursor: 'pointer' }}>
            <input
              type="radio"
              name="brief-pattern"
              value={p.value}
              checked={draft.pattern === p.value}
              onChange={() => {
                // A radio has no meaningful blur: the choice is the commit.
                const next = { ...draft, pattern: p.value };
                setDraft(next);
                persist(next);
              }}
              style={{ accentColor: 'var(--accent)', width: 18, height: 18 }}
            />
            {p.label}
          </label>
        ))}
      </div>
      {text('abstract', 'abstract', 6)}
      </div>
    </section>
  );
}

/** Brief on the left, the four checks and their remarks in the middle, the deck on the right with anchored slides lit. */
export function BriefChecks({ api = briefChecksApi, subscribe = defaultSubscribe, navigate = defaultNavigate }: BriefChecksProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [brief, setBrief] = useState<Brief | null>(null);
  const [remarks, setRemarks] = useState<Remark[]>([]);
  const [lanes, setLanes] = useState<Lane[]>([]);
  const [status, setStatus] = useState<ChecksStatus | null>(null);
  const [thumbs, setThumbs] = useState<Record<SlideId, string | undefined>>({});
  const [expanded, setExpanded] = useState<ReadonlySet<CheckName>>(new Set());
  const [runError, setRunError] = useState<string | null>(null);
  const [liveError, setLiveError] = useState<string | null>(null);
  // Rows with warnings open by default, decided once on the first remarks load so a user's collapse sticks.
  const autoExpanded = useRef(false);
  // Per check, the lastRun this screen saw before the current one: remarks created after it came from the latest run.
  // Absent until a run finishes while the screen is open (the first look has nothing to compare with); null = it had never run.
  const lastSeen = useRef<Partial<Record<CheckName, string | null>>>({});
  const [since, setSince] = useState<Partial<Record<CheckName, string | null>>>({});
  const pendingThumbs = useRef(new Map<string, SlideId>());

  const reportLive = useCallback((err: unknown) => setLiveError(message(err)), []);

  const loadThumb = useCallback(
    async (id: SlideId) => {
      const t = await api.thumbFor(id);
      if (t.ready) {
        pendingThumbs.current.delete(t.hash);
        setThumbs((prev) => ({ ...prev, [id]: thumbUrl(t.hash) }));
      } else {
        pendingThumbs.current.set(t.hash, id);
      }
    },
    [api],
  );

  const loadDeck = useCallback(async () => {
    try {
      const deck = await api.getDeck();
      setLoad({ status: 'ready', deck });
      for (const id of deck.order) await loadThumb(id);
    } catch (err) {
      setLoad({ status: 'error', message: message(err) });
    }
  }, [api, loadThumb]);

  const loadRemarks = useCallback(async () => {
    // Drafts included: a remark linked to a draft lane offers to open it.
    const [rs, ls] = await Promise.all([api.getRemarks(), api.getLanes('all')]);
    setRemarks(rs);
    setLanes(ls);
    setLiveError(null);
    if (!autoExpanded.current) {
      autoExpanded.current = true;
      setExpanded(new Set(CHECK_ROWS.filter((c) => hasWarn(rs, c.name)).map((c) => c.name)));
    }
  }, [api]);

  const loadStatus = useCallback(async () => setStatus(await api.getChecksStatus()), [api]);

  useEffect(() => {
    void loadDeck();
    api.getBrief().then(setBrief, (err: unknown) => setLoad({ status: 'error', message: message(err) }));
    loadRemarks().catch(reportLive);
    loadStatus().catch(reportLive);
    let opens = 0;
    return subscribe((e) => {
      if (e.type === 'hello') {
        // Events sent while the socket was down are lost: resync, except on the first open (the mount just loaded).
        if (e.version !== null || ++opens > 1) {
          loadStatus().catch(reportLive);
          loadRemarks().catch(reportLive);
        }
      } else if (e.type === 'remarks.changed') loadRemarks().catch(reportLive);
      else if (e.type === 'lane.created' || e.type === 'lane.updated' || e.type === 'lane.closed') api.getLanes('all').then(setLanes, reportLive);
      // The event carries the running list: no refetch per event.
      else if (e.type === 'checks.status') setStatus((prev) => applyRunning(prev, e.running, new Date().toISOString()));
      else if (e.type === 'deck.changed') void loadDeck();
      else if (e.type === 'thumb.ready') {
        const id = pendingThumbs.current.get(e.hash);
        if (id) loadThumb(id).catch(reportLive);
      }
    });
  }, [api, subscribe, loadDeck, loadRemarks, loadStatus, loadThumb, reportLive]);

  useEffect(() => {
    if (!status) return;
    const changed: Partial<Record<CheckName, string | null>> = {};
    for (const { name } of CHECK_ROWS) {
      const at = status.lastRun[name];
      if (name in lastSeen.current && lastSeen.current[name] !== at) changed[name] = lastSeen.current[name] ?? null;
      lastSeen.current[name] = at;
    }
    if (Object.keys(changed).length > 0) setSince((prev) => ({ ...prev, ...changed }));
  }, [status]);

  const isNew = (r: Remark, name: CheckName): boolean => {
    if (!(name in since)) return false;
    const before = since[name];
    return before === null || before === undefined || Date.parse(r.createdAt) > Date.parse(before);
  };

  const run = (): void => {
    setRunError(null);
    // Progress arrives as checks.status events; merging `started` here could re-mark a check that already finished.
    api.runChecks().catch((err: unknown) => setRunError(message(err)));
  };

  const toggle = (name: CheckName): void =>
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  if (load.status === 'error') {
    return (
      <div style={{ padding: 32 }}>
        <p style={{ color: 'var(--warn)', fontWeight: 700 }}>Could not load the deck.</p>
        <p className="muted mono">{load.message}</p>
        <button type="button" className="btn" onClick={() => void loadDeck()}>Retry</button>
      </div>
    );
  }
  if (load.status === 'loading' || !brief) return <div style={{ padding: 32 }} className="muted">Loading brief and checks…</div>;

  const { deck } = load;
  const running = new Set(status?.running ?? []);
  const show = (anchor: Anchor): void => navigate(mainPath(anchor));
  // Slides pointed at by an open remark of an expanded check, or by any open check remark when none is expanded.
  const lit = new Set<SlideId>();
  const litFrom = expanded.size > 0 ? CHECK_ROWS.filter((c) => expanded.has(c.name)) : CHECK_ROWS;
  for (const c of litFrom) {
    for (const r of openOf(remarks, c.name)) {
      if (r.anchor.kind === 'arc') continue;
      const cols = anchorColumns(r.anchor, deck.order);
      if (cols) for (const id of deck.order.slice(cols.start, cols.start + cols.span)) lit.add(id);
    }
  }
  const lastRunLabel = (name: CheckName): string => {
    if (running.has(name)) return 'running…';
    const at = status?.lastRun[name];
    return at ? `last run ${new Date(at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}` : 'not run yet';
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <ScreenHeader>
        <h1 className="screen-title">Brief and checks</h1>
        <span className="meta">{deck.state.name}</span>
        <span className="meta">v{deck.state.version}</span>
        {runError ? <span style={{ color: 'var(--warn)', fontSize: 13 }}>{runError}</span> : null}
        <button type="button" className="btn-primary" onClick={run} disabled={running.size === CHECK_ROWS.length} style={{ marginLeft: 'auto', alignSelf: 'center' }}>
          {running.size > 0 ? 'Checks running…' : 'Run checks'}
        </button>
      </ScreenHeader>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(380px, 1.2fr) minmax(300px, 1fr)', gap: 0, padding: '8px 24px 20px' }}>
        <BriefCard initial={brief} api={api} />

        <section style={card} aria-label="checks">
          <style>{DOT_CSS}</style>
          <h2 style={h2}>Checks</h2>
          {liveError ? <p style={{ color: 'var(--warn)', fontSize: 12 }}>Remarks: {liveError}</p> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {CHECK_ROWS.map(({ name, label }) => {
              const open = openOf(remarks, name);
              const warn = hasWarn(remarks, name);
              const dot = dotState({ running: running.has(name), warn, ran: Boolean(status?.lastRun[name]) });
              const isOpen = expanded.has(name);
              return (
                <div key={name} data-testid="check-row" data-check={name} style={{ borderBottom: '1px solid var(--line)' }}>
                  <button
                    type="button"
                    aria-expanded={isOpen}
                    onClick={() => toggle(name)}
                    style={{ all: 'unset', boxSizing: 'border-box', width: '100%', cursor: 'pointer', display: 'flex', alignItems: 'baseline', gap: 12, padding: '12px 0' }}
                  >
                    <span
                      data-testid="check-dot"
                      data-status={dot}
                      role="img"
                      aria-label={DOT[dot].label}
                      style={{ width: 10, height: 10, borderRadius: '50%', flex: '0 0 auto', alignSelf: 'center', transition: 'background .2s ease', ...DOT[dot].style }}
                    />
                    <span className="row-label">{label}</span>
                    {open.length ? <span className="meta">{`${open.length} remark${open.length > 1 ? 's' : ''}`}</span> : null}
                    <span className="meta">{lastRunLabel(name)}</span>
                    <span aria-hidden style={{ marginLeft: 'auto', color: 'var(--grey)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }}>⌄</span>
                  </button>
                  {isOpen ? (
                    <div data-testid="check-remarks" style={{ padding: '0 0 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {open.length === 0 ? (
                        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                          {status?.lastRun[name] ? 'Nothing to flag.' : 'Not run yet. Use "Run checks" to get remarks here.'}
                        </p>
                      ) : (
                        open.map((r) => (
                          <RemarkCard
                            key={r.id}
                            remark={r}
                            order={deck.order}
                            onShow={show}
                            onPropose={(id) => api.proposeRemark(id)}
                            laneHref={laneHref(lanes, r.laneId)}
                            onOpenLane={navigate}
                            draftLaneId={draftLaneOf(lanes, r.laneId)}
                            onOpenDraft={(id) => api.openLane(id)}
                            isNew={isNew(r, name)}
                          />
                        ))
                      )}
                    </div>
                  ) : null}
                </div>
              );
            })}
          </div>
        </section>

        <section style={card} aria-label="slides">
          <h2 style={h2}>Slides</h2>
          {deck.order.length === 0 ? (
            <p className="muted">No slides yet. Import a deck.html into the folder, then run checks.</p>
          ) : (
            <div style={{ '--thumb-w': '96px', '--thumb-h': '96px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, var(--thumb-w))', gap: 10, justifyContent: 'start' } as CSSProperties}>
              {deck.order.map((id, i) => (
                <div key={id} data-testid="brief-thumb" data-slide={id} data-lit={lit.has(id)} style={{ opacity: lit.has(id) ? 1 : 0.45, transition: 'opacity .15s ease' }}>
                  <Thumb slideId={id} n={i + 1} title={deck.slides[id]?.title ?? id} url={thumbs[id]} selected={lit.has(id)} onClick={() => show({ kind: 'slide', slide: id })} />
                </div>
              ))}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
