import 'dotenv/config';

import { createApp } from './app.js';
import { env } from './config/env.js';
import { logger } from './utils/logger.js';

const app = createApp();

const server = app.listen(env.PORT, () => {
  const addr = server.address();
  const address =
    typeof addr === 'string' ? addr : `http://localhost:${addr.port}`;
  logger.info({ port: env.PORT, address }, 'api-proxy listening');
});

const SHUTDOWN_TIMEOUT_MS = 10_000;

function shutdown(signal) {
  logger.info({ signal }, 'received shutdown signal, closing server');

  const forceExit = setTimeout(() => {
    logger.warn(
      { timeoutMs: SHUTDOWN_TIMEOUT_MS },
      'forced shutdown after timeout',
    );
    process.exit(1);
  }, SHUTDOWN_TIMEOUT_MS);
  forceExit.unref();

  server.close((err) => {
    if (err) {
      logger.error({ err }, 'error during server.close');
      process.exit(1);
    }
    logger.info('server closed cleanly');
    process.exit(0);
  });
}

process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
