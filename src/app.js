import express from 'express';
import helmet from 'helmet';
import cors from 'cors';
import pinoHttp from 'pino-http';

import { env } from './config/env.js';
import { logger } from './utils/logger.js';
import healthRouter from './routes/health.js';
import meRouter from './routes/me.js';
import usageRouter from './routes/usage.js';
import anthropicRouter from './routes/anthropic.js';
import supabaseRouter from './routes/supabase.js';
import { authenticate } from './middleware/auth.js';
import { rateLimiter } from './middleware/rateLimit.js';
import { errorHandler } from './middleware/errorHandler.js';

export function createApp() {
  const app = express();

  app.disable('x-powered-by');
  app.set('trust proxy', 1);

  app.use(helmet());

  app.use(
    cors({
      origin: (origin, cb) => {
        if (!origin) return cb(null, true);
        if (env.ALLOWED_ORIGINS.includes(origin)) return cb(null, true);
        return cb(null, false);
      },
      credentials: true,
    }),
  );

  app.use(express.json({ limit: '1mb' }));

  app.use(
    pinoHttp({
      logger,
      customLogLevel: (req, res, err) => {
        if (err || res.statusCode >= 500) return 'error';
        if (res.statusCode >= 400) return 'warn';
        return 'info';
      },
    }),
  );

  app.use(healthRouter);

  app.use('/api', authenticate, rateLimiter);
  app.use('/api', meRouter);
  app.use('/api', usageRouter);
  app.use('/api/anthropic', anthropicRouter);
  app.use('/api/supabase', supabaseRouter);

  app.use(errorHandler);

  return app;
}
