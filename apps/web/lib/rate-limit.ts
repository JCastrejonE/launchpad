/**
 * In-memory sliding-window rate limiter. Originally spec 0074 (audit #3's
 * `/api/chat` fix line); `/api/chat` was deleted in spec 0082 and took this
 * module's only consumer with it, leaving the control plane with NO limiter —
 * spec 0092 restores it for `POST /api/supervisor`, the surface that starts
 * Agent SDK sessions and never had one. Deliberately minimal: one process, one Map — correct for the
 * single-owner control plane (no multi-instance deployment to coordinate;
 * revisit only if the control plane ever scales out). `now` is injectable so
 * tests never sleep.
 */
export class SlidingWindowLimiter {
  private readonly hits = new Map<string, number[]>();

  constructor(
    /** Max allowed events per key inside the window. */
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly now: () => number = Date.now,
  ) {}

  /** Record an attempt for `key`; true = allowed, false = rate-limited (the
   * refused attempt is NOT recorded, so a client can't extend its own ban). */
  allow(key: string): boolean {
    const t = this.now();
    const cutoff = t - this.windowMs;
    const recent = (this.hits.get(key) ?? []).filter((x) => x > cutoff);
    if (recent.length >= this.limit) {
      this.hits.set(key, recent);
      return false;
    }
    recent.push(t);
    this.hits.set(key, recent);
    return true;
  }
}
