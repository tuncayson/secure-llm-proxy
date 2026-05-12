import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';

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

let authenticate;
let logger;
let AuthError;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.ALLOWED_ORIGINS = 'https://app.example.com';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  delete process.env.SUPABASE_JWT_SECRET;

  ({ authenticate } = await import('../../src/middleware/auth.js'));
  ({ logger } = await import('../../src/utils/logger.js'));
  ({ AuthError } = await import('../../src/utils/errors.js'));
});

beforeEach(() => {
  mockSupabase.auth.getClaims.mockReset();
  mockSupabase.auth.getUser.mockReset();
});

async function runAuth(headers = {}) {
  const req = { headers };
  const res = {};
  let nextErr;
  let nextCalled = false;
  await authenticate(req, res, (err) => {
    nextCalled = true;
    nextErr = err;
  });
  return { req, nextCalled, nextErr };
}

describe('auth middleware — header parsing', () => {
  it('rejects requests with no Authorization header', async () => {
    const { nextErr } = await runAuth({});
    expect(nextErr).toBeInstanceOf(AuthError);
    expect(nextErr.status).toBe(401);
    expect(mockSupabase.auth.getClaims).not.toHaveBeenCalled();
  });

  it('rejects malformed Authorization headers (no Bearer prefix)', async () => {
    const { nextErr } = await runAuth({
      authorization: 'token-without-bearer',
    });
    expect(nextErr).toBeInstanceOf(AuthError);
    expect(nextErr.status).toBe(401);
    expect(mockSupabase.auth.getClaims).not.toHaveBeenCalled();
  });

  it('rejects a Bearer header with no token value', async () => {
    const { nextErr } = await runAuth({ authorization: 'Bearer ' });
    expect(nextErr).toBeInstanceOf(AuthError);
    expect(nextErr.status).toBe(401);
    expect(mockSupabase.auth.getClaims).not.toHaveBeenCalled();
  });
});

describe('auth middleware — verification', () => {
  it('rejects expired/invalid tokens (getClaims returns error)', async () => {
    mockSupabase.auth.getClaims.mockResolvedValue({
      data: null,
      error: { message: 'JWT expired' },
    });

    const { nextErr, req } = await runAuth({
      authorization: 'Bearer expired.jwt.here',
    });

    expect(nextErr).toBeInstanceOf(AuthError);
    expect(nextErr.status).toBe(401);
    expect(req.user).toBeUndefined();
  });

  it('rejects when claims payload is missing', async () => {
    mockSupabase.auth.getClaims.mockResolvedValue({
      data: {},
      error: null,
    });

    const { nextErr } = await runAuth({
      authorization: 'Bearer some.jwt.token',
    });
    expect(nextErr).toBeInstanceOf(AuthError);
  });

  it('populates req.user on a valid token', async () => {
    mockSupabase.auth.getClaims.mockResolvedValue({
      data: {
        claims: {
          sub: 'user-abc',
          email: 'user@example.com',
          role: 'authenticated',
        },
      },
      error: null,
    });

    const { req, nextCalled, nextErr } = await runAuth({
      authorization: 'Bearer valid.jwt.token',
    });

    expect(nextErr).toBeUndefined();
    expect(nextCalled).toBe(true);
    expect(req.user).toEqual({
      id: 'user-abc',
      email: 'user@example.com',
      role: 'authenticated',
    });
  });
});

describe('auth middleware — logging hygiene', () => {
  it('never writes the bearer token to the logger', async () => {
    const TOKEN = 'super-secret-bearer-token-abc123';

    const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const spies = methods.map((m) =>
      vi.spyOn(logger, m).mockImplementation(() => {}),
    );

    mockSupabase.auth.getClaims.mockResolvedValueOnce({
      data: null,
      error: { message: 'bad signature' },
    });
    await runAuth({ authorization: `Bearer ${TOKEN}` });

    mockSupabase.auth.getClaims.mockResolvedValueOnce({
      data: {
        claims: { sub: 's', email: 'e@x.com', role: 'authenticated' },
      },
      error: null,
    });
    await runAuth({ authorization: `Bearer ${TOKEN}` });

    for (const spy of spies) {
      for (const call of spy.mock.calls) {
        expect(JSON.stringify(call)).not.toContain(TOKEN);
      }
    }

    for (const spy of spies) spy.mockRestore();
  });
});
