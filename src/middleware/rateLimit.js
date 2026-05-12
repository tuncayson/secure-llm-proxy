import rateLimit, { MemoryStore } from 'express-rate-limit';
import { env } from '../config/env.js';

export const rateLimitStore = new MemoryStore();

/**
 * Per-user rate limiter for authenticated routes.
 *
 * Storage: the default in-memory MemoryStore. Counters live in this
 * process only, so when the proxy runs on more than one Railway
 * replica each replica tracks its own buckets and the effective
 * cap becomes N * RATE_LIMIT_MAX. That is acceptable for v1
 * (single replica) and documented as a known scaling limit.
 *
 * Swapping to Redis when we add replicas:
 *
 *   npm install rate-limit-redis ioredis
 *
 *   import { RedisStore } from 'rate-limit-redis';
 *   import Redis from 'ioredis';
 *   const client = new Redis(env.REDIS_URL);
 *
 *   // then add to the options below:
 *   //   store: new RedisStore({
 *   //     sendCommand: (...args) => client.call(...args),
 *   //   }),
 *
 * Docs: https://github.com/express-rate-limit/rate-limit-redis
 */
export const rateLimiter = rateLimit({
  windowMs: env.RATE_LIMIT_WINDOW_MS,
  limit: env.RATE_LIMIT_MAX,
  store: rateLimitStore,
  standardHeaders: 'draft-7',
  legacyHeaders: false,
  keyGenerator: (req) => {
    if (!req.user?.id) {
      throw new Error(
        'rateLimiter requires req.user — mount it AFTER the authenticate middleware',
      );
    }
    return req.user.id;
  },
  handler: (req, res) => {
    const resetTime = req.rateLimit?.resetTime;
    const resetMs = resetTime instanceof Date ? resetTime.getTime() : undefined;
    const retryAfterMs =
      typeof resetMs === 'number'
        ? Math.max(0, resetMs - Date.now())
        : env.RATE_LIMIT_WINDOW_MS;
    res.status(429).json({ error: 'rate_limited', retryAfterMs });
  },
});
