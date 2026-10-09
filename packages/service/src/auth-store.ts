import type { Pool } from 'pg';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import type { AuthFlow, AuthStore, CliDecision, PendingCli, User } from './auth.js';

export async function migrateAuth(pool:Pool) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SELECT pg_advisory_xact_lock(hashtext('herbie-auth-v1'))");
    await client.query(`
      CREATE TABLE IF NOT EXISTS auth_users (id text PRIMARY KEY, login text NOT NULL, encrypted_token text NOT NULL, expires_at timestamptz NOT NULL);
      CREATE TABLE IF NOT EXISTS auth_sessions (token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES auth_users(id), expires_at timestamptz NOT NULL);
      ALTER TABLE auth_sessions ADD COLUMN IF NOT EXISTS mode text NOT NULL DEFAULT 'unknown';
      CREATE TABLE IF NOT EXISTS auth_flows (state_hash text PRIMARY KEY, poll_hash text, browser_hash text, client text NOT NULL CHECK(client IN ('web','cli')), expires_at timestamptz NOT NULL, verifier text NOT NULL);
      ALTER TABLE auth_flows ADD COLUMN IF NOT EXISTS user_code_hash text;
      CREATE TABLE IF NOT EXISTS auth_polls (poll_hash text PRIMARY KEY, encrypted_token text, expires_at timestamptz NOT NULL);
      ALTER TABLE auth_polls ADD COLUMN IF NOT EXISTS rejected boolean NOT NULL DEFAULT false;
      ALTER TABLE auth_polls ADD COLUMN IF NOT EXISTS consent_version integer NOT NULL DEFAULT 0;
      CREATE TABLE IF NOT EXISTS auth_pending_cli (
        approval_hash text PRIMARY KEY, poll_hash text UNIQUE NOT NULL, user_code_hash text NOT NULL,
        csrf_token text NOT NULL, user_id text NOT NULL, login text NOT NULL, encrypted_credential text NOT NULL,
        credential_expires_at timestamptz NOT NULL, expires_at timestamptz NOT NULL
      );
      CREATE INDEX IF NOT EXISTS auth_sessions_expiry ON auth_sessions(expires_at);
      CREATE INDEX IF NOT EXISTS auth_flows_expiry ON auth_flows(expires_at);
      CREATE INDEX IF NOT EXISTS auth_polls_expiry ON auth_polls(expires_at);
      CREATE INDEX IF NOT EXISTS auth_pending_cli_expiry ON auth_pending_cli(expires_at);
    `);
    await client.query('COMMIT');
  } catch(error) {try{await client.query('ROLLBACK');}catch{/* Preserve the migration failure. */}throw error;} finally {client.release();}
}
const flowSchema = z.object({state_hash:z.string(),poll_hash:z.string().nullable(),browser_hash:z.string().nullable(),user_code_hash:z.string().nullable(),client:z.enum(['web','cli']),expires_at:z.date(),verifier:z.string()});
const pendingSchema = z.object({approval_hash:z.string(),poll_hash:z.string(),user_code_hash:z.string(),csrf_token:z.string(),
  user_id:z.string(),login:z.string(),encrypted_credential:z.string(),credential_expires_at:z.date(),expires_at:z.date()});
function pendingFromRow(value:unknown):PendingCli {
  const row = pendingSchema.parse(value);
  return {approvalHash:row.approval_hash,pollHash:row.poll_hash,userCodeHash:row.user_code_hash,csrfToken:row.csrf_token,
    user:{id:row.user_id,login:row.login},encryptedCredential:row.encrypted_credential,credentialExpiresAt:row.credential_expires_at,expiresAt:row.expires_at};
}
function equalSecret(left:string,right:string) {
  const a=Buffer.from(left), b=Buffer.from(right);
  return a.length===b.length && timingSafeEqual(a,b);
}

export class PgAuthStore implements AuthStore {
  constructor(private readonly pool:Pool) {}
  async putFlow(flow:AuthFlow) {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query('DELETE FROM auth_flows WHERE expires_at <= now()');
      await client.query('DELETE FROM auth_polls WHERE expires_at <= now()');
      await client.query('DELETE FROM auth_sessions WHERE expires_at <= now()');
      await client.query('DELETE FROM auth_pending_cli WHERE expires_at <= now()');
      await client.query('INSERT INTO auth_flows(state_hash,poll_hash,browser_hash,client,expires_at,verifier,user_code_hash) VALUES($1,$2,$3,$4,$5,$6,$7)',[flow.stateHash,flow.pollHash,flow.browserHash,flow.client,flow.expiresAt,flow.verifier,flow.userCodeHash]);
      if(flow.pollHash) await client.query('INSERT INTO auth_polls(poll_hash,expires_at,consent_version) VALUES($1,$2,1)',[flow.pollHash,flow.expiresAt]);
      await client.query('COMMIT');
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async takeFlow(stateHash:string):Promise<AuthFlow|null> {
    const result = await this.pool.query('DELETE FROM auth_flows WHERE state_hash=$1 RETURNING *',[stateHash]);
    if (!result.rows.length) return null;
    const row = flowSchema.parse(result.rows[0]);
    return {stateHash:row.state_hash,pollHash:row.poll_hash,browserHash:row.browser_hash,userCodeHash:row.user_code_hash,client:row.client,expiresAt:row.expires_at,verifier:row.verifier};
  }
  async putPendingCli(pending:PendingCli) {
    await this.pool.query(`INSERT INTO auth_pending_cli(approval_hash,poll_hash,user_code_hash,csrf_token,user_id,login,encrypted_credential,credential_expires_at,expires_at)
      VALUES($1,$2,$3,$4,$5,$6,$7,$8,$9)`,[pending.approvalHash,pending.pollHash,pending.userCodeHash,pending.csrfToken,pending.user.id,pending.user.login,pending.encryptedCredential,pending.credentialExpiresAt,pending.expiresAt]);
  }
  async pendingCli(approvalHash:string):Promise<PendingCli|null> {
    const result = await this.pool.query('SELECT * FROM auth_pending_cli WHERE approval_hash=$1 AND expires_at>now()',[approvalHash]);
    return result.rows.length ? pendingFromRow(result.rows[0]) : null;
  }
  async decideCli(decision:CliDecision):Promise<'approved'|'rejected'|'invalid'|'expired'> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT * FROM auth_pending_cli WHERE approval_hash=$1 FOR UPDATE',[decision.approvalHash]);
      const pending = result.rows.length ? pendingFromRow(result.rows[0]) : null;
      if (!pending) {await client.query('COMMIT');return 'invalid';}
      const polls = await client.query('SELECT expires_at,rejected,encrypted_token,consent_version FROM auth_polls WHERE poll_hash=$1 FOR UPDATE',[pending.pollHash]);
      const poll = polls.rows.length ? z.object({expires_at:z.date(),rejected:z.boolean(),encrypted_token:z.string().nullable(),consent_version:z.number()}).parse(polls.rows[0]) : null;
      if (!poll || poll.consent_version!==1 || poll.rejected || poll.encrypted_token || poll.expires_at.getTime()<=Date.now() || pending.expiresAt.getTime()<=Date.now() || pending.credentialExpiresAt.getTime()<=Date.now()) {
        await client.query('DELETE FROM auth_pending_cli WHERE approval_hash=$1',[decision.approvalHash]);
        await client.query('COMMIT');return 'expired';
      }
      if (!equalSecret(decision.csrfToken,pending.csrfToken)) {await client.query('COMMIT');return 'invalid';}
      // Consume exactly once under the row lock. A wrong code invalidates this browser grant.
      await client.query('DELETE FROM auth_pending_cli WHERE approval_hash=$1',[decision.approvalHash]);
      if (decision.decision==='reject' || !decision.userCodeHash || !equalSecret(decision.userCodeHash,pending.userCodeHash)) {
        await client.query('UPDATE auth_polls SET rejected=true WHERE poll_hash=$1',[pending.pollHash]);
        await client.query('COMMIT');return 'rejected';
      }
      await client.query('INSERT INTO auth_users(id,login,encrypted_token,expires_at) VALUES($1,$2,$3,$4) ON CONFLICT(id) DO UPDATE SET login=EXCLUDED.login,encrypted_token=EXCLUDED.encrypted_token,expires_at=EXCLUDED.expires_at',
        [pending.user.id,pending.user.login,pending.encryptedCredential,pending.credentialExpiresAt]);
      await client.query("INSERT INTO auth_sessions(token_hash,user_id,expires_at,mode) VALUES($1,$2,$3,'live')",[decision.session.tokenHash,pending.user.id,pending.credentialExpiresAt]);
      await client.query('UPDATE auth_polls SET encrypted_token=$2 WHERE poll_hash=$1',[pending.pollHash,decision.session.encryptedToken]);
      await client.query('COMMIT');return 'approved';
    } catch(error) {await client.query('ROLLBACK');throw error;} finally {client.release();}
  }
  async takePoll(pollHash:string):Promise<{status:'pending'|'expired'|'rejected'}|{status:'complete';encryptedToken:string}> {
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      const result = await client.query('SELECT encrypted_token,expires_at,rejected,consent_version FROM auth_polls WHERE poll_hash=$1 FOR UPDATE',[pollHash]);
      const row = result.rows.length ? z.object({encrypted_token:z.string().nullable(),expires_at:z.date(),rejected:z.boolean(),consent_version:z.number()}).parse(result.rows[0]) : null;
      if (!row || row.consent_version!==1 || row.expires_at.getTime()<=Date.now()) {
        await client.query('DELETE FROM auth_polls WHERE poll_hash=$1',[pollHash]);
        await client.query('COMMIT');
        return {status:'expired'};
      }
      if (row.rejected) {await client.query('COMMIT');return {status:'rejected'};}
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
  async createSession(session:{tokenHash:string;userId:string;expiresAt:Date;mode:'demo'|'live'}) {
    await this.pool.query('INSERT INTO auth_sessions(token_hash,user_id,expires_at,mode) VALUES($1,$2,$3,$4)',[session.tokenHash,session.userId,session.expiresAt,session.mode]);
  }
  async session(tokenHash:string) {
    const result = await this.pool.query("SELECT u.id,u.login,s.expires_at,s.mode FROM auth_sessions s JOIN auth_users u ON u.id=s.user_id WHERE s.token_hash=$1 AND s.expires_at>now() AND s.mode IN ('demo','live')",[tokenHash]);
    if (!result.rows.length) return null;
    const row = z.object({id:z.string(),login:z.string(),expires_at:z.date(),mode:z.enum(['demo','live'])}).parse(result.rows[0]);
    return {user:{id:row.id,login:row.login},expiresAt:row.expires_at,mode:row.mode};
  }
  async deleteSession(tokenHash:string) {await this.pool.query('DELETE FROM auth_sessions WHERE token_hash=$1',[tokenHash]);}
}
