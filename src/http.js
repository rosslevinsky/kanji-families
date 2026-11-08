// Small helpers for the Worker's responses and request bodies.

// _headers only covers static files, so Worker responses set their own.
const BASE_HEADERS = {
  'Content-Type': 'application/json; charset=utf-8',
  'Cache-Control': 'no-store',
  'X-Content-Type-Options': 'nosniff',
};

export function json(status, body, headers = {}) {
  return new Response(JSON.stringify(body), { status, headers: { ...BASE_HEADERS, ...headers } });
}

export function error(status, code, message, headers) {
  return json(status, { code, message }, headers);
}

// A redirect that can set several cookies, which a plain headers object can't hold.
export function redirect(location, cookies = []) {
  const headers = new Headers({ 'Cache-Control': 'no-store', 'X-Content-Type-Options': 'nosniff', Location: location });
  for (const cookie of cookies) headers.append('Set-Cookie', cookie);
  return new Response(null, { status: 302, headers });
}

// Reads a body up to a limit, and returns null if it is over. Workers buffer what is read, so a
// declared length over the limit is refused unread, and a stream stops at the limit.
export async function readBody(request, limit) {
  const declared = Number(request.headers.get('Content-Length'));
  if (declared > limit) return null;
  if (!request.body) return new Uint8Array();
  const reader = request.body.getReader();
  const chunks = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      return null;
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.byteLength;
  }
  return out;
}

// Returns the parsed JSON, or undefined if the bytes aren't valid UTF-8 JSON.
export function parseJson(bytes) {
  try {
    return JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
  } catch {
    return undefined;
  }
}
