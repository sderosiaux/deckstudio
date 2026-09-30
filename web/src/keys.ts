/** True when a key press lands in a field that takes text: screen shortcuts leave those keys alone. */
export function typingIn(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  if (target.isContentEditable) return true;
  const tag = target.tagName;
  return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

/** A shortcut only fires on a bare key: with a modifier held the key belongs to the browser or the system. */
export function modified(e: KeyboardEvent): boolean {
  return e.metaKey || e.ctrlKey || e.altKey;
}
