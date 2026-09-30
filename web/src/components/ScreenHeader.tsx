import type { CSSProperties, ReactNode } from 'react';
import { navigate as defaultNavigate } from '../api.js';

/**
 * The header every screen shares: the empty 120px gutter, then the screen's title on the column start (x = 144), on
 * one baseline, so the title never moves between screens and no screen names itself twice.
 */
export function ScreenHeader({ children }: { children: ReactNode }) {
  return (
    <header className="screen-header">
      <div className="gutter" />
      {children}
    </header>
  );
}

/** The way back to main, a quiet link on the header's right side, before the screen's primary action. */
export function BackToMain({ navigate = defaultNavigate, style }: { navigate?: (path: string) => void; style?: CSSProperties }) {
  return (
    <a
      href="/"
      data-testid="header-main"
      className="link"
      style={{ marginLeft: 'auto', ...style }}
      onClick={(e) => {
        e.preventDefault();
        navigate('/');
      }}
    >
      back to main
    </a>
  );
}
