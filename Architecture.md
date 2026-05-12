# Architecture

This document describes the architecture, security model, and conventions for the api-proxy service.

## Project Overview

A lightweight Node.js + Express API proxy server that holds the Anthropic API key and Supabase service role key server-side. The existing browser-based SaaS workspace currently embeds the Anthropic API key in client-side code; this proxy fixes that security gap so the product can scale safely.

The proxy:
- Authenticates every request using the Supabase user JWT (Bearer token in `Authorization` header).
- Enforces per-user rate limiting.
- Forwards approved requests to the Anthropic Messages API and (optionally) to Supabase via the service role key.
- Exposes a small, well-defined surface (3–5 endpoints).
- Deploys to **Railway**.

## Tech Stack

- **Runtime**: Node.js 20 LTS or newer
- **Framework**: Express 4.x
- **Language**: JavaScript (ES Modules — `"type": "module"` in package.json)
- **Anthropic SDK**: `@anthropic-ai/sdk` (latest)
- **Supabase**: `@supabase/supabase-js` (for JWT verification via `auth.getClaims()` and optional admin queries with the service role key)
- **Rate limiting**: `express-rate-limit` with an in-memory store for v1 (documented swap path to Redis later)
- **Security**: `helmet`, `cors`, `express-validator` (or `zod`) for input validation
- **Logging**: `pino` + `pino-http`
- **Config**: `dotenv` for local dev; Railway env vars in production
- **Testing**: `vitest` + `supertest`

## Architecture Principles

1. **Never log secrets.** Redact `Authorization` headers, API keys, and request/response bodies that contain sensitive data.
2. **Fail closed.** If auth or rate-limit middleware errors, return 401/429 — do not pass the request through.
3. **Stateless.** The proxy holds no user data. JWT verification is local (asymmetric keys) when possible to avoid a network round-trip per request.
4. **Streaming-first for Anthropic.** The `/v1/messages` proxy must support both streaming (SSE) and non-streaming responses, since the client UX depends on it.
5. **Strict CORS.** Allow only the frontend origin(s) listed in `ALLOWED_ORIGINS`. No wildcard in production.
6. **Layered structure.**
   ```
   src/
     index.js                # entrypoint, starts server
     app.js                  # express app factory (for tests)
     config/
       env.js                # validates and exports env vars
     middleware/
       auth.js               # Supabase JWT verification
       rateLimit.js          # per-user rate limiting
       errorHandler.js       # central error handler
       requestLogger.js      # pino-http
     routes/
       health.js             # GET /health
       anthropic.js          # POST /api/anthropic/messages (proxy)
       supabase.js           # POST /api/supabase/* (whitelisted operations)
     services/
       anthropicClient.js    # singleton Anthropic SDK client
       supabaseAdmin.js      # singleton service-role Supabase client
     utils/
       logger.js
       errors.js             # custom error classes (AuthError, RateLimitError, etc.)
   tests/
     ...
   ```

## API Surface (v1)

All endpoints except `/health` require `Authorization: Bearer <supabase-jwt>`.

| Method | Path | Purpose |
| --- | --- | --- |
| GET | `/health` | Liveness probe. No auth. Returns `{ status: "ok", version }` |
| POST | `/api/anthropic/messages` | Proxy to Anthropic Messages API. Body matches Anthropic's spec. Supports `stream: true`. |
| GET | `/api/me` | Returns the authenticated user's profile (from JWT claims). Useful for the client to confirm auth works. |
| POST | `/api/supabase/query` | (Optional) Whitelisted server-side Supabase operations that need the service role key. Body: `{ operation, params }`. Reject unknown operations. |
| GET | `/api/usage` | (Optional) Returns the caller's current rate-limit usage (remaining requests, reset time). |

Final count: 3 required + 2 optional = up to 5 endpoints.

## Environment Variables

```
# Server
PORT=3000
NODE_ENV=development
LOG_LEVEL=info

# Anthropic
ANTHROPIC_API_KEY=sk-ant-...

# Supabase
SUPABASE_URL=https://<project>.supabase.co
SUPABASE_SERVICE_ROLE_KEY=eyJ...      # NEVER expose to client
SUPABASE_JWT_SECRET=...               # only if using HS256 legacy keys; prefer JWKS

# CORS
ALLOWED_ORIGINS=https://app.example.com,https://staging.example.com

# Rate limiting (per authenticated user)
RATE_LIMIT_WINDOW_MS=60000            # 1 minute
RATE_LIMIT_MAX=30                     # 30 requests per window per user
```

All env vars are validated at startup in `src/config/env.js`. The process exits with a clear error if a required var is missing.

## Security Requirements (non-negotiable)

- **Helmet** on every response.
- **CORS** restricted to `ALLOWED_ORIGINS`. Preflight handled.
- **JSON body size limit**: 1 MB.
- **JWT verification**: use Supabase's `auth.getClaims()` so verification is local against the JWKS endpoint (cached). Fall back to `auth.getUser(token)` only if asymmetric keys are not configured.
- **Rate limit key**: the Supabase user `sub` claim, NOT the IP. Anonymous requests are rejected upstream by auth middleware.
- **No secrets in logs.** Configure pino redaction for `req.headers.authorization`, `req.headers.cookie`, and `*.apiKey`.
- **Error responses** never leak stack traces in production.

## Anthropic Proxy Behavior

`POST /api/anthropic/messages`:
- Validate request body has `model`, `messages`, `max_tokens`.
- Inject the server-side API key — never accept one from the client.
- If `req.body.stream === true`, pipe the SSE stream from the SDK back to the client with `Content-Type: text/event-stream`.
- Otherwise return the JSON response.
- Map Anthropic API errors to appropriate HTTP status codes (rate-limit → 429, auth → 502 [our side configured wrong], etc.).
- Log: `userId`, `model`, `inputTokens`, `outputTokens`, `latencyMs`, `status`. Do NOT log message content.

## Testing Standards

- Unit tests for each middleware and route handler.
- Integration tests using `supertest` against the Express app (do not start a real port).
- Mock the Anthropic SDK and Supabase client in tests — never make real network calls in CI.
- Aim for ≥80% coverage on `src/middleware` and `src/routes`.

## Deployment (Railway)

- Repo deploys via Railway's GitHub integration.
- Railway auto-detects Node.js via `package.json`. Provide `start` script: `node src/index.js`.
- Use Railway's "Sealed Variables" for `ANTHROPIC_API_KEY` and `SUPABASE_SERVICE_ROLE_KEY`.
- Health check path: `/health`.
- Use `process.env.PORT` (Railway injects this — do NOT hardcode 3000 in production).
- A `railway.json` may be added to pin build/start commands explicitly.

## Coding Conventions

- ES Modules everywhere (`import` / `export`).
- Use `async/await`, never raw `.then()` chains.
- Throw typed errors from `utils/errors.js`; the central error handler maps them to responses.
- Route handlers are thin — business logic lives in `services/`.
- No `console.log` — always go through the pino logger.
- Run Prettier + ESLint before commit. Config: standard + import/order.

## What NOT to Do

- Do not accept an API key from the client. The whole point of this proxy is to keep it server-side.
- Do not use the Supabase service role key for operations that should run under user RLS — only for explicitly-whitelisted admin tasks.
- Do not use IP-based rate limiting. Use the authenticated user ID.
- Do not log message bodies, JWTs, or API keys.
- Do not enable CORS wildcard (`*`) in production.
- Do not add a database to this service. It is a stateless proxy.
