import type { Clock } from "../http/clock.ts";

export interface RefreshCacheOptions<T> {
  readonly clock: Clock;
  readonly intervalMs: number;
  readonly fetch: () => Promise<T>;
  readonly initialValue: T;
  readonly onFailure?: (error: unknown) => void;
}

export interface RefreshCache<T> {
  // Resolves to whether a fetch was actually attempted, so a caller can tell
  // a real attempt from an off-cadence cycle restating the last outcome.
  refreshIfDue(): Promise<boolean>;
  // Makes the next refreshIfDue() fetch regardless of the interval: how a
  // configuration-hash change forces a subnet-map refresh (D§5.6).
  invalidate(): void;
  getCached(): T;
}

// The independent-cadence primitive. "Due" is judged from when the last
// fetch started, so a fetch slower than the interval cannot overlap the
// next one, given that callers await each refreshIfDue() before the next.
// A failed refresh keeps the previous value and does not throw.
export function createRefreshCache<T>(options: RefreshCacheOptions<T>): RefreshCache<T> {
  const { clock, intervalMs, fetch, onFailure } = options;
  let value = options.initialValue;
  let lastStartedAt: number | undefined;

  return {
    async refreshIfDue(): Promise<boolean> {
      const now = clock.elapsed();
      if (lastStartedAt !== undefined && now - lastStartedAt < intervalMs) return false;
      lastStartedAt = now;
      try {
        value = await fetch();
      } catch (error) {
        onFailure?.(error);
      }
      return true;
    },
    invalidate(): void {
      lastStartedAt = undefined;
    },
    getCached(): T {
      return value;
    },
  };
}
