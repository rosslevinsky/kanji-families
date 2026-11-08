// The progress API. The Worker is the final authority: it reads the row, merges, checks the size,
// writes only if the version hasn't changed, and returns the merged result.
import { adoptAnonymous, blankStore, mergeStores, STORE_VERSION } from '../public/merge.js';
import { accountId, clearedSessionCookie, deletionHash, SESSION_MAX_AGE_MS } from './session.js';
import { error, json, parseJson, readBody } from './http.js';

export const MAX_PROGRESS_BYTES = 1024 * 1024;
const MAX_WRITE_ATTEMPTS = 5;
const DELETION_MARGIN_MS = 60000; // covers an overlapping login and clock differences between Workers
const encoder = new TextEncoder();

const accountDeleted = () => error(410, 'account_deleted', 'This account was deleted. Remove the copy in this browser.');
const isMap = (x) => !!x && typeof x === 'object' && !Array.isArray(x);

// True when a marker refuses this session. Used as a condition inside each write as well as on
// reads, so a deletion that lands after the read still stops the write.
const REFUSED = 'EXISTS (SELECT 1 FROM deletion_markers WHERE sub_hash = ? AND deleted_at >= ?)';

// One consistent view of the marker and the row.
async function load(env, session, hash, time) {
  const [marker, row] = await env.DB.batch([
    env.DB.prepare('SELECT deleted_at FROM deletion_markers WHERE sub_hash = ?').bind(hash),
    env.DB.prepare('SELECT data, version FROM progress WHERE sub = ?').bind(session.sub),
  ]);
  const deletedAt = marker.results[0] ? marker.results[0].deleted_at : null;
  return { deletedAt, refused: deletedAt !== null && deletedAt >= time, row: row.results[0] || null };
}

// Individual bad entries are dropped by the shared cleaner, but a store of the wrong shape is
// refused outright: cleaning it would look like a successful save of nothing.
function isSavableStore(x) {
  return isMap(x) && x.v === STORE_VERSION && isMap(x.gen) && isMap(x.counters) && isMap(x.srs)
    && Array.isArray(x.log) && Array.isArray(x.tests);
}

// The browser records serverTime as when its copy last matched the account, and compares that with
// deletedAt after its next login. A deletion's time is placed ahead of the clock and a session after
// it is dated later still, so this is never earlier than the session: a copy that synced after a
// deletion always reads as newer than it.
async function result(env, session, version, progress, fields = {}) {
  const serverTime = Math.max(Date.now(), session.iat);
  return json(200, { account: await accountId(env, session.sub), version, progress, serverTime, ...fields });
}

export async function getProgress(request, env, session) {
  const { deletedAt, refused, row } = await load(env, session, await deletionHash(env, session.sub), session.iat);
  if (refused) return accountDeleted();
  // A session started after a deletion isn't refused, so the browser decides from this whether its
  // copy predates the deletion and must not be uploaded. Markers last as long as sessions, 90 days,
  // so a browser idle for longer than that is not covered: its copy would bring the old data back.
  return result(env, session, row ? row.version : 0, row ? JSON.parse(row.data) : blankStore(), { deletedAt });
}

// Returns whether the write landed. Both forms fail if the version moved or a deletion arrived.
async function write(env, session, hash, row, text, now, time) {
  const statement = row
    ? env.DB.prepare(`UPDATE progress SET data = ?, version = version + 1, updated_at = ?
        WHERE sub = ? AND version = ? AND NOT ${REFUSED}`)
      .bind(text, now, session.sub, row.version, hash, time)
    : env.DB.prepare(`INSERT INTO progress (sub, data, version, created_at, updated_at)
        SELECT ?, ?, 1, ?, ? WHERE NOT ${REFUSED} ON CONFLICT (sub) DO NOTHING`)
      .bind(session.sub, text, now, now, hash, time);
  return (await statement.run()).meta.changes === 1;
}

// The browser names the account its copy belongs to. The session cookie can change under an open
// tab, when another tab signs in as someone else, and one account's data must never reach another.
async function namesOtherAccount(url, env, session) {
  const named = url.searchParams.get('account');
  return named !== null && named !== await accountId(env, session.sub);
}

// How old this save's data can be: its session's time, or the time its copy last matched the account
// if that is earlier, so a refreshed session can't carry a copy older than a deletion past the marker.
// Returns null if since is malformed, which is refused: ignoring it would drop that protection.
function dataTime(url, session) {
  const since = url.searchParams.get('since');
  if (since === null) return session.iat;
  return /^\d+$/.test(since) && Number.isSafeInteger(Number(since)) ? Math.min(session.iat, Number(since)) : null;
}

export async function putProgress(request, env, session) {
  const url = new URL(request.url);
  if (await namesOtherAccount(url, env, session)) {
    return error(409, 'wrong_account', 'This save belongs to a different account.');
  }
  const time = dataTime(url, session);
  if (time === null) return error(400, 'invalid_since', 'This save has an invalid sync time.');
  const bytes = await readBody(request, MAX_PROGRESS_BYTES);
  if (!bytes) return error(413, 'too_large', 'This save is too large.');
  const incoming = parseJson(bytes);
  if (!isSavableStore(incoming)) return error(400, 'invalid_progress', 'This is not a valid progress store.');

  const merge = url.searchParams.get('adopt') === '1' ? adoptAnonymous : mergeStores;
  const hash = await deletionHash(env, session.sub);
  const blank = JSON.stringify(blankStore());

  for (let attempt = 0; attempt < MAX_WRITE_ATTEMPTS; attempt++) {
    const { refused, row } = await load(env, session, hash, time);
    if (refused) return accountDeleted();
    const merged = merge(row ? JSON.parse(row.data) : blankStore(), incoming);
    const text = JSON.stringify(merged);
    if (encoder.encode(text).byteLength > MAX_PROGRESS_BYTES) {
      return error(413, 'progress_too_large', 'Saved progress would be over the 1 MB limit, so nothing was changed.');
    }
    if (text === (row ? row.data : blank)) return result(env, session, row ? row.version : 0, merged);
    if (await write(env, session, hash, row, text, Date.now(), time)) return result(env, session, row ? row.version + 1 : 1, merged);
  }
  return error(503, 'busy', 'Too many saves at once. Try again.', { 'Retry-After': '1' });
}

export async function deleteProgress(request, env, session) {
  if (await namesOtherAccount(new URL(request.url), env, session)) {
    return error(409, 'wrong_account', 'This deletion is for a different account.');
  }
  const hash = await deletionHash(env, session.sub);
  const now = Date.now();
  // Ahead of the clock, and never earlier than this session, so a login that overlaps this deletion
  // (it read the old row before the batch landed) is still refused. Logins after it are issued later still.
  const deletedAt = Math.max(now + DELETION_MARGIN_MS, session.iat);
  // A batch is one transaction. Each step rechecks this session, so a stale delete can't remove a
  // newer login's row. The row goes first, while the marker that would refuse this session is absent.
  const [, marker] = await env.DB.batch([
    env.DB.prepare(`DELETE FROM progress WHERE sub = ? AND NOT ${REFUSED}`).bind(session.sub, hash, session.iat),
    env.DB.prepare(`INSERT INTO deletion_markers (sub_hash, deleted_at) SELECT ?, ? WHERE NOT ${REFUSED}
      ON CONFLICT (sub_hash) DO UPDATE SET deleted_at = MAX(deleted_at, excluded.deleted_at)`).bind(hash, deletedAt, hash, session.iat),
    // Every session issued at or before such a marker has expired, so it has nothing left to refuse.
    env.DB.prepare('DELETE FROM deletion_markers WHERE deleted_at < ?').bind(now - SESSION_MAX_AGE_MS),
  ]);
  if (marker.meta.changes !== 1) return accountDeleted();
  return json(200, { deleted: true }, { 'Set-Cookie': clearedSessionCookie(env) });
}
