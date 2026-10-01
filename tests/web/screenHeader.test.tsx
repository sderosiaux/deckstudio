// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen } from '@testing-library/react';
import { BackToMain } from '../../web/src/components/ScreenHeader.js';

afterEach(() => {
  cleanup();
  history.replaceState(null, '', '/');
});

describe('header ways back', () => {
  it('offers every deck, then main of this deck', () => {
    history.replaceState(null, '', '/d/talk/history');
    const navigate = vi.fn<(path: string) => void>();
    render(<BackToMain navigate={navigate} />);
    const decks = screen.getByTestId('header-decks');
    const main = screen.getByTestId('header-main');
    expect(decks.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(decks.textContent).toBe('decks');
    expect(decks.getAttribute('href')).toBe('/');
    expect(main.getAttribute('href')).toBe('/d/talk/');
    fireEvent.click(decks);
    fireEvent.click(main);
    expect(navigate.mock.calls).toEqual([['/'], ['/d/talk/']]);
  });
});
