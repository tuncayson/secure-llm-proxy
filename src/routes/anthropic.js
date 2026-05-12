import { Router } from 'express';
import { z } from 'zod';

import { anthropic } from '../services/anthropicClient.js';
import { logger } from '../utils/logger.js';
import {
  RateLimitError,
  UpstreamError,
  ValidationError,
} from '../utils/errors.js';

const router = Router();

const messagesSchema = z
  .object({
    model: z.string().min(1),
    messages: z.array(z.unknown()).min(1),
    max_tokens: z.number().int().positive(),
    stream: z.boolean().optional(),
  })
  .passthrough()
  .refine(
    (body) => !('api_key' in body) && !('apiKey' in body),
    { message: 'Client-supplied api_key is not allowed' },
  );

function extractRetryAfter(err) {
  if (!err) return undefined;
  if (err.retryAfter) return String(err.retryAfter);
  const h = err.headers;
  if (h?.get) return h.get('retry-after') ?? undefined;
  if (h) return h['retry-after'] ?? h['Retry-After'] ?? undefined;
  return undefined;
}

function mapAnthropicError(err) {
  const status = err?.status;
  if (typeof status === 'number') {
    if (status === 401) {
      return new UpstreamError('Upstream authentication failed');
    }
    if (status === 429) {
      const mapped = new RateLimitError(
        err.message ?? 'Upstream rate limited',
      );
      const retryAfter = extractRetryAfter(err);
      if (retryAfter) mapped.retryAfter = retryAfter;
      return mapped;
    }
    if (status === 400) {
      return new ValidationError(err.message ?? 'Bad request');
    }
    return new UpstreamError(err.message ?? `Anthropic error ${status}`);
  }
  return new UpstreamError(err?.message ?? 'Network error');
}

function logRequest(req, body, startTime, status, usage = {}) {
  logger.info(
    {
      userId: req.user?.id,
      model: body.model,
      stream: body.stream === true,
      status,
      latencyMs: Date.now() - startTime,
      inputTokens: usage.input_tokens ?? 0,
      outputTokens: usage.output_tokens ?? 0,
    },
    'anthropic.messages',
  );
}

async function handleStream(req, res, next, body, startTime) {
  const abortController = new AbortController();
  let clientClosed = false;

  req.on('close', () => {
    if (!res.writableEnded) {
      clientClosed = true;
      abortController.abort();
    }
  });

  let status = 200;
  const usage = { input_tokens: 0, output_tokens: 0 };

  try {
    const stream = await anthropic.messages.create(body, {
      signal: abortController.signal,
    });

    res.status(200);
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders();

    for await (const event of stream) {
      if (event.type === 'message_start' && event.message?.usage) {
        usage.input_tokens =
          event.message.usage.input_tokens ?? usage.input_tokens;
        usage.output_tokens =
          event.message.usage.output_tokens ?? usage.output_tokens;
      } else if (event.type === 'message_delta' && event.usage) {
        usage.output_tokens =
          event.usage.output_tokens ?? usage.output_tokens;
      }

      res.write(`event: ${event.type}\n`);
      res.write(`data: ${JSON.stringify(event)}\n\n`);
    }

    res.end();
    logRequest(req, body, startTime, status, usage);
  } catch (err) {
    if (clientClosed) {
      status = 499;
      logRequest(req, body, startTime, status, usage);
      return;
    }

    const mapped = mapAnthropicError(err);
    status = mapped.status;
    logRequest(req, body, startTime, status, usage);

    if (res.headersSent) {
      res.end();
      return;
    }
    if (mapped.retryAfter) res.setHeader('Retry-After', mapped.retryAfter);
    next(mapped);
  }
}

router.post('/messages', async (req, res, next) => {
  const parsed = messagesSchema.safeParse(req.body);
  if (!parsed.success) {
    return next(
      new ValidationError('Invalid request body', {
        details: parsed.error.issues.map((i) => ({
          path: i.path,
          message: i.message,
        })),
      }),
    );
  }

  const body = parsed.data;
  const startTime = Date.now();

  if (body.stream === true) {
    return handleStream(req, res, next, body, startTime);
  }

  try {
    const response = await anthropic.messages.create(body);
    logRequest(req, body, startTime, 200, response.usage ?? {});
    res.json(response);
  } catch (err) {
    const mapped = mapAnthropicError(err);
    logRequest(req, body, startTime, mapped.status);
    if (mapped.retryAfter) res.setHeader('Retry-After', mapped.retryAfter);
    next(mapped);
  }
});

export default router;
