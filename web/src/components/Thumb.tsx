import { useEffect, useState, type CSSProperties } from 'react';

export interface ThumbProps {
  slideId: string;
  n: number;
  title: string;
  url: string | undefined;
  selected: boolean;
  /** The selection ring: the accent (default), or ink where the accent already means "changed" (history diff). */
  ring?: 'accent' | 'ink';
  /** The slide number under the card (default). Lanes leave it out: their cells sit under main's numbered columns. */
  numbered?: boolean;
  onClick(): void;
  /** Double-click: open this slide somewhere else (main uses it for the player). */
  onDoubleClick?(): void;
  /** Turns the title line into a link, shown as long as the thumb is selected (main: the slide's edit screen). */
  titleLink?: ThumbTitleLink;
}

export interface ThumbTitleLink {
  href: string;
  /** A plain click; a modified click (new tab, new window) is left to the browser. */
  onFollow(): void;
}

const RINGS = {
  accent: '0 0 0 2px var(--paper), 0 0 0 3.5px var(--accent)',
  ink: '0 0 0 2px var(--paper), 0 0 0 4px var(--ink)',
} as const;

/** A 16:9 card the width of one grid column (--thumb-h follows --thumb-w), holding the rendered slide. */
const frame = (selected: boolean, ring: keyof typeof RINGS): CSSProperties => ({
  width: 'var(--thumb-w)',
  height: 'var(--thumb-h)',
  borderRadius: 4,
  overflow: 'hidden',
  background: 'var(--card)',
  boxShadow: selected ? RINGS[ring] : '0 0 0 1px var(--line)',
  transition: 'box-shadow .15s ease',
});

/* The whole slide scaled into the card, never cropped: a strip reads as the deck, titles included. */
const picture: CSSProperties = { width: '100%', height: '100%', display: 'block', objectFit: 'contain' };

/**
 * One slide in a strip: the rendered slide (a grey block until the PNG is ready), its number under it unless
 * `numbered` is off, and its title as one line on hover or selection.
 */
export function Thumb({ slideId, n, title, url, selected, ring = 'accent', numbered = true, onClick, onDoubleClick, titleLink }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const showImage = url !== undefined && !failed;
  const card = (
    <button
      type="button"
      className="thumb"
      data-testid="thumb"
      data-slide={slideId}
      aria-pressed={selected}
      aria-label={`Slide ${n}: ${title}`}
      onClick={onClick}
      onDoubleClick={onDoubleClick}
      style={{ all: 'unset', position: 'relative', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, width: 'var(--thumb-w)', flex: '0 0 auto' }}
    >
      <div className={selected ? 'thumb-selected edge-frame' : 'edge-frame'} style={frame(selected, ring)}>
        {showImage ? (
          <img data-testid="thumb-image" src={url} alt="" draggable={false} onError={() => setFailed(true)} style={picture} />
        ) : (
          <div data-testid="thumb-placeholder" style={{ ...picture, background: 'var(--line)' }} />
        )}
      </div>
      {numbered ? <span style={{ fontSize: 'var(--fs-meta)', lineHeight: '15px', textAlign: 'center', color: selected ? `var(--${ring})` : 'var(--grey)' }}>{n}</span> : null}
      {titleLink ? null : <span className="thumb-title">{title}</span>}
    </button>
  );
  if (!titleLink) return card;
  // A link cannot sit inside the button: it is the button's sibling, on the same line the title takes.
  return (
    <div className="thumb-wrap" style={{ position: 'relative' }}>
      {card}
      <a
        data-testid="thumb-title-link"
        className="thumb-title thumb-title-link"
        href={titleLink.href}
        onClick={(e) => {
          if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
          e.preventDefault();
          titleLink.onFollow();
        }}
      >
        {title}
      </a>
    </div>
  );
}
