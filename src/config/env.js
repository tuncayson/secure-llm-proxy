import { z } from 'zod';

const schema = z.object({
  PORT: z.coerce.number().int().positive().default(3000),
  NODE_ENV: z
    .enum(['development', 'production', 'test'])
    .default('development'),
  LOG_LEVEL: z
    .enum(['trace', 'debug', 'info', 'warn', 'error', 'fatal'])
    .default('info'),

  ANTHROPIC_API_KEY: z.string().min(1),

  SUPABASE_URL: z.string().url(),
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1),
  SUPABASE_JWT_SECRET: z.string().min(1).optional(),

  ALLOWED_ORIGINS: z
    .string()
    .min(1)
    .transform((value) =>
      value
        .split(',')
        .map((origin) => origin.trim())
        .filter(Boolean),
    )
    .refine((origins) => origins.length > 0, {
      message: 'ALLOWED_ORIGINS must list at least one origin',
    }),

  RATE_LIMIT_WINDOW_MS: z.coerce.number().int().positive().default(60_000),
  RATE_LIMIT_MAX: z.coerce.number().int().positive().default(30),
});

function loadEnv() {
  const result = schema.safeParse(process.env);
  if (result.success) return result.data;

  /* eslint-disable no-console -- the pino logger depends on env, so the bootstrap-failure path has to use console.error */
  console.error('Invalid environment configuration:');
  for (const issue of result.error.issues) {
    const path = issue.path.join('.') || '(root)';
    console.error(`  - ${path}: ${issue.message}`);
  }
  /* eslint-enable no-console */
  process.exit(1);
  // Defensive: if process.exit is stubbed (tests), avoid exporting undefined.
  throw new Error('Invalid environment configuration');
}

export const env = Object.freeze(loadEnv());
