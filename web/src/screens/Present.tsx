import { useEffect } from 'react';
import { presentUrl } from '../api.js';

/**
 * The player is a standalone HTML page served by the server (original deck behaviour: arrows, `s` story, `n` notes).
 * This route hands the tab over to it; the link stays as a fallback when navigation is blocked.
 */
export function Present() {
  const url = presentUrl();
  useEffect(() => {
    // assign, not replace: the browser's back button must return to the workbench.
    location.assign(url);
  }, [url]);
  return (
    <div style={{ padding: 32 }}>
      <a href={url} style={{ color: 'var(--accent)', fontWeight: 700 }}>Open the deck player</a>
    </div>
  );
}
