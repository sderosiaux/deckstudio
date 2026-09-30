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
}

const RINGS = {
  accent: '0 0 0 2px var(--paper), 0 0 0 3.5px var(--accent)',
  ink: '0 0 0 2px var(--paper), 0 0 0 4px var(--ink)',
} as const;

/** A card the size of one grid column, filled by the rendered slide. */
const frame = (selected: boolean, ring: keyof typeof RINGS): CSSProperties => ({
  width: 'var(--thumb-w)',
  height: 'var(--thumb-h)',
  borderRadius: 4,
  overflow: 'hidden',
  background: 'var(--card)',
  boxShadow: selected ? RINGS[ring] : '0 0 0 1px var(--line)',
  transition: 'box-shadow .15s ease',
});

/*
 * The slide covers the whole card. Cards are narrower than 16:9, so the render is cropped on the right: the deck's
 * titles are left aligned, and their start is what identifies a slide at this size.
 */
const picture: CSSProperties = { width: '100%', height: '100%', display: 'block', objectFit: 'cover', objectPosition: 'left center' };

/**
 * One slide in a strip: the rendered slide (a grey block until the PNG is ready), its number under it unless
 * `numbered` is off, and its title as one line on hover or selection.
 */
export function Thumb({ slideId, n, title, url, selected, ring = 'accent', numbered = true, onClick }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const showImage = url !== undefined && !failed;
  return (
    <button
      type="button"
      className="thumb"
      data-testid="thumb"
      data-slide={slideId}
      aria-pressed={selected}
      aria-label={`Slide ${n}: ${title}`}
      onClick={onClick}
      style={{ all: 'unset', position: 'relative', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, width: 'var(--thumb-w)', flex: '0 0 auto' }}
    >
      <div className={selected ? 'thumb-selected edge-frame' : 'edge-frame'} style={frame(selected, ring)}>
        {showImage ? (
          <img data-testid="thumb-image" src={url} alt="" draggable={false} onError={() => setFailed(true)} style={picture} />
        ) : (
          <div data-testid="thumb-placeholder" style={{ ...picture, background: 'var(--line)' }} />
        )}
      </div>
      {numbered ? <span style={{ fontSize: 'var(--fs-meta)', lineHeight: '15px', textAlign: 'center', color: selected ? `var(--${ring})` : 'var(--grey)' }}>{n}</span> : null}
      <span className="thumb-title">{title}</span>
    </button>
  );
}
