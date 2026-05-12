import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const REQUIRED_VARS = [
  'ANTHROPIC_API_KEY',
  'SUPABASE_URL',
  'SUPABASE_SERVICE_ROLE_KEY',
  'ALLOWED_ORIGINS',
];

const VALID_ENV = {
  ANTHROPIC_API_KEY: 'sk-ant-test',
  SUPABASE_URL: 'https://example.supabase.co',
  SUPABASE_SERVICE_ROLE_KEY: 'service-role-key',
  ALLOWED_ORIGINS: 'https://app.example.com,https://staging.example.com',
};

describe('config/env', () => {
  const ORIGINAL_ENV = process.env;

  beforeEach(() => {
    vi.resetModules();
    process.env = { ...ORIGINAL_ENV };
    for (const key of REQUIRED_VARS) delete process.env[key];
    delete process.env.PORT;
    delete process.env.RATE_LIMIT_WINDOW_MS;
    delete process.env.RATE_LIMIT_MAX;
    delete process.env.NODE_ENV;
    delete process.env.LOG_LEVEL;
  });

  afterEach(() => {
    process.env = ORIGINAL_ENV;
    vi.restoreAllMocks();
  });

  it('calls process.exit(1) when required vars are missing', async () => {
    const exitSpy = vi
      .spyOn(process, 'exit')
      .mockImplementation(() => undefined);
    const errSpy = vi.spyOn(console, 'error').mockImplementation(() => {});

    await expect(import('../../src/config/env.js')).rejects.toThrow();

    expect(exitSpy).toHaveBeenCalledWith(1);
    expect(errSpy).toHaveBeenCalled();
    const messages = errSpy.mock.calls.map((args) => args.join(' ')).join('\n');
    for (const key of REQUIRED_VARS) {
      expect(messages).toContain(key);
    }
  });

  it('loads, coerces, and freezes env when all required vars are present', async () => {
    Object.assign(process.env, VALID_ENV);

    const { env } = await import('../../src/config/env.js');

    expect(env.PORT).toBe(3000);
    expect(typeof env.PORT).toBe('number');
    expect(env.RATE_LIMIT_WINDOW_MS).toBe(60_000);
    expect(env.RATE_LIMIT_MAX).toBe(30);
    expect(env.NODE_ENV).toBe('development');
    expect(env.LOG_LEVEL).toBe('info');
    expect(env.ALLOWED_ORIGINS).toEqual([
      'https://app.example.com',
      'https://staging.example.com',
    ]);
    expect(Object.isFrozen(env)).toBe(true);
  });
});
