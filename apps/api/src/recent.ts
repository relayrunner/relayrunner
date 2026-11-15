// Values read from GitHub (or D1), reused while younger than the age a caller accepts. Each is kept as a
// promise so callers that arrive together share one read, and a failed read is forgotten so the
// next caller asks again. With `maxSize`, the oldest entry goes once there are more.
export class Recent<K, V> {
  private entries = new Map<K, { at: number; value: Promise<V> }>();

  constructor(private maxSize = Infinity) {}

  /** `keep` says whether a successful read may be reused; one it turns down is forgotten too. */
  get(key: K, maxAge: number, read: () => Promise<V>, keep?: (value: V) => boolean): Promise<V> {
    const now = Date.now();
    const cached = this.entries.get(key);
    if (cached && now - cached.at < maxAge) return cached.value;
    const value = read();
    this.entries.delete(key); // Re-added last, so the oldest is first to go.
    this.entries.set(key, { at: now, value });
    if (this.entries.size > this.maxSize) this.entries.delete(this.entries.keys().next().value!);
    const forget = () => {
      if (this.entries.get(key)?.value === value) this.entries.delete(key);
    };
    value.then((result) => keep && !keep(result) && forget(), forget);
    return value;
  }

  forget(key: K) {
    this.entries.delete(key);
  }

  clear() {
    this.entries.clear();
  }
}
