// In-process fixed-window rate limiter keyed by client address. A single
// instance only; a multi-replica deployment should also limit at the proxy.
export const clientAddress = (req) => req.ip ?? req.socket?.remoteAddress ?? 'unknown';

export function createRateLimiter({ limit, windowMs, now = () => Date.now() }) {
  const buckets = new Map();
  let lastSweep = now();
  return function rateLimit(req, res, next) {
    const t = now();
    if (t - lastSweep > windowMs) {
      for (const [k, b] of buckets) if (t - b.start >= windowMs) buckets.delete(k);
      lastSweep = t;
    }
    const key = clientAddress(req);
    let bucket = buckets.get(key);
    if (!bucket || t - bucket.start >= windowMs) {
      bucket = { start: t, count: 0 };
      buckets.set(key, bucket);
    }
    bucket.count += 1;
    if (bucket.count > limit) {
      res.set('retry-after', String(Math.ceil((bucket.start + windowMs - t) / 1000)));
      return res.status(429).json({ error: 'rate_limited', message: 'too many requests' });
    }
    return next();
  };
}
