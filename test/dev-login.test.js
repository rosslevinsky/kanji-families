import wranglerConfig from '../wrangler.jsonc?raw';
import { describe, expect, it } from 'vitest';
import { call, callWith } from './helpers/api.js';

describe('fake login', () => {
  it.each([[undefined], [''], ['0'], ['true']])('is not found when DEV_LOGIN is %j', async (DEV_LOGIN) => {
    expect((await callWith({ DEV_LOGIN }, 'POST', '/auth/dev-login', { body: { sub: 'x' } })).status).toBe(404);
    expect((await callWith({ DEV_LOGIN }, 'GET', '/auth/dev-login')).status).toBe(404);
  });

  it('never appears in the deployed config', () => {
    expect(wranglerConfig.length).toBeGreaterThan(0);
    expect(wranglerConfig).not.toContain('DEV_LOGIN');
  });

  it('with DEV_LOGIN=1, starts a session for the sub the test names', async () => {
    const one = await call('POST', '/auth/dev-login', { body: { sub: 'one' } });
    expect(one.status).toBe(200);
    const two = await call('POST', '/auth/dev-login', { body: { sub: 'two' } });
    const accountOf = async (res) => (await res.json()).account;
    expect(await accountOf(one)).not.toBe(await accountOf(two));
    const cookie = two.headers.get('Set-Cookie').split(';')[0];
    expect((await call('GET', '/api/progress', { cookie })).status).toBe(200);
  });

  it('uses a default fake account when no sub is named', async () => {
    const res = await call('POST', '/auth/dev-login');
    expect(res.status).toBe(200);
  });

  it.each([[''], [5], ['x'.repeat(256)]])('refuses the sub %j', async (sub) => {
    expect((await call('POST', '/auth/dev-login', { body: { sub } })).status).toBe(400);
  });

  it.each([['{nope'], ['[]'], ['null']])('refuses the body %s rather than logging in as the default account', async (body) => {
    expect((await call('POST', '/auth/dev-login', { body })).status).toBe(400);
  });

  it('refuses a cross-origin login', async () => {
    expect((await call('POST', '/auth/dev-login', { body: { sub: 'x' }, origin: 'http://evil.test' })).status).toBe(403);
  });

  it('reports itself as unavailable when no signing key is set', async () => {
    const res = await callWith({ SESSION_KEY: '' }, 'POST', '/auth/dev-login', { body: { sub: 'x' } });
    expect(res.status).toBe(503);
  });
});
