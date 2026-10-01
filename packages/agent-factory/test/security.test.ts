import { test } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPair, SignJWT } from 'jose';
import { GoogleIdentity, requireOrigin } from '../src/adapters/auth.js';
import { runToken, verifyRunToken } from '../src/adapters/capability.js';
import { verifySignature } from '../src/cloudflare/webhooks.js';
import { validatePush } from '../src/cloudflare/proxy.js';

test('Google identity requires correct signature, issuer, audience, expiry, nonce, verified email and hosted domain', async () => {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const verifier = new GoogleIdentity('client', async () => publicKey);
  async function token(changes: Record<string, unknown> = {}) {
    return new SignJWT({ sub: 'stable-google-sub', email: 'person@company.example', email_verified: true,
      hd: 'company.example', nonce: 'nonce', iss: 'https://accounts.google.com', aud: 'client',
      iat: Math.floor(Date.now() / 1000), exp: Math.floor(Date.now() / 1000) + 300, ...changes })
      .setProtectedHeader({ alg: 'RS256' }).sign(privateKey);
  }
  assert.deepEqual(await verifier.verify(await token(), 'nonce'), { sub: 'stable-google-sub', domain: 'company.example' });
  for (const changes of [{ hd: undefined }, { email_verified: false }, { aud: 'other' }, { iss: 'attacker' }, { exp: 1 }, { nonce: 'other' }, { sub: undefined }])
    await assert.rejects(verifier.verify(await token(changes), 'nonce'));
  const other = await generateKeyPair('RS256');
  await assert.rejects(new GoogleIdentity('client', async () => other.publicKey).verify(await token(), 'nonce'));
});
test('signed webhooks reject altered content, unsigned requests and malformed signatures', async () => {
  const body = new TextEncoder().encode('{"action":"closed"}'), secret = 'test-only-secret';
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(secret), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const digest = Buffer.from(await crypto.subtle.sign('HMAC', key, body)).toString('hex');
  assert.equal(await verifySignature(secret, body, `sha256=${digest}`), true);
  assert.equal(await verifySignature(secret, new TextEncoder().encode('{}'), `sha256=${digest}`), false);
  assert.equal(await verifySignature(secret, body, 'sha256=oops'), false);
});
test('run capabilities bind goal/run/attempt and reject the wrong secret', async () => {
  const secret = 'test-secret-is-at-least-32-characters-long';
  const token = await runToken(secret, 'goal', 'run', 2);
  assert.deepEqual(await verifyRunToken(secret, token), { goal: 'goal', run: 'run', attempt: 2 });
  await assert.rejects(verifyRunToken('other-secret', token));
});
function push(ref: string, sha = 'b'.repeat(40)) {
  const line = 'a'.repeat(40) + ' ' + sha + ' ' + ref + '\0report-status\n';
  return new TextEncoder().encode((line.length + 4).toString(16).padStart(4, '0') + line + '0000PACK');
}
test('Git push capability cannot update main, tags, another run branch, or delete a branch', () => {
  validatePush(push('refs/heads/herbie/run-1'), 'herbie/run-1');
  for (const ref of ['refs/heads/main', 'refs/tags/v1', 'refs/heads/herbie/run-2']) assert.throws(() => validatePush(push(ref), 'herbie/run-1'));
  assert.throws(() => validatePush(push('refs/heads/herbie/run-1', '0'.repeat(40)), 'herbie/run-1'));
  assert.throws(() => validatePush(new TextEncoder().encode('0000'), 'herbie/run-1'));
});
test('cross-origin state changes are rejected', () => {
  assert.throws(() => requireOrigin(new Request('https://herbie.example', { headers: { origin: 'https://evil.example' } }), 'https://herbie.example'));
});
