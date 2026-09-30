import type { Anchor, Slide, SlideId } from '../../../src/model/types.js';
import { slidePath } from '../api.js';

export interface ContextChipProps {
  context: Anchor;
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  onClear?(): void;
  /** For a slide context: an "edit" link to that slide's edit screen. */
  onEdit?(slide: SlideId): void;
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
    case 'slide':
      return `slide ${num(context.slide)}`;
    case 'range':
      return `slides ${num(context.from)}–${num(context.to)}`;
  }
}

/** What the next message is about: the current selection on main. */
export function ContextChip({ context, order, slides, onClear, onEdit }: ContextChipProps) {
  const label = describeAnchor(context, order, slides);
  const title = context.kind === 'slide' ? slides[context.slide]?.title : undefined;
  return (
    <div
      data-testid="context-chip"
      data-kind={context.kind}
      style={{ display: 'inline-flex', alignItems: 'baseline', gap: 12, maxWidth: '100%', padding: '4px 10px', borderRadius: 4, border: '1px solid var(--line)', fontSize: 12, color: 'var(--ink)' }}
    >
      <span style={{ whiteSpace: 'nowrap' }}>context: {label}</span>
      {title ? (
        <span className="muted" style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis', minWidth: 0 }} title={title}>
          {title}
        </span>
      ) : null}
      {onEdit && context.kind === 'slide' ? (
        <a
          href={slidePath(context.slide)}
          className="link"
          style={{ fontSize: 12, color: 'var(--ink)' }}
          onClick={(e) => {
            if (e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
            e.preventDefault();
            onEdit(context.slide);
          }}
        >
          edit
        </a>
      ) : null}
      {onClear && context.kind !== 'arc' ? (
        <button type="button" aria-label="clear context" onClick={onClear} style={{ all: 'unset', cursor: 'pointer', color: 'var(--grey)', padding: '0 2px' }}>
          ×
        </button>
      ) : null}
    </div>
  );
}
