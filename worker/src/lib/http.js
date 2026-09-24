export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export const fail = (status, message) => { throw new HttpError(status, message); };

export function json(obj, status = 200, headers = {}) {
  return new Response(JSON.stringify(obj), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store", ...headers },
  });
}

/** Parse a JSON object body, refusing anything large or malformed. */
export async function readJson(req, maxBytes = 64 * 1024) {
  const len = +(req.headers.get("content-length") || 0);
  if (len > maxBytes) fail(413, "That request is too large.");
  const text = await req.text();
  if (text.length > maxBytes) fail(413, "That request is too large.");
  if (!text.trim()) return {};
  let v;
  try { v = JSON.parse(text); } catch { fail(400, "The request wasn't valid JSON."); }
  if (!v || typeof v !== "object" || Array.isArray(v)) fail(400, "The request wasn't valid JSON.");
  return v;
}
