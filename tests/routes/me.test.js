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

let app;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.ALLOWED_ORIGINS = 'https://app.example.com';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_MAX = '50';

  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(() => {
  mockSupabase.auth.getClaims.mockReset();
  mockSupabase.auth.getUser.mockReset();
});

function mockValidClaims(claims) {
  mockSupabase.auth.getClaims.mockResolvedValueOnce({
    data: { claims },
    error: null,
  });
}

describe('GET /api/me', () => {
  it('returns 401 when no Authorization header is sent', async () => {
    const res = await request(app).get('/api/me');
    expect(res.status).toBe(401);
    expect(mockSupabase.auth.getClaims).not.toHaveBeenCalled();
  });

  it('returns 200 with { id, email, role } from JWT claims', async () => {
    const userId = `user-${Date.now()}`;
    mockValidClaims({
      sub: userId,
      email: 'user@example.com',
      role: 'authenticated',
    });

    const res = await request(app)
      .get('/api/me')
      .set('authorization', 'Bearer valid.jwt.token');

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      id: userId,
      email: 'user@example.com',
      role: 'authenticated',
    });
  });

  it('emits draft-7 RateLimit headers on a successful response', async () => {
    mockValidClaims({
      sub: `user-${Date.now()}-headers`,
      email: 'u@example.com',
      role: 'authenticated',
    });

    const res = await request(app)
      .get('/api/me')
      .set('authorization', 'Bearer valid.jwt.token');

    expect(res.status).toBe(200);
    expect(res.headers['ratelimit']).toBeDefined();
    expect(res.headers['ratelimit-policy']).toBeDefined();
    expect(res.headers['x-ratelimit-limit']).toBeUndefined();
  });
});
