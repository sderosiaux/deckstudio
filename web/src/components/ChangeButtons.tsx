import type { CSSProperties } from 'react';
import type { Change, Lane } from '../../../src/model/types.js';

export interface ChangeButtonsProps {
  change: Change;
  disabled: boolean;
  onAccept(changeId: string): void;
  onRefuse(changeId: string): void;
  /** What the change does, in the creator's words ("modify slide 3, Hook"): the buttons' accessible names. */
  describe?: string;
}

const btn = (tone: 'ok' | 'warn', disabled: boolean): CSSProperties => ({
  width: 26,
  height: 26,
  display: 'inline-flex',
  alignItems: 'center',
  justifyContent: 'center',
  borderRadius: 6,
  border: '1px solid var(--line)',
  background: 'var(--card)',
  color: tone === 'ok' ? 'var(--ink)' : 'var(--grey)',
  cursor: disabled ? 'default' : 'pointer',
  opacity: disabled ? 0.5 : 1,
  fontSize: 13,
  lineHeight: 1,
  padding: 0,
  transition: 'border-color .15s ease, background .15s ease',
});

const verb: Record<Change['kind'], string> = { insert: 'insert', modify: 'modify', remove: 'remove', move: 'move' };

/** ✓ ✗ for one change of a lane. The reason is the tooltip, so the creator can judge before clicking. */
export function ChangeButtons({ change, disabled, onAccept, onRefuse, describe }: ChangeButtonsProps) {
  const hint = `${verb[change.kind]}: ${change.reason}`;
  const name = (action: 'accept' | 'refuse'): string => (describe ? `${action}: ${describe}` : `${action} change ${change.id}`);
  return (
    <div style={{ display: 'flex', gap: 6 }} data-testid="change-buttons" data-change={change.id}>
      <button type="button" aria-label={name('accept')} title={`Accept (${hint})`} disabled={disabled} onClick={(e) => {
          e.stopPropagation();
          onAccept(change.id);
        }} style={btn('ok', disabled)}>
        ✓
      </button>
      <button type="button" aria-label={name('refuse')} title={`Refuse (${hint})`} disabled={disabled} onClick={(e) => {
          e.stopPropagation();
          onRefuse(change.id);
        }} style={btn('warn', disabled)}>
        ✗
      </button>
    </div>
  );
}

/** The cause the server gives a change it settled itself when rebasing a lane on main, instead of the creator. */
export const ALREADY_ON_MAIN = 'already on main';

/** The server's reasons for the changes it settled on a rebase, by change id, as the lane payload carries them. */
export function causesOf(lane: Lane): Record<string, string> {
  return (lane as Lane & { causes?: Record<string, string> }).causes ?? {};
}

/**
 * What stands instead of accept and refuse for a change nobody has to decide: "stale: <the server's reason>" for an
 * orphan, "already on main" for a change main took on its own; null for any other.
 */
export function settledNote(lane: Lane, change: Change): string | null {
  const cause = causesOf(lane)[change.id];
  if (change.status === 'orphan') return `stale: ${cause ?? 'it no longer applies on main'}`;
  if (change.status === 'accepted' && cause === ALREADY_ON_MAIN) return ALREADY_ON_MAIN;
  return null;
}
