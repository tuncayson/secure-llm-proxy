import { beforeAll, describe, expect, it } from 'vitest';
import express from 'express';
import request from 'supertest';

const LIMIT = 3;

let app;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.ALLOWED_ORIGINS = 'https://app.example.com';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_MAX = String(LIMIT);

  const { rateLimiter } = await import('../../src/middleware/rateLimit.js');

  app = express();
  app.use((req, _res, next) => {
    const id = req.headers['x-test-user'];
    if (id) req.user = { id };
    next();
  });
  app.use(rateLimiter);
  app.get('/probe', (req, res) => res.json({ ok: true, user: req.user.id }));
});

async function hit(userId) {
  return request(app).get('/probe').set('x-test-user', userId);
}

describe('rateLimiter', () => {
  it('returns 429 on the (limit+1)th request from the same user', async () => {
    const userId = `alice-${Date.now()}`;

    for (let i = 0; i < LIMIT; i++) {
      const res = await hit(userId);
      expect(res.status).toBe(200);
    }

    const blocked = await hit(userId);
    expect(blocked.status).toBe(429);
    expect(blocked.body).toMatchObject({ error: 'rate_limited' });
    expect(typeof blocked.body.retryAfterMs).toBe('number');
    expect(blocked.body.retryAfterMs).toBeGreaterThan(0);
  });

  it('does not share buckets between users', async () => {
    const bob = `bob-${Date.now()}`;
    const carol = `carol-${Date.now()}`;

    for (let i = 0; i < LIMIT; i++) {
      const r1 = await hit(bob);
      const r2 = await hit(carol);
      expect(r1.status).toBe(200);
      expect(r2.status).toBe(200);
    }
  });

  it('emits draft-7 RateLimit headers and no legacy X-RateLimit-* headers', async () => {
    const userId = `dave-${Date.now()}`;
    const res = await hit(userId);

    expect(res.headers['ratelimit']).toBeDefined();
    expect(res.headers['ratelimit-policy']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
    expect(res.headers['x-ratelimit-remaining']).toBeUndefined();
  });
});
