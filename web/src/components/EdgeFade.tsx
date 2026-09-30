import { useLayoutEffect, useState, type RefObject } from 'react';

/** Deck columns fully in view inside a horizontally scrolling canvas, and how many lie past its right edge. */
export interface VisibleColumns {
  /** 0-based first column not under the sticky gutter, and one past the last column that fits before the right edge. */
  first: number;
  end: number;
  /** Columns cut by or beyond the right edge. */
  hidden: number;
  /** Middle of the strip's thumbnails, from the top of the scroller's box: where the count sits. */
  countTop: number;
}

const same = (a: VisibleColumns | null, b: VisibleColumns | null): boolean =>
  a === b || (a !== null && b !== null && a.first === b.first && a.end === b.end && a.hidden === b.hidden && a.countTop === b.countTop);

function measure(scroller: HTMLElement, items: readonly Element[]): VisibleColumns | null {
  const box = scroller.getBoundingClientRect();
  if (box.width === 0 || items.length === 0) return null;
  const pad = parseFloat(getComputedStyle(scroller).paddingRight) || 0;
  const left = scroller.querySelector('.gutter')?.getBoundingClientRect().right ?? box.left;
  const right = box.left + scroller.clientWidth - pad;
  const rects = items.map((el) => el.getBoundingClientRect());
  let first = rects.findIndex((r) => r.left >= left - 1);
  if (first < 0) first = rects.length;
  let end = first;
  while (end < rects.length && rects[end]!.right <= right + 1) end++;
  const hidden = rects.filter((r) => r.right > right + 1).length;
  const r0 = rects[0]!;
  return { first, end, hidden, countTop: Math.round(r0.top - box.top + Math.min(r0.height, 80) / 2) };
}

/**
 * Tracks which columns of `selector` (the thumbnails of one strip, in column order) are in view while `scroller`
 * scrolls or resizes. Null until laid out (and in jsdom), which callers read as "everything fits".
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
    return () => {
      if (frame) cancelAnimationFrame(frame);
      el.removeEventListener('scroll', schedule);
      window.removeEventListener('resize', schedule);
      ro?.disconnect();
    };
  }, [scroller, selector, ...deps]);
  return visible;
}

/**
 * The right end of a strip that scrolls on: a 32px fade from transparent to paper over the canvas edge, and the
 * number of slides past it. Nothing when every column fits. Place it in a positioned box around the scroller.
 */
export function EdgeFade({ visible, testId = 'edge-fade' }: { visible: VisibleColumns | null; testId?: string }) {
  if (!visible || visible.hidden === 0) return null;
  return (
    <div data-testid={testId} aria-hidden style={{ position: 'absolute', top: 0, right: 0, bottom: 0, width: 32, pointerEvents: 'none', background: 'linear-gradient(to right, transparent, var(--paper))' }}>
      <span
        data-testid={`${testId}-count`}
        style={{ position: 'absolute', right: 2, top: visible.countTop, transform: 'translateY(-50%)', fontSize: 'var(--fs-meta)', color: 'var(--grey)', background: 'var(--paper)', padding: '2px 2px', lineHeight: 1 }}
      >
        +{visible.hidden}
      </span>
    </div>
  );
}
