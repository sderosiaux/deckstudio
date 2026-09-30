import { useEffect, useState, type CSSProperties } from 'react';

export interface ThumbProps {
  slideId: string;
  n: number;
  title: string;
  url: string | undefined;
  selected: boolean;
  /** The selection ring: the accent (default), or ink where the accent already means "changed" (history diff). */
  ring?: 'accent' | 'ink';
  onClick(): void;
}

const RINGS = {
  accent: '0 0 0 2px var(--paper), 0 0 0 3.5px var(--accent)',
  ink: '0 0 0 2px var(--paper), 0 0 0 4px var(--ink)',
} as const;

/** A card the size of one grid column: the title on top, the rendered slide under it. */
const frame = (selected: boolean, ring: keyof typeof RINGS): CSSProperties => ({
  width: 'var(--thumb-w)',
  height: 'var(--thumb-h)',
  borderRadius: 4,
  overflow: 'hidden',
  background: 'var(--card)',
  boxShadow: selected ? RINGS[ring] : '0 0 0 1px var(--line)',
  display: 'flex',
  flexDirection: 'column',
  justifyContent: 'space-between',
  transition: 'box-shadow .15s ease',
});

const titleStyle: CSSProperties = {
  padding: '4px 4px 0',
  fontSize: 'var(--fs-meta)',
  fontWeight: 500,
  lineHeight: 1.15,
  color: 'var(--ink)',
  overflow: 'hidden',
  display: '-webkit-box',
  WebkitLineClamp: 2,
  WebkitBoxOrient: 'vertical',
  overflowWrap: 'anywhere',
};

const picture: CSSProperties = { width: '100%', aspectRatio: '16 / 9', flex: '0 0 auto', display: 'block', objectFit: 'cover', borderTop: '1px solid var(--line)' };

/** One slide in a filmstrip: a small card (title, rendered slide) with its number under it; a grey block stands in until the PNG is ready. */
export function Thumb({ slideId, n, title, url, selected, ring = 'accent', onClick }: ThumbProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  const showImage = url !== undefined && !failed;
  return (
    <button
      type="button"
      data-testid="thumb"
      data-slide={slideId}
      aria-pressed={selected}
      aria-label={`Slide ${n}: ${title}`}
      title={title}
      onClick={onClick}
      style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 4, width: 'var(--thumb-w)', flex: '0 0 auto' }}
    >
      <div className={selected ? 'thumb-selected' : undefined} style={frame(selected, ring)}>
        <span style={titleStyle}>{title}</span>
        {showImage ? (
          <img data-testid="thumb-image" src={url} alt="" draggable={false} onError={() => setFailed(true)} style={picture} />
        ) : (
          <div data-testid="thumb-placeholder" style={{ ...picture, background: 'var(--line)' }} />
        )}
      </div>
      <span style={{ fontSize: 'var(--fs-meta)', textAlign: 'center', color: selected ? `var(--${ring})` : 'var(--grey)' }}>{n}</span>
    </button>
  );
}
