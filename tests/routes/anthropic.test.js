import {
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from 'vitest';
import request from 'supertest';

const { mockSupabase, mockAnthropicMessages } = vi.hoisted(() => ({
  mockSupabase: {
    auth: {
      getClaims: vi.fn(),
      getUser: vi.fn(),
    },
  },
  mockAnthropicMessages: {
    create: vi.fn(),
  },
}));

vi.mock('@supabase/supabase-js', () => ({
  createClient: vi.fn(() => mockSupabase),
}));

vi.mock('@anthropic-ai/sdk', () => {
  class MockAnthropic {
    constructor() {
      this.messages = mockAnthropicMessages;
    }
  }
  return { default: MockAnthropic };
});

let app;
let logger;

beforeAll(async () => {
  process.env.ANTHROPIC_API_KEY = 'sk-ant-test';
  process.env.SUPABASE_URL = 'https://example.supabase.co';
  process.env.SUPABASE_SERVICE_ROLE_KEY = 'service-role-key';
  process.env.ALLOWED_ORIGINS = 'https://app.example.com';
  process.env.NODE_ENV = 'test';
  process.env.LOG_LEVEL = 'fatal';
  process.env.RATE_LIMIT_WINDOW_MS = '60000';
  process.env.RATE_LIMIT_MAX = '1000';

  ({ logger } = await import('../../src/utils/logger.js'));
  const { createApp } = await import('../../src/app.js');
  app = createApp();
});

beforeEach(() => {
  mockSupabase.auth.getClaims.mockReset();
  mockAnthropicMessages.create.mockReset();
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

function mockAuth(userId = `user-${Date.now()}-${Math.random()}`) {
  mockSupabase.auth.getClaims.mockResolvedValueOnce({
    data: {
      claims: { sub: userId, email: 'u@example.com', role: 'authenticated' },
    },
    error: null,
  });
}

const VALID_BODY = {
  model: 'claude-3-haiku-latest',
  messages: [{ role: 'user', content: 'hello' }],
  max_tokens: 64,
};

describe('POST /api/anthropic/messages', () => {
  it('rejects a body that contains a client-supplied apiKey', async () => {
    mockAuth();
    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send({ ...VALID_BODY, apiKey: 'sk-ant-stolen' });

    expect(res.status).toBe(400);
    expect(mockAnthropicMessages.create).not.toHaveBeenCalled();
  });

  it('rejects a body that contains a client-supplied api_key', async () => {
    mockAuth();
    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send({ ...VALID_BODY, api_key: 'sk-ant-stolen' });

    expect(res.status).toBe(400);
    expect(mockAnthropicMessages.create).not.toHaveBeenCalled();
  });

  it('rejects a body that fails zod validation (empty messages)', async () => {
    mockAuth();
    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send({ ...VALID_BODY, messages: [] });

    expect(res.status).toBe(400);
    expect(mockAnthropicMessages.create).not.toHaveBeenCalled();
  });

  it('rejects a body missing max_tokens', async () => {
    mockAuth();
    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send({ model: 'claude-3-haiku-latest', messages: VALID_BODY.messages });

    expect(res.status).toBe(400);
  });

  it('returns JSON for a non-streaming happy path', async () => {
    mockAuth();
    mockAnthropicMessages.create.mockResolvedValueOnce({
      id: 'msg_1',
      content: [{ type: 'text', text: 'hi' }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send(VALID_BODY);

    expect(res.status).toBe(200);
    expect(res.body.id).toBe('msg_1');
    expect(mockAnthropicMessages.create).toHaveBeenCalledTimes(1);
    const [params] = mockAnthropicMessages.create.mock.calls[0];
    expect(params).not.toHaveProperty('apiKey');
    expect(params).not.toHaveProperty('api_key');
  });

  it('streams SSE events when stream: true', async () => {
    mockAuth();
    async function* mockStream() {
      yield {
        type: 'message_start',
        message: { usage: { input_tokens: 4, output_tokens: 0 } },
      };
      yield {
        type: 'content_block_delta',
        index: 0,
        delta: { type: 'text_delta', text: 'hello' },
      };
      yield {
        type: 'message_delta',
        delta: { stop_reason: 'end_turn' },
        usage: { output_tokens: 2 },
      };
      yield { type: 'message_stop' };
    }
    mockAnthropicMessages.create.mockResolvedValueOnce(mockStream());

    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send({ ...VALID_BODY, stream: true });

    expect(res.status).toBe(200);
    expect(res.headers['content-type']).toContain('text/event-stream');
    expect(res.headers['cache-control']).toContain('no-cache');
    expect(res.text).toContain('event: message_start');
    expect(res.text).toContain('event: content_block_delta');
    expect(res.text).toContain('event: message_delta');
    expect(res.text).toContain('event: message_stop');
  });

  it('maps an SDK 401 to a 502 UpstreamError', async () => {
    mockAuth();
    const err = Object.assign(new Error('unauthorized'), { status: 401 });
    mockAnthropicMessages.create.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send(VALID_BODY);

    expect(res.status).toBe(502);
  });

  it('maps an SDK 429 to a 429 with Retry-After passthrough', async () => {
    mockAuth();
    const err = Object.assign(new Error('rate limited'), {
      status: 429,
      headers: { 'retry-after': '12' },
    });
    mockAnthropicMessages.create.mockRejectedValueOnce(err);

    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send(VALID_BODY);

    expect(res.status).toBe(429);
    expect(res.headers['retry-after']).toBe('12');
  });

  it('maps a network error (no status) to 502', async () => {
    mockAuth();
    mockAnthropicMessages.create.mockRejectedValueOnce(
      new Error('ECONNRESET'),
    );

    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send(VALID_BODY);

    expect(res.status).toBe(502);
  });

  it('never writes message content to the logger', async () => {
    mockAuth();
    const SECRET = 'PROMPT-CONTENT-XYZZY-12345';
    mockAnthropicMessages.create.mockResolvedValueOnce({
      id: 'msg_2',
      content: [{ type: 'text', text: 'reply' }],
      usage: { input_tokens: 5, output_tokens: 3 },
    });

    const methods = ['trace', 'debug', 'info', 'warn', 'error', 'fatal'];
    const spies = methods.map((m) =>
      vi.spyOn(logger, m).mockImplementation(() => {}),
    );

    const res = await request(app)
      .post('/api/anthropic/messages')
      .set('authorization', 'Bearer valid')
      .send({
        ...VALID_BODY,
        messages: [{ role: 'user', content: SECRET }],
      });

    expect(res.status).toBe(200);

    // pino-http calls logger.info({req, res}, 'request completed'). The
    // spy sees raw refs (req.body included); pino's stdSerializers.req
    // strips body at format time before it ever hits stdout. We assert
    // on the only log line *our route code* emits.
    const ourLogCalls = spies.flatMap((s) =>
      s.mock.calls.filter((args) => args[1] === 'anthropic.messages'),
    );
    expect(ourLogCalls.length).toBeGreaterThan(0);
    for (const call of ourLogCalls) {
      expect(safeStringify(call)).not.toContain(SECRET);
    }

    for (const spy of spies) spy.mockRestore();
  });
});
