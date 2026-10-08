import {readFile} from 'node:fs/promises';
import {z} from 'zod';
import type {GithubConfig} from './github.js';

export async function readConfig(environment:NodeJS.ProcessEnv=process.env){
  const mode=z.enum(['demo','live']).parse(environment.HERBIE_MODE??'demo');
  const executionEnabled=z.enum(['true','false']).parse(environment.HERBIE_EXECUTION_ENABLED??(mode==='demo'?'true':'false'))==='true';
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
    if(environment.GITHUB_PRIVATE_KEY&&environment.GITHUB_PRIVATE_KEY_FILE)throw new Error('Set only one GitHub private key source');
    const privateKey=environment.GITHUB_PRIVATE_KEY?.trim()||await readFile(required('GITHUB_PRIVATE_KEY_FILE'),'utf8');
    github={appId:required('GITHUB_APP_ID'),clientId:required('GITHUB_CLIENT_ID'),clientSecret:required('GITHUB_CLIENT_SECRET'),
      privateKey,callbackUrl:`${origin.origin}/api/auth/callback`,webhookSecret:required('GITHUB_WEBHOOK_SECRET')};
  }
  return {mode,host,port,publicUrl:origin.origin,databaseUrl,credentialKey,github,executionEnabled,
    deploymentId:z.string().regex(/^[a-zA-Z0-9-]{1,128}$/).optional().parse(environment.HERBIE_DEPLOYMENT_ID),
    imageRevision:z.string().regex(/^[a-zA-Z0-9-]{1,128}$/).optional().parse(environment.HERBIE_IMAGE_REVISION),
    databaseCa:environment.HERBIE_DATABASE_CA,databaseCaFile:environment.HERBIE_DATABASE_CA_FILE};
}
