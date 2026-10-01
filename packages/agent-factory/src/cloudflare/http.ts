import { HttpError } from '../adapters/auth.js';
export async function bytes(req: Request, limit = 1024 * 1024) {
  if (Number(req.headers.get('content-length')) > limit) throw new HttpError(413, 'Request too large');
  const reader = req.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = []; let size = 0;
  for (;;) {
    const next = await reader.read(); if (next.done) break;
    size += next.value.byteLength;
    if (size > limit) { await reader.cancel(); throw new HttpError(413, 'Request too large'); }
    chunks.push(next.value);
  }
  const result = new Uint8Array(size); let offset = 0;
  for (const chunk of chunks) { result.set(chunk, offset); offset += chunk.length; }
  return result;
}
export async function json(req: Request): Promise<Record<string, unknown>> {
  if (!req.headers.get('content-type')?.startsWith('application/json')) throw new HttpError(415, 'JSON required');
  try {
    const body: unknown = JSON.parse(new TextDecoder().decode(await bytes(req, 65536)));
    if (!body || typeof body !== 'object' || Array.isArray(body)) throw new Error();
    return body as Record<string, unknown>;
  } catch (e) { if (e instanceof HttpError) throw e; throw new HttpError(400, 'Invalid JSON'); }
}
export function string(body: Record<string, unknown>, name: string) {
  if (typeof body[name] !== 'string') throw new HttpError(400, `${name} required`);
  return body[name];
}
