// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react';
import { Filmstrip } from '../../web/src/components/Filmstrip.js';
import type { Slide, SlideId } from '../../src/model/types.js';

const slide = (id: string, title: string): Slide => ({ id, title, story: '', notes: '', body: `<p>${title}</p>`, assets: [], kind: 'text' });
const titles = ['Opening', 'The problem', 'A diagram', 'Some code', 'Close'];
const order: SlideId[] = titles.map((_, i) => `s${i + 1}`);
const slides: Record<SlideId, Slide> = Object.fromEntries(order.map((id, i) => [id, slide(id, titles[i]!)]));

afterEach(() => cleanup());

describe('Filmstrip', () => {
  it('renders 5 thumbs in deck order with number and title', () => {
    render(<Filmstrip order={order} slides={slides} thumbs={{}} onSelect={() => {}} />);
    const items = screen.getAllByTestId('thumb');
    expect(items).toHaveLength(5);
    expect(items.map((el) => el.getAttribute('data-slide'))).toEqual(order);
    items.forEach((el, i) => {
      expect(within(el).getByText(String(i + 1))).toBeTruthy();
      expect(within(el).getAllByText(titles[i]!).length).toBeGreaterThan(0);
    });
    expect(screen.getByText('main')).toBeTruthy();
  });

  it('shows placeholders until thumb URLs arrive, then images', () => {
    const { rerender } = render(<Filmstrip order={order} slides={slides} thumbs={{}} onSelect={() => {}} />);
    expect(screen.getAllByTestId('thumb-placeholder')).toHaveLength(5);
    expect(screen.queryAllByTestId('thumb-image')).toHaveLength(0);

    rerender(<Filmstrip order={order} slides={slides} thumbs={{ s1: '/api/thumbs/aaa.png', s3: '/api/thumbs/ccc.png' }} onSelect={() => {}} />);
    const imgs = screen.getAllByTestId('thumb-image') as HTMLImageElement[];
    expect(imgs.map((i) => i.getAttribute('src'))).toEqual(['/api/thumbs/aaa.png', '/api/thumbs/ccc.png']);
    expect(screen.getAllByTestId('thumb-placeholder')).toHaveLength(3);
  });

  it('calls onSelect with the slide id on click and marks the selection', () => {
    const onSelect = vi.fn();
    const { rerender } = render(<Filmstrip order={order} slides={slides} thumbs={{}} onSelect={onSelect} />);
    fireEvent.click(screen.getAllByTestId('thumb')[2]!);
    expect(onSelect).toHaveBeenCalledWith('s3');
    rerender(<Filmstrip order={order} slides={slides} thumbs={{}} selected="s3" onSelect={onSelect} />);
    const selected = screen.getAllByTestId('thumb').filter((el) => el.getAttribute('aria-pressed') === 'true');
    expect(selected.map((el) => el.getAttribute('data-slide'))).toEqual(['s3']);
  });
});
