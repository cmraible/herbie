import type { Pool } from 'pg';
import { z } from 'zod';
import type { AuthFlow, AuthStore, User } from './auth.js';

export async function migrateAuth(pool:Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('herbie-auth-v1'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_users (id text PRIMARY KEY, login text NOT NULL, encrypted_token text NOT NULL, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES auth_users(id), expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_flows (state_hash text PRIMARY KEY, poll_hash text, browser_hash text, client text NOT NULL CHECK(client IN ('web','cli')), expires_at timestamptz NOT NULL, verifier text NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_polls (poll_hash text PRIMARY KEY, encrypted_token text, expires_at timestamptz NOT NULL);
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_flows_expiry ON auth_flows(expires_at);
      CREATE INDEX IF NOT EXISTS auth_polls_expiry ON auth_polls(expires_at);
    `);
    await client.query('COMMIT');
  } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
}
const flowSchema = z.object({state_hash:z.string(),poll_hash:z.string().nullable(),browser_hash:z.string().nullable(),client:z.enum(['web','cli']),expires_at:z.date(),verifier:z.string()});

export class PgAuthStore implements AuthStore {
  constructor(private readonly pool:Pool) {}
  async putFlow(flow:AuthFlow) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM auth_flows WHERE expires_at <= now()');
      await client.query('DELETE FROM auth_polls WHERE expires_at <= now()');
      await client.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      await client.query('INSERT INTO auth_flows(state_hash,poll_hash,browser_hash,client,expires_at,verifier) VALUES($1,$2,$3,$4,$5,$6)',[flow.stateHash,flow.pollHash,flow.browserHash,flow.client,flow.expiresAt,flow.verifier]);
      if(flow.pollHash) await client.query('INSERT INTO auth_polls(poll_hash,expires_at) VALUES($1,$2)',[flow.pollHash,flow.expiresAt]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async takeFlow(stateHash:string):Promise<AuthFlow|null> {
    const result = await this.pool.query('DELETE FROM auth_flows WHERE state_hash=$1 RETURNING *',[stateHash]);
    if (!result.rows.length) return null;
    const row = flowSchema.parse(result.rows[0]);
    return {stateHash:row.state_hash,pollHash:row.poll_hash,browserHash:row.browser_hash,client:row.client,expiresAt:row.expires_at,verifier:row.verifier};
  }
  async completePoll(pollHash:string,encryptedToken:string,expiresAt:Date) {
    await this.pool.query('UPDATE auth_polls SET encrypted_token=$2,expires_at=$3 WHERE poll_hash=$1 AND expires_at>now()',[pollHash,encryptedToken,expiresAt]);
  }
  async takePoll(pollHash:string):Promise<{status:'pending'|'expired'}|{status:'complete';encryptedToken:string}> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT encrypted_token,expires_at FROM auth_polls WHERE poll_hash=$1 FOR UPDATE',[pollHash]);
      const row = result.rows.length ? z.object({encrypted_token:z.string().nullable(),expires_at:z.date()}).parse(result.rows[0]) : null;
      if (!row || row.expires_at.getTime()<=Date.now()) {
        await client.query('DELETE FROM auth_polls WHERE poll_hash=$1',[pollHash]);
        await client.query('COMMIT');
        return {status:'expired'};
      }
      if (row.encrypted_token) await client.query('DELETE FROM auth_polls WHERE poll_hash=$1',[pollHash]);
      await client.query('COMMIT');
      return row.encrypted_token ? {status:'complete',encryptedToken:row.encrypted_token} : {status:'pending'};
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async putCredential(user:User,encryptedToken:string,expiresAt:Date) {
    await this.pool.query('INSERT INTO auth_users(id,login,encrypted_token,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET login=EXCLUDED.login, encrypted_token=EXCLUDED.encrypted_token, expires_at=EXCLUDED.expires_at',[user.id,user.login,encryptedToken,expiresAt]);
  }
  async credential(userId:string) {
    const result = await this.pool.query('SELECT encrypted_token,expires_at FROM auth_users WHERE id=$1',[userId]);
    if (!result.rows.length) return null;
    const row = z.object({encrypted_token:z.string(),expires_at:z.date()}).parse(result.rows[0]);
    return {encryptedToken:row.encrypted_token,expiresAt:row.expires_at};
  }
  async createSession(session:{tokenHash:string;userId:string;expiresAt:Date}) {
    await this.pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at) VALUES($1,$2,$3)',[session.tokenHash,session.userId,session.expiresAt]);
  }
  async session(tokenHash:string) {
    const result = await this.pool.query('SELECT u.id,u.login,s.expires_at FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now()',[tokenHash]);
    if (!result.rows.length) return null;
    const row = z.object({id:z.string(),login:z.string(),expires_at:z.date()}).parse(result.rows[0]);
    return {user:{id:row.id,login:row.login},expiresAt:row.expires_at};
  }
  async deleteSession(tokenHash:string) {await this.pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[tokenHash]);}
}
