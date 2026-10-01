import { randomBytes, randomUUID, createHash } from 'node:crypto';
import { mkdir, readFile, writeFile, rename, chmod } from 'node:fs/promises';
import { join } from 'node:path';
import { createRemoteJWKSet, jwtVerify } from 'jose';

const issuer = 'https://auth.openai.com';
const resource = 'https://api.openai.com/v1';
const permission = 'chatgpt.tokens.use.direct';
const random = () => randomBytes(32).toString('base64url');
type Tokens = { access_token: string; refresh_token?: string; id_token?: string; scope?: string; expires_in: number; token_type: string };
type Account = { client_id: string; subject: string; email: string; tokens?: Tokens; expires_at?: number; welcomed?: boolean };
type Store = { host: string; accounts: Account[]; active?: string };
type Attempt = { state: string; nonce: string; verifier: string; client?: string; expires: number };

export class Auth {
  private store!: Store;
  private pending?: Attempt;
  private jwks = createRemoteJWKSet(new URL(`${issuer}/.well-known/jwks.json`));
  constructor(private directory: string, private callback: string) {}

  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
    await chmod(this.directory, 0o700);
    try {
      this.store = JSON.parse(await readFile(join(this.directory, 'credentials.json'), 'utf8'));
      await chmod(join(this.directory, 'credentials.json'), 0o600);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      this.store = { host: `urn:uuid:${randomUUID()}`, accounts: [] };
      await this.save();
    }
  }
  private async save() {
    const path = join(this.directory, 'credentials.json');
    const temporary = `${path}.${randomUUID()}.tmp`;
    await writeFile(temporary, JSON.stringify(this.store), { mode: 0o600, flag: 'wx' });
    await rename(temporary, path);
  }
  private get account() { return this.store.accounts.find(a => a.client_id === this.store.active); }
  status() {
    const account = this.account;
    return {
      accounts: this.store.accounts.map(a => ({ id: a.client_id, label: `${a.email} · ${a.client_id.slice(-8)}` })),
      active: account?.client_id,
      signedIn: Boolean(account?.tokens),
      enabled: Boolean(account?.tokens?.scope?.split(' ').includes(permission)),
      welcome: Boolean(account?.tokens && !account.welcomed),
    };
  }
  begin(client?: string) {
    const account = client ? this.store.accounts.find(a => a.client_id === client) : undefined;
    if (client && !account) throw new Error('Unknown saved account.');
    const attempt = { state: random(), nonce: random(), verifier: random(), client, expires: Date.now() + 600_000 };
    this.pending = attempt;
    const params = new URLSearchParams({
      client_id: client || 'dynamic_agent_client', ext_agent_host_id: this.store.host,
      response_type: 'code', redirect_uri: this.callback,
      scope: `openid profile email offline_access resource.invoke ${permission}`,
      resource, state: attempt.state, nonce: attempt.nonce,
      code_challenge_method: 'S256', code_challenge: createHash('sha256').update(attempt.verifier).digest('base64url'),
    });
    if (!client) params.set('agent_name_hint', 'Herbie');
    if (account?.tokens?.id_token) params.set('id_token_hint', account.tokens.id_token);
    return `${issuer}/api/accounts/authorize?${params}`;
  }
  async complete(params: URLSearchParams) {
    const attempt = this.pending;
    if (!attempt || params.get('state') !== attempt.state || Date.now() > attempt.expires) throw new Error('Sign-in expired or state did not match. Please try again.');
    this.pending = undefined;
    if (params.has('error')) throw new Error('Sign-in was declined. Please try again when ready.');
    const client = params.get('client_id') || attempt.client;
    if (!client || client === 'dynamic_agent_client' || (attempt.client && client !== attempt.client)) throw new Error('Sign-in returned an invalid client registration.');
    const code = params.get('code');
    if (!code) throw new Error('Sign-in did not return an authorization code.');
    const tokens = await this.exchange({ grant_type: 'authorization_code', client_id: client, code, code_verifier: attempt.verifier, redirect_uri: this.callback });
    if (!tokens.id_token) throw new Error('Sign-in did not return an identity token.');
    const { payload } = await jwtVerify(tokens.id_token, this.jwks, { issuer, audience: client, requiredClaims: ['sub', 'exp', 'iat', 'nonce'] });
    if (payload.nonce !== attempt.nonce) throw new Error('Sign-in identity nonce did not match.');
    let account = this.store.accounts.find(a => a.client_id === client);
    if (account && account.subject !== payload.sub) throw new Error('Sign-in returned a different account.');
    if (!account) {
      account = { client_id: client, subject: payload.sub!, email: typeof payload.email === 'string' ? payload.email : 'ChatGPT account' };
      this.store.accounts.push(account);
    }
    account.tokens = tokens;
    account.expires_at = Date.now() + tokens.expires_in * 1000;
    this.store.active = client;
    await this.save();
  }
  private async exchange(fields: Record<string, string>): Promise<Tokens> {
    const response = await fetch(`${issuer}/api/accounts/oauth/token`, { method: 'POST', body: new URLSearchParams({ ...fields, resource }), signal: AbortSignal.timeout(30_000) });
    if (!response.ok) throw new Error('ChatGPT authorization failed. Please sign in again.');
    const tokens = await response.json() as Tokens;
    if (!tokens.access_token || !Number.isFinite(tokens.expires_in) || tokens.expires_in <= 0 || tokens.token_type?.toLowerCase() !== 'bearer') throw new Error('ChatGPT returned invalid credentials.');
    return tokens;
  }
  async accessToken() {
    const account = this.account;
    if (!account?.tokens) throw new Error('Please sign in with ChatGPT.');
    if ((account.expires_at || 0) < Date.now() + 60_000) {
      if (!account.tokens.refresh_token) throw new Error('Session expired. Please sign in again.');
      const tokens = await this.exchange({ grant_type: 'refresh_token', client_id: account.client_id, refresh_token: account.tokens.refresh_token });
      account.tokens = { ...account.tokens, ...tokens };
      account.expires_at = Date.now() + tokens.expires_in * 1000;
      await this.save();
    }
    if (!account.tokens.scope?.split(' ').includes(permission)) throw new Error('ChatGPT plan usage is not enabled. Sign in again and grant plan access.');
    return account.tokens.access_token;
  }
  async welcome() {
    if (this.account) { this.account.welcomed = true; await this.save(); }
  }
  async logout() {
    const account = this.account;
    this.pending = undefined;
    let revoked = !account?.tokens;
    if (account?.tokens?.refresh_token) {
      try {
        const discovery = await fetch(`${issuer}/.well-known/openid-configuration`, { signal: AbortSignal.timeout(10_000) });
        const { revocation_endpoint } = await discovery.json() as { revocation_endpoint: string };
        if (new URL(revocation_endpoint).origin !== issuer) throw new Error('Unexpected issuer');
        for (let retry = 0; retry < 2; retry++) {
          const result = await fetch(revocation_endpoint, { method: 'POST', body: new URLSearchParams({ token: account.tokens.refresh_token, token_type_hint: 'refresh_token', client_id: account.client_id }), signal: AbortSignal.timeout(10_000) });
          revoked = result.ok;
          if (revoked || result.status < 500) break;
          await new Promise(resolve => setTimeout(resolve, 500));
        }
      } catch { /* Local sign-out still clears credentials. */ }
    }
    if (account) { delete account.tokens; delete account.expires_at; }
    delete this.store.active;
    await this.save();
    return revoked ? 'Signed out.' : 'Signed out locally. Remote revocation could not be confirmed; disconnect Herbie in ChatGPT settings.';
  }
}
