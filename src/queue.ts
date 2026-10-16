/**
 * Serializes background turns per key: for one threadKey, fn N+1 starts only
 * after fn N settles. Different keys run concurrently.
 */
export class TurnQueue {
  private tails: Map<string, Promise<void>> = new Map();

  private pending = new Map<string, number>();

  /** True while a turn for `key` is queued or running (lets viewers show "working…"). */
  busy(key: string): boolean {
    return (this.pending.get(key) ?? 0) > 0;
  }

  // ponytail: tails map grows by one entry per distinct thread; delete it if
  // threads ever reach the tens of thousands.
  run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const prev = this.tails.get(key) ?? Promise.resolve();
    this.pending.set(key, (this.pending.get(key) ?? 0) + 1);
    const done = () => {
      const left = (this.pending.get(key) ?? 1) - 1;
      if (left > 0) this.pending.set(key, left);
      else this.pending.delete(key);
    };
    const result = prev.then(fn, fn).finally(done);
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
