import { betterAuth, type BetterAuthOptions } from 'better-auth';
import { magicLink } from 'better-auth/plugins/magic-link';
import type { LoginEmail } from '../core/email.js';
import { admitted, emailDomain } from '../core/email.js';
import { Access, hash, HttpError } from './auth.js';
export interface LoginConfig { DB:D1Database; APP_ORIGIN:string; BETTER_AUTH_SECRET:string; ALLOWED_EMAIL_DOMAINS:string }
export function loginOptions(env:LoginConfig,sender:LoginEmail):BetterAuthOptions {
  if(!env.BETTER_AUTH_SECRET || env.BETTER_AUTH_SECRET.length<32) throw new HttpError(503,'Sign-in is not configured');
  return {
    database:env.DB,baseURL:env.APP_ORIGIN,basePath:'/api/auth',secret:env.BETTER_AUTH_SECRET,
    trustedOrigins:[env.APP_ORIGIN],logger:{disabled:true},
    advanced:{useSecureCookies:true,ipAddress:{ipAddressHeaders:['cf-connecting-ip']},defaultCookieAttributes:{httpOnly:true,secure:true,sameSite:'lax'}},
    session:{expiresIn:8*3600,updateAge:3600,cookieCache:{enabled:false}},
    rateLimit:{enabled:true,storage:'database',window:60,max:30},
    emailAndPassword:{enabled:false},
    plugins:[magicLink({expiresIn:300,storeToken:'hashed',sendMagicLink:async({email,url})=>{
      // Identical success response for unadmitted addresses; never send a login link.
      if(admitted(email,env.ALLOWED_EMAIL_DOMAINS)) await sender.send(email,url);
    }})],
  };
}
export function login(env:LoginConfig,sender:LoginEmail) {return betterAuth(loginOptions(env,sender));}
export async function requireLogin(auth:ReturnType<typeof login>,req:Request,env:LoginConfig) {
  const session=await auth.api.getSession({headers:req.headers});
  if(!session?.user.emailVerified) throw new HttpError(401,'Sign in required');
  if(!admitted(session.user.email,env.ALLOWED_EMAIL_DOMAINS)) throw new HttpError(403,'Your company is not enabled for this private release');
  const identity={sub:'ba:'+session.user.id,domain:emailDomain(session.user.email),email:session.user.email,name:session.user.name};
  await new Access(env.DB).signIn(identity);
  const binding=await hash(session.session.id);
  // Only a valid Better Auth session can refresh this binding. It is never an auth credential.
  await env.DB.prepare('INSERT INTO sessions(token_hash,sub,expires) VALUES(?,?,?) ON CONFLICT(token_hash) DO UPDATE SET expires=excluded.expires').bind(binding,identity.sub,session.session.expiresAt.getTime()).run();
  return {sub:identity.sub,binding};
}
