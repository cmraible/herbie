import {createPrivateKey} from 'node:crypto';
import {readFile} from 'node:fs/promises';
import {z} from 'zod';

const text=z.string().trim().min(1,'Must not be empty');
const privateKeySchema=text.refine(value=>{try{return createPrivateKey(value).asymmetricKeyType==='rsa';}catch{return false;}},'Must be a PEM-encoded RSA private key');
const revision=z.string().regex(/^[a-zA-Z0-9-]{1,128}$/,'Use 1–128 letters, numbers, or hyphens');
const httpUrl=z.string().refine(value=>{try{return ['http:','https:'].includes(new URL(value).protocol);}catch{return false;}},'Must be an HTTP or HTTPS URL');

export const environmentSchema=z.object({
  NODE_ENV:z.enum(['development','test','production']).default('development'),
  HERBIE_MODE:z.enum(['demo','live']).default('demo'),
  HERBIE_EXECUTION_ENABLED:z.enum(['true','false']).optional(),
  HERBIE_HOST:text.default('127.0.0.1'),
  HERBIE_PORT:z.coerce.number().int().min(1).max(65535).default(8787),
  HERBIE_PUBLIC_URL:httpUrl.optional(),
  DATABASE_URL:z.string().refine(value=>{
    try{const url=new URL(value);return ['postgres:','postgresql:'].includes(url.protocol)&&!!url.hostname&&!!url.username&&!!url.pathname.slice(1)&&!url.hash;}
    catch{return false;}
  },'Must be a PostgreSQL URL with a host, user, and database').prefault(''),
  HERBIE_ALLOWED_GITHUB_USER_ID:z.string().regex(/^[1-9][0-9]*$/,'Must be a positive numeric GitHub account ID').refine(value=>value.trim()===value,'Must not contain whitespace').optional(),
  HERBIE_CREDENTIAL_KEY:z.string().refine(value=>{const key=Buffer.from(value,'base64');return key.length===32&&key.toString('base64')===value;},'Must be exactly 32 bytes encoded as base64').optional(),
  GITHUB_APP_ID:text.optional(),GITHUB_CLIENT_ID:text.optional(),GITHUB_CLIENT_SECRET:text.optional(),
  GITHUB_PRIVATE_KEY:privateKeySchema.optional(),GITHUB_PRIVATE_KEY_FILE:text.optional(),GITHUB_WEBHOOK_SECRET:text.optional(),
  HERBIE_DATABASE_CA:text.optional(),HERBIE_DATABASE_CA_FILE:text.optional(),
  DAYTONA_API_KEY:text.optional(),DAYTONA_API_URL:httpUrl.refine(value=>{
    try{const url=new URL(value);return url.protocol==='https:'&&!url.username&&!url.password&&!url.search&&!url.hash;}catch{return false;}
  },'Must use HTTPS without credentials, a query, or a fragment').optional(),
  HERBIE_DAYTONA_OPENAI_SECRET:text.optional(),HERBIE_DAYTONA_SNAPSHOT:text.optional(),
  OPENAI_API_KEY:text.optional(),HERBIE_GOAL_NAME_MODEL:text.optional(),
  HERBIE_DEPLOYMENT_ID:revision.optional(),HERBIE_IMAGE_REVISION:revision.optional(),
}).superRefine((env,ctx)=>{
  const issue=(name:string,message:string)=>ctx.addIssue({code:'custom',path:[name],message});
  const origin=URL.canParse(env.HERBIE_PUBLIC_URL??'')?new URL(env.HERBIE_PUBLIC_URL!):undefined;
  if(origin&&(origin.username||origin.password||origin.pathname!=='/'||origin.search||origin.hash))issue('HERBIE_PUBLIC_URL','Must be an origin without credentials, a path, query, or fragment');
  if(env.HERBIE_MODE==='demo'){
    if(!['localhost','127.0.0.1','::1'].includes(env.HERBIE_HOST))issue('HERBIE_HOST','Demo mode requires a loopback host');
    if(origin&&!['localhost','127.0.0.1','[::1]'].includes(origin.hostname))issue('HERBIE_PUBLIC_URL','Demo mode requires a loopback origin');
  }else{
    if(origin?.protocol!=='https:')issue('HERBIE_PUBLIC_URL','Live mode requires an HTTPS origin');
    for(const name of ['HERBIE_ALLOWED_GITHUB_USER_ID','HERBIE_CREDENTIAL_KEY','GITHUB_APP_ID','GITHUB_CLIENT_ID','GITHUB_CLIENT_SECRET','GITHUB_WEBHOOK_SECRET','OPENAI_API_KEY'] as const){
      if(!env[name])issue(name,'Required in live mode');
    }
    if(!env.GITHUB_PRIVATE_KEY&&!env.GITHUB_PRIVATE_KEY_FILE)issue('GITHUB_PRIVATE_KEY','Set GITHUB_PRIVATE_KEY or GITHUB_PRIVATE_KEY_FILE in live mode');
    if(env.HERBIE_EXECUTION_ENABLED==='true'){
      for(const name of ['DAYTONA_API_KEY','HERBIE_DAYTONA_OPENAI_SECRET'] as const)if(!env[name])issue(name,'Required when live execution is enabled');
    }
  }
  if(env.GITHUB_PRIVATE_KEY&&env.GITHUB_PRIVATE_KEY_FILE)issue('GITHUB_PRIVATE_KEY_FILE','Set only one GitHub private key source');
  if(env.HERBIE_DATABASE_CA&&env.HERBIE_DATABASE_CA_FILE)issue('HERBIE_DATABASE_CA_FILE','Set only one database CA source');
});

export class ConfigurationError extends Error {
  constructor(readonly issues:{variable:string;message:string}[]){
    super(`Invalid environment configuration:\n${issues.map(issue=>`${issue.variable}: ${issue.message}`).join('\n')}`);
  }
}

export async function readConfig(environment:NodeJS.ProcessEnv=process.env){
  const result=environmentSchema.safeParse(environment);
  if(!result.success)throw new ConfigurationError(result.error.issues.map(issue=>({variable:String(issue.path[0]),message:issue.message})));
  const env=result.data;
  const mode=env.HERBIE_MODE;
  const publicUrl=new URL(env.HERBIE_PUBLIC_URL??`http://127.0.0.1:${env.HERBIE_PORT}`).origin;
  let privateKey=env.GITHUB_PRIVATE_KEY;
  if(mode==='live'&&env.GITHUB_PRIVATE_KEY_FILE){
    try{privateKey=await readFile(env.GITHUB_PRIVATE_KEY_FILE,'utf8');}
    catch{throw new ConfigurationError([{variable:'GITHUB_PRIVATE_KEY_FILE',message:'Could not read the private key file; check its path and permissions'}]);}
    const parsedKey=privateKeySchema.safeParse(privateKey);
    if(!parsedKey.success)throw new ConfigurationError([{variable:'GITHUB_PRIVATE_KEY_FILE',message:'File must contain a PEM-encoded RSA private key'}]);
    privateKey=parsedKey.data;
  }
  return {mode,host:env.HERBIE_HOST,port:env.HERBIE_PORT,publicUrl,databaseUrl:env.DATABASE_URL,
    credentialKey:mode==='live'?env.HERBIE_CREDENTIAL_KEY!:Buffer.alloc(32,7).toString('base64'),
    github:mode==='live'?{appId:env.GITHUB_APP_ID!,clientId:env.GITHUB_CLIENT_ID!,clientSecret:env.GITHUB_CLIENT_SECRET!,privateKey:privateKey!,callbackUrl:`${publicUrl}/api/auth/callback`,webhookSecret:env.GITHUB_WEBHOOK_SECRET!}:undefined,
    executionEnabled:env.HERBIE_EXECUTION_ENABLED?env.HERBIE_EXECUTION_ENABLED==='true':mode==='demo',
    allowedGithubUserId:mode==='live'?env.HERBIE_ALLOWED_GITHUB_USER_ID:undefined,
    deploymentId:env.HERBIE_DEPLOYMENT_ID,imageRevision:env.HERBIE_IMAGE_REVISION,
    databaseCa:env.HERBIE_DATABASE_CA,databaseCaFile:env.HERBIE_DATABASE_CA_FILE,
    openaiApiKey:mode==='live'?env.OPENAI_API_KEY:undefined,goalNameModel:env.HERBIE_GOAL_NAME_MODEL,
    daytona:{apiKey:env.DAYTONA_API_KEY!,apiUrl:env.DAYTONA_API_URL,openaiSecretName:env.HERBIE_DAYTONA_OPENAI_SECRET!,snapshot:env.HERBIE_DAYTONA_SNAPSHOT},
  };
}
