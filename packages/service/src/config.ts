import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {GithubConfig} from './github.js';

export async function readConfig(environment:NodeJS.ProcessEnv=process.env){
  const mode=z.enum(['demo','live']).parse(environment.HERBIE_MODE??'demo');
  const host=environment.HERBIE_HOST??'127.0.0.1';
  const port=z.coerce.number().int().min(1).max(65535).parse(environment.HERBIE_PORT??8787);
  const publicUrl=environment.HERBIE_PUBLIC_URL??`http://127.0.0.1:${port}`;
  const origin=new URL(publicUrl);
  if(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash)throw new Error('HERBIE_PUBLIC_URL must be an origin');
  if(mode==='demo'&&(!['localhost','127.0.0.1','::1'].includes(host)||!['localhost','127.0.0.1','[::1]'].includes(origin.hostname)))throw new Error('Demo mode must bind to loopback');
  function required(name:string){return z.string().min(1,`${name} is required`).parse(environment[name]);}
  const databaseUrl=required('DATABASE_URL');
  const credentialKey=mode==='live'?required('HERBIE_CREDENTIAL_KEY'):Buffer.alloc(32,7).toString('base64');
  let github:GithubConfig|undefined;
  if(mode==='live'){
    if(origin.protocol!=='https:')throw new Error('Live mode requires an HTTPS public URL');
    github={appId:required('GITHUB_APP_ID'),clientId:required('GITHUB_CLIENT_ID'),clientSecret:required('GITHUB_CLIENT_SECRET'),
      privateKey:await readFile(required('GITHUB_PRIVATE_KEY_FILE'),'utf8'),callbackUrl:`${origin.origin}/api/auth/callback`,webhookSecret:required('GITHUB_WEBHOOK_SECRET')};
  }
  return {mode,host,port,publicUrl:origin.origin,databaseUrl,credentialKey,github};
}
