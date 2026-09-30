import { useLayoutEffect, useState, type RefObject } from 'react';

/** Width of the fade over the last visible thumb, and of the slot beside it that holds the count. */
export const END_W = 32;

/** One row of a strip ([data-edge-row]) and how many of its items ([data-edge-item]) lie past the visible end. */
export interface EdgeRow {
  hidden: number;
  /** Middle of the row's cards, from the top of the scroller's box: where the count sits. */
  top: number;
}

/** Deck columns fully in view inside a horizontally scrolling canvas, and how many lie past its visible end. */
export interface VisibleColumns {
  /** 0-based first column not under the sticky gutter, and one past the last column that fits before the end slot. */
  first: number;
  end: number;
  /** Columns cut by or beyond the visible end. */
  hidden: number;
  /** Every marked row of the canvas: each gets its own count. */
  rows: EdgeRow[];
}

const same = (a: VisibleColumns | null, b: VisibleColumns | null): boolean =>
  a === b ||
  (a !== null &&
    b !== null &&
    a.first === b.first &&
    a.end === b.end &&
    a.hidden === b.hidden &&
    a.rows.length === b.rows.length &&
    a.rows.every((r, i) => r.hidden === b.rows[i]!.hidden && r.top === b.rows[i]!.top));

function measure(scroller: HTMLElement, items: readonly Element[]): VisibleColumns | null {
  const box = scroller.getBoundingClientRect();
  if (box.width === 0 || items.length === 0) return null;
  const left = scroller.querySelector('.gutter')?.getBoundingClientRect().right ?? box.left;
  // The last END_W pixels hold the count: a card reaching into them is past the end.
  const right = box.left + scroller.clientWidth - END_W;
  const rects = items.map((el) => el.getBoundingClientRect());
  let first = rects.findIndex((r) => r.left >= left - 1);
  if (first < 0) first = rects.length;
  let end = first;
  while (end < rects.length && rects[end]!.right <= right + 1) end++;
  const hidden = rects.filter((r) => r.right > right + 1).length;
  const rows = [...scroller.querySelectorAll('[data-edge-row]')].flatMap((row) => {
    const cells = [...row.querySelectorAll('[data-edge-item]')];
    if (cells.length === 0) return [];
    const frame = (cells[0]!.querySelector('.edge-frame') ?? cells[0]!).getBoundingClientRect();
    return [{ hidden: cells.filter((c) => c.getBoundingClientRect().right > right + 1).length, top: Math.round(frame.top - box.top + frame.height / 2) }];
  });
  return { first, end, hidden, rows };
}

/**
 * Tracks which columns of `selector` (the thumbnails of one strip, in column order) are in view while `scroller`
 * scrolls or resizes, and how many items of each [data-edge-row] lie past the end. Null until laid out (and in
 * jsdom), which callers read as "everything fits". The scroller needs at least END_W of right padding so that its
 * last card, scrolled to the end, clears the count slot.
 */
export function useVisibleColumns(scroller: RefObject<HTMLElement | null>, selector: string, deps: readonly unknown[]): VisibleColumns | null {
  const [visible, setVisible] = useState<VisibleColumns | null>(null);
  useLayoutEffect(() => {
    const el = scroller.current;
    if (!el) return;
    let frame = 0;
    const update = (): void => {
      frame = 0;
      const next = measure(el, [...el.querySelectorAll(selector)]);
      setVisible((prev) => (same(prev, next) ? prev : next));
    };
    const schedule = (): void => {
      if (!frame) frame = requestAnimationFrame(update);
    };
    update();
    el.addEventListener('scroll', schedule, { passive: true });
    window.addEventListener('resize', schedule);
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(schedule);
    ro?.observe(el);
    // Rows come and go (a lane opens, a preview loads) without resizing the scroller.
    const mo = typeof MutationObserver === 'undefined' ? null : new MutationObserver(schedule);
    mo?.observe(el, { childList: true, subtree: true });
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
      mo?.disconnect();
    };
  }, [scroller, selector, ...deps]);
  return visible;
}

/**
 * The right end of a canvas that scrolls on, the same on every strip: a 32px fade from transparent to paper over
 * the last visible cards, then a 32px paper slot where each row that runs on prints its own "+N", level with its
 * cards. Nothing when every row fits. Place it in a positioned box the size of the scroller.
 */
export function EdgeFade({ visible, testId = 'edge-fade' }: { visible: VisibleColumns | null; testId?: string }) {
  if (!visible || visible.rows.every((r) => r.hidden === 0)) return null;
  return (
    <div data-testid={testId} aria-hidden style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: END_W * 2, overflow: 'hidden', pointerEvents: 'none', display: 'flex' }}>
      <div style={{ width: END_W, background: 'linear-gradient(to right, transparent, var(--paper))' }} />
      <div style={{ position: 'relative', width: END_W, background: 'var(--paper)' }}>
        {visible.rows.map((r, i) =>
          r.hidden > 0 ? (
            <span
              key={i}
              data-testid={`${testId}-count`}
              style={{ position: 'absolute', left: 0, right: 0, top: r.top, transform: 'translateY(-50%)', textAlign: 'center', fontSize: 'var(--fs-meta)', color: 'var(--grey)', lineHeight: 1 }}
            >
              +{r.hidden}
            </span>
          ) : null,
        )}
      </div>
    </div>
  );
}
