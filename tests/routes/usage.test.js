import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';

const { mockSupabase } = vi.hoisted(() => ({
  mockSupabase: {
    auth: {
      getClaims: vi.fn(),
      getUser: vi.fn(),
    },
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabase),
}));

const LIMIT = 50;
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

  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(() => {
  mockSupabase.auth.getClaims.mockReset();
});

function mockAuthFor(userId) {
  mockSupabase.auth.getClaims.mockResolvedValue({
    data: {
      claims: { sub: userId, email: 'u@example.com', role: 'authenticated' },
    },
    error: null,
  });
}

describe('GET /api/usage', () => {
  it('returns 401 without an Authorization header', async () => {
    const res = await request(app).get('/api/usage');
    expect(res.status).toBe(401);
    expect(mockSupabase.auth.getClaims).not.toHaveBeenCalled();
  });

  it('returns 200 with { limit, remaining, resetAt } for a valid token', async () => {
    const userId = `usage-${Date.now()}-shape`;
    mockAuthFor(userId);

    const res = await request(app)
      .get('/api/usage')
      .set('authorization', 'Bearer valid');

    expect(res.status).toBe(200);
    expect(res.body.limit).toBe(LIMIT);
    expect(typeof res.body.remaining).toBe('number');
    expect(res.body.remaining).toBeGreaterThanOrEqual(0);
    expect(res.body.remaining).toBeLessThanOrEqual(LIMIT - 1);
    expect(typeof res.body.resetAt).toBe('string');
    expect(Number.isNaN(Date.parse(res.body.resetAt))).toBe(false);
    expect(new Date(res.body.resetAt).getTime()).toBeGreaterThan(Date.now());
  });

  it('remaining decreases as the user makes more requests', async () => {
    const userId = `usage-${Date.now()}-trend`;
    mockAuthFor(userId);

    const r1 = await request(app)
      .get('/api/usage')
      .set('authorization', 'Bearer valid');
    expect(r1.status).toBe(200);
    const remainingBefore = r1.body.remaining;

    for (let i = 0; i < 3; i++) {
      const r = await request(app)
        .get('/api/me')
        .set('authorization', 'Bearer valid');
      expect(r.status).toBe(200);
    }

    const r2 = await request(app)
      .get('/api/usage')
      .set('authorization', 'Bearer valid');
    expect(r2.status).toBe(200);

    expect(r2.body.remaining).toBeLessThan(remainingBefore);
    expect(remainingBefore - r2.body.remaining).toBe(4);
  });
});
