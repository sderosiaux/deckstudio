import { useEffect } from 'react';

export const PRESENT_URL = '/api/present';

/**
 * The player is a standalone HTML page served by the server (original deck behaviour: arrows, `s` story, `n` notes).
 * This route hands the tab over to it; the link stays as a fallback when navigation is blocked.
 */
export function Present() {
  useEffect(() => {
    location.replace(PRESENT_URL);
  }, []);
  return (
    <div style={{ padding: 32 }}>
      <a href={PRESENT_URL} style={{ color: 'var(--accent)', fontWeight: 700 }}>Open the deck player</a>
    </div>
  );
}
