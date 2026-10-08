import { createCipheriv, createDecipheriv, createHash, randomBytes } from 'node:crypto';
import type { Session } from '@herbie/contracts';
import type { Github } from './github.js';

export interface AuthFlow {
  stateHash:string; pollHash:string|null; browserHash:string|null;
  client:'web'|'cli'; expiresAt:Date; verifier:string;
}
export interface User {id:string;login:string}
export interface AuthStore {
  putFlow(flow:AuthFlow):Promise<void>;
  takeFlow(stateHash:string):Promise<AuthFlow|null>;
  completePoll(pollHash:string,encryptedToken:string,expiresAt:Date):Promise<void>;
  takePoll(pollHash:string):Promise<{status:'pending'|'expired'}|{status:'complete';encryptedToken:string}>;
  putCredential(user:User,encryptedToken:string,expiresAt:Date):Promise<void>;
  credential(userId:string):Promise<{encryptedToken:string;expiresAt:Date}|null>;
  createSession(session:{tokenHash:string;userId:string;expiresAt:Date;mode:'demo'|'live'}):Promise<void>;
  session(tokenHash:string):Promise<{user:User;expiresAt:Date;mode:'demo'|'live'}|null>;
  deleteSession(tokenHash:string):Promise<void>;
}
export interface AuthConfig {mode:'demo'|'live';publicUrl:string;credentialKey:string}
export class AuthError extends Error {constructor(readonly status:number,message:string){super(message);}}

const hash = (value:string)=>createHash('sha256').update(value).digest('hex');
const secret = ()=>randomBytes(32).toString('base64url');
export function createAuth(config:AuthConfig,store:AuthStore,github?:Github) {
  const key = Buffer.from(config.credentialKey,'base64');
  if (key.length!==32 || key.toString('base64')!==config.credentialKey) throw new Error('Credential key must be 32 bytes encoded as base64');
  const publicUrl = new URL(config.publicUrl);
  if (publicUrl.username || publicUrl.password || publicUrl.search || publicUrl.hash || publicUrl.pathname!=='/') throw new Error('Public URL must be an origin without credentials');
  if (config.mode==='live' && (publicUrl.protocol!=='https:' || !github)) throw new Error('Live auth requires GitHub App configuration and HTTPS');
  if (config.mode==='demo' && (!['127.0.0.1','localhost','[::1]'].includes(publicUrl.hostname) || !['http:','https:'].includes(publicUrl.protocol))) throw new Error('Demo authentication is restricted to loopback');
  function encrypt(value:string) {
    const iv = randomBytes(12);
    const cipher = createCipheriv('aes-256-gcm',key,iv);
    const encrypted = Buffer.concat([cipher.update(value,'utf8'),cipher.final()]);
    return [iv,cipher.getAuthTag(),encrypted].map(part=>part.toString('base64url')).join('.');
  }
  function decrypt(value:string) {
    const [iv,tag,encrypted,...extra] = value.split('.');
    if (!iv || !tag || !encrypted || extra.length) throw new Error('Invalid encrypted credential');
    const cipher = createDecipheriv('aes-256-gcm',key,Buffer.from(iv,'base64url'));
    cipher.setAuthTag(Buffer.from(tag,'base64url'));
    return Buffer.concat([cipher.update(Buffer.from(encrypted,'base64url')),cipher.final()]).toString('utf8');
  }
  async function issue(user:User,expiresAt:Date) {
    const token = secret();
    await store.createSession({tokenHash:hash(token),userId:user.id,expiresAt,mode:config.mode});
    return {token,session:{user,mode:config.mode}};
  }
  return {
    async start(client:'web'|'cli') {
      if (!github || config.mode!=='live') throw new AuthError(400,'GitHub login is available only in live mode');
      const state = secret();
      const verifier = secret();
      const pollToken = client==='cli' ? secret() : undefined;
      const browserState = client==='web' ? secret() : undefined;
      await store.putFlow({stateHash:hash(state),pollHash:pollToken ? hash(pollToken) : null,browserHash:browserState ? hash(browserState) : null,client,expiresAt:new Date(Date.now()+600_000),verifier});
      return {url:github.authorizationUrl(state,createHash('sha256').update(verifier).digest('base64url')),pollToken,browserState};
    },
    async callback(code:string,state:string,browserState?:string):Promise<{client:'web'|'cli';token?:string;session:Session}> {
      if (!github || config.mode!=='live' || !code || !state) throw new AuthError(400,'Invalid authorization callback');
      const flow = await store.takeFlow(hash(state));
      if (!flow || flow.expiresAt.getTime()<=Date.now()) throw new AuthError(400,'Authorization is expired or invalid; start login again');
      if (flow.client==='web' && (!browserState || hash(browserState)!==flow.browserHash)) throw new AuthError(400,'Authorization browser does not match; start login again');
      const authorized = await github.authenticate(code,flow.verifier);
      await store.putCredential(authorized.user,encrypt(authorized.token),authorized.expiresAt);
      const result = await issue(authorized.user,authorized.expiresAt);
      if (flow.client==='cli') {
        if (!flow.pollHash) throw new Error('Missing CLI authorization binding');
        await store.completePoll(flow.pollHash,encrypt(result.token),flow.expiresAt);
        return {client:'cli',session:result.session};
      }
      return {client:'web',...result};
    },
    async poll(token:string):Promise<{status:'pending'|'complete'|'expired';token?:string}> {
      if (!/^[\w-]{43}$/.test(token)) return {status:'expired'};
      const result = await store.takePoll(hash(token));
      return result.status==='complete' ? {status:'complete',token:decrypt(result.encryptedToken)} : result;
    },
    async session(token:string):Promise<Session|null> {
      if (!/^[\w-]{43}$/.test(token)) return null;
      const session = await store.session(hash(token));
      return session && session.mode===config.mode && session.expiresAt.getTime()>Date.now() ? {user:session.user,mode:config.mode} : null;
    },
    async logout(token:string) { await store.deleteSession(hash(token)); },
    async demoLogin() {
      if (config.mode!=='demo') throw new AuthError(400,'Demo authentication is disabled');
      const user = {id:'demo-user',login:'demo'};
      const expiresAt = new Date(Date.now()+28_800_000);
      await store.putCredential(user,encrypt('DEMO: no GitHub credential'),expiresAt);
      return issue(user,expiresAt);
    },
    async userToken(userId:string) {
      if (config.mode!=='live') throw new AuthError(400,'Demo has no GitHub credentials');
      const credential = await store.credential(userId);
      if (!credential || credential.expiresAt.getTime()<=Date.now()) throw new AuthError(401,'GitHub login expired; log in again before continuing');
      return decrypt(credential.encryptedToken);
    },
  };
}
export type Auth = ReturnType<typeof createAuth>;
