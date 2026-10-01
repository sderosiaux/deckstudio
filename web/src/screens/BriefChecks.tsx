import { useCallback, useEffect, useRef, useState, type CSSProperties } from 'react';
import type { Anchor, Brief, Lane, Remark, SlideId } from '../../../src/model/types.js';
import {
  briefChecksApi,
  focusPath,
  mainPath,
  slidePath,
  navigate as defaultNavigate,
  subscribe as defaultSubscribe,
  thumbUrl,
  type BriefChecksApi,
  type BusEvent,
  type CheckName,
  type ChecksStatus,
  type DeckPayload,
  type DesignInfo,
} from '../api.js';
import { anchorColumns } from '../components/LaneRow.js';
import { RemarkCard } from '../components/Remark.js';
import { Thumb } from '../components/Thumb.js';
import { BackToMain, ScreenHeader } from '../components/ScreenHeader.js';

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
  a.title === b.title &&
  a.audience === b.audience &&
  a.message === b.message &&
  a.pattern === b.pattern &&
  a.abstract === b.abstract &&
  a.design.rules === b.design.rules &&
  a.design.imageStyle === b.design.imageStyle;
// Remarks from a lane-scoped run describe that lane's preview, not main: they are shown on the lane row, not here.
const ofCheck = (rs: Remark[], name: CheckName): Remark[] => rs.filter((r) => r.origin === `check:${name}` && !r.sourceLaneId);
/** A remark whose lane was closed (accepted, refused or discarded) was acted on: it is history, like a resolved one. */
const laneClosed = (r: Remark, lanes: Lane[]): boolean => r.laneId !== null && !lanes.some((l) => l.id === r.laneId && l.status !== 'closed');
/** What a check still says about main: open, and not settled through a closed lane. */
const liveOf = (rs: Remark[], lanes: Lane[], name: CheckName): Remark[] => ofCheck(rs, name).filter((r) => r.status === 'open' && !laneClosed(r, lanes));
/** Resolved or lane-closed: kept behind "show resolved (N)". */
const settledOf = (rs: Remark[], lanes: Lane[], name: CheckName): Remark[] => ofCheck(rs, name).filter((r) => r.status !== 'open' || laneClosed(r, lanes));
const hasWarn = (rs: Remark[], lanes: Lane[], name: CheckName): boolean => liveOf(rs, lanes, name).some((r) => r.severity === 'warn');

const sameAnchor = (x: Anchor, y: Anchor): boolean =>
  x.kind === 'arc' ? y.kind === 'arc' : x.kind === 'slide' ? y.kind === 'slide' && x.slide === y.slide : y.kind === 'range' && x.from === y.from && x.to === y.to;

/** Function words that carry no point of their own: two remarks sharing only these are not alike. */
const STOP_WORDS: ReadonlySet<string> = new Set(
  ('the and for but nor yet with without that this these those which while where when what who whom whose how why ' +
    'are was were been being has have had its not from into onto over under about inside outside here there their ' +
    'they them then than also only just very more most less each every some such same other both either neither ' +
    'all any can could would should will does did one two nothing something anything already still even so')
    .split(' '),
);

/** A plural or third-person "s" dropped, so "promises" and "promise", "details" and "detail" count as one word. */
const stem = (w: string): string => (w.length > 3 && w.endsWith('s') && !w.endsWith('ss') ? w.slice(0, -1) : w);

/** The words of a remark that carry its point: lower-cased, three letters or more, without function words, stemmed. */
export function remarkWords(text: string): ReadonlySet<string> {
  return new Set((text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 3 && !STOP_WORDS.has(w)).map(stem));
}

/** Share of the shorter remark's words the other one also uses, from which two remarks make the same point. */
export const SIMILAR_SHARE = 0.6;

/**
 * Two remarks make the same point: same anchor, same origin, and at least 60% of the shorter one's words in the other.
 * The server applies the same rule when a check reruns; until it dedupes, the screen groups what it would merge.
 */
export function similarRemarks(a: Remark, b: Remark): boolean {
  if (a.origin !== b.origin || !sameAnchor(a.anchor, b.anchor)) return false;
  const wa = remarkWords(a.text);
  const wb = remarkWords(b.text);
  const smaller = Math.min(wa.size, wb.size);
  if (smaller === 0) return a.text.trim() === b.text.trim();
  let shared = 0;
  for (const w of wa) if (wb.has(w)) shared++;
  return shared / smaller >= SIMILAR_SHARE;
}

/** Remarks grouped by point, at the place of their first one; in a group the oldest leads (the one already seen). */
export function groupSimilar(rs: readonly Remark[]): Remark[][] {
  const groups: Remark[][] = [];
  for (const r of rs) {
    const g = groups.find((members) => members.some((m) => similarRemarks(m, r)));
    if (g) g.push(r);
    else groups.push([r]);
  }
  return groups.map((g) => [...g].sort((x, y) => Date.parse(x.createdAt) - Date.parse(y.createdAt)));
}

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

/** The image-style field reads as empty when it is: the built-in style itself sits behind a disclosure. */
export const IMAGE_STYLE_PLACEHOLDER = 'built-in flat keynote style; type here to override';
const h3: CSSProperties = { margin: '28px 0 0', fontSize: 15, fontWeight: 700 };

type DesignLoad = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; info: DesignInfo };

/** Where the deck's theme.css lives and when an edit shows up: it is edited on disk, not here. */
function themeNote(d: DesignLoad): string {
  if (d.status === 'loading') return '';
  if (d.status === 'error') return `theme.css: could not load its location (${d.message})`;
  const { themeCssPath, themeCssPresent } = d.info;
  return themeCssPresent
    ? `theme.css: ${themeCssPath} (edit on disk; renders and thumbnails reload on restart)`
    : `theme.css: ${themeCssPath} (not present: the built-in theme applies; create it to change the look, then restart)`;
}

function BriefCard({ initial, api, previewSlide, navigate }: { initial: Brief; api: BriefChecksApi; previewSlide: SlideId | undefined; navigate(path: string): void }) {
  const [draft, setDraft] = useState<Brief>(initial);
  const saved = useRef<Brief>(initial);
  const [save, setSave] = useState<Save>({ kind: 'idle' });
  const [design, setDesign] = useState<DesignLoad>({ status: 'loading' });
  const [showBuiltIn, setShowBuiltIn] = useState(false);
  const dirty = !sameBrief(draft, saved.current);

  useEffect(() => {
    let live = true;
    api.getDesign().then(
      (info) => live && setDesign({ status: 'ready', info }),
      (err: unknown) => live && setDesign({ status: 'error', message: message(err) }),
    );
    return () => {
      live = false;
    };
  }, [api]);

  const designText = (key: 'rules' | 'imageStyle', label: string, minRows: number, placeholder?: string) => (
    <>
      {key === 'rules' && previewSlide !== undefined ? (
        // The rules apply to every render: one slide shows them at work.
        <span style={{ ...fieldLabel, display: 'flex', alignItems: 'baseline', justifyContent: 'space-between', gap: 12 }}>
          <label htmlFor={`brief-design-${key}`}>{label}</label>
          <a
            href={slidePath(previewSlide)}
            className="link"
            onClick={(e) => {
              if (e.metaKey || e.ctrlKey || e.shiftKey || e.button !== 0) return;
              e.preventDefault();
              persist(draft);
              navigate(slidePath(previewSlide));
            }}
            style={{ fontSize: 12, fontWeight: 400, color: 'var(--ink)' }}
          >
            preview on a slide
          </a>
        </span>
      ) : (
        <label htmlFor={`brief-design-${key}`} style={fieldLabel}>{label}</label>
      )}
      <textarea
        id={`brief-design-${key}`}
        className="brief-design-field"
        value={draft.design[key]}
        rows={autoRows(draft.design[key], minRows)}
        {...(placeholder !== undefined ? { placeholder } : {})}
        style={{ ...input, resize: 'vertical' }}
        onChange={(e) => setDraft({ ...draft, design: { ...draft.design, [key]: e.target.value } })}
        onBlur={() => persist(draft)}
      />
    </>
  );

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
        {/* Autosave on blur stays; the state is always visible, and "save" commits without leaving the field. */}
        <span style={{ display: 'flex', alignItems: 'baseline', gap: 10 }}>
          <span data-testid="brief-save" style={{ fontSize: 12, color: save.kind === 'error' ? 'var(--warn)' : dirty ? 'var(--ink)' : 'var(--grey)' }}>
            {save.kind === 'saving' ? 'saving…' : save.kind === 'error' ? `not saved: ${save.message}` : dirty ? 'unsaved changes' : save.kind === 'saved' ? 'saved' : ''}
          </span>
          <button type="button" className="btn" disabled={!dirty || save.kind === 'saving'} onMouseDown={(e) => e.preventDefault()} onClick={() => persist(draft)} style={{ padding: '4px 10px', fontSize: 12 }}>
            save
          </button>
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
      <h3 style={h3}>Design</h3>
      <div data-testid="brief-design" style={{ display: 'grid', gridTemplateColumns: 'minmax(0, 1fr)', gridAutoRows: 'auto', rowGap: 8, alignItems: 'start' }}>
        {designText('rules', 'rules the co-author must respect', 4)}
        {designText('imageStyle', 'image style', 3, IMAGE_STYLE_PLACEHOLDER)}
        {design.status === 'ready' ? (
          <div>
            <button type="button" className="link" aria-expanded={showBuiltIn} onClick={() => setShowBuiltIn((v) => !v)} style={{ fontSize: 12 }}>
              {showBuiltIn ? 'hide built-in style' : 'show built-in style'}
            </button>
            {showBuiltIn ? (
              <pre style={{ margin: '6px 0 0', padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--line)', background: 'var(--card)', whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
                <code data-testid="builtin-style" className="mono" style={{ fontSize: 12, lineHeight: 1.45, color: 'var(--ink)' }}>{design.info.defaultImageStyle}</code>
              </pre>
            ) : null}
          </div>
        ) : null}
        <p data-testid="theme-note" className="muted" style={{ margin: '4px 0 0', fontSize: 12, lineHeight: 1.45, overflowWrap: 'anywhere' }}>
          {themeNote(design)}
        </p>
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
  /**
   * Who the run in flight belongs to. 'requested': this screen asked, the server has not said a check started yet;
   * 'running': this screen's run is under way. A run seen while 'idle' was started by the system (after a deck change).
   */
  const [ownRun, setOwnRun] = useState<'idle' | 'requested' | 'running'>('idle');
  const [showSettled, setShowSettled] = useState<ReadonlySet<CheckName>>(new Set());
  /** Groups of near-duplicate remarks unfolded, by the id of the remark that leads them. */
  const [similarShown, setSimilarShown] = useState<ReadonlySet<string>>(new Set());
  /** Per check, when this screen saw its current run start: the fallback reference when the check had never run before. */
  const runStart = useRef<Partial<Record<CheckName, string>>>({});
  const [liveError, setLiveError] = useState<string | null>(null);
  // Rows with warnings open by default, decided once on the first remarks load so a user's collapse sticks.
  const autoExpanded = useRef(false);
  // Per check, the lastRun this screen saw before the current one: remarks created after it came from the latest run.
  // Absent until a run finishes while the screen is open (the first look has nothing to compare with); null = it had never run.
  const lastSeen = useRef<Partial<Record<CheckName, string | null>>>({});
  /** Per check, the reference of its latest finished run: the lastRun before it, and the remark ids listed before it started. */
  const [since, setSince] = useState<Partial<Record<CheckName, { at: string | null; listed: readonly Remark[] }>>>({});
  /** The latest list loaded; a run's "before" is this list when the run is seen starting. */
  const listed = useRef<readonly Remark[] | null>(null);
  /** Per check, the remarks listed when this screen saw its current run start. */
  const runListed = useRef<Partial<Record<CheckName, readonly Remark[]>>>({});
  /** What the first load listed: never "new", nor anything that rewords it, even when a run already in flight produced it. */
  const [firstListed, setFirstListed] = useState<readonly Remark[] | null>(null);
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
    if (listed.current === null) setFirstListed(rs);
    listed.current = rs;
    setLiveError(null);
    if (!autoExpanded.current) {
      autoExpanded.current = true;
      setExpanded(new Set(CHECK_ROWS.filter((c) => hasWarn(rs, ls, c.name)).map((c) => c.name)));
    }
  }, [api]);

  /**
   * Applies a status as it arrives, outside render: a run's "before" list must be the one listed when its start was
   * announced, not whatever list is loaded by the time an effect would run.
   */
  const statusNow = useRef<ChecksStatus | null>(null);
  const applyStatus = useCallback((status: ChecksStatus): void => {
    statusNow.current = status;
    setStatus(status);
    const changed: Partial<Record<CheckName, { at: string | null; listed: readonly Remark[] }>> = {};
    const now = new Date().toISOString();
    for (const { name } of CHECK_ROWS) {
      if (status.running.includes(name) && runStart.current[name] === undefined) {
        runStart.current[name] = now;
        runListed.current[name] = listed.current ?? [];
      }
      const at = status.lastRun[name];
      // The reference is the previous lastRun; a check that never ran falls back to when this screen saw the run start.
      if (name in lastSeen.current && lastSeen.current[name] !== at) {
        changed[name] = { at: lastSeen.current[name] ?? runStart.current[name] ?? null, listed: runListed.current[name] ?? [] };
      }
      if (!status.running.includes(name)) {
        delete runStart.current[name];
        delete runListed.current[name];
      }
      lastSeen.current[name] = at;
    }
    if (Object.keys(changed).length > 0) setSince((prev) => ({ ...prev, ...changed }));
    // This screen's run is under way once a check reports running, and over once none does.
    setOwnRun((own) => (status.running.length > 0 ? (own === 'requested' ? 'running' : own) : own === 'running' ? 'idle' : own));
  }, []);

  const loadStatus = useCallback(async () => applyStatus(await api.getChecksStatus()), [api, applyStatus]);

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
      else if (e.type === 'checks.status') applyStatus(applyRunning(statusNow.current, e.running, new Date().toISOString()));
      else if (e.type === 'deck.changed') {
        void loadDeck();
        // The server writes "slide N (title)" into a remark's text when it is read: refetched with the deck, so the
        // text and its range chip renumber together.
        loadRemarks().catch(reportLive);
      }
      else if (e.type === 'thumb.ready') {
        const id = pendingThumbs.current.get(e.hash);
        if (id) loadThumb(id).catch(reportLive);
      }
    });
  }, [api, subscribe, loadDeck, loadRemarks, loadStatus, loadThumb, reportLive, applyStatus]);


  // Never on the first look, and never without a reference: "new" means created since the run before this one, and
  // neither listed nor reworded from a remark listed before this run started (a point the creator already saw is not
  // new because the run ended after it, or because the check phrased it again).
  const isNew = (r: Remark, name: CheckName): boolean => {
    const before = since[name];
    if (!before || typeof before.at !== 'string' || !firstListed) return false;
    const seen = (rs: readonly Remark[]): boolean => rs.some((x) => x.id === r.id || similarRemarks(x, r));
    return Date.parse(r.createdAt) > Date.parse(before.at) && !seen(before.listed) && !seen(firstListed);
  };

  const run = (): void => {
    setRunError(null);
    setOwnRun('requested');
    // Progress arrives as checks.status events; merging `started` here could re-mark a check that already finished.
    api.runChecks().then(
      // Nothing started (every check already queued): no run of this screen's to wait for.
      ({ started }) => {
        if (started.length === 0) setOwnRun((own) => (own === 'requested' ? 'idle' : own));
      },
      (err: unknown) => {
        setRunError(message(err));
        setOwnRun('idle');
      },
    );
  };

  const toggleSettled = (name: CheckName): void =>
    setShowSettled((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });

  const toggleSimilar = (id: string): void =>
    setSimilarShown((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

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
  // A run nobody asked for here: the system started it after a deck change.
  const systemRun = running.size > 0 && ownRun === 'idle';
  const show = (anchor: Anchor): void => navigate(mainPath(anchor));
  // Slides pointed at by an open remark of an expanded check, or by any open check remark when none is expanded.
  const lit = new Set<SlideId>();
  const litFrom = expanded.size > 0 ? CHECK_ROWS.filter((c) => expanded.has(c.name)) : CHECK_ROWS;
  for (const c of litFrom) {
    for (const r of liveOf(remarks, lanes, c.name)) {
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
        <BackToMain navigate={navigate} />
        {/* One check still running is a run in flight: a second run would only join it. A run the system started says
            why it runs instead of showing a button that stays disabled for minutes. */}
        {systemRun ? (
          <span data-testid="checks-auto" role="status" className="meta" style={{ marginLeft: 8, alignSelf: 'center' }}>
            running after a deck change
          </span>
        ) : (
          <button type="button" className="btn-primary" onClick={run} disabled={ownRun !== 'idle' || running.size > 0} style={{ marginLeft: 8, alignSelf: 'center' }}>
            {running.size > 0 ? 'Checks running…' : 'Run checks'}
          </button>
        )}
      </ScreenHeader>
      <div style={{ flex: 1, minHeight: 0, display: 'grid', gridTemplateColumns: 'minmax(300px, 1fr) minmax(380px, 1.2fr) minmax(300px, 1fr)', gap: 0, padding: '8px 24px 20px' }}>
        <BriefCard initial={brief} api={api} previewSlide={deck.order[0]} navigate={navigate} />

        <section style={card} aria-label="checks">
          <style>{DOT_CSS}</style>
          <h2 style={h2}>Checks</h2>
          {liveError ? <p style={{ color: 'var(--warn)', fontSize: 12 }}>Remarks: {liveError}</p> : null}
          <div style={{ display: 'flex', flexDirection: 'column', gap: 10 }}>
            {CHECK_ROWS.map(({ name, label }) => {
              const open = liveOf(remarks, lanes, name);
              // Near-duplicates (a rerun's rewording) share one card until the server dedupes them.
              const groups = groupSimilar(open);
              const card = (r: Remark) => (
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
                  isNew={r.status === 'open' && !laneClosed(r, lanes) && isNew(r, name)}
                />
              );
              const settled = settledOf(remarks, lanes, name);
              const settledShown = showSettled.has(name);
              const warn = hasWarn(remarks, lanes, name);
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
                    {groups.length ? <span className="meta">{`${groups.length} remark${groups.length > 1 ? 's' : ''}`}</span> : null}
                    <span className="meta">{lastRunLabel(name)}</span>
                    <span aria-hidden style={{ marginLeft: 'auto', color: 'var(--grey)', transform: isOpen ? 'rotate(180deg)' : 'none', transition: 'transform .15s ease' }}>⌄</span>
                  </button>
                  {isOpen ? (
                    <div data-testid="check-remarks" style={{ padding: '0 0 12px', display: 'flex', flexDirection: 'column', gap: 10 }}>
                      {open.length === 0 ? (
                        <p className="muted" style={{ margin: 0, fontSize: 13 }}>
                          {status?.lastRun[name] ? 'Nothing to flag.' : 'Not run yet. Use "Run checks" to get remarks here.'}
                        </p>
                      ) : null}
                      {groups.map(([lead, ...alike]) => {
                        const shown = similarShown.has(lead!.id);
                        return (
                          <div key={lead!.id} data-testid="remark-group" style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                            {card(lead!)}
                            {alike.length > 0 ? (
                              <button type="button" className="link" aria-expanded={shown} onClick={() => toggleSimilar(lead!.id)} style={{ fontSize: 12, alignSelf: 'flex-start', color: 'var(--ink)' }}>
                                {`${alike.length + 1} similar`}
                              </button>
                            ) : null}
                            {shown ? <div style={{ display: 'flex', flexDirection: 'column', gap: 6, paddingLeft: 12, borderLeft: '1px solid var(--line)' }}>{alike.map(card)}</div> : null}
                          </div>
                        );
                      })}
                      {settledShown ? settled.map(card) : null}
                      {settled.length > 0 ? (
                        <button type="button" className="link" aria-expanded={settledShown} onClick={() => toggleSettled(name)} style={{ fontSize: 12, alignSelf: 'flex-start' }}>
                          {`${settledShown ? 'hide' : 'show'} resolved (${settled.length})`}
                        </button>
                      ) : null}
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
            // Rows size to their cells: the caption is part of the cell, so it can never reach the next row.
            <div style={{ '--thumb-w': '96px', '--thumb-h': '54px', display: 'grid', gridTemplateColumns: 'repeat(auto-fill, var(--thumb-w))', gridAutoRows: 'auto', alignItems: 'start', gap: 10, justifyContent: 'start' } as CSSProperties}>
              {deck.order.map((id, i) => {
                const title = deck.slides[id]?.title ?? id;
                return (
                  <div key={id} data-testid="brief-thumb" data-slide={id} data-lit={lit.has(id)} style={{ width: 'var(--thumb-w)', minWidth: 0, opacity: lit.has(id) ? 1 : 0.45, transition: 'opacity .15s ease' }}>
                    <Thumb slideId={id} n={i + 1} title={title} url={thumbs[id]} selected={lit.has(id)} hoverTitle={false} onClick={() => show({ kind: 'slide', slide: id })} />
                    <div data-testid="brief-thumb-caption" title={title} style={{ width: '100%', fontSize: 'var(--fs-meta)', lineHeight: '16px', color: 'var(--ink)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {title}
                    </div>
                  </div>
                );
              })}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}
