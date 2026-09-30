import type { Slide, SlideId } from '../../../src/model/types.js';
import { Thumb } from './Thumb.js';

export interface FilmstripProps {
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  /** Thumbnail URL per slide; undefined until the PNG is rendered. */
  thumbs: Record<SlideId, string | undefined>;
  selected?: SlideId;
  onSelect(id: SlideId): void;
  label?: string;
}

/** A labelled, horizontally scrollable row of slide thumbnails in deck order. */
export function Filmstrip({ order, slides, thumbs, selected, onSelect, label = 'main' }: FilmstripProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start', minWidth: 0 }}>
      <div style={{ width: 120, flex: '0 0 120px', paddingTop: 'calc(var(--thumb-h) / 2 - 9px)', fontWeight: 700, fontSize: 13, color: 'var(--ink)', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {label}
      </div>
      <div role="list" style={{ display: 'flex', gap: 'var(--col-gap)', overflowX: 'auto', padding: '6px 6px 12px', minWidth: 0, flex: 1 }}>
        {order.map((id, i) => {
          const slide = slides[id];
          return (
            <div role="listitem" key={id} style={{ flex: '0 0 auto' }}>
              <Thumb slideId={id} n={i + 1} title={slide?.title ?? id} url={thumbs[id]} selected={id === selected} onClick={() => onSelect(id)} />
            </div>
          );
        })}
      </div>
    </div>
  );
}
