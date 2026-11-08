// Shared helpers for tests that call the Worker against local D1.
import { env, SELF } from 'cloudflare:test';
import worker from '../../src/worker.js';

export const ORIGIN = env.APP_URL;
export const baseEnv = () => ({ APP_URL: env.APP_URL, SESSION_KEY: env.SESSION_KEY, DEV_LOGIN: env.DEV_LOGIN, DB: env.DB });

export function request(method, path, { cookie, body, origin = ORIGIN, headers = {} } = {}) {
  const h = new Headers(headers);
  if (cookie) h.set('Cookie', cookie);
  if (origin) h.set('Origin', origin);
  const payload = body === undefined || typeof body === 'string' || body instanceof ReadableStream ? body : JSON.stringify(body);
  const init = { method, headers: h, body: payload };
  if (payload instanceof ReadableStream) init.duplex = 'half';
  return new Request(ORIGIN + path, init);
}

export const call = (method, path, options) => SELF.fetch(request(method, path, options));

// Calls the Worker directly, for tests that change its settings or wrap its database.
export const callWith = (overrides, method, path, options) =>
  worker.fetch(request(method, path, options), { ...baseEnv(), ...overrides });

export async function login(sub) {
  const res = await call('POST', '/auth/dev-login', { body: { sub } });
  if (res.status !== 200) throw new Error(`login failed: ${res.status}`);
  return res.headers.get('Set-Cookie').split(';')[0];
}

export function store(fields = {}) {
  return { v: 3, gen: { t: 0, id: '0' }, counters: {}, srs: {}, log: [], tests: [], ...fields };
}

export const answers = (device, n, c = n) => ({ [device]: { scores: { reading: { c, n } }, kanji: {} } });
export const review = (key, r) => ({ ['reading:' + key]: { b: 1, d: r + 1000, r } });

export const row = (sub) => env.DB.prepare('SELECT * FROM progress WHERE sub = ?').bind(sub).first();

// A database whose writes to the progress table first let something else happen, as if another
// request got in between this request's read and its write. Without `every`, only the first does.
export function racingDb(before, { every = false } = {}) {
  let fired = false;
  return {
    batch: (statements) => env.DB.batch(statements),
    prepare(sql) {
      const statement = env.DB.prepare(sql);
      if (!/(INTO|UPDATE) progress/.test(sql)) return statement;
      return {
        bind: (...args) => {
          const bound = statement.bind(...args);
          return {
            run: async () => {
              if (every || !fired) {
                fired = true;
                await before();
              }
              return bound.run();
            },
          };
        },
      };
    },
  };
}
