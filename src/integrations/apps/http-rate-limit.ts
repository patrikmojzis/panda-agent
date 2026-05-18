import type {IncomingMessage} from "node:http";

const RATE_LIMIT_WINDOW_MS = 60_000;
const RATE_LIMIT_MAX_KEYS = 10_000;

export function readAgentAppRateLimitKey(request: IncomingMessage): string {
  // Do not trust X-Forwarded-For here. If 8092 is accidentally exposed, client
  // supplied forwarding headers must not become a rate-limit bypass.
  return request.socket.remoteAddress || "unknown";
}

export function createAgentAppRateLimiter(maxPerMinute: number): (key: string) => boolean {
  if (maxPerMinute === 0) {
    return () => true;
  }

  const hits = new Map<string, {count: number; resetAt: number}>();
  let requestsSincePrune = 0;
  const pruneExpired = (now: number): void => {
    for (const [key, bucket] of hits) {
      if (bucket.resetAt <= now) {
        hits.delete(key);
      }
    }
  };

  return (key: string): boolean => {
    const now = Date.now();
    requestsSincePrune += 1;
    if (requestsSincePrune >= 1000 || hits.size > RATE_LIMIT_MAX_KEYS) {
      requestsSincePrune = 0;
      pruneExpired(now);
    }

    const current = hits.get(key);
    if (!current || current.resetAt <= now) {
      if (!current && hits.size >= RATE_LIMIT_MAX_KEYS) {
        return false;
      }
      hits.set(key, {count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS});
      return true;
    }

    current.count += 1;
    return current.count <= maxPerMinute;
  };
}
