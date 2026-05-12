import { Router } from 'express';
import { env } from '../config/env.js';
import { rateLimitStore } from '../middleware/rateLimit.js';

const router = Router();

function resetAtFromDate(date) {
  if (date instanceof Date) return date.toISOString();
  return new Date(Date.now() + env.RATE_LIMIT_WINDOW_MS).toISOString();
}

router.get('/usage', async (req, res) => {
  if (req.rateLimit) {
    return res.json({
      limit: req.rateLimit.limit,
      remaining: req.rateLimit.remaining,
      resetAt: resetAtFromDate(req.rateLimit.resetTime),
    });
  }

  const info = await rateLimitStore.get(req.user.id);
  const limit = env.RATE_LIMIT_MAX;
  const used = info?.totalHits ?? 0;

  res.json({
    limit,
    remaining: Math.max(0, limit - used),
    resetAt: resetAtFromDate(info?.resetTime),
  });
});

export default router;
