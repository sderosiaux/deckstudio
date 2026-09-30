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
  accent: '0 0 0 2px var(--paper), 0 0 0 4px var(--accent)',
  ink: '0 0 0 2px var(--paper), 0 0 0 5px var(--ink)',
} as const;

const frame = (selected: boolean, ring: keyof typeof RINGS): CSSProperties => ({
  width: 'var(--thumb-w)',
  height: 'var(--thumb-h)',
  borderRadius: 6,
  overflow: 'hidden',
  background: 'var(--card)',
  boxShadow: selected ? RINGS[ring] : '0 0 0 1px var(--line)',
  transition: 'box-shadow .15s ease, transform .15s ease',
});

const placeholder: CSSProperties = {
  width: '100%',
  height: '100%',
  display: 'flex',
  alignItems: 'center',
  justifyContent: 'center',
  padding: 10,
  background: 'var(--line)',
  color: 'var(--grey)',
  fontSize: 11,
  fontWeight: 600,
  textAlign: 'center',
  lineHeight: 1.25,
  overflow: 'hidden',
};

/** One slide in a filmstrip: the rendered thumbnail, or a grey card with the title until the PNG is ready. */
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
      onClick={onClick}
      style={{ all: 'unset', cursor: 'pointer', display: 'flex', flexDirection: 'column', gap: 6, width: 'var(--thumb-w)', flex: '0 0 auto' }}
    >
      <div className={selected ? 'thumb-selected' : undefined} style={frame(selected, ring)}>
        {showImage ? (
          <img data-testid="thumb-image" src={url} alt="" draggable={false} onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
        ) : (
          <div data-testid="thumb-placeholder" style={placeholder}>{title}</div>
        )}
      </div>
      <div style={{ display: 'flex', gap: 6, alignItems: 'baseline', minWidth: 0, fontSize: 12 }}>
        <span className="mono" style={{ color: selected ? `var(--${ring})` : 'var(--grey)', flex: '0 0 auto' }}>{n}</span>
        <span title={title} style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0, color: 'var(--ink)' }}>{title}</span>
      </div>
    </button>
  );
}
