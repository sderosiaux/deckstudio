/** FIFO async mutex. A rejected critical section releases the lock like a resolved one. */
export class Mutex {
  private tail: Promise<void> = Promise.resolve();

  run<T>(fn: () => Promise<T>): Promise<T> {
    const result = this.tail.then(fn);
    this.tail = result.then(
      () => undefined,
      () => undefined,
    );
    return result;
  }
}

const registry = new Map<string, Mutex>();

/** One mutex per key for the whole process, so two stores opened on the same folder serialize together. */
export function mutexFor(key: string): Mutex {
  let m = registry.get(key);
  if (!m) {
    m = new Mutex();
    registry.set(key, m);
  }
  return m;
}
