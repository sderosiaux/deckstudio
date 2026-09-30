import { useEffect, useState, type CSSProperties } from 'react';

export type SlidePreviewVariant = 'main' | 'lane' | 'missing';

export interface SlidePreviewProps {
  /** Caption in the card's corner, eg "main · slide 7". */
  label: string;
  variant: SlidePreviewVariant;
  /** Slide title, shown until the thumbnail is ready. Ignored for `missing`. */
  title?: string;
  /** Rendered thumbnail; undefined while the server renders it. */
  url?: string;
  /** Text of the dashed card for `missing`, eg "not in main". */
  missingText?: string;
}

const WIDTH = 560;
const HEIGHT = (WIDTH * 720) / 1280;

const card = (variant: SlidePreviewVariant): CSSProperties => ({
  position: 'relative',
  width: WIDTH,
  flex: `0 0 ${WIDTH}px`,
  height: HEIGHT,
  borderRadius: 'var(--radius)',
  overflow: 'hidden',
  background: variant === 'missing' ? 'transparent' : 'var(--card)',
  border: variant === 'missing' ? '1.5px dashed var(--grey-2)' : undefined,
  boxShadow: variant === 'lane' ? '0 0 0 2px var(--accent), var(--shadow)' : variant === 'main' ? '0 0 0 1px var(--line), var(--shadow)' : undefined,
});

const caption: CSSProperties = {
  position: 'absolute',
  top: 10,
  left: 12,
  padding: '2px 8px',
  borderRadius: 6,
  background: 'var(--card)',
  color: 'var(--grey)',
  fontSize: 12,
  zIndex: 1,
};

/** One slide at reading size (560px wide, 16:9), from its thumbnail; or a dashed card when the slide does not exist on that side. */
export function SlidePreview({ label, variant, title = '', url, missingText = '' }: SlidePreviewProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <figure data-testid="slide-preview" data-variant={variant} aria-label={label} style={{ margin: 0, ...card(variant) }}>
      <figcaption style={caption}>{label}</figcaption>
      {variant === 'missing' ? (
        <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--grey)', fontSize: 15 }}>{missingText}</div>
      ) : url !== undefined && !failed ? (
        <img src={url} alt={title} draggable={false} onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'cover', display: 'block' }} />
      ) : (
        <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32, textAlign: 'center', background: 'var(--line)' }}>
          <strong style={{ fontSize: 22 }}>{title}</strong>
          <span className="muted" style={{ fontSize: 12 }}>{failed ? 'render failed' : 'rendering…'}</span>
        </div>
      )}
    </figure>
  );
}
