import type { Anchor, Slide, SlideId } from '../../../src/model/types.js';

export interface ContextChipProps {
  context: Anchor;
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  onClear?(): void;
}

/** Human label of an anchor against the current main order (1-based slide numbers). */
export function describeAnchor(context: Anchor, order: SlideId[], slides: Record<SlideId, Slide>): string {
  const num = (id: SlideId): string => {
    const i = order.indexOf(id);
    return i < 0 ? `${id} (not on main)` : String(i + 1);
  };
  switch (context.kind) {
    case 'arc':
      return 'whole deck';
    case 'slide': {
      const title = slides[context.slide]?.title;
      return `slide ${num(context.slide)}${title ? ` · ${title}` : ''}`;
    }
    case 'range':
      return `slides ${num(context.from)}–${num(context.to)}`;
  }
}

/** What the next message is about: the current selection on main. */
export function ContextChip({ context, order, slides, onClear }: ContextChipProps) {
  const label = describeAnchor(context, order, slides);
  return (
    <div
      data-testid="context-chip"
      data-kind={context.kind}
      style={{ display: 'inline-flex', alignItems: 'center', gap: 6, maxWidth: '100%', padding: '5px 10px', borderRadius: 8, background: 'var(--line)', fontSize: 12, color: 'var(--ink)' }}
    >
      <span style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }} title={label}>
        context: {label}
      </span>
      {onClear && context.kind !== 'arc' ? (
        <button type="button" aria-label="clear context" onClick={onClear} style={{ all: 'unset', cursor: 'pointer', color: 'var(--grey)', padding: '0 2px' }}>
          ×
        </button>
      ) : null}
    </div>
  );
}
