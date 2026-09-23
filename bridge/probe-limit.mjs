export const PUBLIC_PROBE_LIMIT = 30;
export const PUBLIC_PROBE_WINDOW_MS = 10_000;
export const AUTH_FAIL_LIMIT = 20;
export const AUTH_FAIL_WINDOW_MS = 60_000;
export const MAX_JSON_BODY_BYTES = 24 * 1024 * 1024;

export function createProbeLimiter({ limit, windowMs, now = Date.now }) {
  const hits = [];
  return {
    allow() {
      const ts = now();
      while (hits.length > 0 && ts - hits[0] >= windowMs) hits.shift();
      if (hits.length >= limit) return false;
      hits.push(ts);
      return true;
    }
  };
}
