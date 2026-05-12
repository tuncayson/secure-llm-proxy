import { createClient } from '@supabase/supabase-js';
import { env } from '../config/env.js';
import { AuthError } from '../utils/errors.js';

const authClient = createClient(
  env.SUPABASE_URL,
  env.SUPABASE_SERVICE_ROLE_KEY,
  {
    auth: {
      persistSession: false,
      autoRefreshToken: false,
    },
  },
);

const BEARER_RE = /^Bearer\s+(.+)$/i;

function extractToken(req) {
  const header = req.headers?.authorization;
  if (!header) throw new AuthError('Missing Authorization header');
  const match = BEARER_RE.exec(header);
  if (!match) throw new AuthError('Malformed Authorization header');
  const token = match[1].trim();
  if (!token) throw new AuthError('Malformed Authorization header');
  return token;
}

async function verifyToken(token) {
  if (typeof authClient.auth.getClaims === 'function') {
    const { data, error } = await authClient.auth.getClaims(token);
    if (!error && data?.claims) {
      return data.claims;
    }
    if (!env.SUPABASE_JWT_SECRET) {
      throw new AuthError('Invalid token');
    }
  } else if (!env.SUPABASE_JWT_SECRET) {
    throw new AuthError('JWT verification unavailable');
  }

  const { data, error } = await authClient.auth.getUser(token);
  if (error || !data?.user) {
    throw new AuthError('Invalid token');
  }
  const { user } = data;
  return { sub: user.id, email: user.email, role: user.role };
}

export async function authenticate(req, res, next) {
  try {
    const token = extractToken(req);
    const claims = await verifyToken(token);
    req.user = {
      id: claims.sub,
      email: claims.email,
      role: claims.role,
    };
    next();
  } catch (err) {
    next(err);
  }
}
