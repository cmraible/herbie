import {resolve} from 'node:path';
import {createPrivateKey,X509Certificate} from 'node:crypto';
import {setTimeout as delay} from 'node:timers/promises';

type Environment=Record<string,string|undefined>;
function isRecord(value:unknown):value is Record<string,unknown>{return !!value&&typeof value==='object'&&!Array.isArray(value);}
function object(value:unknown){if(!isRecord(value))throw new Error('Invalid deployment configuration');return value;}
function required(values:Record<string,unknown>,name:string){
  const value=values[name];
  if(typeof value!=='string'||!value.trim())throw new Error(`Missing deployment input: ${name}`);
  return value;
}

export async function waitForDeployment(origin:string,revision:string,options:{timeoutMs?:number;intervalMs?:number;signal?:AbortSignal}={}){
  const deadline=Date.now()+(options.timeoutMs??600_000);
  while(Date.now()<deadline&&!options.signal?.aborted){
    try{
      const signal=AbortSignal.any([AbortSignal.timeout(10_000),...(options.signal?[options.signal]:[])]);
      const response=await fetch(`${origin}/api/health`,{signal,redirect:'error'});
      const health:unknown=await response.json();
      if(response.ok&&isRecord(health)&&health.mode==='live'&&health.executionEnabled===false
        &&health.deploymentId===revision&&health.imageRevision===revision)return;
    }catch{/* Responses can contain credentials or platform details; never print them. */}
    await delay(options.intervalMs??5000,undefined,{signal:options.signal}).catch(()=>undefined);
  }
  throw new Error('Deployment did not become ready for the requested revision');
}

export function prepareDeployment(environment:Environment,input:unknown,directory:string){
  const repository=required(environment,'HERBIE_DEPLOY_REPOSITORY');
  if(!/^[a-zA-Z0-9-]+\/[a-zA-Z0-9_.-]+$/.test(repository)||environment.GITHUB_REPOSITORY!==repository||environment.GITHUB_REF!=='refs/heads/main'
    ||!['push','workflow_dispatch'].includes(environment.GITHUB_EVENT_NAME??'')||environment.HERBIE_DEPLOY_ENABLED!=='true'){
    throw new Error('Deployment is not authorized for this workflow context');
  }
  const config=object(input),vars=object(config.vars),assets=object(config.assets);
  const containers=config.containers;
  if(!Array.isArray(containers)||containers.length!==1)throw new Error('Invalid deployment configuration');
  const container=object(containers[0]);
  if(config.account_id!==undefined||config.name!=='herbie-service'||vars.HERBIE_PUBLIC_URL!=='https://herbie.example.invalid'
    ||vars.HERBIE_EXECUTION_ENABLED!=='false'||container.instance_type!=='basic'||container.max_instances!==1){
    throw new Error('Deployment target or disabled execution configuration does not match the approved service');
  }
  const account=required(environment,'CLOUDFLARE_ACCOUNT_ID'),origin=required(environment,'HERBIE_PUBLIC_URL');
  const project=required(environment,'HERBIE_SUPABASE_PROJECT_REF'),poolerHost=required(environment,'HERBIE_SUPABASE_POOLER_HOST');
  try{
    const url=new URL(origin);
    if(!/^[a-f0-9]{32}$/.test(account)||!/^[a-z0-9]{20}$/.test(project)||!/^[a-z0-9-]+\.pooler\.supabase\.com$/.test(poolerHost)
      ||url.origin!==origin||url.protocol!=='https:'||url.port||url.username||url.password
      ||!/^herbie-service\.[a-z0-9-]+\.workers\.dev$/.test(url.hostname))throw new Error();
  }catch{throw new Error('Invalid private deployment target configuration');}
  required(environment,'CLOUDFLARE_API_TOKEN');
  if(!/^[a-f0-9]{40}$/.test(environment.GITHUB_SHA??'')||!/^\d+$/.test(environment.GITHUB_RUN_ID??'')||!/^\d+$/.test(environment.GITHUB_RUN_ATTEMPT??'')){
    throw new Error('Invalid deployment revision');
  }
  const revision=`${required(environment,'GITHUB_SHA')}-${required(environment,'GITHUB_RUN_ID')}-${required(environment,'GITHUB_RUN_ATTEMPT')}`;
  const runtime={DATABASE_URL:required(environment,'HERBIE_DATABASE_URL'),HERBIE_CREDENTIAL_KEY:required(environment,'HERBIE_CREDENTIAL_KEY'),
    GITHUB_APP_ID:required(environment,'HERBIE_GITHUB_APP_ID'),GITHUB_CLIENT_ID:required(environment,'HERBIE_GITHUB_CLIENT_ID'),
    GITHUB_CLIENT_SECRET:required(environment,'HERBIE_GITHUB_CLIENT_SECRET'),GITHUB_PRIVATE_KEY:required(environment,'HERBIE_GITHUB_PRIVATE_KEY'),
    GITHUB_WEBHOOK_SECRET:required(environment,'HERBIE_GITHUB_WEBHOOK_SECRET'),
    ...(environment.HERBIE_DATABASE_CA?{HERBIE_DATABASE_CA:environment.HERBIE_DATABASE_CA}:{})};
  try{
    const database=new URL(runtime.DATABASE_URL);
    if(database.protocol!=='postgresql:'||database.username!==`postgres.${project}`||!database.password
      ||database.hostname!==poolerHost||database.port!=='5432'||database.pathname!=='/postgres'
      ||database.hash||![...database.searchParams].every(([name,value])=>name==='sslmode'&&value==='verify-full'))throw new Error();
    const key=Buffer.from(runtime.HERBIE_CREDENTIAL_KEY,'base64');
    if(key.length!==32||key.toString('base64')!==runtime.HERBIE_CREDENTIAL_KEY)throw new Error();
    if(createPrivateKey(runtime.GITHUB_PRIVATE_KEY).asymmetricKeyType!=='rsa'||!/^\d+$/.test(runtime.GITHUB_APP_ID))throw new Error();
    if(runtime.HERBIE_DATABASE_CA)new X509Certificate(runtime.HERBIE_DATABASE_CA);
  }catch{throw new Error('Invalid runtime secret configuration; check the project session URL, key and PEM values');}
  return {revision,origin,repositoryUrl:`https://github.com/${repository}.git`,secrets:JSON.stringify({HERBIE_RUNTIME_SECRETS:JSON.stringify(runtime)}),
    config:{...config,account_id:account,main:resolve(directory,required(config,'main')),
      vars:{...vars,HERBIE_PUBLIC_URL:origin,HERBIE_EXECUTION_ENABLED:'false',HERBIE_DEPLOYMENT_ID:revision},
      assets:{...assets,directory:resolve(directory,required(assets,'directory'))},
      containers:[{...container,image:resolve(directory,required(container,'image')),image_build_context:resolve(directory,required(container,'image_build_context')),
        image_vars:{HERBIE_RUNTIME_REVISION:revision}}]}};
}
