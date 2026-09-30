import type { CSSProperties } from 'react';
import type { Change } from '../../../src/model/types.js';

export interface ChangeButtonsProps {
  change: Change;
  disabled: boolean;
  onAccept(changeId: string): void;
  onRefuse(changeId: string): void;
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
export function ChangeButtons({ change, disabled, onAccept, onRefuse }: ChangeButtonsProps) {
  const hint = `${verb[change.kind]}: ${change.reason}`;
  return (
    <div style={{ display: 'flex', gap: 6 }} data-testid="change-buttons" data-change={change.id}>
      <button type="button" aria-label={`accept change ${change.id}`} title={`Accept (${hint})`} disabled={disabled} onClick={() => onAccept(change.id)} style={btn('ok', disabled)}>
        ✓
      </button>
      <button type="button" aria-label={`refuse change ${change.id}`} title={`Refuse (${hint})`} disabled={disabled} onClick={() => onRefuse(change.id)} style={btn('warn', disabled)}>
        ✗
      </button>
    </div>
  );
}
