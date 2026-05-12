import { env } from '../config/env.js';
import { logger } from '../utils/logger.js';
import { AppError } from '../utils/errors.js';

const STATUS_BY_NAME = {
  AuthError: 401,
  RateLimitError: 429,
  ValidationError: 400,
  UpstreamError: 502,
};

export function errorHandler(err, req, res, next) {
  if (res.headersSent) return next(err);

  const status =
    (err instanceof AppError && err.status) ||
    STATUS_BY_NAME[err?.name] ||
    err?.status ||
    err?.statusCode ||
    500;

  const log = req.log ?? logger;
  log.error(
    {
      err,
      status,
      method: req.method,
      path: req.originalUrl,
    },
    err.message || 'Request failed',
  );

  const safeMessage =
    status >= 500 && env.NODE_ENV === 'production'
      ? 'Internal server error'
      : err.message || 'Internal server error';

  const body = { error: { message: safeMessage } };
  if (err.code) body.error.code = err.code;
  if (err.details) body.error.details = err.details;
  if (env.NODE_ENV !== 'production' && err.stack) {
    body.error.stack = err.stack;
  }

  res.status(status).json(body);
}
