// Runs only for /api/* and /auth/*. Everything else is a static file (see wrangler.jsonc).
import { googleLoginAvailable, loginCallback, logout, startLogin } from './auth.js';
import { devLogin, devLoginEnabled } from './dev-login.js';
import { error, json } from './http.js';
import { deleteProgress, getProgress, putProgress } from './progress.js';
import { hasSessionKey, readSession } from './session.js';

const isSafeMethod = (method) => method === 'GET' || method === 'HEAD';

function isSameOrigin(request, env) {
  try {
    return request.headers.get('Origin') === new URL(env.APP_URL).origin;
  } catch {
    return false; // APP_URL is missing or invalid: refuse rather than guess
  }
}

const withSession = (handler) => async (request, env) => {
  const session = await readSession(request, env);
  if (!session) return error(401, 'not_signed_in', 'Please sign in.');
  return handler(request, env, session);
};

// Tells the page which sign-in buttons to show and whether a session is present, so a visitor who
// never signed in needs no failing request to find that out.
const getConfig = async (request, env) => json(200, {
  googleLogin: googleLoginAvailable(env),
  devLogin: devLoginEnabled(env) && hasSessionKey(env),
  signedIn: !!await readSession(request, env),
});

const ROUTES = {
  '/api/config': { GET: getConfig },
  '/auth/login': { GET: startLogin },
  '/auth/callback': { GET: loginCallback },
  '/auth/logout': { POST: logout },
  '/api/progress': { GET: withSession(getProgress), PUT: withSession(putProgress), DELETE: withSession(deleteProgress) },
};

function routesFor(pathname, env) {
  if (pathname === '/auth/dev-login') return devLoginEnabled(env) ? { POST: devLogin } : null;
  return Object.hasOwn(ROUTES, pathname) ? ROUTES[pathname] : null;
}

export default {
  async fetch(request, env) {
    try {
      const methods = routesFor(new URL(request.url).pathname, env);
      if (!methods) return error(404, 'not_found', 'Not found.');
      const handler = Object.hasOwn(methods, request.method) ? methods[request.method] : null;
      if (!handler) return error(405, 'method_not_allowed', 'Method not allowed.', { Allow: Object.keys(methods).join(', ') });
      if (!isSafeMethod(request.method) && !isSameOrigin(request, env)) {
        return error(403, 'bad_origin', 'This request did not come from this site.');
      }
      return await handler(request, env);
    } catch (e) {
      console.error(e);
      return error(500, 'server_error', 'Something went wrong. Try again.');
    }
  },
};
