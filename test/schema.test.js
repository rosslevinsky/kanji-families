import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';

async function columns() {
  const tables = (await env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table'").all()).results
    .map((t) => t.name)
    .filter((n) => !/^(sqlite_|_cf_|d1_)/.test(n));
  const out = {};
  for (const t of tables) out[t] = (await env.DB.prepare(`PRAGMA table_info(${t})`).all()).results.map((c) => c.name);
  return out;
}

describe('database schema', () => {
  it('holds only the sub, progress, timestamps and deletion markers', async () => {
    expect(await columns()).toEqual({
      progress: ['sub', 'data', 'version', 'created_at', 'updated_at'],
      deletion_markers: ['sub_hash', 'deleted_at'],
    });
  });

  it('has no column for email or name', async () => {
    const all = Object.values(await columns()).flat();
    expect(all.length).toBeGreaterThan(0);
    for (const c of all) expect(c).not.toMatch(/mail|name|picture|profile/i);
  });
});
