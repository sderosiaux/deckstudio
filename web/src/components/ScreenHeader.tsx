import type { ReactNode } from 'react';
import { navigate as defaultNavigate } from '../api.js';

/**
 * The header every screen shares: "main" in the 120px gutter (plain on main itself, a link back elsewhere), then the
 * screen's title on the column start, on one baseline, so the title never moves between screens.
 */
export function ScreenHeader({ onMain = false, navigate = defaultNavigate, children }: { onMain?: boolean; navigate?: (path: string) => void; children: ReactNode }) {
  return (
    <header className="screen-header">
      <div className="gutter">
        {onMain ? (
          <span data-testid="header-main">main</span>
        ) : (
          <a
            href="/"
            data-testid="header-main"
            className="link"
            onClick={(e) => {
              e.preventDefault();
              navigate('/');
            }}
          >
            main
          </a>
        )}
      </div>
      {children}
    </header>
  );
}
