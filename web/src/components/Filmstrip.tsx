import type { Slide, SlideId } from '../../../src/model/types.js';
import { Thumb, type ThumbTitleLink } from './Thumb.js';

export interface FilmstripProps {
  order: SlideId[];
  slides: Record<SlideId, Slide>;
  /** Thumbnail URL per slide; undefined until the PNG is rendered. */
  thumbs: Record<SlideId, string | undefined>;
  /** The selected slide, or every slide of a selected range: each gets the ring and the accent number. */
  selected?: SlideId | readonly SlideId[];
  onSelect(id: SlideId): void;
  /** Double-click on a slide (main: present from it). */
  onOpen?(id: SlideId): void;
  label?: string;
  /** Full row name, as the gutter label's tooltip when `label` is a shortened one. */
  fullLabel?: string;
  /** Makes the selected slide's title line a link (main: to its edit screen). */
  titleLink?(id: SlideId): ThumbTitleLink | undefined;
}

/** A row of slide thumbnails in deck order, its name in the gutter. The canvas around it scrolls, not the row. */
export function Filmstrip({ order, slides, thumbs, selected, onSelect, onOpen, label = 'main', fullLabel, titleLink }: FilmstripProps) {
  const picked = new Set<SlideId>(selected === undefined ? [] : typeof selected === 'string' ? [selected] : selected);
  const range = picked.size > 1;
  return (
    <div style={{ display: 'flex', alignItems: 'stretch' }}>
      <div className="gutter row-label" title={fullLabel} style={{ paddingTop: 8 }}>
        {label}
      </div>
      {/* 22px under the numbers: room for the selected slide's title line. */}
      <div role="list" data-strip={label} data-range={range ? '' : undefined} data-edge-row style={{ display: 'flex', gap: 'var(--col-gap)', padding: '6px 6px 22px' }}>
        {order.map((id, i) => {
          const slide = slides[id];
          return (
            <div role="listitem" key={id} data-edge-item style={{ flex: '0 0 auto' }}>
              <Thumb
                slideId={id}
                n={i + 1}
                title={slide?.title ?? id}
                url={thumbs[id]}
                selected={picked.has(id)}
                onClick={() => onSelect(id)}
                onDoubleClick={onOpen ? () => onOpen(id) : undefined}
                titleLink={!range && picked.has(id) ? titleLink?.(id) : undefined}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
