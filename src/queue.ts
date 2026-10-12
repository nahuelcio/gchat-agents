/**
 * Serializes background turns per key: for one threadKey, fn N+1 starts only
 * after fn N settles. Different keys run concurrently.
 */
export class TurnQueue {
  private tails: Map<string, Promise<void>> = new Map();

  // ponytail: tails map grows by one entry per distinct thread; delete it if
  // threads ever reach the tens of thousands.
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    const result = prev.then(fn, fn);
    this.tails.set(
      key,
      result.then(
        () => undefined,
        () => undefined,
      ),
    );
    return result;
  }
}
