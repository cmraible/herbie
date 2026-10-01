// Offline schema generation against an empty local D1. Never runs remote migrations.
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { getMigrations } from 'better-auth/db/migration';
import { writeFile } from 'node:fs/promises';
import { loginOptions } from '../src/adapters/login.js';
const mf=new Miniflare(convertV4MiniflareOptions({modules:true,script:'export default {fetch(){return new Response()}}',d1Databases:{DB:'schema'}}));
try {
  const DB=await mf.getD1Database('DB');
  const migrations=await getMigrations(loginOptions({DB,APP_ORIGIN:'https://schema.test',BETTER_AUTH_SECRET:'schema-only-secret-with-at-least-32-characters',ALLOWED_EMAIL_DOMAINS:''},{async send(){throw new Error('Schema generation cannot send email');}}));
  await writeFile('migrations/0003_better_auth.sql','-- Generated with Better Auth 1.7.7; apply through reviewed D1 migrations.\n'+await migrations.compileMigrations());
} finally {await mf.dispose();}
