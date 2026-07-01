import pRetry, { AbortError } from 'p-retry';

export async function withRetry<T>(fn: () => Promise<T>, label: string, attempts = 3): Promise<T> {
  return pRetry(fn, {
    retries: attempts - 1,
    minTimeout: 250,
    factor: 2,
    onFailedAttempt: (e) => {
      console.warn(`[retry:${label}] attempt ${e.attemptNumber} failed: ${e.message}`);
    },
  });
}

export function abortRetry(message: string): never {
  throw new AbortError(message);
}

type CacheEntry<T> = { value: T; expiresAt: number };

export function makeCache<T>(ttlMs: number) {
  const store = new Map<string, CacheEntry<T>>();
  return {
    get(key: string): T | undefined {
      const hit = store.get(key);
      if (!hit) return undefined;
      if (hit.expiresAt < Date.now()) {
        store.delete(key);
        return undefined;
      }
      return hit.value;
    },
    set(key: string, value: T): void {
      store.set(key, { value, expiresAt: Date.now() + ttlMs });
    },
    async wrap(key: string, fn: () => Promise<T>): Promise<T> {
      const hit = this.get(key);
      if (hit !== undefined) return hit;
      const v = await fn();
      this.set(key, v);
      return v;
    },
  };
}

/**
 * fetch with a hard timeout. Node's global fetch has NO default timeout, so a
 * stalled socket hangs forever — this bounds every external call. On timeout it
 * throws (a TimeoutError), which withRetry will catch and retry.
 */
export async function fetchWithTimeout(
  url: string,
  init: RequestInit = {},
  timeoutMs = 8000,
): Promise<Response> {
  return fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) });
}

export function nowIso(): string {
  return new Date().toISOString();
}

export function fmtUtcHm(d: Date = new Date()): string {
  const h = String(d.getUTCHours()).padStart(2, '0');
  const m = String(d.getUTCMinutes()).padStart(2, '0');
  return `${h}:${m} UTC`;
}
