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
    from: vi.fn(),
    rpc: vi.fn(),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabase),
}));

const SERVICE_ROLE_KEY = 'super-secret-service-role-key-xyz';

let app;
let logger;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = SERVICE_ROLE_KEY;
  process.env.ALLOWED_ORIGINS = 'https://app.example.com';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_MAX = '100';

  ({ logger } = await import('../../src/utils/logger.js'));
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(() => {
  mockSupabase.auth.getClaims.mockReset();
  mockSupabase.from.mockReset();
  mockSupabase.rpc.mockReset();
});

function safeStringify(value) {
  const seen = new WeakSet();
  return JSON.stringify(value, (_k, v) => {
    if (typeof v === 'object' && v !== null) {
      if (seen.has(v)) return '[Circular]';
      seen.add(v);
    }
    return v;
  });
}

function mockAuth(userId) {
  mockSupabase.auth.getClaims.mockResolvedValueOnce({
    data: {
      claims: { sub: userId, email: 'u@example.com', role: 'authenticated' },
    },
    error: null,
  });
}

function mockMetadataQuery(result) {
  const builder = {
    select: vi.fn().mockReturnThis(),
    eq: vi.fn().mockReturnThis(),
    maybeSingle: vi.fn().mockResolvedValue(result),
  };
  mockSupabase.from.mockReturnValue(builder);
  return builder;
}

describe('POST /api/supabase/query', () => {
  it('returns 400 for an unknown operation', async () => {
    mockAuth(`user-${Date.now()}-unknown-op`);
    const res = await request(app)
      .post('/api/supabase/query')
      .set('authorization', 'Bearer valid')
      .send({ operation: 'delete_everything', params: {} });

    expect(res.status).toBe(400);
    expect(mockSupabase.from).not.toHaveBeenCalled();
    expect(mockSupabase.rpc).not.toHaveBeenCalled();
  });

  it('returns 403 when asking for another user\'s metadata', async () => {
    const userId = `user-${Date.now()}-self`;
    mockAuth(userId);

    const res = await request(app)
      .post('/api/supabase/query')
      .set('authorization', 'Bearer valid')
      .send({
        operation: 'get_user_metadata',
        params: { user_id: 'someone-else' },
      });

    expect(res.status).toBe(403);
    expect(mockSupabase.from).not.toHaveBeenCalled();
  });

  it('returns the caller\'s metadata on the happy path', async () => {
    const userId = `user-${Date.now()}-happy`;
    mockAuth(userId);
    const builder = mockMetadataQuery({
      data: { user_id: userId, plan: 'pro', credits: 100 },
      error: null,
    });

    const res = await request(app)
      .post('/api/supabase/query')
      .set('authorization', 'Bearer valid')
      .send({ operation: 'get_user_metadata', params: {} });

    expect(res.status).toBe(200);
    expect(res.body).toEqual({
      ok: true,
      data: { user_id: userId, plan: 'pro', credits: 100 },
    });
    expect(mockSupabase.from).toHaveBeenCalledWith('user_metadata');
    expect(builder.eq).toHaveBeenCalledWith('user_id', userId);
  });

  it('ignores a matching user_id in params (still allowed)', async () => {
    const userId = `user-${Date.now()}-matching`;
    mockAuth(userId);
    mockMetadataQuery({
      data: { user_id: userId, plan: 'free' },
      error: null,
    });

    const res = await request(app)
      .post('/api/supabase/query')
      .set('authorization', 'Bearer valid')
      .send({
        operation: 'get_user_metadata',
        params: { user_id: userId },
      });

    expect(res.status).toBe(200);
  });

  it('never echoes the service role key in the response body or headers', async () => {
    const userId = `user-${Date.now()}-leak-resp`;
    mockAuth(userId);
    mockMetadataQuery({
      data: { user_id: userId },
      error: null,
    });

    const res = await request(app)
      .post('/api/supabase/query')
      .set('authorization', 'Bearer valid')
      .send({ operation: 'get_user_metadata', params: {} });

    expect(res.status).toBe(200);
    expect(JSON.stringify(res.body)).not.toContain(SERVICE_ROLE_KEY);
    expect(JSON.stringify(res.headers)).not.toContain(SERVICE_ROLE_KEY);
  });

  it('never writes the service role key to the logger', async () => {
    const userId = `user-${Date.now()}-leak-log`;
    mockAuth(userId);
    mockMetadataQuery({
      data: { user_id: userId },
      error: null,
    });

    const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const spies = methods.map((m) =>
      vi.spyOn(logger, m).mockImplementation(() => {}),
    );

    const res = await request(app)
      .post('/api/supabase/query')
      .set('authorization', 'Bearer valid')
      .send({ operation: 'get_user_metadata', params: {} });

    expect(res.status).toBe(200);
    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(safeStringify(call)).not.toContain(SERVICE_ROLE_KEY);
      }
    }
    for (const spy of spies) spy.mockRestore();
  });
});
