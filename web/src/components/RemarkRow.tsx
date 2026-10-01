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

/** A card is never narrower than this many columns (about 220px or more): remark text needs a measure that breaks on words. */
export const MIN_CARD_COLS = 4;
/** Narrowest a card may get to keep clear of a moved hairline: below it, the card covers the line instead. */
export const MIN_READABLE_COLS = 2;

export interface Placed {
  id: string;
  /** 0-based first column of the card and its width in columns. */
  start: number;
  width: number;
  /** 0-based stacking row: cards whose columns overlap go on separate rows. */
  row: number;
  /** The card starts on a column a moved hairline runs down: it starts MOVE_CLEAR px into that column instead. */
  inset: boolean;
}

/**
 * Room a card leaves beside a moved hairline, which runs 4px inside its column's left edge: a card starting on that
 * column starts 12px right of the line; a card ending before it ends one 8px gap plus the 4px short of it.
 */
export const MOVE_CLEAR = 16;

/**
 * Places cards on `columns` deck columns: selected ones first, then left to right. Each starts at its anchor column
 * (pulled left when it would run past the last column) and takes the first row where it overlaps no card already
 * placed. Cards that would need more than `maxRows` rows are left out.
 * With a `view` (the columns in sight of a scrolling canvas), cards anchored outside it are left out and the others
 * stay inside it: a card never runs past the visible right edge.
 * `avoid` lists the columns a moved hairline runs down: a card never covers one, except by starting on it (inset
 * past the line), so the line reads unbroken from main's thumb to its lane slot. Such a card may come out narrower,
 * never under MIN_READABLE_COLS: squeezed more, it ignores the lines.
 */
export function placeCards(
  items: readonly { id: string; col: number; span: number; selected?: boolean }[],
  columns: number,
  maxRows = Infinity,
  view?: { first: number; end: number },
  avoid: ReadonlySet<number> = new Set(),
): Placed[] {
  const lo = view ? Math.max(0, view.first) : 0;
  const hi = view ? Math.min(columns, view.end) : columns;
  const rows: Array<Array<[number, number]>> = [];
  const lines = [...avoid];
  return [...items]
    .filter((it) => it.col >= lo && it.col < hi)
    .sort((a, b) => Number(Boolean(b.selected)) - Number(Boolean(a.selected)) || a.col - b.col)
    .flatMap((it) => {
      // The stretch around the anchor that no line crosses: from the last line at or left of it (the card may start
      // there, inset) to the first line right of it.
      const clearFrom = Math.max(lo, ...lines.filter((c) => c <= it.col));
      const clearTo = Math.min(hi, ...lines.filter((c) => c > it.col));
      // Under MIN_READABLE_COLS between two lines, no text reads and the actions spill out: the card runs over the
      // lines (it sits above them) rather than shrink to one column.
      const squeezed = clearTo - clearFrom < MIN_READABLE_COLS;
      const from = squeezed ? lo : clearFrom;
      const to = squeezed ? hi : clearTo;
      const width = Math.min(Math.max(it.span, MIN_CARD_COLS), Math.max(to - from, 1));
      const start = Math.max(from, Math.min(it.col, to - width));
      const end = start + width;
      let row = rows.findIndex((taken) => taken.every(([s, e]) => end <= s || start >= e));
      if (row < 0) {
        if (rows.length >= maxRows) return [];
        row = rows.push([]) - 1;
      }
      rows[row]!.push([start, end]);
      return [{ id: it.id, start, width, row, inset: avoid.has(start) }];
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
  slotTestId = 'post-it-slot',
  maxRows,
  view,
  avoid,
}: {
  items: readonly Pinned[];
  columns: number;
  testId: string;
  /** Test id of each card's slot. */
  slotTestId?: string;
  maxRows?: number;
  view?: { first: number; end: number };
  /** Columns a moved hairline runs down: cards keep clear of them (see placeCards). */
  avoid?: ReadonlySet<number>;
}) {
  const placed = new Map(placeCards(items, columns, maxRows, view, avoid).map((p) => [p.id, p]));
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
            data-testid={slotTestId}
            data-col={it.col}
            data-span={it.span}
            data-slide={it.slide}
            data-inset={p.inset ? 'true' : undefined}
            style={{ position: 'relative', gridColumn: `${p.start + 1} / span ${p.width}`, gridRow: p.row + 2, marginLeft: p.inset ? MOVE_CLEAR : 0 }}
          >
            <span
              aria-hidden
              style={{
                position: 'absolute',
                bottom: '100%',
                left: p.inset ? `calc(${colOffset(it.col - p.start)} - ${MOVE_CLEAR}px)` : colOffset(it.col - p.start),
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
