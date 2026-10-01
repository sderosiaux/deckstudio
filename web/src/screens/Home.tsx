import { useCallback, useEffect, useRef, useState, type CSSProperties, type FormEvent, type MouseEvent } from 'react';
import type { Brief } from '../../../src/model/types.js';
import { ApiError, deckHref, deckThumbUrl, homeApi, navigate as defaultNavigate, type DeckSummary, type HomeApi, type NewDeck } from '../api.js';
import { ScreenHeader } from '../components/ScreenHeader.js';

export interface HomeProps {
  api?: HomeApi;
  navigate?: (path: string) => void;
  /** The clock "updated …" is worded against; injectable for tests. */
  now?: () => Date;
}

type Load = { status: 'loading' } | { status: 'error'; message: string } | { status: 'ready'; decks: DeckSummary[] };
type Panel = 'none' | 'create' | 'import';

const PATTERNS: { value: Brief['pattern']; label: string }[] = [
  { value: 'solution-first', label: 'solution first, then decompose' },
  { value: 'problem-driven', label: 'problem by problem, build up' },
];
/** Waits between cover thumbnail requests while the server renders it; then the grey block stays. */
const COVER_RETRY_MS = [500, 1000, 2000, 4000, 8000];

const errText = (err: unknown): string => (err instanceof ApiError ? err.detail : err instanceof Error ? err.message : String(err));

const rtf = new Intl.RelativeTimeFormat('en', { numeric: 'auto' });

/** "updated 5 minutes ago", "updated yesterday"; past a week, the date. */
export function updatedLabel(iso: string, now: Date): string {
  const at = new Date(iso);
  const s = (now.getTime() - at.getTime()) / 1000;
  if (s < 45) return 'updated just now';
  if (s < 3600) return `updated ${rtf.format(-Math.max(1, Math.round(s / 60)), 'minute')}`;
  if (s < 86_400) return `updated ${rtf.format(-Math.round(s / 3600), 'hour')}`;
  if (s < 7 * 86_400) return `updated ${rtf.format(-Math.max(1, Math.round(s / 86_400)), 'day')}`;
  const sameYear = at.getFullYear() === now.getFullYear();
  return `updated on ${at.toLocaleDateString('en', { month: 'short', day: 'numeric', ...(sameYear ? {} : { year: 'numeric' }) })}`;
}

const metaLine = (d: DeckSummary): string => `${d.slides} ${d.slides === 1 ? 'slide' : 'slides'}, v${d.version}`;

/** The deck's first slide, requested again while the server is still rendering it. */
function useCover(api: HomeApi, deck: DeckSummary): string | undefined {
  const [url, setUrl] = useState<string | undefined>(undefined);
  const { id, coverSlideId } = deck;
  useEffect(() => {
    setUrl(undefined);
    if (!coverSlideId) return;
    let live = true;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const ask = (attempt: number): void => {
      api.deckThumbFor(id, coverSlideId).then(
        (t) => {
          if (!live) return;
          if (t.ready) setUrl(deckThumbUrl(id, t.hash));
          else if (attempt < COVER_RETRY_MS.length) timer = setTimeout(() => ask(attempt + 1), COVER_RETRY_MS[attempt]);
        },
        (err: unknown) => console.warn(`deckstudio: cover of ${id} failed`, err),
      );
    };
    ask(0);
    return () => {
      live = false;
      if (timer) clearTimeout(timer);
    };
  }, [api, id, coverSlideId]);
  return url;
}

function DeckCard({ deck, api, now, open }: { deck: DeckSummary; api: HomeApi; now: Date; open(id: string): void }) {
  const cover = useCover(api, deck);
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [cover]);
  const onClick = (e: MouseEvent<HTMLAnchorElement>): void => {
    if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
    e.preventDefault();
    open(deck.id);
  };
  return (
    <a href={deckHref(deck.id)} data-testid="deck-card" data-deck={deck.id} className="deck-card" onClick={onClick}>
      <span className="deck-card-cover">
        {cover && !failed ? (
          <img data-testid="cover-image" src={cover} alt="" draggable={false} onError={() => setFailed(true)} />
        ) : (
          <span data-testid="thumb-placeholder" className="deck-card-placeholder" />
        )}
      </span>
      <span className="deck-card-title">{deck.title || deck.id}</span>
      <span className="deck-card-meta meta">
        <span>{metaLine(deck)}</span>
        <span>{updatedLabel(deck.updatedAt, now)}</span>
      </span>
    </a>
  );
}

const fieldLabel: CSSProperties = { display: 'block', fontSize: 13, fontWeight: 500, margin: 0, padding: '10px 0 4px' };
const input: CSSProperties = { display: 'block', width: '100%', margin: 0, padding: '8px 12px', borderRadius: 'var(--radius)', border: '1px solid var(--line)', background: 'var(--card)', font: 'inherit', fontSize: 13, lineHeight: 1.45, color: 'var(--ink)' };

interface Draft {
  title: string;
  audience: string;
  message: string;
  pattern: Brief['pattern'];
  abstract: string;
  rules: string;
}
const EMPTY_DRAFT: Draft = { title: '', audience: '', message: '', pattern: 'solution-first', abstract: '', rules: '' };

/** What POST /api/decks gets: optional fields only when written, so the server's starter rules apply to an empty one. */
export function newDeckOf(d: Draft): NewDeck {
  return {
    title: d.title.trim(),
    audience: d.audience.trim(),
    message: d.message.trim(),
    pattern: d.pattern,
    ...(d.abstract.trim() ? { abstract: d.abstract.trim() } : {}),
    ...(d.rules.trim() ? { design: { rules: d.rules.trim() } } : {}),
  };
}

function createError(err: unknown): string {
  if (err instanceof ApiError && err.status === 409) return `A deck with this id exists (${err.detail}). Change the title to create another one.`;
  return `Could not create the presentation: ${errText(err)}`;
}

function CreateForm({ api, onDone, onCancel }: { api: HomeApi; onDone(d: DeckSummary): void; onCancel(): void }) {
  const [draft, setDraft] = useState<Draft>(EMPTY_DRAFT);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const set = (k: keyof Draft) => (e: { target: { value: string } }) => setDraft((d) => ({ ...d, [k]: e.target.value }));
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!draft.title.trim() || busy) return;
    setBusy(true);
    setError(null);
    api.createDeck(newDeckOf(draft)).then(onDone, (err: unknown) => {
      setBusy(false);
      setError(createError(err));
    });
  };
  return (
    <form data-testid="create-form" className="home-panel" onSubmit={submit} aria-label="new presentation">
      <h2 className="home-panel-title">New presentation</h2>
      <div className="home-form-grid">
        <div>
          <label htmlFor="new-title" style={fieldLabel}>title</label>
          <input id="new-title" type="text" autoFocus required value={draft.title} onChange={set('title')} style={input} />
          <label htmlFor="new-audience" style={fieldLabel}>audience</label>
          <input id="new-audience" type="text" value={draft.audience} onChange={set('audience')} style={input} />
          <label htmlFor="new-message" style={fieldLabel}>message in one sentence</label>
          <textarea id="new-message" rows={2} value={draft.message} onChange={set('message')} style={{ ...input, resize: 'vertical' }} />
          <span id="new-pattern-label" style={fieldLabel}>narrative pattern</span>
          <div role="radiogroup" aria-labelledby="new-pattern-label">
            {PATTERNS.map((p) => (
              <label key={p.value} style={{ display: 'flex', alignItems: 'center', gap: 12, padding: '4px 0', cursor: 'pointer' }}>
                <input
                  type="radio"
                  name="new-pattern"
                  value={p.value}
                  checked={draft.pattern === p.value}
                  onChange={() => setDraft((d) => ({ ...d, pattern: p.value }))}
                  style={{ accentColor: 'var(--accent)', width: 18, height: 18, margin: 0 }}
                />
                {p.label}
              </label>
            ))}
          </div>
        </div>
        <div>
          <label htmlFor="new-abstract" style={fieldLabel}>abstract (optional)</label>
          <textarea id="new-abstract" rows={4} value={draft.abstract} onChange={set('abstract')} style={{ ...input, resize: 'vertical' }} />
          <label htmlFor="new-rules" style={fieldLabel}>design rules</label>
          <textarea id="new-rules" rows={4} value={draft.rules} onChange={set('rules')} aria-describedby="new-rules-hint" style={{ ...input, resize: 'vertical' }} />
          <span id="new-rules-hint" className="meta" style={{ display: 'block', paddingTop: 4 }}>leave empty for the starter rules</span>
        </div>
      </div>
      {error ? (
        <p role="alert" style={{ margin: '12px 0 0', color: 'var(--warn)', fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 16 }}>
        <button type="submit" className="btn-primary" disabled={!draft.title.trim() || busy}>
          {busy ? 'Creating…' : 'Create'}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
}

function ImportForm({ api, onDone, onCancel }: { api: HomeApi; onDone(d: DeckSummary): void; onCancel(): void }) {
  const [path, setPath] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const submit = (e: FormEvent): void => {
    e.preventDefault();
    if (!path.trim() || busy) return;
    setBusy(true);
    setError(null);
    api.importDeck(path.trim()).then(onDone, (err: unknown) => {
      setBusy(false);
      setError(err instanceof ApiError && err.status === 409 ? `A deck with this id exists (${err.detail}).` : `Could not import: ${errText(err)}`);
    });
  };
  return (
    <form data-testid="import-form" className="home-panel" onSubmit={submit} aria-label="import a deck.html">
      <h2 className="home-panel-title">Import a deck.html</h2>
      <label htmlFor="import-path" style={fieldLabel}>path of the deck.html on this machine</label>
      <input id="import-path" type="text" autoFocus value={path} onChange={(e) => setPath(e.target.value)} placeholder="/Users/me/talks/deck.html" className="mono" style={{ ...input, maxWidth: 640 }} />
      <span className="meta" style={{ display: 'block', paddingTop: 4 }}>one &lt;section class="slide"&gt; per slide; its images are copied next to the new deck</span>
      {error ? (
        <p role="alert" style={{ margin: '12px 0 0', color: 'var(--warn)', fontSize: 13 }}>
          {error}
        </p>
      ) : null}
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 16, marginTop: 16 }}>
        <button type="submit" className="btn-primary" disabled={!path.trim() || busy}>
          {busy ? 'Importing…' : 'Import'}
        </button>
        <button type="button" className="link" onClick={onCancel}>
          cancel
        </button>
      </div>
    </form>
  );
}

/** '/': every presentation of the studio, the way to start a new one, and the way to bring an existing deck.html in. */
export function Home({ api = homeApi, navigate = defaultNavigate, now = () => new Date() }: HomeProps) {
  const [load, setLoad] = useState<Load>({ status: 'loading' });
  const [panel, setPanel] = useState<Panel>('none');
  const live = useRef(true);
  const reload = useCallback(() => {
    setLoad({ status: 'loading' });
    api.listDecks().then(
      (decks) => live.current && setLoad({ status: 'ready', decks }),
      (err: unknown) => live.current && setLoad({ status: 'error', message: errText(err) }),
    );
  }, [api]);
  useEffect(() => {
    live.current = true;
    reload();
    return () => {
      live.current = false;
    };
  }, [reload]);
  const open = (id: string): void => navigate(deckHref(id));
  const done = (d: DeckSummary): void => open(d.id);
  const clock = now();
  return (
    <div data-testid="home" style={{ height: '100%', overflow: 'auto' }}>
      <ScreenHeader>
        <h1 className="screen-title">deckstudio</h1>
        <span className="meta">Write and rework presentations with a co-author: every proposal is a lane you accept slide by slide.</span>
        <button type="button" className="link" aria-expanded={panel === 'import'} onClick={() => setPanel((p) => (p === 'import' ? 'none' : 'import'))} style={{ marginLeft: 'auto', color: 'var(--ink)' }}>
          Import a deck.html
        </button>
        <button type="button" className="btn-primary" aria-expanded={panel === 'create'} onClick={() => setPanel((p) => (p === 'create' ? 'none' : 'create'))} style={{ alignSelf: 'center' }}>
          New presentation
        </button>
      </ScreenHeader>
      <div className="home-body">
        {panel === 'create' ? <CreateForm api={api} onDone={done} onCancel={() => setPanel('none')} /> : null}
        {panel === 'import' ? <ImportForm api={api} onDone={done} onCancel={() => setPanel('none')} /> : null}
        {load.status === 'loading' ? <p className="muted">Loading presentations…</p> : null}
        {load.status === 'error' ? (
          <p role="alert" style={{ color: 'var(--warn)' }}>
            <span>Could not list the presentations: {load.message}</span>{' '}
            <button type="button" className="btn" onClick={reload}>
              Retry
            </button>
          </p>
        ) : null}
        {load.status === 'ready' && load.decks.length === 0 ? <p className="home-empty">No presentations yet. Create one or import a deck.html.</p> : null}
        {load.status === 'ready' && load.decks.length > 0 ? (
          <div role="list" aria-label="presentations" className="deck-grid">
            {load.decks.map((d) => (
              <div role="listitem" key={d.id} style={{ minWidth: 0 }}>
                <DeckCard deck={d} api={api} now={clock} open={open} />
              </div>
            ))}
          </div>
        ) : null}
      </div>
    </div>
  );
}
