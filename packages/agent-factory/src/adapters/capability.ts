import { SignJWT, jwtVerify } from 'jose';
export async function runToken(secret: string, goal: string, run: string, attempt: number) {
  if (secret.length < 32) throw new Error('RUN_TOKEN_SECRET must contain at least 32 characters');
  return new SignJWT({ goal, run, attempt }).setProtectedHeader({ alg: 'HS256' }).setAudience('herbie-run')
    .setIssuedAt().setExpirationTime('35m').sign(new TextEncoder().encode(secret));
}
export async function verifyRunToken(secret: string, token: string) {
  const { payload } = await jwtVerify(token, new TextEncoder().encode(secret), { audience: 'herbie-run', algorithms: ['HS256'] });
  if (typeof payload.goal !== 'string' || typeof payload.run !== 'string' || !Number.isInteger(payload.attempt)) throw new Error('Invalid capability');
  return { goal: payload.goal, run: payload.run, attempt: payload.attempt as number };
}
