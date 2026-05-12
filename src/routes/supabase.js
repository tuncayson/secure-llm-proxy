import { Router } from 'express';
import { z } from 'zod';

import { supabaseAdmin } from '../services/supabaseAdmin.js';
import {
  ForbiddenError,
  UpstreamError,
  ValidationError,
} from '../utils/errors.js';

const router = Router();

const handlers = {
  get_user_metadata: async (admin, params, user) => {
    const schema = z.object({
      user_id: z.string().optional(),
    });
    const parsed = schema.parse(params);

    if (parsed.user_id && parsed.user_id !== user.id) {
      throw new ForbiddenError(
        'Cannot read metadata for a different user',
      );
    }

    const { data, error } = await admin
      .from('user_metadata')
      .select('*')
      .eq('user_id', user.id)
      .maybeSingle();

    if (error) {
      throw new UpstreamError(error.message ?? 'Supabase query failed');
    }
    return data ?? null;
  },

  increment_user_credit: async (admin, params, user) => {
    const schema = z.object({
      amount: z.number().int().positive(),
    });
    const { amount } = schema.parse(params);

    const { data, error } = await admin.rpc('increment_user_credit', {
      user_id: user.id,
      amount,
    });

    if (error) {
      throw new UpstreamError(error.message ?? 'Supabase RPC failed');
    }
    return data;
  },
};

const bodySchema = z.object({
  operation: z.enum(Object.keys(handlers)),
  params: z.record(z.unknown()).optional().default({}),
});

router.post('/query', async (req, res, next) => {
  const parsed = bodySchema.safeParse(req.body);
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

  const { operation, params } = parsed.data;
  const handler = handlers[operation];

  try {
    const data = await handler(supabaseAdmin, params, req.user);
    res.json({ ok: true, data });
  } catch (err) {
    if (err instanceof z.ZodError) {
      return next(
        new ValidationError(`Invalid params for ${operation}`, {
          details: err.issues.map((i) => ({
            path: i.path,
            message: i.message,
          })),
        }),
      );
    }
    next(err);
  }
});

export default router;
