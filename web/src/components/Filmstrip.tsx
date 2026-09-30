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
  /** Full row name, as the gutter label's tooltip when `label` is a shortened one. */
  fullLabel?: string;
}

/** A row of slide thumbnails in deck order, its name in the gutter. The canvas around it scrolls, not the row. */
export function Filmstrip({ order, slides, thumbs, selected, onSelect, label = 'main', fullLabel }: FilmstripProps) {
  return (
    <div style={{ display: 'flex', alignItems: 'flex-start' }}>
      <div className="gutter row-label" title={fullLabel} style={{ paddingTop: 8 }}>
        {label}
      </div>
      <div role="list" style={{ display: 'flex', gap: 'var(--col-gap)', padding: '6px 6px 4px' }}>
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
