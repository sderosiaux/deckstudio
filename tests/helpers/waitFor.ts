export async function waitFor<T>(
  fn: () => Promise<T | undefined | false | null> | T | undefined | false | null,
  opts: { timeout?: number; interval?: number } = {},
): Promise<T> {
  const timeout = opts.timeout ?? 10_000;
  const interval = opts.interval ?? 50;
  const start = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v as T;
    if (Date.now() - start > timeout) throw new Error('waitFor: timeout');
    await new Promise((r) => setTimeout(r, interval));
  }
}
