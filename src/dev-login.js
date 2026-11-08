// A fake login for local development and tests. The router only offers it when DEV_LOGIN=1, which
// lives in the git-ignored .dev.vars and never in wrangler.jsonc, so the deployed site has no such route.
import { accountId, hasSessionKey, MAX_SUB_LENGTH, startSession } from './session.js';
import { error, json, parseJson, readBody } from './http.js';

const MAX_BODY_BYTES = 1024;
const DEFAULT_SUB = 'local-dev-user';

export const devLoginEnabled = (env) => env.DEV_LOGIN === '1';

export async function devLogin(request, env) {
  if (!hasSessionKey(env)) return error(503, 'not_configured', 'SESSION_KEY is not set. Run "npm run setup".');
  const bytes = await readBody(request, MAX_BODY_BYTES);
  if (!bytes) return error(413, 'too_large', 'The request is too large.');
  const body = bytes.length ? parseJson(bytes) : {};
  if (!body || typeof body !== 'object' || Array.isArray(body)) return error(400, 'invalid_sub', 'Send a JSON object.');
  const sub = body.sub ?? DEFAULT_SUB;
  if (typeof sub !== 'string' || !sub || sub.length > MAX_SUB_LENGTH) {
    return error(400, 'invalid_sub', 'sub must be a short, non-empty string.');
  }
  return json(200, { account: await accountId(env, sub) }, { 'Set-Cookie': await startSession(env, sub) });
}
