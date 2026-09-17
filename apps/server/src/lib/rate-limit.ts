/**
 * In-memory token buckets. Enough for a single-process server; state resets
 * on restart, which is acceptable for abuse protection.
 */
export class RateLimiter {
  private readonly buckets = new Map<string, { tokens: number; at: number }>();

  constructor(
    /** Tokens refilled per `windowMs`, and the bucket capacity. */
    private readonly capacity: number,
    private readonly windowMs: number,
    private readonly maxKeys = 50_000,
  ) {}

  /** Takes up to `count` tokens; returns how many were granted. */
  take(key: string, count = 1, now = Date.now()): number {
    let bucket = this.buckets.get(key);
    if (!bucket) {
      if (this.buckets.size >= this.maxKeys) this.prune(now);
      bucket = { tokens: this.capacity, at: now };
      this.buckets.set(key, bucket);
    }
    bucket.tokens = Math.min(this.capacity, bucket.tokens + ((now - bucket.at) / this.windowMs) * this.capacity);
    bucket.at = now;
    const granted = Math.max(0, Math.min(count, Math.floor(bucket.tokens)));
    bucket.tokens -= granted;
    return granted;
  }

  /** True when the key still has at least one token (without taking it). */
  peek(key: string, now = Date.now()): boolean {
    const bucket = this.buckets.get(key);
    if (!bucket) return true;
    return bucket.tokens + ((now - bucket.at) / this.windowMs) * this.capacity >= 1;
  }

  reset(key: string): void {
    this.buckets.delete(key);
  }

  private prune(now: number): void {
    for (const [key, bucket] of this.buckets) {
      if (now - bucket.at > this.windowMs) this.buckets.delete(key);
    }
    if (this.buckets.size >= this.maxKeys) this.buckets.clear();
  }
}
