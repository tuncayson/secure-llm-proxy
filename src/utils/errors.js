export class AppError extends Error {
  constructor(message, { status = 500, code, details, cause } = {}) {
    super(message);
    this.name = this.constructor.name;
    this.status = status;
    if (code) this.code = code;
    if (details) this.details = details;
    if (cause) this.cause = cause;
  }
}

export class AuthError extends AppError {
  constructor(message = 'Unauthorized', options = {}) {
    super(message, {
      ...options,
      status: 401,
      code: options.code ?? 'unauthorized',
    });
  }
}

export class ForbiddenError extends AppError {
  constructor(message = 'Forbidden', options = {}) {
    super(message, {
      ...options,
      status: 403,
      code: options.code ?? 'forbidden',
    });
  }
}

export class RateLimitError extends AppError {
  constructor(message = 'Too many requests', options = {}) {
    super(message, {
      ...options,
      status: 429,
      code: options.code ?? 'rate_limited',
    });
  }
}

export class ValidationError extends AppError {
  constructor(message = 'Invalid request', options = {}) {
    super(message, {
      ...options,
      status: 400,
      code: options.code ?? 'invalid_request',
    });
  }
}

export class UpstreamError extends AppError {
  constructor(message = 'Upstream service error', options = {}) {
    super(message, {
      ...options,
      status: 502,
      code: options.code ?? 'upstream_error',
    });
  }
}
