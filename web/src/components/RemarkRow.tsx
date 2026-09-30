import type { ReactNode } from 'react';

/** A card pinned under a column of the deck grid: `col` is the slide it points at, `span` the columns its anchor covers. */
export interface Pinned {
  id: string;
  col: number;
  span: number;
  selected?: boolean;
  /** The slide the card is pinned to, for tests and hover. */
  slide?: string;
  card: ReactNode;
}

/** A card is never narrower than this many columns: remark text needs a readable measure. */
export const MIN_CARD_COLS = 3;

export interface Placed {
  id: string;
  /** 0-based first column of the card and its width in columns. */
  start: number;
  width: number;
  /** 0-based stacking row: cards whose columns overlap go on separate rows. */
  row: number;
}

/**
 * Places cards on `columns` deck columns: selected ones first, then left to right. Each starts at its anchor column
 * (pulled left when it would run past the last column) and takes the first row where it overlaps no card already
 * placed. Cards that would need more than `maxRows` rows are left out.
 * With a `view` (the columns in sight of a scrolling canvas), cards anchored outside it are left out and the others
 * stay inside it: a card never runs past the visible right edge.
 */
export function placeCards(
  items: readonly { id: string; col: number; span: number; selected?: boolean }[],
  columns: number,
  maxRows = Infinity,
  view?: { first: number; end: number },
): Placed[] {
  const lo = view ? Math.max(0, view.first) : 0;
  const hi = view ? Math.min(columns, view.end) : columns;
  const rows: Array<Array<[number, number]>> = [];
  return [...items]
    .filter((it) => it.col >= lo && it.col < hi)
    .sort((a, b) => Number(Boolean(b.selected)) - Number(Boolean(a.selected)) || a.col - b.col)
    .flatMap((it) => {
      const width = Math.min(Math.max(it.span, MIN_CARD_COLS), Math.max(hi - lo, 1));
      const start = Math.max(lo, Math.min(it.col, hi - width));
      const end = start + width;
      let row = rows.findIndex((taken) => taken.every(([s, e]) => end <= s || start >= e));
      if (row < 0) {
        if (rows.length >= maxRows) return [];
        row = rows.push([]) - 1;
      }
      rows[row]!.push([start, end]);
      return [{ id: it.id, start, width, row }];
    });
}

const colOffset = (n: number): string => `calc(${n} * (var(--thumb-w) + var(--col-gap)) + var(--thumb-w) / 2)`;

/**
 * Remark cards laid on the deck grid under the slides they point at. A pin (small dot) marks the slide's column and a
 * hairline runs from it down to the card; lines pass behind the cards of upper rows.
 */
export function RemarkRow({
  items,
  columns,
  testId,
  maxRows,
  view,
}: {
  items: readonly Pinned[];
  columns: number;
  testId: string;
  maxRows?: number;
  view?: { first: number; end: number };
}) {
  const placed = new Map(placeCards(items, columns, maxRows, view).map((p) => [p.id, p]));
  const pins = [...new Set(items.map((i) => i.col))];
  return (
    <div
      data-testid={testId}
      style={{
        position: 'relative',
        overflow: 'hidden',
        display: 'grid',
        gridTemplateColumns: `repeat(${Math.max(columns, 1)}, var(--thumb-w))`,
        gridTemplateRows: '8px',
        columnGap: 'var(--col-gap)',
        rowGap: 10,
        alignItems: 'start',
        padding: '0 6px',
      }}
    >
      {pins.map((col) => (
        <span key={`pin:${col}`} aria-hidden style={{ gridRow: 1, gridColumn: col + 1, justifySelf: 'center', width: 5, height: 5, marginTop: 2, borderRadius: 999, background: 'var(--grey-2)' }} />
      ))}
      {items.map((it) => {
        const p = placed.get(it.id);
        if (!p) return null;
        return (
          <div
            key={it.id}
            data-testid="post-it-slot"
            data-col={it.col}
            data-span={it.span}
            data-slide={it.slide}
            style={{ position: 'relative', gridColumn: `${p.start + 1} / span ${p.width}`, gridRow: p.row + 2 }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                bottom: '100%',
                left: colOffset(it.col - p.start),
                height: 2000,
                borderLeft: `1px solid ${it.selected ? 'var(--accent)' : 'var(--grey-2)'}`,
              }}
            />
            {it.card}
          </div>
        );
      })}
    </div>
  );
}
