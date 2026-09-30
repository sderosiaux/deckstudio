import { useEffect, useState, type CSSProperties } from 'react';

export type SlidePreviewVariant = 'main' | 'lane' | 'missing';

export interface SlidePreviewProps {
  /** The card's label, on its own line above the slide, eg "main, slide 7". */
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

/** The card: white, its ring saying which side it is, 12px of padding around the label line and the slide frame. */
const card = (variant: SlidePreviewVariant): CSSProperties => ({
  width: WIDTH,
  flex: `0 0 ${WIDTH}px`,
  display: 'flex',
  flexDirection: 'column',
  gap: 8,
  padding: 12,
  borderRadius: 'var(--radius)',
  background: variant === 'missing' ? 'transparent' : 'var(--card)',
  boxShadow: variant === 'lane' ? '0 0 0 2px var(--accent), var(--shadow)' : variant === 'main' ? '0 0 0 1px var(--line), var(--shadow)' : '0 0 0 1px var(--line)',
});

/** The label on its own line above the slide, never over it. */
const caption: CSSProperties = { fontSize: 'var(--fs-meta)', lineHeight: '16px', color: 'var(--grey)', whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' };

/** The slide frame: the whole 16:9 render inset in a 1px line, nothing cropped. */
const frame = (variant: SlidePreviewVariant): CSSProperties => ({
  position: 'relative',
  width: '100%',
  aspectRatio: '16 / 9',
  overflow: 'hidden',
  border: variant === 'missing' ? '1px dashed var(--grey-2)' : '1px solid var(--line)',
  borderRadius: 2,
});

/**
 * One slide at reading size (560px wide unless its container sets the width): the label line, then the whole slide
 * in an inset 16:9 frame, from its thumbnail; or a dashed frame when the slide does not exist on that side.
 */
export function SlidePreview({ label, variant, title = '', url, missingText = '' }: SlidePreviewProps) {
  const [failed, setFailed] = useState(false);
  useEffect(() => setFailed(false), [url]);
  return (
    <figure data-testid="slide-preview" data-variant={variant} aria-label={label} style={{ margin: 0, ...card(variant) }}>
      <figcaption style={caption} title={label}>{label}</figcaption>
      <div data-testid="slide-frame" style={frame(variant)}>
        {variant === 'missing' ? (
          <div style={{ height: '100%', display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--grey)', fontSize: 15 }}>{missingText}</div>
        ) : url !== undefined && !failed ? (
          <img src={url} alt={title} draggable={false} onError={() => setFailed(true)} style={{ width: '100%', height: '100%', objectFit: 'contain', display: 'block' }} />
        ) : (
          <div style={{ height: '100%', display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'center', gap: 8, padding: 32, textAlign: 'center', background: 'var(--line)' }}>
            <strong style={{ fontSize: 22 }}>{title}</strong>
            <span className="muted" style={{ fontSize: 12 }}>{failed ? 'render failed' : 'rendering…'}</span>
          </div>
        )}
      </div>
    </figure>
  );
}
